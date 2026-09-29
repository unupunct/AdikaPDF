/**
 * Text matches with exact letter positions, for Find & replace and
 * Redact by pattern. Pages are read with the glyph engine (textRemoval.ts);
 * pages it cannot read fully fall back to pdf.js text runs (estimated
 * positions, marked `exact: false`).
 */
import { PDFDocument } from 'pdf-lib';
import type { FontFamily, PageRef, SourceDoc } from '@/types';
import { applyMatrix, displayToPdfMatrix, totalRotation, type Matrix, type Rect } from '@/lib/geometry';
import { analyzePageText, type Box, type Glyph } from './textRemoval';
import { joinRuns, normalizeForSearch, type SearchOptions } from '@/lib/search';
import { runRect, type TextRun } from './textGeometry';

export type Range = [number, number];
export type Finder = (text: string) => Range[];

export interface TextMatch {
  pageId: string;
  /** The matched text as it appears on the page. */
  text: string;
  /** Display-space rects (scale 1), one per line of the match. */
  rects: Rect[];
  /** Positions come from the page's own glyphs (the letters can be removed exactly). */
  exact: boolean;
  /** Baseline start of the first letter (display space), text direction, font size in points. */
  origin: [number, number];
  dir: [number, number];
  size: number;
  /** Width of the first line of the match along the text direction. */
  width: number;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  color: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Finder for a typed query: case / diacritic handling like the search bar. */
export function queryFinder(query: string, opts: SearchOptions = {}): Finder {
  const cs = !!opts.caseSensitive;
  const q = normalizeForSearch(query.trim(), cs).replace(/\s+/g, ' ');
  return (text) => {
    if (!q) return [];
    const hay = normalizeForSearch(text, cs).replace(/\s/g, ' ');
    const out: Range[] = [];
    for (let from = 0; ; ) {
      const at = hay.indexOf(q, from);
      if (at < 0) break;
      const end = at + q.length;
      from = end;
      if (opts.wholeWord && ((at > 0 && WORD_CHAR.test(text[at - 1])) || (end < text.length && WORD_CHAR.test(text[end])))) {
        from = at + 1;
        continue;
      }
      out.push([at, end]);
    }
    return out;
  };
}

export function styleFromFontName(name: string): { family: FontFamily; bold: boolean; italic: boolean } {
  const n = name.toLowerCase();
  const family: FontFamily = /mono|courier|consol/.test(n) ? 'mono' : /serif|times|georgia|garamond|roman|cambria|book|minion/.test(n) && !/sans/.test(n) ? 'serif' : 'sans';
  return { family, bold: /bold|black|heavy|semibold|demi/.test(n), italic: /italic|oblique/.test(n) };
}

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function displayRect(inv: Matrix, b: Box): Rect {
  const pts = [applyMatrix(inv, b.x0, b.y0), applyMatrix(inv, b.x1, b.y0), applyMatrix(inv, b.x0, b.y1), applyMatrix(inv, b.x1, b.y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function union(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width));
  const y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Matches on one page read by the glyph engine; null when the page needs the fallback. */
export function engineMatches(doc: PDFDocument, ref: PageRef, finder: Finder): TextMatch[] | null {
  if (ref.kind !== 'source') return null;
  const page = doc.getPage(ref.sourceIndex);
  const t = analyzePageText(doc, page);
  if (t.partial) return null;
  const b = page.getCropBox();
  const inv = invert(displayToPdfMatrix(totalRotation(ref), { x: b.x, y: b.y, width: b.width, height: b.height }));
  const lin: Matrix = [inv[0], inv[1], inv[2], inv[3], 0, 0];
  const out: TextMatch[] = [];
  for (const [s, e] of finder(t.text)) {
    const idx: number[] = [];
    for (let k = s; k < e; k++) {
      const g = t.map[k];
      if (g >= 0 && idx[idx.length - 1] !== g) idx.push(g);
    }
    // Leading / trailing spaces are not part of the visible match.
    while (idx.length && /^\s*$/.test(t.glyphs[idx[0]].text)) idx.shift();
    while (idx.length && /^\s*$/.test(t.glyphs[idx[idx.length - 1]].text)) idx.pop();
    if (!idx.length) continue;
    // Split into lines.
    const lines: Glyph[][] = [];
    let prev: Glyph | null = null;
    for (const i of idx) {
      const g = t.glyphs[i];
      const across = prev ? Math.abs(-(g.origin[0] - prev.origin[0]) * prev.dir[1] + (g.origin[1] - prev.origin[1]) * prev.dir[0]) : 0;
      if (!prev || across > prev.size * 0.5) lines.push([g]);
      else lines[lines.length - 1].push(g);
      prev = g;
    }
    const first = lines[0][0];
    const lastOfFirst = lines[0][lines[0].length - 1];
    const o = applyMatrix(inv, first.origin[0], first.origin[1]);
    const d = applyMatrix(lin, first.dir[0], first.dir[1]);
    const dl = Math.hypot(d[0], d[1]) || 1;
    const along = (lastOfFirst.origin[0] - first.origin[0]) * first.dir[0] + (lastOfFirst.origin[1] - first.origin[1]) * first.dir[1];
    out.push({
      pageId: ref.id,
      text: t.text.slice(s, e).trim(),
      rects: lines.map((l) => union(l.map((g) => displayRect(inv, g.box)))),
      exact: true,
      origin: [o[0], o[1]],
      dir: [d[0] / dl, d[1] / dl],
      size: first.size,
      width: along + lastOfFirst.advance,
      ...styleFromFontName(first.font),
      color: first.color,
    });
  }
  return out;
}

/** Matches from pdf.js text runs (positions estimated within a run). */
export function runMatches(ref: PageRef, runs: TextRun[], finder: Finder): TextMatch[] {
  const { text, segments } = joinRuns(runs);
  const out: TextMatch[] = [];
  for (const [s, e] of finder(text)) {
    const rects: Rect[] = [];
    let first: { run: TextRun; from: number } | null = null;
    let firstWidth = 0;
    for (const seg of segments) {
      const a = Math.max(s, seg.start);
      const b = Math.min(e, seg.start + seg.run.str.length);
      if (a >= b) continue;
      const r = runRect(seg.run, a - seg.start, b - seg.start);
      rects.push(r);
      if (!first) {
        first = { run: seg.run, from: a - seg.start };
        firstWidth = (seg.run.width * (b - a)) / Math.max(1, seg.run.str.length);
      }
    }
    if (!first) continue;
    const { run, from } = first;
    const u = (run.width * from) / Math.max(1, run.str.length);
    out.push({
      pageId: ref.id,
      text: text.slice(s, e).trim(),
      rects,
      exact: false,
      origin: [run.origin[0] + run.dir[0] * u, run.origin[1] + run.dir[1] * u],
      dir: run.dir,
      size: run.size,
      width: firstWidth,
      ...styleFromFontName(`${run.fontName} ${run.fontFamily ?? ''}`),
      bold: run.bold,
      italic: run.italic,
      color: '#000000',
    });
  }
  return out;
}

/**
 * All matches in the document. `fallbackRuns` supplies pdf.js text runs for
 * pages the engine cannot read (blank pages are skipped).
 */
export async function findTextMatches(
  pages: PageRef[],
  sources: Record<string, SourceDoc>,
  finder: Finder,
  fallbackRuns?: (page: PageRef) => Promise<TextRun[]>,
): Promise<TextMatch[]> {
  const docs = new Map<string, PDFDocument | null>();
  const out: TextMatch[] = [];
  for (const ref of pages) {
    if (ref.kind !== 'source' || !ref.sourceId) continue;
    let doc = docs.get(ref.sourceId);
    if (doc === undefined) {
      const src = sources[ref.sourceId];
      doc = src ? await PDFDocument.load(src.bytes, { updateMetadata: false, ignoreEncryption: true }).catch(() => null) : null;
      docs.set(ref.sourceId, doc);
    }
    const exact = doc ? engineMatches(doc, ref, finder) : null;
    if (exact) out.push(...exact);
    else if (fallbackRuns) out.push(...runMatches(ref, await fallbackRuns(ref), finder));
  }
  return out;
}
