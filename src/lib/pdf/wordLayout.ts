// Page layout analysis for PDF -> Word. Turns the positioned lines of a page
// (from `extractStructuredText`) plus image and rule boxes into Word-shaped
// blocks: paragraphs (joined lines, alignment, indents, spacing, lists),
// tables, inline and floating images, and one- or two-column segments.
//
// Pure: no pdf.js or DOM, so it is unit-tested in node. All geometry is in
// PDF points with a top-left page origin (y grows downwards).

import { assignTableColumns, detectTableColumns, headingLevel, median, type TextCell, type TextLine, type PageText } from './convert';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface TabStop {
  /** Points from the paragraph's reference left edge. */
  pos: number;
  right: boolean;
}

export interface ParaBlock {
  kind: 'para';
  lines: TextLine[];
  /** Ink box of the lines on the PDF page. */
  box: Box;
  align: Align;
  /** Points from the stream's left edge (flow) / from box.x0 (exact). */
  indentLeft: number;
  /** Points from the stream's right edge (centred / right-aligned paragraphs). */
  indentRight: number;
  /** Positive = first-line indent, negative = hanging indent. */
  firstLine: number;
  /** Baseline-to-baseline distance Word should use (points). */
  lineHeight: number;
  /** Explicit line spacing to set (points) when the PDF's leading is looser than single. */
  lineSpacing?: number;
  fontSize: number;
  heading: 0 | 1 | 2 | 3;
  bullet: boolean;
  tabs: TabStop[];
  spaceBefore: number;
  /** RRGGBB background (code blocks, highlighted notes). */
  shading?: string;
}

export interface TableBlock {
  kind: 'table';
  lines: TextLine[];
  /** Column start positions (points, page coordinates). */
  cols: number[];
  /** Right edge of the last column (page coordinates). */
  right: number;
  box: Box;
  rowHeight: number;
  fontSize: number;
  bordered: boolean;
  spaceBefore: number;
  /** RRGGBB background of the whole table (e.g. aligned code inside a grey block). */
  shading?: string;
  /** Ruled tables: the cell contents (rows x columns, each a list of paragraphs) and row heights. */
  grid?: { cells: ParaBlock[][][]; rowHeights: number[]; shading?: (string | undefined)[][] };
}

/** A table drawn with ruling lines: column and row boundaries (points). */
export interface RuledGrid {
  box: Box;
  xs: number[];
  ys: number[];
}

export interface ImageBlock {
  kind: 'image';
  index: number;
  box: Box;
  indentLeft: number;
  spaceBefore: number;
}

export type Block = ParaBlock | TableBlock | ImageBlock;

export interface Segment {
  columns: 1 | 2;
  /** Space between the two columns (points). */
  gap: number;
  /** One stream per column, each in reading order. */
  streams: Block[][];
}

export interface FloatImage {
  index: number;
  box: Box;
  /** Text sits on top of the image (behind text); otherwise text wraps around it. */
  behind: boolean;
}

export interface PageLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  segments: Segment[];
  floats: FloatImage[];
  /** Bottom of the page's content before any squeezing (points). */
  contentBottom: number;
}

export interface PageGraphicsBoxes {
  images: Box[];
  /** Thin stroked/filled paths (table borders, underlines, separators). */
  rules: Box[];
  /** Solid backgrounds behind text (code blocks, shaded cells): box and RRGGBB. */
  shades?: { box: Box; color: string }[];
}

/** Word's single line height per font, in em (ascent + descent + line gap of the font). */
const LINE_HEIGHTS: Record<string, number> = {
  Arial: 1.15,
  'Times New Roman': 1.15,
  'Courier New': 1.133,
  Calibri: 1.22,
  Cambria: 1.172,
  Candara: 1.22,
  Consolas: 1.17,
  Georgia: 1.136,
  Verdana: 1.215,
  Tahoma: 1.207,
  'Trebuchet MS': 1.16,
  'Segoe UI': 1.33,
  Aptos: 1.2,
  Garamond: 1.12,
  'Book Antiqua': 1.17,
  'Century Gothic': 1.225,
  'Open Sans': 1.362,
  'Noto Sans': 1.362,
  'Noto Serif': 1.362,
  Roboto: 1.172,
  'DejaVu Sans': 1.164,
  'Liberation Sans': 1.149,
  'Liberation Serif': 1.149,
};
const NATURAL = 1.17;
/** Distance from the baseline to the bottom of Word's line box (em). */
const DESCENT = 0.25;

/** Single line height (em) of the font most of `lines` use. */
function naturalOf(lines: TextLine[], fallback?: string): number {
  const count = new Map<string, number>();
  for (const l of lines) for (const c of l.cells) for (const s of c.spans ?? []) if (s.family) count.set(s.family, (count.get(s.family) ?? 0) + s.text.length);
  let fam = fallback;
  let n = 0;
  for (const [f, k] of count) if (k > n) [fam, n] = [f, k];
  return (fam && LINE_HEIGHTS[fam]) || NATURAL;
}

const BULLET_ONLY = /^([•●○◦▪▫■□◆◇►▶➢➤✓✔·*–—-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,4}[.)])$/;
const BULLET_LEAD = /^([•●○◦▪▫■□◆◇►▶➢➤✓✔·*–—-]|\d{1,3}[.)]|[a-zA-Z][.)])\s+\S/;

// ---------------------------------------------------------------------------
// Line geometry
// ---------------------------------------------------------------------------

function lineRight(l: TextLine): number {
  return l.x + (l.width ?? l.text.length * 0.5 * l.fontSize);
}

function cellRight(c: TextCell, fs: number): number {
  return c.x + (c.width ?? c.text.length * 0.5 * fs);
}

function lineBox(l: TextLine): Box {
  return { x0: l.x, y0: l.y - 0.8 * l.fontSize, x1: lineRight(l), y1: l.y + 0.25 * l.fontSize };
}

function inside(inner: Box, outer: Box, tol = 2): boolean {
  return inner.x0 >= outer.x0 - tol && inner.x1 <= outer.x1 + tol && inner.y0 >= outer.y0 - tol && inner.y1 <= outer.y1 + tol;
}

function overlapsY(a: Box, b: Box, shrink = 2): boolean {
  return a.y0 < b.y1 - shrink && b.y0 < a.y1 - shrink;
}

function overlapsX(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1;
}

function intersects(a: Box, b: Box): boolean {
  return overlapsX(a, b) && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** A copy of `l` restricted to `cells`, with table columns cleared and size/bold recomputed. */
function subLine(l: TextLine, cells: TextCell[]): TextLine {
  const cs = cells.map((c) => ({ ...c, col: undefined }));
  const last = cs[cs.length - 1];
  const spans = cs.flatMap((c) => c.spans ?? []);
  let fontSize = l.fontSize;
  let bold = l.bold;
  if (spans.length) {
    fontSize = Math.max(...spans.map((s) => s.fontSize));
    const chars = spans.reduce((n, s) => n + s.text.trim().length, 0);
    const boldChars = spans.reduce((n, s) => n + (s.bold ? s.text.trim().length : 0), 0);
    bold = chars > 0 && boldChars / chars > 0.5;
  }
  return {
    y: l.y,
    x: cs[0].x,
    text: cs.map((c) => c.text).join('\t'),
    fontSize,
    bold,
    cells: cs,
    width: cellRight(last, fontSize) - cs[0].x,
  };
}

function bulletOf(l: TextLine): { textX?: number } | null {
  if (l.cells.length >= 2 && BULLET_ONLY.test(l.cells[0].text)) return { textX: l.cells[1].x };
  if (BULLET_LEAD.test(l.cells[0].text)) return {};
  return null;
}

function isTableLine(l: TextLine): boolean {
  return l.cells.length >= 2 && l.cells.every((c) => c.col !== undefined);
}

/** Lines that may join others into a flowing paragraph. */
function isProse(l: TextLine): boolean {
  if (isTableLine(l)) return false;
  return l.cells.length === 1 || (l.cells.length === 2 && BULLET_ONLY.test(l.cells[0].text));
}

/** Table detection that never pulls a bullet line into a table. */
function assignTables(lines: TextLine[]): void {
  let run: TextLine[] = [];
  for (const l of lines) {
    if (l.cells.length >= 2 && BULLET_ONLY.test(l.cells[0].text)) {
      assignTableColumns(run);
      run = [];
    } else run.push(l);
  }
  assignTableColumns(run);
}

function firstWordWidth(l: TextLine): number {
  const t = l.cells[l.cells.length === 2 && BULLET_ONLY.test(l.cells[0].text) ? 1 : 0].text;
  const w = /^\S+/.exec(t)?.[0].length ?? 4;
  return w * 0.55 * l.fontSize;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Where a span's ink ends (some producers pad words with trailing spaces). */
function spanInkEnd(s: { text: string; x: number; width: number }): number {
  const kept = s.text.replace(/\s+$/, '').length;
  return s.x + (s.text.length && kept < s.text.length ? (s.width * kept) / s.text.length : s.width);
}

/**
 * Splits text cells at word gaps that line up across many lines: a column
 * gutter narrower than the 2 em cell split still shows up as the same gap
 * on line after line. Mutates the lines.
 */
export function splitAtSharedGaps(lines: TextLine[]): void {
  const found: { line: TextLine; cell: TextCell; k: number; mid: number }[] = [];
  for (const l of lines) {
    for (const cell of l.cells) {
      const sp = cell.spans ?? [];
      for (let k = 1; k < sp.length; k++) {
        const end = spanInkEnd(sp[k - 1]);
        const gap = sp[k].x - end;
        if (gap > 1.0 * l.fontSize) found.push({ line: l, cell, k, mid: (end + sp[k].x) / 2 });
      }
    }
  }
  if (found.length < 4) return;
  const buckets = new Map<number, typeof found>();
  for (const f of found) {
    const key = Math.round(f.mid / 6);
    buckets.set(key, [...(buckets.get(key) ?? []), f]);
  }
  for (const [key, list] of buckets) {
    const near = [...list, ...(buckets.get(key - 1) ?? []), ...(buckets.get(key + 1) ?? [])];
    if (new Set(near.map((f) => f.line)).size < 4 || list.length < 3) continue;
    for (const f of list) {
      const idx = f.line.cells.indexOf(f.cell);
      const spans = f.cell.spans!;
      if (idx < 0 || f.k >= spans.length) continue;
      const left = spans.slice(0, f.k);
      const right = spans.slice(f.k);
      const mk = (ss: typeof spans): TextCell => {
        const t = ss.map((s) => ({ ...s }));
        t[0].text = t[0].text.replace(/^\s+/, '');
        t[t.length - 1].text = t[t.length - 1].text.replace(/\s+$/, '');
        return { x: t[0].x, text: t.map((s) => s.text).join(''), width: spanInkEnd(ss[ss.length - 1]) - t[0].x, spans: t.filter((s) => s.text) };
      };
      f.line.cells.splice(idx, 1, mk(left), mk(right));
      f.line.text = f.line.cells.map((c) => c.text).join('\t');
    }
  }
}

/**
 * Finds the gutter of a two-column page: an x that many lines leave empty
 * with prose-width text on both sides. Returns the gap band or null.
 */
export function detectColumnGutter(lines: TextLine[], left: number, right: number): { x0: number; x1: number } | null {
  const span = right - left;
  if (lines.length < 4 || span < 200) return null;
  // A line reads as two columns at g when nothing crosses g and both halves are prose-width
  // (table rows have short cells, so they do not count).
  const sides = (l: TextLine, g: number) => {
    const L = l.cells.filter((c) => cellRight(c, l.fontSize) <= g);
    const R = l.cells.filter((c) => c.x >= g);
    if (!L.length || !R.length || L.length + R.length !== l.cells.length) return null;
    const lr = Math.max(...L.map((c) => cellRight(c, l.fontSize)));
    const rl = Math.min(...R.map((c) => c.x));
    const lw = lr - Math.min(...L.map((c) => c.x));
    const rw = Math.max(...R.map((c) => cellRight(c, l.fontSize))) - rl;
    return lw >= 0.5 * (g - left) && rw >= 0.5 * (right - g) ? { lr, rl } : null;
  };
  let best: { g: number; count: number } | null = null;
  for (let g = left + 0.3 * span; g <= left + 0.7 * span; g += 2) {
    const count = lines.reduce((n, l) => n + (sides(l, g) ? 1 : 0), 0);
    if (!best || count > best.count) best = { g, count };
  }
  if (!best || best.count < 4) return null;
  let gx0 = left;
  let gx1 = right;
  for (const l of lines) {
    const s = sides(l, best.g);
    if (!s) continue;
    gx0 = Math.max(gx0, s.lr);
    gx1 = Math.min(gx1, s.rl);
  }
  if (gx1 - gx0 < 4) return null;
  return { x0: gx0, x1: gx1 };
}

// ---------------------------------------------------------------------------
// Stream -> blocks
// ---------------------------------------------------------------------------

interface StreamCtx {
  /** Measured ink edges of the stream (for alignment heuristics). */
  left: number;
  right: number;
  /** Word's text-area edges for this stream (indents are relative to them). */
  refLeft: number;
  refRight: number;
  /** Centre of the page or column, for titles centred on the page rather than on the text. */
  mid: number;
  body: number;
  justified: boolean;
  rules: Box[];
  /** Document default font (for line heights of text without a known font). */
  font?: string;
}

function paraBlock(lines: TextLine[], ctx: StreamCtx): ParaBlock {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const fs = median(lines.map((l) => l.fontSize)) || first.fontSize;
  const bullet = bulletOf(first);
  const rest = lines.slice(1);
  const bodyX = rest.length ? Math.min(...rest.map((l) => l.x)) : bullet?.textX ?? first.x;
  const textX = bullet ? bullet.textX ?? (rest.length ? bodyX : first.x) : bodyX;
  const box: Box = {
    x0: Math.min(...lines.map((l) => l.x)),
    y0: first.y - 0.8 * first.fontSize,
    x1: Math.max(...lines.map(lineRight)),
    y1: last.y + 0.25 * last.fontSize,
  };

  const gl = (l: TextLine) => l.x - ctx.left;
  const gr = (l: TextLine) => ctx.right - lineRight(l);
  const tol = Math.max(1.5 * fs, 4);
  let align: Align = 'left';
  const nonLast = lines.slice(0, -1);
  // A two-line paragraph's first line is always the longest, so it only counts as justified in a justified stream.
  if (nonLast.length && nonLast.every((l) => gr(l) <= 0.6 * fs) && (lines.length >= 3 || ctx.justified)) align = 'justify';
  else if (
    !bullet &&
    // Centred text is clearly narrower than its column.
    lines.every((l) => lineRight(l) - l.x <= 0.85 * (ctx.right - ctx.left)) &&
    lines.every((l) => gl(l) > 1.5 * fs && gr(l) > 1.5 * fs && (Math.abs(gl(l) - gr(l)) <= tol || Math.abs((l.x + lineRight(l)) / 2 - ctx.mid) <= tol / 2)) &&
    (lines.length > 1 || gl(first) > 3 * fs)
  )
    align = 'center';
  else if (lines.every((l) => gr(l) <= fs && gl(l) > 4 * fs)) align = 'right';

  let indentLeft = 0;
  let indentRight = 0;
  let firstLine = 0;
  if (align === 'center') {
    // Word centres between the indents: shift them so the text lands where the PDF has it.
    const shift = (box.x0 + box.x1) / 2 - (ctx.refLeft + ctx.refRight) / 2;
    if (shift > 0) indentLeft = 2 * shift;
    else indentRight = -2 * shift;
  } else if (align === 'right') {
    indentRight = Math.max(0, ctx.refRight - box.x1);
  }
  if (align === 'left' || align === 'justify') {
    if (bullet) {
      indentLeft = textX - ctx.refLeft;
      firstLine = -(textX - first.x);
    } else {
      indentLeft = bodyX - ctx.refLeft;
      firstLine = first.x - bodyX;
    }
  }

  const natural = naturalOf(lines, ctx.font);
  let lineHeight = natural * fs;
  let lineSpacing: number | undefined;
  if (lines.length >= 2) {
    const pitch = median(lines.slice(1).map((l, k) => l.y - lines[k].y));
    if (pitch > natural * fs * 1.05) {
      lineSpacing = pitch;
      lineHeight = pitch;
    }
  }

  const tabs: TabStop[] = [];
  if (lines.length === 1) {
    // Cell 0 starts the paragraph; a separate bullet marker's text cell sits on the hanging indent.
    const cells = first.cells;
    for (let k = bullet?.textX !== undefined ? 2 : 1; k < cells.length; k++) {
      const c = cells[k];
      const r = cellRight(c, fs);
      if (k === cells.length - 1 && ctx.right - r <= fs && c.x - ctx.left > 0.5 * (ctx.right - ctx.left)) tabs.push({ pos: r - ctx.refLeft, right: true });
      else tabs.push({ pos: c.x - ctx.refLeft, right: false });
    }
  }

  const textLen = lines.reduce((n, l) => n + l.text.length, 0);
  const heading = lines.length <= 3 ? headingLevel(fs, ctx.body, textLen) : 0;
  return { kind: 'para', lines, box, align, indentLeft, indentRight, firstLine, lineHeight, lineSpacing, fontSize: fs, heading, bullet: !!bullet, tabs, spaceBefore: 0 };
}

function canJoin(para: TextLine[], pitch: number | undefined, l: TextLine, ctx: StreamCtx): boolean {
  const P = para[para.length - 1];
  if (!isProse(P) || !isProse(l) || bulletOf(l)) return false;
  const fs = Math.max(P.fontSize, l.fontSize);
  if (Math.abs(P.fontSize - l.fontSize) > 0.15 * fs) return false;
  if (P.bold !== l.bold) return false;
  const d = l.y - P.y;
  if (d <= 0.5 * fs || d > 1.7 * fs) return false;
  if (pitch !== undefined && Math.abs(d - pitch) > Math.max(1.5, 0.15 * pitch)) return false;
  const pr = lineRight(P);
  const lr = lineRight(l);
  const centred = Math.abs((P.x + pr) / 2 - (l.x + lr) / 2) < fs && P.x - ctx.left > 1.5 * fs && l.x - ctx.left > 1.5 * fs;
  const wrapped = ctx.right - pr < firstWordWidth(l) + 1.5 * fs;
  if (!wrapped && !centred) return false;
  if (centred) return true;
  const firstBullet = bulletOf(para[0]);
  const body = para.length >= 2 ? para[1].x : firstBullet?.textX;
  if (body !== undefined) return Math.abs(l.x - body) <= 1.2 * fs;
  const dx = P.x - l.x;
  // Same left edge, or the first line was indented.
  return Math.abs(dx) <= 1.2 * fs || (dx > 0 && dx <= 8 * fs) || (!!firstBullet && l.x > P.x);
}

function tableBlock(lines: TextLine[], ctx: StreamCtx): TableBlock {
  const fs = median(lines.map((l) => l.fontSize)) || 10;
  let cols = detectTableColumns(lines);
  const nCols = Math.max(...lines.flatMap((l) => l.cells.map((c) => (c.col ?? 0) + 1)));
  if (cols.length < nCols) {
    // Column indices can exceed the detected starts (cells never merge); fall back to per-index minimum x.
    cols = Array.from({ length: nCols }, (_, k) => Math.min(...lines.flatMap((l) => l.cells.filter((c) => c.col === k).map((c) => c.x)), Infinity));
    for (let k = 0; k < cols.length; k++) if (!Number.isFinite(cols[k])) cols[k] = k ? cols[k - 1] + 20 : lines[0].x;
  }
  let right = Math.max(...lines.map(lineRight)) + fs;
  const box: Box = {
    x0: Math.min(...lines.map((l) => l.x)),
    y0: lines[0].y - 0.8 * lines[0].fontSize,
    x1: right,
    y1: lines[lines.length - 1].y + 0.25 * lines[lines.length - 1].fontSize,
  };
  const natural = naturalOf(lines, ctx.font);
  const rowHeight = lines.length >= 2 ? median(lines.slice(1).map((l, k) => l.y - lines[k].y)) : natural * fs;
  const grown = { x0: box.x0 - 12, y0: box.y0 - 6, x1: box.x1 + 4, y1: box.y1 + 6 };
  const near = ctx.rules.filter((r) => intersects(r, grown));
  const bordered = near.length >= 2;
  if (bordered) {
    // Drawn cell borders give the real column edges: one vertical rule per boundary.
    const xs: number[] = [];
    for (const r of near.filter((r) => r.x1 - r.x0 <= 2.5 && r.y1 - r.y0 >= 6).sort((a, b) => a.x0 - b.x0)) {
      const x = (r.x0 + r.x1) / 2;
      if (!xs.length || x - xs[xs.length - 1] > 2) xs.push(x);
    }
    if (xs.length === cols.length + 1 && xs.every((x, k) => k === cols.length || x <= cols[k] + 1)) {
      cols = xs.slice(0, -1).map((x) => x + 2);
      right = xs[xs.length - 1] + 2; // widths are measured between starts, so the last one ends on the rule
    } else {
      const horizontal = near.filter((r) => r.y1 - r.y0 <= 2.5);
      if (horizontal.length) right = Math.max(right, Math.max(...horizontal.map((r) => r.x1)) - 2);
    }
    box.x1 = right;
  }
  return { kind: 'table', lines, cols, right, box, rowHeight: Math.max(rowHeight, natural * fs), fontSize: fs, bordered, spaceBefore: 0 };
}

// ---------------------------------------------------------------------------
// Ruled tables
// ---------------------------------------------------------------------------

function uniqueSorted(values: number[], tol: number): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

/**
 * Finds tables drawn with ruling lines: connected sets of horizontal and
 * vertical rules. Row and column boundaries are the distinct rule positions.
 */
export function detectRuledGrids(rules: Box[], pageWidth: number, pageHeight: number): RuledGrid[] {
  const H = rules.filter((r) => r.y1 - r.y0 <= 2.5 && r.x1 - r.x0 >= 4);
  const V = rules.filter((r) => r.x1 - r.x0 <= 2.5 && r.y1 - r.y0 >= 4);
  const all = [...H, ...V];
  if (all.length > 4000) return []; // vector artwork, not tables
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tol = 2;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.x0 <= b.x1 + tol && b.x0 <= a.x1 + tol && a.y0 <= b.y1 + tol && b.y0 <= a.y1 + tol) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Box[]>();
  all.forEach((r, i) => {
    const k = find(i);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  });
  const out: RuledGrid[] = [];
  for (const g of groups.values()) {
    const hs = g.filter((r) => H.includes(r));
    const vs = g.filter((r) => V.includes(r));
    if (hs.length < 2 || vs.length < 2) continue;
    const box = g.reduce((u, r) => ({ x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) }));
    const xs = uniqueSorted(vs.map((r) => (r.x0 + r.x1) / 2), 3);
    const ys = uniqueSorted(hs.map((r) => (r.y0 + r.y1) / 2), 3);
    if (xs.length < 2 || ys.length < 2 || box.x1 - box.x0 < 30 || box.y1 - box.y0 < 8) continue;
    // A frame around (most of) the page is decoration, not a one-cell table.
    const cells = (xs.length - 1) * (ys.length - 1);
    if (cells === 1 && (box.x1 - box.x0) * (box.y1 - box.y0) > 0.4 * pageWidth * pageHeight) continue;
    out.push({ box, xs, ys });
  }
  return out;
}

function indexIn(bounds: number[], v: number): number {
  let k = 0;
  for (let i = 0; i < bounds.length - 1; i++) if (bounds[i] <= v) k = i;
  return k;
}

const CELL_PAD = 2;

/** Cuts a text cell whose words run across column rules (narrow cell padding merges them). */
function splitAtRules(c: TextCell, xs: number[]): TextCell[] {
  const spans = c.spans;
  if (!spans || spans.length < 2) return [c];
  const groups = new Map<number, typeof spans>();
  for (const s of spans) {
    const k = indexIn(xs, s.x + 0.5);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  if (groups.size < 2) return [c];
  return [...groups.values()].map((ss) => {
    const trimmed = ss.map((s) => ({ ...s }));
    trimmed[0].text = trimmed[0].text.replace(/^\s+/, '');
    trimmed[trimmed.length - 1].text = trimmed[trimmed.length - 1].text.replace(/\s+$/, '');
    const last = trimmed[trimmed.length - 1];
    return { x: trimmed[0].x, text: trimmed.map((s) => s.text).join(''), width: last.x + last.width - trimmed[0].x, spans: trimmed.filter((s) => s.text) };
  });
}

/** A ruled table's content: every line cut at the column rules, each cell laid out as paragraphs. */
export function ruledTableBlock(grid: RuledGrid, lines: TextLine[], body: number, font?: string, shades: { box: Box; color: string }[] = []): TableBlock {
  const { xs, ys } = grid;
  const nR = ys.length - 1;
  const nC = xs.length - 1;
  const parts: TextLine[][][] = Array.from({ length: nR }, () => Array.from({ length: nC }, () => [] as TextLine[]));
  for (const l of lines) {
    const r = indexIn(ys, l.y - 0.35 * l.fontSize);
    const byCol = new Map<number, TextCell[]>();
    for (const c of l.cells.flatMap((c) => splitAtRules(c, xs))) {
      const k = indexIn(xs, c.x + 0.5);
      byCol.set(k, [...(byCol.get(k) ?? []), c]);
    }
    for (const [k, cs] of byCol) parts[r][k].push(subLine(l, cs));
  }
  const insets = parts.flatMap((row) => row.flatMap((ls, c) => ls.map((l) => l.x - xs[c]))).filter((d) => d >= 0);
  const inset = Math.min(8, median(insets) || 3);
  const cells = parts.map((row, r) =>
    row.map((ls, c) => {
      if (!ls.length) return [];
      ls.sort((a, b) => a.y - b.y || a.x - b.x);
      const left = xs[c] + inset;
      const right = xs[c + 1] - inset;
      const blocks = layoutStream(ls, [], {
        left,
        right: Math.max(right, ...ls.map(lineRight)),
        refLeft: xs[c] + CELL_PAD,
        refRight: xs[c + 1] - CELL_PAD,
        mid: (xs[c] + xs[c + 1]) / 2,
        body,
        rules: [],
        font,
      }).filter((b): b is ParaBlock => b.kind === 'para');
      assignSpacing(blocks, ys[r]);
      return blocks;
    }),
  );
  const fs = median(lines.map((l) => l.fontSize)) || body;
  const rowHeights = ys.slice(1).map((y, k) => y - ys[k]);
  const shading = ys.slice(1).map((y1, r) =>
    xs.slice(1).map((x1, c) => shades.find((s) => inside({ x0: xs[c] + 1, y0: ys[r] + 1, x1: x1 - 1, y1: y1 - 1 }, s.box, 2))?.color),
  );
  return {
    kind: 'table',
    lines,
    cols: xs.slice(0, -1).map((x) => x + CELL_PAD),
    right: xs[nC] + CELL_PAD,
    box: { ...grid.box },
    rowHeight: median(rowHeights),
    fontSize: fs,
    bordered: true,
    spaceBefore: 0,
    grid: { cells, rowHeights, shading },
  };
}

/** Builds the blocks of one column stream (lines already in reading order). */
export function layoutStream(lines: TextLine[], images: { index: number; box: Box }[], ctx: Omit<StreamCtx, 'justified'>, tables: TableBlock[] = []): Block[] {
  // Whole-stream justification: most wrapped lines end at the right edge.
  let wrappedLines = 0;
  let flush = 0;
  for (let k = 1; k < lines.length; k++) {
    const P = lines[k - 1];
    const l = lines[k];
    if (!isProse(P) || !isProse(l) || l.y - P.y > 1.7 * P.fontSize) continue;
    wrappedLines++;
    if (ctx.right - lineRight(P) <= 0.6 * P.fontSize) flush++;
  }
  const full: StreamCtx = { ...ctx, justified: wrappedLines >= 5 && flush / wrappedLines > 0.6 };

  const text: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableLine(lines[i])) {
      let j = i + 1;
      while (j < lines.length && isTableLine(lines[j])) j++;
      if (j - i >= 2) {
        text.push(tableBlock(lines.slice(i, j), full));
        i = j;
        continue;
      }
    }
    const para = [lines[i]];
    let pitch: number | undefined;
    let j = i + 1;
    while (j < lines.length && canJoin(para, pitch, lines[j], full)) {
      if (pitch === undefined) pitch = lines[j].y - para[para.length - 1].y;
      para.push(lines[j]);
      j++;
    }
    text.push(paraBlock(para, full));
    i = j;
  }

  const imgs: Block[] = images.map((im) => ({ kind: 'image', index: im.index, box: im.box, indentLeft: im.box.x0 - ctx.refLeft, spaceBefore: 0 }));
  return [...text, ...imgs, ...tables].sort((a, b) => a.box.y0 - b.box.y0);
}

// ---------------------------------------------------------------------------
// Vertical spacing (Word line-box model)
// ---------------------------------------------------------------------------

/** Top of the block's first line box as Word will lay it out. */
export function blockTop(b: Block): number {
  if (b.kind === 'para') return b.lines[0].y - b.lineHeight + DESCENT * b.lines[0].fontSize;
  if (b.kind === 'table') return b.grid ? b.box.y0 : b.lines[0].y - b.rowHeight + DESCENT * b.fontSize;
  return b.box.y0;
}

/** Bottom of the block's last line box as Word will lay it out. */
export function blockBottom(b: Block): number {
  if (b.kind === 'para') {
    const last = b.lines[b.lines.length - 1];
    return last.y + DESCENT * last.fontSize;
  }
  if (b.kind === 'table') return b.grid ? b.box.y1 : b.lines[b.lines.length - 1].y + DESCENT * b.fontSize;
  return b.box.y1 + 2;
}

function assignSpacing(blocks: Block[], start: number): number {
  let prev = start;
  for (const b of blocks) {
    b.spaceBefore = Math.max(0, blockTop(b) - prev);
    prev = Math.max(prev, blockBottom(b));
  }
  return prev;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Side = 'left' | 'right' | 'both' | 'cross';

function sideOfLine(l: TextLine, g: number): Side {
  let L = false;
  let R = false;
  for (const c of l.cells) {
    const r = cellRight(c, l.fontSize);
    if (c.x < g && r > g) return 'cross';
    if (r <= g) L = true;
    else R = true;
  }
  return L && R ? 'both' : L ? 'left' : 'right';
}

function sideOfBox(b: Box, g: number): Side {
  if (b.x1 <= g) return 'left';
  if (b.x0 >= g) return 'right';
  return 'cross';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Lays out one page. `graphics` boxes use the same coordinates as the text. */
export function layoutPage(page: PageText, graphics: PageGraphicsBoxes, body: number, font?: string): PageLayout {
  const W = page.width;
  const H = page.height;
  const allLines = page.lines.filter((l) => l.cells.length > 0);
  // Ruled tables take the lines inside them.
  const grids: TableBlock[] = [];
  const taken = new Set<TextLine>();
  for (const grid of detectRuledGrids(graphics.rules, W, H)) {
    const inside = allLines.filter((l) => {
      const mid = l.y - 0.35 * l.fontSize;
      return !taken.has(l) && mid > grid.box.y0 && mid < grid.box.y1 && l.x >= grid.box.x0 - 2 && l.x < grid.box.x1;
    });
    if (!inside.length) continue;
    inside.forEach((l) => taken.add(l));
    grids.push(ruledTableBlock(grid, inside, body, font, graphics.shades));
  }
  const lines = allLines.filter((l) => !taken.has(l));
  const pageArea = W * H;
  const imgs = graphics.images
    .map((box, index) => ({ index, box }))
    .filter(({ box }) => box.x1 - box.x0 >= 6 && box.y1 - box.y0 >= 6)
    // A page-sized picture under text is a scan or background: keep the text, not the picture.
    .filter(({ box }) => !(lines.length && (box.x1 - box.x0) * (box.y1 - box.y0) >= 0.8 * pageArea));

  const boxes = [...lines.map(lineBox), ...imgs.map((i) => i.box), ...grids.map((t) => t.box)];
  const L0 = boxes.length ? Math.min(...boxes.map((b) => b.x0)) : 72;
  const R0 = boxes.length ? Math.max(...boxes.map((b) => b.x1)) : W - 72;
  const T0 = boxes.length ? Math.min(...boxes.map((b) => b.y0)) : 72;
  const B0 = boxes.length ? Math.max(...boxes.map((b) => b.y1)) : H - 72;
  const margin = {
    left: clamp(L0, 14, W / 3),
    right: clamp(W - R0, 14, W / 3),
    top: clamp(T0 - 2, 14, 72),
    bottom: clamp(H - B0 - 2, 14, 54),
  };
  if (W - margin.left - margin.right < 72) {
    margin.left = Math.min(margin.left, 36);
    margin.right = Math.min(margin.right, 36);
  }

  splitAtSharedGaps(lines);
  const gutter = detectColumnGutter(lines, L0, R0);
  const g = gutter ? (gutter.x0 + gutter.x1) / 2 : Infinity;

  // Image placement: behind text, floating beside text, or inline in the flow.
  const floats: FloatImage[] = [];
  const inline: { index: number; box: Box; side: Side }[] = [];
  for (const im of imgs) {
    // A scan without a text layer stays a page-sized picture pinned to the page.
    if (!lines.length && !grids.length && (im.box.x1 - im.box.x0) * (im.box.y1 - im.box.y0) >= 0.5 * pageArea) {
      floats.push({ index: im.index, box: im.box, behind: false });
      continue;
    }
    const lbs = lines.map(lineBox);
    if (lbs.some((lb) => inside(lb, im.box))) {
      floats.push({ index: im.index, box: im.box, behind: true });
      continue;
    }
    const side = gutter ? sideOfBox(im.box, g) : 'cross';
    const beside = lines.some((l) => {
      const lb = lineBox(l);
      if (!overlapsY(lb, im.box)) return false;
      if (!gutter || side === 'cross') return true;
      const ls = sideOfLine(l, g);
      return ls === side || ls === 'both' || ls === 'cross';
    });
    if (beside) floats.push({ index: im.index, box: im.box, behind: false });
    else inline.push({ ...im, side });
  }

  // Walk lines and inline images top-down, cutting two-column runs out of single-column text.
  type Item = { top: number; line?: TextLine; img?: { index: number; box: Box }; table?: TableBlock; side: Side };
  // A line with text on both sides only reads as two columns when both halves are prose-width
  // (a table whose last column starts past the gutter is not two columns).
  const lineSide = (l: TextLine): Side => {
    if (!gutter) return 'cross';
    const s = sideOfLine(l, g);
    if (s !== 'both') return s;
    const fs = l.fontSize;
    const L = l.cells.filter((c) => cellRight(c, fs) <= g);
    const R = l.cells.filter((c) => cellRight(c, fs) > g);
    const lw = Math.max(...L.map((c) => cellRight(c, fs))) - Math.min(...L.map((c) => c.x));
    const rw = Math.max(...R.map((c) => cellRight(c, fs))) - Math.min(...R.map((c) => c.x));
    return lw >= 0.55 * (gutter.x0 - L0) && rw >= 0.55 * (R0 - gutter.x1) ? 'both' : 'cross';
  };
  const items: Item[] = [
    ...lines.map((l): Item => ({ top: lineBox(l).y0, line: l, side: lineSide(l) })),
    ...inline.map((im): Item => ({ top: im.box.y0, img: im, side: im.side })),
    ...grids.map((t): Item => ({ top: t.box.y0, table: t, side: gutter ? sideOfBox(t.box, g) : 'cross' })),
  ].sort((a, b) => a.top - b.top || (a.line && b.line ? a.line.x - b.line.x : 0));

  const runs: { two: boolean; items: Item[] }[] = [];
  for (const it of items) {
    const two = it.side !== 'cross';
    const last = runs[runs.length - 1];
    if (last && last.two === two) last.items.push(it);
    else runs.push({ two, items: [it] });
  }
  for (const r of runs) {
    if (!r.two) continue;
    const leftN = r.items.filter((it) => it.side === 'left' || it.side === 'both').length;
    const rightN = r.items.filter((it) => it.side === 'right' || it.side === 'both').length;
    if (leftN < 2 || rightN < 2 || r.items.length < 4) {
      r.two = false;
      continue;
    }
    // Both sides must be running text; a table whose last column sits past the gutter is not two columns.
    const widths = (side: 'left' | 'right') =>
      r.items.flatMap((it) => {
        if (!it.line) return [];
        const fs = it.line.fontSize;
        const cs = it.line.cells.filter((c) => (side === 'left' ? cellRight(c, fs) <= g : cellRight(c, fs) > g));
        return cs.length ? [Math.max(...cs.map((c) => cellRight(c, fs))) - Math.min(...cs.map((c) => c.x))] : [];
      });
    if (median(widths('left')) < 0.55 * (gutter!.x0 - L0) || median(widths('right')) < 0.55 * (R0 - gutter!.x1)) r.two = false;
  }
  // Lines above the first right-column line (a section heading) span the page.
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (!r.two) continue;
    const firstRight = r.items.findIndex((it) => it.side === 'right' || it.side === 'both');
    const cut = r.items.findIndex((it) => it.top >= r.items[firstRight].top - 2);
    if (cut > 0) {
      runs.splice(k, 0, { two: false, items: r.items.slice(0, cut) });
      r.items = r.items.slice(cut);
      k++;
    }
  }
  const merged: typeof runs = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.two === r.two && !r.two) last.items.push(...r.items);
    else merged.push({ two: r.two, items: [...r.items] });
  }

  const segments: Segment[] = [];
  let cursor = margin.top;
  const textWidth = W - margin.left - margin.right;
  for (const r of merged) {
    if (!r.two) {
      const ls = r.items.filter((it) => it.line).map((it) => subLine(it.line!, it.line!.cells));
      assignTables(ls);
      const blocks = layoutStream(ls, r.items.filter((it) => it.img).map((it) => it.img!), {
        left: L0,
        right: R0,
        refLeft: margin.left,
        refRight: W - margin.right,
        mid: W / 2,
        body,
        rules: graphics.rules,
        font,
      }, r.items.filter((it) => it.table).map((it) => it.table!));
      cursor = assignSpacing(blocks, cursor);
      segments.push({ columns: 1, gap: 0, streams: [blocks] });
      continue;
    }
    const gap = Math.max(6, gutter!.x1 - gutter!.x0);
    const colW = (textWidth - gap) / 2;
    const leftLines: TextLine[] = [];
    const rightLines: TextLine[] = [];
    const leftImgs: { index: number; box: Box }[] = [];
    const rightImgs: { index: number; box: Box }[] = [];
    const leftTables: TableBlock[] = [];
    const rightTables: TableBlock[] = [];
    for (const it of r.items) {
      if (it.img) (it.side === 'right' ? rightImgs : leftImgs).push(it.img);
      if (it.table) (it.side === 'right' ? rightTables : leftTables).push(it.table);
      if (!it.line) continue;
      const fs = it.line.fontSize;
      const Lc = it.line.cells.filter((c) => cellRight(c, fs) <= g);
      const Rc = it.line.cells.filter((c) => cellRight(c, fs) > g);
      if (Lc.length) leftLines.push(subLine(it.line, Lc));
      if (Rc.length) rightLines.push(subLine(it.line, Rc));
    }
    const byY = (a: TextLine, b: TextLine) => a.y - b.y || a.x - b.x;
    leftLines.sort(byY);
    rightLines.sort(byY);
    assignTables(leftLines);
    assignTables(rightLines);
    const leftEdge = leftLines.length ? Math.min(...leftLines.map((l) => l.x)) : L0;
    const rightEdge = rightLines.length ? Math.max(...rightLines.map(lineRight)) : R0;
    const lRef = margin.left;
    const rRef = margin.left + colW + gap;
    const leftBlocks = layoutStream(leftLines, leftImgs, { left: leftEdge, right: gutter!.x0, refLeft: lRef, refRight: lRef + colW, mid: (leftEdge + gutter!.x0) / 2, body, rules: graphics.rules, font }, leftTables);
    const rightBlocks = layoutStream(rightLines, rightImgs, { left: gutter!.x1, right: rightEdge, refLeft: rRef, refRight: rRef + colW, mid: (gutter!.x1 + rightEdge) / 2, body, rules: graphics.rules, font }, rightTables);
    const endL = assignSpacing(leftBlocks, cursor);
    const endR = assignSpacing(rightBlocks, cursor);
    cursor = Math.max(endL, endR);
    segments.push({ columns: 2, gap, streams: [leftBlocks, rightBlocks] });
  }

  // Paragraphs on a solid background keep it as paragraph shading.
  for (const s of graphics.shades ?? [])
    for (const b of segments.flatMap((sg) => sg.streams.flat())) {
      if (b.kind === 'para' && inside(b.box, s.box, 2)) b.shading = s.color;
      if (b.kind === 'table' && !b.grid && inside(b.box, s.box, 4)) b.shading = s.color;
    }

  // Fonts that Word substitutes are often taller; if the page would overflow, shrink the gaps.
  const limit = H - margin.bottom;
  if (cursor > limit) {
    const spaces = segments.flatMap((s) => s.streams.flat()).reduce((n, b) => n + b.spaceBefore, 0);
    const factor = spaces > 0 ? clamp(1 - (cursor - limit) / spaces, 0, 1) : 1;
    for (const s of segments) for (const b of s.streams.flat()) b.spaceBefore *= factor;
  }

  return { width: W, height: H, margin, segments, floats, contentBottom: cursor };
}

// ---------------------------------------------------------------------------
// Running headers and footers
// ---------------------------------------------------------------------------

export interface RunningLines {
  /** Lines to move out of the page body (page numbers, running titles). */
  running: Set<TextLine>;
  /** Header / footer lines to use, taken from the first page that has them, with that page number. */
  header?: { lines: TextLine[]; pageNumber: number; width: number; height: number };
  footer?: { lines: TextLine[]; pageNumber: number; width: number; height: number };
}

const normalizeRunning = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Lines repeated in the top or bottom band of most pages (same text once
 * digits are ignored, about the same place) are headers and footers.
 */
export function detectRunningLines(pages: PageText[]): RunningLines {
  const out: RunningLines = { running: new Set() };
  if (pages.length < 2) return out;
  const zoneOf = (p: PageText, l: TextLine): 'top' | 'bottom' | null => (l.y - l.fontSize < 0.1 * p.height ? 'top' : l.y > 0.9 * p.height ? 'bottom' : null);
  const counts = new Map<string, number>();
  const keyOf = (l: TextLine, z: string) => `${z}|${normalizeRunning(l.text)}|${Math.round(l.x / 24)}`;
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.lines) {
      const z = zoneOf(p, l);
      if (!z || !l.text.trim()) continue;
      const k = keyOf(l, z);
      if (!seen.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
      seen.add(k);
    }
  }
  const need = Math.max(2, Math.ceil(0.5 * pages.length));
  for (const p of pages) {
    const picked: Record<'top' | 'bottom', TextLine[]> = { top: [], bottom: [] };
    for (const l of p.lines) {
      const z = zoneOf(p, l);
      if (!z || (counts.get(keyOf(l, z)) ?? 0) < need) continue;
      out.running.add(l);
      picked[z].push(l);
    }
    if (!out.header && picked.top.length) out.header = { lines: picked.top, pageNumber: p.pageNumber, width: p.width, height: p.height };
    if (!out.footer && picked.bottom.length) out.footer = { lines: picked.bottom, pageNumber: p.pageNumber, width: p.width, height: p.height };
  }
  return out;
}
