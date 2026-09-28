/**
 * Writes edited bookmarks as the document outline (/Outlines), replacing the
 * file's own. Destinations point at the saved pages, so bookmarks follow
 * pages that were moved, and ones whose page was deleted are dropped.
 */
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFPage, PDFRef, PDFString } from 'pdf-lib';
import type { BookmarkItem } from '@/types';

/** Items that still lead somewhere (a kept page or a web address), with their children. */
function reachable(items: BookmarkItem[], pageById: Map<string, PDFPage>): BookmarkItem[] {
  return items
    .map((it) => ({ ...it, children: reachable(it.children, pageById) }))
    .filter((it) => it.url || (it.pageId && pageById.has(it.pageId)) || it.children.length > 0);
}

function countOpen(items: BookmarkItem[]): number {
  return items.reduce((n, it) => n + 1 + (it.open ? countOpen(it.children) : 0), 0);
}

export function writeOutline(doc: PDFDocument, items: BookmarkItem[], pageById: Map<string, PDFPage>): void {
  const ctx = doc.context;
  const list = reachable(items, pageById);
  if (!list.length) {
    doc.catalog.delete(PDFName.of('Outlines'));
    return;
  }
  const rootRef = ctx.nextRef();
  const build = (nodes: BookmarkItem[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = nodes.map(() => ctx.nextRef());
    nodes.forEach((it, k) => {
      const page = it.pageId ? pageById.get(it.pageId) : undefined;
      const dict: Record<string, unknown> = {
        Title: PDFHexString.fromText(it.title || 'Untitled'),
        Parent: parent,
      };
      if (k > 0) dict.Prev = refs[k - 1];
      if (k < nodes.length - 1) dict.Next = refs[k + 1];
      if (it.url) dict.A = { Type: 'Action', S: 'URI', URI: PDFString.of(it.url) };
      else if (page) dict.Dest = it.top === null ? [page.ref, PDFName.of('Fit')] : [page.ref, PDFName.of('XYZ'), PDFNull, it.top, PDFNull];
      const flags = (it.italic ? 1 : 0) | (it.bold ? 2 : 0);
      if (flags) dict.F = flags;
      if (it.children.length) {
        const kids = build(it.children, refs[k]);
        dict.First = kids.first;
        dict.Last = kids.last;
        // Positive count = shown expanded, negative = collapsed.
        dict.Count = it.open ? countOpen(it.children) : -it.children.length;
      }
      ctx.assign(refs[k], ctx.obj(dict as Parameters<typeof ctx.obj>[0]));
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const top = build(list, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: countOpen(list) }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}
