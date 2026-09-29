/** The file's own outline (bookmarks) as an editable tree of BookmarkItem. */
import { getOutline, resolveDestination, type OutlineNode } from './pdfService';
import { uid } from '@/lib/uid';
import type { BookmarkItem, PageRef } from '@/types';

type Tree = BookmarkItem[];

/** The file outlines (one per source, in page order) as an editable tree. */
export async function toEditable(sources: Array<{ id: string }>, pages: PageRef[]): Promise<Tree> {
  const convert = async (sourceId: string, nodes: OutlineNode[]): Promise<Tree> =>
    Promise.all(
      nodes.map(async (n): Promise<BookmarkItem> => {
        const dest = n.url ? null : await resolveDestination(sourceId, n.dest).catch(() => null);
        const page = dest ? pages.find((p) => p.sourceId === sourceId && p.sourceIndex === dest.index) : undefined;
        return {
          id: uid('bm'),
          title: n.title,
          pageId: page?.id ?? null,
          top: dest?.top ?? null,
          url: n.url,
          bold: n.bold,
          italic: n.italic,
          open: n.items.length > 0 && n.items.length < 12,
          children: await convert(sourceId, n.items),
        };
      }),
    );
  const out: Tree = [];
  for (const s of sources) out.push(...(await convert(s.id, await getOutline(s.id).catch(() => []))));
  return out;
}

