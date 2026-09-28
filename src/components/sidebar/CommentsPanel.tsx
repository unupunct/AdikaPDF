/** All comments of the document: new ones (editable) and those already in the file. */
import { useEffect, useMemo, useState } from 'react';
import { Highlighter, Keyboard, MessageSquare, PenLine, Search, StickyNote, Strikethrough, Underline, Waves } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { getAnnotations, getPdfPage, type PageAnnotation } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { usePageLabels } from '@/hooks/usePageLabels';
import { cn } from '@/lib/cn';

const COMMENT_SUBTYPES = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment']);

interface Row {
  key: string;
  pageId: string;
  y: number;
  kind: string;
  author: string;
  date: string | null;
  text: string;
  /** Editor object id for comments added in this session. */
  objectId: string | null;
}

const KIND_LABEL: Record<string, string> = {
  Text: 'Note',
  FreeText: 'Typewriter',
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strikeout',
  Squiggly: 'Squiggly',
  Ink: 'Drawing',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Line: 'Line',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  Stamp: 'Stamp',
  Caret: 'Insert text',
  FileAttachment: 'Attachment',
};

function icon(kind: string) {
  const p = { size: 13, className: 'shrink-0' };
  if (kind === 'Text') return <StickyNote {...p} className="shrink-0 text-amber-500" />;
  if (kind === 'FreeText') return <Keyboard {...p} />;
  if (kind === 'Highlight') return <Highlighter {...p} className="shrink-0 text-amber-500" />;
  if (kind === 'Underline') return <Underline {...p} className="shrink-0 text-green-600" />;
  if (kind === 'StrikeOut') return <Strikethrough {...p} className="shrink-0 text-red-600" />;
  if (kind === 'Squiggly') return <Waves {...p} className="shrink-0 text-blue-600" />;
  if (kind === 'Ink') return <PenLine {...p} />;
  return <MessageSquare {...p} />;
}

function pdfDateToIso(d: unknown): string | null {
  if (typeof d !== 'string' || !d) return null;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(d);
  if (!m) return null;
  const [, y, mo = '01', da = '01', h = '00', mi = '00', se = '00'] = m;
  return `${y}-${mo}-${da}T${h}:${mi}:${se}`;
}

type RawAnnot = PageAnnotation & { contentsObj?: { str?: string }; titleObj?: { str?: string }; modificationDate?: string; creationDate?: string; id?: string };

export function CommentsPanel() {
  const pages = usePDFStore((s) => s.pages);
  const objects = usePDFStore((s) => s.objects);
  const selectedIds = usePDFStore((s) => s.selectedIds);
  const labels = usePageLabels();
  const [existing, setExisting] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState('');

  // Comments already stored in the file(s), read through pdf.js.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows: Row[] = [];
      for (const p of pages) {
        if (p.kind !== 'source' || !p.sourceId) continue;
        const annots = (await getAnnotations(p.sourceId, p.sourceIndex).catch(() => [])) as RawAnnot[];
        const list = annots.filter((a) => COMMENT_SUBTYPES.has(a.subtype));
        if (!list.length) continue;
        const pdfPage = await getPdfPage(p.sourceId, p.sourceIndex).catch(() => null);
        const vp = pdfPage?.getViewport({ scale: 1, rotation: totalRotation(p) });
        for (const a of list) {
          const y = vp ? Math.min(vp.convertToViewportPoint(a.rect[0], a.rect[1])[1], vp.convertToViewportPoint(a.rect[2], a.rect[3])[1]) : 0;
          rows.push({
            key: `${p.id}:${a.id ?? rows.length}`,
            pageId: p.id,
            y,
            kind: a.subtype,
            author: a.titleObj?.str ?? '',
            date: pdfDateToIso(a.modificationDate ?? a.creationDate),
            text: a.contentsObj?.str ?? '',
            objectId: null,
          });
        }
      }
      if (alive) setExisting(rows);
    })();
    return () => {
      alive = false;
    };
  }, [pages]);

  const mine: Row[] = useMemo(
    () =>
      objects.flatMap((o): Row[] => {
        if (o.type === 'note') return [{ key: o.id, pageId: o.pageId, y: o.y, kind: 'Text', author: o.author, date: o.modifiedAt, text: o.text, objectId: o.id }];
        if (o.type === 'markup')
          return [{ key: o.id, pageId: o.pageId, y: o.y, kind: { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' }[o.kind], author: o.author, date: o.modifiedAt, text: o.text || o.selectedText, objectId: o.id }];
        if (o.type === 'text' && o.annotation) return [{ key: o.id, pageId: o.pageId, y: o.y, kind: 'FreeText', author: o.author ?? '', date: null, text: o.text, objectId: o.id }];
        return [];
      }),
    [objects],
  );

  const pageOrder = new Map(pages.map((p, i) => [p.id, i]));
  const q = filter.trim().toLowerCase();
  const rows = [...mine, ...(existing ?? [])]
    .filter((r) => !q || `${r.text} ${r.author} ${KIND_LABEL[r.kind] ?? r.kind}`.toLowerCase().includes(q))
    .sort((a, b) => (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) || a.y - b.y);

  const open = (r: Row) => {
    const s = usePDFStore.getState();
    s.navigateTo(r.pageId, r.y);
    if (r.objectId) {
      s.setTool('select');
      s.select([r.objectId]);
    }
  };

  let lastPage = '';
  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>Comments</span>
        <span className="font-normal normal-case">{rows.length}</span>
      </div>
      <div className="border-b border-app p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-app bg-panel-2 px-2">
          <Search size={12} className="text-muted" />
          <input aria-label="Filter comments" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none" />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-1.5" data-testid="comments-panel">
        {existing && rows.length === 0 ? <p className="px-2 py-4 text-xs text-muted">{q ? 'No comments match.' : 'No comments yet. Use the Comment tab to add notes, highlights and more.'}</p> : null}
        {rows.map((r) => {
          const header = r.pageId !== lastPage;
          lastPage = r.pageId;
          const pageNo = (pageOrder.get(r.pageId) ?? 0) + 1;
          return (
            <div key={r.key}>
              {header ? <div className="px-1.5 pb-1 pt-2 text-[10.5px] font-semibold text-muted">Page {labels[r.pageId] ?? pageNo}</div> : null}
              <button
                type="button"
                data-testid="comment-row"
                onClick={() => open(r)}
                className={cn('mb-1 block w-full rounded-md border px-2 py-1.5 text-left', r.objectId && selectedIds.includes(r.objectId) ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/30' : 'border-app hover-app')}
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  {icon(r.kind)}
                  <span className="font-semibold">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{r.author}</span>
                  {r.objectId ? <span className="rounded bg-brand-100 px-1 text-[9.5px] text-brand-700 dark:bg-brand-900/50 dark:text-brand-200">new</span> : null}
                </div>
                {r.text ? <div className="mt-0.5 line-clamp-3 break-words text-[12px]">{r.text}</div> : null}
                {r.date ? <div className="mt-0.5 text-[10px] text-muted">{new Date(r.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div> : null}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
