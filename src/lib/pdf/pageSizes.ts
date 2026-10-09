/**
 * Page sizes of large documents, read lazily. pdf.js has no bulk API for
 * page boxes, and `getPage` for each of 5,000 pages before the first one is
 * shown takes seconds; so a large document opens with the first pages read
 * and the rest estimated (the first page's size), then corrected in batches
 * in the background. Pure: no pdf.js import (the benchmark runs it in Node).
 */
import type { Rotation } from '@/types';
import { normalizeRotation } from '@/lib/geometry';

/** Documents with more pages than this mount only the pages (and thumbnails) near the view. */
export const VIRTUAL_MIN_PAGES = 60;
/** Documents with more pages than this open with estimated sizes. */
export const LAZY_MIN_PAGES = 60;
/** Pages read before the document is shown (the first screenful). */
export const FIRST_PAGES = 3;
/** getPage calls in flight at once while reading the rest. */
export const SIZE_BATCH = 200;

export interface PageSize {
  index: number;
  /** Unrotated size in points (the view box: CropBox within MediaBox). */
  width: number;
  height: number;
  rotation: Rotation;
}

interface PageLike {
  view: number[];
  rotate: number;
}

interface DocLike {
  numPages: number;
  getPage: (n: number) => Promise<PageLike>;
}

export function sizeOfPage(index: number, p: PageLike): PageSize {
  const [x0, y0, x1, y1] = p.view;
  return { index, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), rotation: normalizeRotation(p.rotate) };
}

/** Pages read before the document is shown: all of a small one, the first few of a large one. */
export function firstPagesToRead(count: number): number[] {
  const n = count > LAZY_MIN_PAGES ? Math.min(count, FIRST_PAGES) : count;
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Reads the sizes of `indices` (0-based), SIZE_BATCH pages at a time, handing
 * each batch to `onBatch`. Yields between batches so the window stays
 * responsive. A page that cannot be read rejects (the caller decides).
 */
export async function loadPageSizes(
  doc: DocLike,
  indices: number[],
  onBatch: (sizes: PageSize[]) => void,
  opts: { batch?: number; cancelled?: () => boolean; yieldEvery?: boolean } = {},
): Promise<void> {
  const batch = opts.batch ?? SIZE_BATCH;
  for (let i = 0; i < indices.length; i += batch) {
    if (opts.cancelled?.()) return;
    const part = indices.slice(i, i + batch);
    const pages = await Promise.all(part.map((n) => doc.getPage(n + 1)));
    onBatch(pages.map((p, k) => sizeOfPage(part[k], p)));
    if (opts.yieldEvery !== false && i + batch < indices.length) await new Promise((r) => setTimeout(r, 0));
  }
}

/** The order the rest is read in: from `near` outwards (the pages around the view first). */
export function readingOrder(count: number, known: (i: number) => boolean, near = 0): number[] {
  const out: number[] = [];
  for (let d = 0; out.length < count && (near - d >= 0 || near + d < count); d++) {
    const a = near + d;
    const b = near - d;
    if (a < count && !known(a)) out.push(a);
    if (d > 0 && b >= 0 && !known(b)) out.push(b);
  }
  return out;
}

export interface Band {
  top: number;
  height: number;
}

/**
 * Keeps the view on the same content when the layout above it changes
 * (estimated page heights replaced by real ones): the row under `scrollTop`
 * keeps the same relative offset. `before` and `after` are the rows' bands
 * (same rows, same order). Returns the new scrollTop.
 */
export function anchoredScrollTop(before: Band[], after: Band[], scrollTop: number): number {
  if (!before.length || before.length !== after.length) return scrollTop;
  const i = rowAt(before, scrollTop);
  const b = before[i];
  const a = after[i];
  const within = b.height > 0 ? Math.min(1, Math.max(0, (scrollTop - b.top) / b.height)) : 0;
  // Above the first row (padding) or in the gap below a row: keep the pixel offset.
  if (scrollTop < b.top) return Math.max(0, a.top - (b.top - scrollTop));
  if (scrollTop > b.top + b.height) return a.top + a.height + (scrollTop - b.top - b.height);
  return a.top + within * a.height;
}

/** Index of the last row starting at or above `y` (binary search; 0 when above all). */
export function rowAt(rows: Band[], y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Rows to mount for a scroll position: those overlapping the viewport widened
 * by `overscan` viewport heights above and below. Returns [first, last]
 * (inclusive), or [0, -1] with no rows.
 */
export function visibleRows(rows: Band[], scrollTop: number, viewportHeight: number, overscan = 1): [number, number] {
  if (!rows.length) return [0, -1];
  const from = scrollTop - viewportHeight * overscan;
  const to = scrollTop + viewportHeight * (1 + overscan);
  let first = rowAt(rows, from);
  if (rows[first].top + rows[first].height < from && first < rows.length - 1) first++;
  let last = rowAt(rows, to);
  if (last < first) last = first;
  return [first, last];
}
