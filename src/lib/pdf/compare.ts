/**
 * "Compare files": finds the words inserted into and deleted from a PDF
 * between two versions and writes a report PDF, like Acrobat's Compare:
 *  - a summary page first (file names, counts, changed pages, legend),
 *  - the new document's pages, with a green /Highlight over inserted or
 *    changed words ("Inserted: …") and a red sticky note (/Text) where text
 *    was removed ("Deleted: …").
 * The word sequences of the whole documents are diffed (not page by page), so
 * text that reflows onto another page is not reported as changed.
 *
 * Both pdf.js documents come from the caller (browser build in the app, the
 * legacy build in node tests); nothing here touches the DOM.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { MarkupObject, NoteObject } from '@/types';
import type { Matrix } from '@/lib/geometry';
import { writeMarkup, writeNote } from './annotations';

export type LoadFont = (v: { family: 'sans' | 'serif' | 'mono'; bold: boolean; italic: boolean }) => Promise<Uint8Array>;

export interface CompareResult {
  bytes: Uint8Array;
  /** Words present only in the new document. */
  inserted: number;
  /** Words present only in the old document. */
  deleted: number;
  /** 1-based page numbers of the new document (before the summary page was added). */
  changedPages: number[];
  pageCountOld: number;
  pageCountNew: number;
}

export interface DiffOp {
  op: 'equal' | 'insert' | 'delete';
  /** Half-open index range in `a` (empty for inserts). */
  a: [number, number];
  /** Half-open index range in `b` (empty for deletes). */
  b: [number, number];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A word on a page, in top-left viewport coordinates (scale 1, page rotation applied). */
export interface PageWord {
  text: string;
  /** Comparison key (normalised text). */
  key: string;
  /** 0-based page index. */
  page: number;
  rect: Rect;
}

const INSERT_COLOR = '#5fd35f';
const DELETE_COLOR = '#e53935';
const AUTHOR = 'Compare';
const MAX_CONTENTS = 1000;

// ------------------------------------------------------------------ word extraction

/** Comparison key: compatibility-normalised (ligatures, full-width forms), typographic quotes and dashes unified. */
function wordKey(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-');
}

function bounds(pts: Array<[number, number]>): Rect {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Words of one page. Each text item is split at whitespace and each word's
 * extent is estimated proportionally to its character offsets within the item.
 * An item that continues a word of the previous item (split by kerning or a
 * font change, no gap) is merged into that word.
 */
export async function pageWords(page: PDFPageProxy, pageIndex: number): Promise<PageWord[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words: PageWord[] = [];
  // End point (user space) and size of the previous item, for merging split words.
  let prev: { x: number; y: number; size: number; open: boolean } | null = null;
  for (const raw of content.items) {
    if (!('str' in raw)) continue;
    const it = raw as TextItem;
    if (!it.str) {
      if (it.hasEOL) prev = null;
      continue;
    }
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    const along = Math.hypot(a, b) || 1;
    const dir: [number, number] = [a / along, b / along];
    const up: [number, number] = [-dir[1], dir[0]];
    const n = it.str.length;
    const point = (u: number, v: number): [number, number] => {
      const p = vp.convertToViewportPoint(e + dir[0] * u + up[0] * v, f + dir[1] * u + up[1] * v);
      return [p[0], p[1]];
    };
    const rectOf = (from: number, to: number): Rect => {
      const u0 = (it.width * from) / n;
      const u1 = (it.width * to) / n;
      return bounds([point(u0, -size * 0.22), point(u1, -size * 0.22), point(u0, size * 0.9), point(u1, size * 0.9)]);
    };
    const continues =
      prev !== null &&
      prev.open &&
      !/^\s/.test(it.str) &&
      Math.abs((e - prev.x) * dir[0] + (f - prev.y) * dir[1]) < prev.size * 0.2 &&
      Math.abs((e - prev.x) * up[0] + (f - prev.y) * up[1]) < prev.size * 0.3;
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    let first = true;
    while ((m = re.exec(it.str))) {
      const rect = rectOf(m.index, m.index + m[0].length);
      const last = words[words.length - 1];
      if (first && continues && m.index === 0 && last) {
        last.text += m[0];
        last.key = wordKey(last.text);
        last.rect = union(last.rect, rect);
      } else {
        words.push({ text: m[0], key: wordKey(m[0]), page: pageIndex, rect });
      }
      first = false;
    }
    prev = it.hasEOL ? null : { x: e + dir[0] * it.width, y: f + dir[1] * it.width, size, open: !/\s$/.test(it.str) };
  }
  return words;
}

export async function documentWords(doc: PDFDocumentProxy): Promise<PageWord[]> {
  const out: PageWord[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    for (const w of await pageWords(page, i)) out.push(w);
  }
  return out;
}

// ------------------------------------------------------------------ diff

/** Work budget for one Myers run: (N + M) × D steps. */
const MYERS_BUDGET = 40_000_000;
/** Largest edit distance Myers may explore (its trace is O(D²) memory). */
const MYERS_MAX_D = 4000;

type Emit = (op: DiffOp['op'], a0: number, a1: number, b0: number, b1: number) => void;

/**
 * Myers' O((N+M)·D) diff on a[aLo..aHi) vs b[bLo..bHi). Returns false (and
 * emits nothing) when the edit distance exceeds `maxD`.
 */
function myers(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, maxD: number, emit: Emit): boolean {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const off = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  // trace[d] holds V[k] for k = -d..d after step d.
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        found = d;
        break outer;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return false;
  // Backtrack from (n, m) into single steps, then emit them in order.
  const steps: Array<[DiffOp['op'], number, number, number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    const mx = down ? px : px + 1;
    const my = down ? py + 1 : py;
    if (x > mx) steps.push(['equal', mx, x, my, y]);
    if (down) steps.push(['insert', px, px, py, py + 1]);
    else steps.push(['delete', px, px + 1, py, py]);
    x = px;
    y = py;
  }
  if (x > 0) steps.push(['equal', 0, x, 0, y]);
  for (let i = steps.length - 1; i >= 0; i--) {
    const [op, a0, a1, b0, b1] = steps[i];
    emit(op, aLo + a0, aLo + a1, bLo + b0, bLo + b1);
  }
  return true;
}

/**
 * Anchors for long inputs (patience diff): tokens occurring exactly once in
 * both ranges, reduced to their longest increasing subsequence.
 */
function uniqueAnchors(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number): Array<[number, number]> {
  const count = new Map<number, [number, number, number]>(); // token → [countA, countB, indexA]
  for (let i = aLo; i < aHi; i++) {
    const c = count.get(a[i]);
    if (c) c[0]++;
    else count.set(a[i], [1, 0, i]);
  }
  const pairs: Array<[number, number]> = [];
  const bIndex = new Map<number, number>();
  for (let j = bLo; j < bHi; j++) {
    const c = count.get(b[j]);
    if (!c) continue;
    c[1]++;
    bIndex.set(b[j], j);
  }
  for (const [tok, c] of count) {
    if (c[0] === 1 && c[1] === 1) pairs.push([c[2], bIndex.get(tok)!]);
  }
  pairs.sort((p, q) => p[0] - q[0]);
  // Longest increasing subsequence on the b indices (patience sorting).
  const tails: number[] = [];
  const back = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: Array<[number, number]> = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = back[i]) out.push(pairs[i]);
  return out.reverse();
}

function diffRange(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, emit: Emit): void {
  // Common prefix and suffix cost nothing to find and shrink the problem.
  let p = 0;
  while (aLo + p < aHi && bLo + p < bHi && a[aLo + p] === b[bLo + p]) p++;
  if (p) emit('equal', aLo, aLo + p, bLo, bLo + p);
  aLo += p;
  bLo += p;
  let s = 0;
  while (aHi - s > aLo && bHi - s > bLo && a[aHi - s - 1] === b[bHi - s - 1]) s++;
  const aEnd = aHi - s;
  const bEnd = bHi - s;
  const n = aEnd - aLo;
  const m = bEnd - bLo;
  if (n === 0 || m === 0) {
    if (n) emit('delete', aLo, aEnd, bLo, bLo);
    if (m) emit('insert', aLo, aLo, bLo, bEnd);
  } else {
    const maxD = Math.min(n + m, MYERS_MAX_D, Math.floor(MYERS_BUDGET / (n + m)));
    if (!myers(a, aLo, aEnd, b, bLo, bEnd, maxD, emit)) {
      // Too many edits for Myers: split at unique common words and diff the gaps.
      const anchors = uniqueAnchors(a, aLo, aEnd, b, bLo, bEnd);
      if (!anchors.length) {
        emit('delete', aLo, aEnd, bLo, bLo);
        emit('insert', aEnd, aEnd, bLo, bEnd);
      } else {
        let ai = aLo;
        let bi = bLo;
        for (const [x, y] of anchors) {
          diffRange(a, ai, x, b, bi, y, emit);
          emit('equal', x, x + 1, y, y + 1);
          ai = x + 1;
          bi = y + 1;
        }
        diffRange(a, ai, aEnd, b, bi, bEnd, emit);
      }
    }
  }
  if (s) emit('equal', aEnd, aHi, bEnd, bHi);
}

/**
 * Word-level diff of two sequences. Adjacent operations of the same kind are
 * merged, and each change between two equal runs is reported as one delete
 * followed by one insert.
 */
export function diffWords(a: string[], b: string[]): DiffOp[] {
  const ids = new Map<string, number>();
  const tok = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const ta = Int32Array.from(a, tok);
  const tb = Int32Array.from(b, tok);
  const out: DiffOp[] = [];
  // Pending change since the last equal run.
  let del: [number, number] | null = null;
  let ins: [number, number] | null = null;
  // Position in a/b where the pending change starts.
  let pendingA = 0;
  let pendingB = 0;
  const flush = () => {
    const aEnd = del ? del[1] : pendingA;
    if (del) out.push({ op: 'delete', a: del, b: [pendingB, pendingB] });
    if (ins) out.push({ op: 'insert', a: [aEnd, aEnd], b: ins });
    del = null;
    ins = null;
  };
  const emit: Emit = (op, a0, a1, b0, b1) => {
    if (op === 'equal') {
      if (a1 <= a0) return;
      flush();
      const last = out[out.length - 1];
      if (last && last.op === 'equal' && last.a[1] === a0 && last.b[1] === b0) {
        last.a[1] = a1;
        last.b[1] = b1;
      } else {
        out.push({ op, a: [a0, a1], b: [b0, b1] });
      }
      pendingA = a1;
      pendingB = b1;
    } else if (op === 'delete') {
      if (a1 <= a0) return;
      del = del ? [del[0], a1] : [a0, a1];
    } else {
      if (b1 <= b0) return;
      ins = ins ? [ins[0], b1] : [b0, b1];
    }
  };
  diffRange(ta, 0, ta.length, tb, 0, tb.length, emit);
  flush();
  return out;
}

// ------------------------------------------------------------------ annotations

/** Inverse of an affine matrix. */
function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Merges word boxes that sit on the same line and touch (within a gap) into line boxes. */
function lineQuads(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last.y + last.height, r.y + r.height) - Math.max(last.y, r.y);
      const gap = r.x - (last.x + last.width);
      if (overlap > 0.5 * Math.min(last.height, r.height) && gap < Math.max(last.height, r.height) * 1.5 && gap > -last.height) {
        out[out.length - 1] = union(last, r);
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

function clip(s: string): string {
  return s.length > MAX_CONTENTS ? `${s.slice(0, MAX_CONTENTS - 1)}…` : s;
}

function joinWords(words: PageWord[]): string {
  return words.map((w) => w.text).join(' ');
}

// ------------------------------------------------------------------ summary page

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** "1–3, 5, 7–8" */
function pageRanges(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? `${pages[i]}–${pages[j]}` : String(pages[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

function drawSummary(page: PDFPage, fonts: { regular: PDFFont; bold: PDFFont }, r: Omit<CompareResult, 'bytes'>, oldName: string, newName: string): void {
  const { width, height } = page.getSize();
  const left = 56;
  const colW = width - 2 * left;
  let y = height - 72;
  const dark = rgb(0.13, 0.13, 0.13);
  const grey = rgb(0.4, 0.4, 0.4);
  const line = (s: string, size: number, font: PDFFont, color = dark, indent = 0, gapAfter = 4) => {
    for (const l of wrap(s, font, size, colW - indent)) {
      page.drawText(l, { x: left + indent, y, size, font, color });
      y -= size * 1.3;
    }
    y -= gapAfter;
  };
  line('Comparison', 24, fonts.bold, dark, 0, 10);
  line(`Old: ${oldName}`, 11, fonts.regular, dark, 0, 0);
  line(`New: ${newName}`, 11, fonts.regular, dark, 0, 0);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  line(`Compared on ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`, 9, fonts.regular, grey, 0, 16);

  line('Results', 14, fonts.bold, dark, 0, 4);
  const total = r.inserted + r.deleted;
  if (!total && r.pageCountOld === r.pageCountNew) {
    line('No differences in the text were found.', 11, fonts.regular);
  } else {
    line(`Inserted words: ${r.inserted}`, 11, fonts.regular, dark, 0, 0);
    line(`Deleted words: ${r.deleted}`, 11, fonts.regular, dark, 0, 0);
  }
  line(`Pages: ${r.pageCountOld} in the old file, ${r.pageCountNew} in the new file`, 11, fonts.regular, dark, 0, 0);
  if (r.changedPages.length) {
    line(`Changed pages (new file): ${pageRanges(r.changedPages)}`, 11, fonts.regular, dark, 0, 0);
    line(`In this report the new file starts on page 2, so its page N is report page N + 1.`, 9, fonts.regular, grey, 0, 0);
  }
  y -= 16;

  line('Legend', 14, fonts.bold, dark, 0, 6);
  const [ir, ig, ib] = [0x5f / 255, 0xd3 / 255, 0x5f / 255];
  page.drawRectangle({ x: left, y: y - 3, width: 28, height: 13, color: rgb(ir, ig, ib), opacity: 0.45 });
  page.drawText('Inserted or changed text (highlight; its comment shows the old text of a change)', { x: left + 38, y, size: 10, font: fonts.regular, color: dark });
  y -= 22;
  page.drawRectangle({ x: left + 7, y: y - 3, width: 14, height: 13, color: rgb(0.9, 0.22, 0.21), borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.6 });
  page.drawText('Deleted text (note placed where the text was removed)', { x: left + 38, y, size: 10, font: fonts.regular, color: dark });
  y -= 30;
  line('Only the text is compared; changes to images, graphics, colours or fonts are not reported.', 9, fonts.regular, grey);
}

// ------------------------------------------------------------------ main

export async function comparePdfs(
  oldDoc: PDFDocumentProxy,
  oldBytes: Uint8Array,
  newDoc: PDFDocumentProxy,
  newBytes: Uint8Array,
  loadFont: LoadFont,
  opts: { oldName?: string; newName?: string } = {},
): Promise<CompareResult> {
  const newWords = await documentWords(newDoc);
  // Byte-identical files: no need to read the old one again.
  const same = oldBytes.length === newBytes.length && oldBytes.every((v, i) => v === newBytes[i]);
  const oldWords = same ? newWords : await documentWords(oldDoc);
  const ops = diffWords(
    oldWords.map((w) => w.key),
    newWords.map((w) => w.key),
  );

  const out = await PDFDocument.load(newBytes, { updateMetadata: false });
  out.registerFontkit(fontkit);
  const pages = out.getPages();
  const toPdf: Matrix[] = [];
  const pageSize: Array<{ width: number; height: number }> = [];
  for (let i = 0; i < newDoc.numPages; i++) {
    const vp = (await newDoc.getPage(i + 1)).getViewport({ scale: 1 });
    toPdf.push(invert(vp.transform as Matrix));
    pageSize.push({ width: vp.width, height: vp.height });
  }
  const now = new Date().toISOString();
  const changed = new Set<number>();
  let inserted = 0;
  let deleted = 0;
  let serial = 0;

  const highlight = (words: PageWord[], contents: string) => {
    const pageIndex = words[0].page;
    const page = pages[pageIndex];
    if (!page) return;
    const o: MarkupObject = {
      id: `compare-${++serial}`,
      pageId: '',
      type: 'markup',
      kind: 'highlight',
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      width: 0,
      height: 0,
      quads: lineQuads(words.map((w) => w.rect)),
      color: INSERT_COLOR,
      selectedText: joinWords(words),
      text: clip(contents),
      author: AUTHOR,
      createdAt: now,
      modifiedAt: now,
    };
    writeMarkup(out, page, toPdf[pageIndex], o);
    changed.add(pageIndex + 1);
  };

  const deletionNote = (pageIndex: number, x: number, top: number, contents: string) => {
    const page = pages[pageIndex];
    if (!page) return;
    const { width, height } = pageSize[pageIndex];
    const o: NoteObject = {
      id: `compare-${++serial}`,
      pageId: '',
      type: 'note',
      x: Math.max(0, Math.min(width - 20, x - 4)),
      y: Math.max(0, Math.min(height - 20, top - 18)),
      rotation: 0,
      opacity: 1,
      width: 20,
      height: 20,
      text: clip(contents),
      color: DELETE_COLOR,
      author: AUTHOR,
      createdAt: now,
      modifiedAt: now,
    };
    writeNote(out, page, toPdf[pageIndex], o);
    changed.add(pageIndex + 1);
  };

  /** Where text removed before new word `j` goes: after the previous word, or before the next one. */
  const anchorAt = (j: number, oldPage: number): { page: number; x: number; top: number } => {
    const before = j > 0 ? newWords[j - 1] : undefined;
    const after = j < newWords.length ? newWords[j] : undefined;
    // Prefer the neighbour on the page the text was deleted from (e.g. a removed last line).
    const useAfter = after && (!before || (before.page !== after.page && after.page === oldPage));
    if (useAfter) return { page: after.page, x: after.rect.x, top: after.rect.y };
    if (before) return { page: before.page, x: before.rect.x + before.rect.width, top: before.rect.y };
    return { page: 0, x: 36, top: 36 };
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'equal') continue;
    const next = ops[i + 1];
    const delRange = op.op === 'delete' ? op.a : null;
    const insRange = op.op === 'insert' ? op.b : next && next.op === 'insert' && op.op === 'delete' ? next.b : null;
    if (op.op === 'delete' && insRange) i++;
    const delWords = delRange ? oldWords.slice(delRange[0], delRange[1]) : [];
    const insWords = insRange ? newWords.slice(insRange[0], insRange[1]) : [];
    deleted += delWords.length;
    inserted += insWords.length;
    if (insWords.length) {
      // One highlight per page the inserted run touches.
      let start = 0;
      for (let k = 1; k <= insWords.length; k++) {
        if (k < insWords.length && insWords[k].page === insWords[start].page) continue;
        const group = insWords.slice(start, k);
        const contents = `Inserted: ${joinWords(group)}` + (start === 0 && delWords.length ? `\nDeleted: ${joinWords(delWords)}` : '');
        highlight(group, contents);
        start = k;
      }
    } else if (delWords.length) {
      const at = anchorAt(op.b[0], delWords[0].page);
      deletionNote(at.page, at.x, at.top, `Deleted: ${joinWords(delWords)}`);
    }
  }

  const result: Omit<CompareResult, 'bytes'> = {
    inserted,
    deleted,
    changedPages: [...changed].sort((p, q) => p - q),
    pageCountOld: oldDoc.numPages,
    pageCountNew: newDoc.numPages,
  };
  const [regular, bold] = await Promise.all([
    loadFont({ family: 'sans', bold: false, italic: false }),
    loadFont({ family: 'sans', bold: true, italic: false }),
  ]);
  const fonts = {
    regular: await out.embedFont(regular, { subset: false }),
    bold: await out.embedFont(bold, { subset: false }),
  };
  const summary = out.insertPage(0, [595.28, 841.89]);
  drawSummary(summary, fonts, result, opts.oldName ?? 'Old document', opts.newName ?? 'New document');
  return { bytes: await out.save(), ...result };
}
