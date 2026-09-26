// PDF -> ODT / RTF / CSV / JSON. Works on the structured text produced by
// `extractStructuredText` (convert.ts). Pure except for the JSON export,
// which also reads metadata and the outline from the pdf.js document.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import JSZip from 'jszip';
import { pageToRows, stripInvalidXmlChars, xmlEscape, type PageText, type TextLine } from './convert';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Character-weighted median font size (same heuristic as the DOCX export). */
function bodyFontSize(pages: PageText[]): number {
  const sizes: number[] = [];
  for (const p of pages) for (const l of p.lines) for (let k = 0; k < Math.min(40, l.text.length); k++) sizes.push(l.fontSize);
  return median(sizes) || 11;
}

function headingLevel(size: number, body: number, textLen: number): 0 | 1 | 2 | 3 {
  if (textLen > 200) return 0;
  const r = size / body;
  if (r >= 1.6) return 1;
  if (r >= 1.3) return 2;
  if (r >= 1.12) return 3;
  return 0;
}

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
// ODT (OpenDocument Text)
// ---------------------------------------------------------------------------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escapes text for ODF: runs of spaces -> text:s, tabs -> text:tab, newlines -> text:line-break. */
export function odfText(s: string): string {
  return xmlEscape(s)
    .replace(/\r\n?|\n/g, '<text:line-break/>')
    .replace(/\t/g, '<text:tab/>')
    .replace(/^ /, '<text:s/>')
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
}

const cm = (pt: number) => `${(pt / 72 * 2.54).toFixed(3)}cm`;

function pageMargin(w: number, h: number): number {
  return Math.min(36, Math.min(w, h) / 10);
}

/** Builds all ODT parts (exported for tests). */
export function buildOdtParts(pages: PageText[], title: string): Map<string, string> {
  const body = bodyFontSize(pages);
  const src = pages.length ? pages : [{ pageNumber: 1, width: 595.28, height: 841.89, lines: [] }];

  // One page layout + master page per distinct page size.
  const sizes = new Map<string, number>();
  const sizeKey = (p: PageText) => `${Math.round(p.width * 10)}x${Math.round(p.height * 10)}`;
  const layouts: string[] = [];
  const masters: string[] = [];
  for (const p of src) {
    const k = sizeKey(p);
    if (sizes.has(k)) continue;
    const idx = sizes.size + 1;
    sizes.set(k, idx);
    const m = pageMargin(p.width, p.height);
    layouts.push(
      `<style:page-layout style:name="PL${idx}"><style:page-layout-properties fo:page-width="${cm(p.width)}" fo:page-height="${cm(p.height)}" ` +
        `style:print-orientation="${p.width > p.height ? 'landscape' : 'portrait'}" fo:margin-top="${cm(m)}" fo:margin-bottom="${cm(m)}" ` +
        `fo:margin-left="${cm(m)}" fo:margin-right="${cm(m)}"/></style:page-layout>`,
    );
    masters.push(`<style:master-page style:name="MP${idx}" style:page-layout-name="PL${idx}"/>`);
  }

  // Automatic styles: paragraph/table styles that start a page on a master page.
  const auto: string[] = [
    '<style:style style:name="T_b" style:family="text"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/></style:style>',
    '<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="0.5pt solid #999999"/></style:style>',
  ];
  const autoNames = new Set<string>();
  const breakStyle = (family: 'paragraph' | 'table', parent: string, mp: number): string => {
    const name = `${family === 'table' ? 'Tbl' : parent.replace(/_20_/g, '')}_MP${mp}`;
    if (!autoNames.has(name)) {
      autoNames.add(name);
      auto.push(
        family === 'table'
          ? `<style:style style:name="${name}" style:family="table" style:master-page-name="MP${mp}"><style:table-properties table:align="margins"/></style:style>`
          : `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}" style:master-page-name="MP${mp}"/>`,
      );
    }
    return name;
  };
  // Automatic styles may only inherit from common styles, so the size and
  // the master page are combined into one automatic style when both apply.
  const sizeStyle = (pt: number, mp?: number): string => {
    const v = Math.max(4, Math.min(72, Math.round(pt * 2) / 2));
    const name = `P_sz${String(v).replace('.', '_')}${mp ? `_MP${mp}` : ''}`;
    if (!autoNames.has(name)) {
      autoNames.add(name);
      auto.push(
        `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard"${mp ? ` style:master-page-name="MP${mp}"` : ''}><style:text-properties fo:font-size="${v}pt" style:font-size-asian="${v}pt" style:font-size-complex="${v}pt"/></style:style>`,
      );
    }
    return name;
  };

  const out: string[] = [];
  let tableNo = 0;
  src.forEach((p) => {
    const mp = sizes.get(sizeKey(p)) ?? 1;
    let first = true;
    const blocks = pageBlocks(p);
    if (!blocks.length) {
      out.push(`<text:p text:style-name="${breakStyle('paragraph', 'Standard', mp)}"/>`);
      return;
    }
    for (const b of blocks) {
      if (b.kind === 'table') {
        tableNo++;
        const style = first ? breakStyle('table', '', mp) : 'Tbl';
        first = false;
        out.push(`<table:table table:name="Table${tableNo}" table:style-name="${style}">`);
        out.push(`<table:table-column table:number-columns-repeated="${b.cols}"/>`);
        b.rows.forEach((row, ri) => {
          const bold = b.lines[ri]?.bold;
          out.push('<table:table-row>');
          for (const cell of row) {
            const inner = bold && cell ? `<text:span text:style-name="T_b">${odfText(cell)}</text:span>` : odfText(cell);
            out.push(`<table:table-cell table:style-name="Cell" office:value-type="string"><text:p text:style-name="Table_20_Contents">${inner}</text:p></table:table-cell>`);
          }
          out.push('</table:table-row>');
        });
        out.push('</table:table>');
        continue;
      }
      const l = b.line;
      const content = l.cells.map((c) => odfText(c.text)).join('<text:tab/>');
      const level = headingLevel(l.fontSize, body, l.text.length);
      if (level) {
        const parent = `Heading_20_${level}`;
        const style = first ? breakStyle('paragraph', parent, mp) : parent;
        out.push(`<text:h text:style-name="${style}" text:outline-level="${level}">${content}</text:h>`);
      } else {
        const plain = Math.abs(l.fontSize - body) < 0.6;
        const style = plain ? (first ? breakStyle('paragraph', 'Standard', mp) : 'Standard') : sizeStyle(l.fontSize, first ? mp : undefined);
        const inner = l.bold ? `<text:span text:style-name="T_b">${content}</text:span>` : content;
        out.push(`<text:p text:style-name="${style}">${inner}</text:p>`);
      }
      first = false;
    }
  });

  const bodyPt = Math.round(body * 2) / 2;
  const styles =
    XML_DECL +
    `<office:document-styles ${ODF_NS} office:version="1.2">` +
    '<office:font-face-decls><style:font-face style:name="Calibri" svg:font-family="Calibri" style:font-family-generic="swiss"/></office:font-face-decls>' +
    '<office:styles>' +
    `<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.1cm"/><style:text-properties style:font-name="Calibri" fo:font-size="${bodyPt}pt" style:font-size-asian="${bodyPt}pt" style:font-size-complex="${bodyPt}pt" fo:language="ro" fo:country="RO"/></style:default-style>` +
    '<style:default-style style:family="table"><style:table-properties table:border-model="collapsing"/></style:default-style>' +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    '<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.21cm" fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/></style:style>' +
    [1, 2, 3]
      .map((lv) => {
        const sz = lv === 1 ? 20 : lv === 2 ? 16 : 13;
        return `<style:style style:name="Heading_20_${lv}" style:display-name="Heading ${lv}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Standard" style:default-outline-level="${lv}" style:class="text"><style:text-properties fo:font-size="${sz}pt" style:font-size-asian="${sz}pt" style:font-size-complex="${sz}pt"/></style:style>`;
      })
      .join('') +
    '<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:margin-bottom="0cm"/></style:style>' +
    '<style:style style:name="Tbl" style:family="table"><style:table-properties table:align="margins"/></style:style>' +
    '</office:styles>' +
    `<office:automatic-styles>${layouts.join('')}</office:automatic-styles>` +
    `<office:master-styles>${masters.join('')}</office:master-styles>` +
    '</office:document-styles>';

  const content =
    XML_DECL +
    `<office:document-content ${ODF_NS} office:version="1.2">` +
    '<office:font-face-decls><style:font-face style:name="Calibri" svg:font-family="Calibri" style:font-family-generic="swiss"/></office:font-face-decls>' +
    `<office:automatic-styles>${auto.join('')}</office:automatic-styles>` +
    `<office:body><office:text>${out.join('')}</office:text></office:body>` +
    '</office:document-content>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const meta =
    XML_DECL +
    `<office:document-meta ${ODF_NS} office:version="1.2"><office:meta>` +
    '<meta:generator>Adika PDF Editor</meta:generator>' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date>` +
    `<meta:document-statistic meta:page-count="${src.length}" meta:table-count="${tableNo}"/>` +
    '</office:meta></office:document-meta>';

  const manifest =
    XML_DECL +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';

  return new Map([
    ['content.xml', content],
    ['styles.xml', styles],
    ['meta.xml', meta],
    ['META-INF/manifest.xml', manifest],
  ]);
}

export const ODT_MIME = 'application/vnd.oasis.opendocument.text';

export async function exportToOdt(pages: PageText[], title: string): Promise<Blob> {
  const zip = new JSZip();
  // The mimetype entry must be first and uncompressed (ODF 1.2 part 3, 3.3).
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' });
  for (const [name, data] of buildOdtParts(pages, title)) zip.file(name, data);
  return zip.generateAsync({ type: 'blob', mimeType: ODT_MIME, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

/** Escapes text for RTF: ASCII as-is, everything else as \uN? (signed 16-bit, UTF-16 units). */
export function rtfEscape(s: string): string {
  let out = '';
  const clean = stripInvalidXmlChars(s);
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i); // UTF-16 code unit: surrogate pairs become two \u escapes
    if (code === 0x5c || code === 0x7b || code === 0x7d) out += '\\' + clean[i];
    else if (code === 0x09) out += '\\tab ';
    else if (code === 0x0a) out += '\\line ';
    else if (code === 0x0d) continue;
    else if (code >= 0x20 && code < 0x80) out += clean[i];
    else if (code < 0x20) continue;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}

const tw = (pt: number) => Math.round(pt * 20);

export function exportToRtf(pages: PageText[], title: string): string {
  const body = bodyFontSize(pages);
  const src = pages.length ? pages : [{ pageNumber: 1, width: 595.28, height: 841.89, lines: [] }];
  const out: string[] = [];
  const hs = [0, 40, 32, 26];
  out.push(
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1',
    '{\\fonttbl{\\f0\\fswiss\\fcharset0 Calibri;}}',
    '{\\colortbl;\\red153\\green153\\blue153;}',
    '{\\stylesheet{\\s0\\f0\\fs22 Normal;}' +
      [1, 2, 3].map((lv) => `{\\s${lv}\\sbasedon0\\snext0\\keepn\\sb240\\sa120\\outlinelevel${lv - 1}\\b\\f0\\fs${hs[lv]} heading ${lv};}`).join('') +
      '}',
    `{\\info{\\title ${rtfEscape(title)}}{\\doccomm Adika PDF Editor}}`,
  );
  const first = src[0];
  const m0 = pageMargin(first.width, first.height);
  out.push(`\\paperw${tw(first.width)}\\paperh${tw(first.height)}\\margl${tw(m0)}\\margr${tw(m0)}\\margt${tw(m0)}\\margb${tw(m0)}${first.width > first.height ? '\\landscape' : ''}\\viewkind1`);
  out.push('\\sectd' + sectSize(first));

  src.forEach((p, pi) => {
    if (pi > 0) {
      const prev = src[pi - 1];
      if (Math.abs(prev.width - p.width) > 0.5 || Math.abs(prev.height - p.height) > 0.5) out.push('\\sect\\sectd\\sbkpage' + sectSize(p));
      else out.push('\\page');
    }
    const textWidth = Math.max(72, p.width - 2 * pageMargin(p.width, p.height));
    const blocks = pageBlocks(p);
    if (!blocks.length) out.push('\\pard\\plain\\s0\\f0\\fs22\\par');
    for (const b of blocks) {
      if (b.kind === 'table') {
        const colW = Math.floor(tw(textWidth) / b.cols);
        const brd = '\\brdrs\\brdrw10\\brdrcf1';
        let rowDef = '\\trowd\\trgaph108\\trleft0\\trautofit1';
        for (let c = 1; c <= b.cols; c++) rowDef += `\\clbrdrt${brd}\\clbrdrl${brd}\\clbrdrb${brd}\\clbrdrr${brd}\\cellx${colW * c}`;
        b.rows.forEach((row, ri) => {
          const bold = b.lines[ri]?.bold;
          const size = Math.max(8, Math.round((b.lines[ri]?.fontSize ?? body) * 2));
          out.push(
            rowDef + '\n' +
              row.map((cell) => `\\pard\\plain\\intbl\\s0\\f0\\fs${size}${bold ? '\\b' : ''} ${rtfEscape(cell)}\\cell`).join('\n') +
              '\n\\row',
          );
        });
        out.push('\\pard');
        continue;
      }
      const l = b.line;
      const text = l.cells.map((c) => rtfEscape(c.text)).join('\\tab ');
      const level = headingLevel(l.fontSize, body, l.text.length);
      if (level) {
        out.push(`\\pard\\plain\\s${level}\\keepn\\sb240\\sa120\\outlinelevel${level - 1}\\b\\f0\\fs${hs[level]} ${text}\\par`);
      } else {
        const size = Math.max(4, Math.round(l.fontSize * 2));
        out.push(`\\pard\\plain\\s0\\sa60\\f0\\fs${size}${l.bold ? '\\b' : ''} ${text}\\par`);
      }
    }
  });
  out.push('}');
  return out.join('\n');
}

function sectSize(p: PageText): string {
  const m = pageMargin(p.width, p.height);
  return `\\pgwsxn${tw(p.width)}\\pghsxn${tw(p.height)}\\marglsxn${tw(m)}\\margrsxn${tw(m)}\\margtsxn${tw(m)}\\margbsxn${tw(m)}${p.width > p.height ? '\\lndscpsxn' : ''}`;
}

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
export function exportToCsv(pages: PageText[], opts: CsvOptions = {}): string {
  const delim = opts.delimiter ?? ',';
  const collected: { page: number; row: string[] }[] = [];
  for (const p of pages) for (const b of pageBlocks(p)) if (b.kind === 'table') for (const row of b.rows) collected.push({ page: p.pageNumber, row });
  if (!collected.length) {
    for (const p of pages) for (const row of pageToRows(p)) collected.push({ page: p.pageNumber, row });
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
