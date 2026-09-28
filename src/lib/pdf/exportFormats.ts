// PDF -> CSV / JSON (ODT / RTF / Markdown live in docWriters.ts). Works on the structured text produced by
// `extractStructuredText` (convert.ts). Pure except for the JSON export,
// which also reads metadata and the outline from the pdf.js document.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pageToRows, stripInvalidXmlChars, type PageText, type TextLine } from './convert';
import type { DocxPageGraphics } from './docx';
import { layoutRows } from './docWriters';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Block = { kind: 'line'; line: TextLine } | { kind: 'table'; rows: string[][]; lines: TextLine[]; cols: number };

/** Splits a page into single lines and table blocks (>= 2 consecutive multi-cell lines). */
function pageBlocks(page: PageText): Block[] {
  const blocks: Block[] = [];
  const rows = pageToRows(page);
  const lines = page.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].cells.length >= 2) {
      let j = i + 1;
      while (j < lines.length && lines[j].cells.length >= 2) j++;
      if (j - i >= 2) {
        const r = rows.slice(i, j);
        const cols = Math.max(...r.map((x) => x.length));
        blocks.push({ kind: 'table', rows: r.map((x) => [...x, ...Array<string>(cols - x.length).fill('')]), lines: lines.slice(i, j), cols });
        i = j;
        continue;
      }
    }
    blocks.push({ kind: 'line', line: lines[i] });
    i++;
  }
  return blocks;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// ODT / RTF / Markdown: built from the page layout (docWriters.ts)
// ---------------------------------------------------------------------------

export { buildOdtParts, exportToMarkdown, exportToOdt, exportToRtf, layoutReflow, layoutRows, ODT_MIME, odfText, rtfEscape } from './docWriters';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t';
  includePageColumn?: boolean;
}

/**
 * Exports table-like rows (blocks of >= 2 consecutive multi-cell lines) from
 * every page. When the document contains no table at all, every line is
 * exported instead so the result is never empty. RFC 4180 quoting, UTF-8
 * BOM, CRLF line endings; rows are padded to a common column count.
 */
export function exportToCsv(pages: PageText[], opts: CsvOptions = {}, graphics?: DocxPageGraphics[]): string {
  const delim = opts.delimiter ?? ',';
  const collected: { page: number; row: string[] }[] = [];
  if (graphics) {
    // Page layout: ruled tables with wrapped cells stay one row per table row.
    const rows = layoutRows(pages, graphics);
    const tables = rows.filter((r) => r.table);
    for (const r of tables.length ? tables : rows) collected.push({ page: r.pageNumber, row: r.cells });
  } else {
    for (const p of pages) for (const b of pageBlocks(p)) if (b.kind === 'table') for (const row of b.rows) collected.push({ page: p.pageNumber, row });
    if (!collected.length) {
      for (const p of pages) for (const row of pageToRows(p)) collected.push({ page: p.pageNumber, row });
    }
  }
  const width = Math.max(0, ...collected.map((r) => r.row.length));
  const quote = (v: string) => {
    const s = stripInvalidXmlChars(v);
    return s.includes(delim) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = collected.map(({ page, row }) => {
    const cells = [...row, ...Array<string>(width - row.length).fill('')].map(quote);
    if (opts.includePageColumn) cells.unshift(String(page));
    return cells.join(delim);
  });
  if (opts.includePageColumn && lines.length) {
    lines.unshift(['Page', ...Array.from({ length: width }, (_, i) => `Column ${i + 1}`)].map(quote).join(delim));
  }
  return '﻿' + lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface JsonOutlineEntry {
  title: string;
  level: number;
  page: number | null;
  url?: string;
}

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

function isRef(v: unknown): v is { num: number; gen: number } {
  return !!v && typeof v === 'object' && typeof (v as { num?: unknown }).num === 'number' && typeof (v as { gen?: unknown }).gen === 'number';
}

async function destPage(pdf: PDFDocumentProxy, dest: OutlineNode['dest']): Promise<number | null> {
  try {
    const explicit: unknown[] | null = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!explicit || !explicit.length) return null;
    const target = explicit[0];
    if (isRef(target)) return (await pdf.getPageIndex(target)) + 1;
    if (typeof target === 'number' && Number.isInteger(target)) return target + 1;
    return null;
  } catch {
    return null;
  }
}

async function flattenOutline(pdf: PDFDocumentProxy, nodes: OutlineNode[], level: number, out: JsonOutlineEntry[]): Promise<void> {
  for (const n of nodes) {
    const entry: JsonOutlineEntry = { title: n.title, level, page: await destPage(pdf, n.dest) };
    if (n.url) entry.url = n.url;
    out.push(entry);
    // `items` is typed as any[] by pdf.js; it holds nested outline nodes.
    if (Array.isArray(n.items) && n.items.length) await flattenOutline(pdf, n.items as OutlineNode[], level + 1, out);
  }
}

function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return Array.from(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  if (typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = jsonSafe(v, depth + 1);
      if (s !== undefined) o[k] = s;
    }
    return o;
  }
  return undefined;
}

export async function exportToJson(
  pdf: PDFDocumentProxy,
  pages: PageText[],
  extra: { formFields?: Array<{ name: string; kind: string; value: unknown }> } = {},
): Promise<string> {
  let metadata: unknown = {};
  try {
    const md = await pdf.getMetadata();
    metadata = jsonSafe(md.info) ?? {};
  } catch {
    /* no metadata */
  }
  const outline: JsonOutlineEntry[] = [];
  try {
    const nodes = await pdf.getOutline();
    if (nodes) await flattenOutline(pdf, nodes, 0, outline);
  } catch {
    /* no outline */
  }
  const doc = {
    generator: 'Adika PDF Editor',
    exportedAt: new Date().toISOString(),
    pageCount: pdf.numPages,
    metadata,
    outline,
    pages: pages.map((p) => ({
      number: p.pageNumber,
      width: r2(p.width),
      height: r2(p.height),
      text: p.lines.map((l) => l.cells.map((c) => c.text).join('\t')).join('\n'),
      lines: p.lines.map((l) => ({
        x: r2(l.x),
        y: r2(l.y),
        fontSize: r2(l.fontSize),
        bold: l.bold,
        text: l.text,
        cells: l.cells.map((c) => ({ x: r2(c.x), text: c.text, ...(c.width !== undefined ? { width: r2(c.width) } : {}), ...(c.col !== undefined ? { col: c.col } : {}) })),
      })),
    })),
    formFields: (extra.formFields ?? []).map((f) => ({ name: f.name, kind: f.kind, value: jsonSafe(f.value) ?? null })),
  };
  return JSON.stringify(doc, null, 2);
}
