/**
 * Turns the current text selection (in pdf.js text layers) into markup
 * annotations: highlight, underline, strikeout, squiggly. Line boxes are
 * converted to page display coordinates and merged per line.
 */
import type { MarkupKind } from '@/types';
import { usePDFStore } from '@/store/usePDFStore';
import { makeMarkup } from './objectFactory';
import { getAuthor } from './author';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Merges fragments that sit on the same line and touch horizontally. */
export function mergeLineBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].filter((b) => b.width > 0.5 && b.height > 0.5).sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Box[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.y + last.height / 2 - (b.y + b.height / 2)) < Math.min(last.height, b.height) * 0.5;
    if (sameLine && b.x <= last.x + last.width + Math.max(3, b.height * 0.6)) {
      const x = Math.min(last.x, b.x);
      const y = Math.min(last.y, b.y);
      last.width = Math.max(last.x + last.width, b.x + b.width) - x;
      last.height = Math.max(last.y + last.height, b.y + b.height) - y;
      last.x = x;
      last.y = y;
    } else out.push({ ...b });
  }
  return out;
}

/** Selection inside text layers, grouped by page, in page display points. */
export function selectionByPage(): Array<{ pageId: string; boxes: Box[]; text: string }> {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (!anchor?.closest('.textLayer') && !anchor?.querySelector('.textLayer')) return [];
  const zoom = usePDFStore.getState().zoom;
  const rects = [...range.getClientRects()];
  const out: Array<{ pageId: string; boxes: Box[]; text: string }> = [];
  for (const pageEl of document.querySelectorAll<HTMLElement>('[data-page-id]')) {
    const pr = pageEl.getBoundingClientRect();
    const boxes: Box[] = [];
    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
      boxes.push({ x: (r.left - pr.left) / zoom, y: (r.top - pr.top) / zoom, width: r.width / zoom, height: r.height / zoom });
    }
    const merged = mergeLineBoxes(boxes);
    if (merged.length) out.push({ pageId: pageEl.dataset.pageId!, boxes: merged, text: sel.toString().replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** Creates markup for the current selection; returns how many pages got markup. */
export function applyMarkupToSelection(kind: MarkupKind): number {
  const store = usePDFStore.getState();
  if (store.readOnlyReason) {
    store.toast(store.readOnlyReason, 'error');
    return 0;
  }
  const groups = selectionByPage();
  if (groups.length === 0) return 0;
  const author = getAuthor();
  for (const g of groups) store.addObject(makeMarkup(g.pageId, kind, g.boxes, g.text, author), false);
  window.getSelection()?.removeAllRanges();
  return groups.length;
}
