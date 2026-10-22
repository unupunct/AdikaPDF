/**
 * Drag and drop routing (pure): what a drop of files does on each target,
 * and the action name the drop overlay shows while dragging.
 *
 * Targets: `app` (anywhere else in the window), `thumbs` (between page
 * thumbnails, `index` = the page the drop goes before), `page` (a page in
 * the viewer: pages go after it, pictures are placed at the point), `tab`
 * (a document tab: hovering switches to it), `list` (a dialog's file list)
 * and `dialog` (a dialog without a list: nothing is dropped there).
 */
import type { FileKind } from './fileKinds';

export type DropTarget =
  | { kind: 'app' }
  | { kind: 'thumbs'; index: number }
  | { kind: 'page'; pageIndex: number; pageId: string; x: number; y: number; onPage: boolean }
  | { kind: 'tab'; tabId: string }
  | { kind: 'list'; list: string }
  | { kind: 'dialog' };

/** A dropped item as far as routing is concerned. */
export interface DropEntry {
  kind: FileKind | 'folder';
}

export interface DropDoc {
  hasDoc: boolean;
  /** blockedReason(…, 'pages'): pages cannot be inserted. */
  pagesBlocked: string | null;
  /** blockedReason(…, 'content'): pictures cannot be placed. */
  contentBlocked: string | null;
}

export interface DropPlan {
  pdfs: number[];
  /** Office and other files converted to PDF first. */
  convert: number[];
  images: number[];
  einvoices: number[];
  folders: number[];
  unsupported: number[];
  /** Where pages would be inserted; null: PDFs open in new tabs. */
  insertAt: number | null;
  /** Ask "Insert pages here" / "Open in new tab" after the drop. */
  ask: boolean;
  /** Pictures placed on this page at this point (else they become pages). */
  place: { pageId: string; x: number; y: number } | null;
  /** Why the drop does less than it would elsewhere (a protected or read-only document). */
  note: string | null;
  /** Nothing can be done with this drop here. */
  rejected: string | null;
}

export const NOT_IN_DIALOG = 'Close the dialog first, or drop the files onto its file list.';
export const NOTHING_SUPPORTED = 'Adika cannot open these files.';

const indexes = (items: DropEntry[], ...kinds: Array<DropEntry['kind']>) => items.flatMap((it, i) => (kinds.includes(it.kind) ? [i] : []));

export function planDrop(items: DropEntry[], target: DropTarget, doc: DropDoc): DropPlan {
  const plan: DropPlan = {
    pdfs: indexes(items, 'pdf'),
    convert: indexes(items, 'office', 'convert'),
    images: indexes(items, 'image'),
    einvoices: indexes(items, 'einvoice'),
    folders: indexes(items, 'folder'),
    unsupported: indexes(items, 'unsupported'),
    insertAt: null,
    ask: false,
    place: null,
    note: null,
    rejected: null,
  };
  if (target.kind === 'dialog') return { ...plan, rejected: NOT_IN_DIALOG };
  if (items.length && plan.unsupported.length === items.length) return { ...plan, rejected: NOTHING_SUPPORTED };
  if (!doc.hasDoc) return plan;

  const at = target.kind === 'thumbs' ? target.index : target.kind === 'page' ? target.pageIndex + 1 : null;
  if (target.kind === 'page' && target.onPage && plan.images.length) {
    if (doc.contentBlocked) plan.note = doc.contentBlocked;
    else plan.place = { pageId: target.pageId, x: target.x, y: target.y };
  }
  const pageMaking = plan.pdfs.length + plan.convert.length + (plan.place ? 0 : plan.images.length);
  if (at !== null && pageMaking > 0) {
    if (doc.pagesBlocked) plan.note = doc.pagesBlocked;
    else {
      plan.insertAt = at;
      plan.ask = true;
    }
  }
  return plan;
}

/** Page drags (thumbnails): copy into another tab's document, or reorder in the same one. */
export function planPageDrop(
  drag: { tabId: string; copyBlocked: string | null },
  activeTabId: string,
  target: DropTarget,
  doc: DropDoc,
): { action: 'reorder' | 'copy' | 'switch' | 'none'; at: number | null; rejected: string | null } {
  if (target.kind === 'tab') return { action: target.tabId === activeTabId ? 'none' : 'switch', at: null, rejected: null };
  const at = target.kind === 'thumbs' ? target.index : target.kind === 'page' ? target.pageIndex + 1 : null;
  if (at === null) return { action: 'none', at: null, rejected: target.kind === 'dialog' ? NOT_IN_DIALOG : null };
  if (doc.pagesBlocked) return { action: 'none', at: null, rejected: doc.pagesBlocked };
  if (drag.tabId === activeTabId) return { action: 'reorder', at, rejected: null };
  if (drag.copyBlocked) return { action: 'none', at: null, rejected: drag.copyBlocked };
  return { action: 'copy', at, rejected: null };
}

/** The page order after moving `dragged` to just before the page at `dropIndex` (indexes of the old order). */
export function reorderedIds(ids: string[], dragged: string[], dropIndex: number): string[] {
  const set = new Set(dragged);
  const before = ids.slice(0, dropIndex).filter((id) => !set.has(id)).length;
  const rest = ids.filter((id) => !set.has(id));
  rest.splice(before, 0, ...ids.filter((id) => set.has(id)));
  return rest;
}

/** "Insert pages after page 3" (whole sentences, so they translate). */
export function insertText(at: number, pageCount: number): string {
  if (at <= 0) return 'Insert pages at the beginning';
  if (at >= pageCount) return 'Insert pages at the end';
  return `Insert pages after page ${at}`;
}

/** The overlay's action name while dragging. */
export function dropLabel(plan: DropPlan, target: DropTarget, pageCount: number): string {
  if (plan.rejected) return plan.rejected;
  if (target.kind === 'tab') return 'Hold to switch to this document';
  if (plan.place && target.kind === 'page') return `Place the picture on page ${target.pageIndex + 1}`;
  if (plan.ask) return `${insertText(plan.insertAt!, pageCount)} or open in a new tab`;
  if (plan.folders.length && !plan.pdfs.length) return 'Open the PDFs in this folder';
  return 'Open in a new tab';
}
