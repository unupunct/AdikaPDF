/** All comments of the document: new ones (editable) and those already in the file. */
import { useEffect, useMemo, useState } from 'react';
import { GitMerge, Highlighter, Keyboard, MessageSquare, PenLine, Pencil, Search, StickyNote, Strikethrough, Trash2, Underline, Waves } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { getAnnotations, getPdfPage, type PageAnnotation } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { usePageLabels } from '@/hooks/usePageLabels';
import { cn } from '@/lib/cn';
import { measureValue } from '@/lib/measure';
import type { ReviewState } from '@/lib/pdf/review';
import { isUntouched } from '@/lib/pdf/fileAnnots';
import { deleteFileAnnot, takeOverAnnot } from '@/actions/fileComments';
import type { EditorObject, PageRef } from '@/types';

const STATE_STYLE: Record<string, string> = {
  Accepted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  Rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  Cancelled: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  Completed: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
};

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
  /** Latest review status (and who set it). */
  status?: { state: ReviewState; by: string } | null;
  /** Comments in the file: how to find them again when setting the status. */
  match?: { subtype: string; rect: number[]; contents: string };
  /** Comments in the file: pdf.js id and the comment it answers. */
  file?: { id: string; inReplyTo: string | null };
  /** Objects taken over from the file: changed since. */
  edited?: boolean;
}

/** Comments of the file that can be taken over for editing (the others can only be deleted). */
const EDITABLE = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp']);

/** Rows of the file hidden by the editor: taken over, or a reply to a deleted comment. */
function hiddenFileRows(pages: PageRef[], objects: EditorObject[], rows: Row[]): Set<string> {
  const out = new Set<string>();
  for (const p of pages) {
    if (!p.takenAnnots?.length) continue;
    const taken = new Set(p.takenAnnots);
    const gone = new Set(p.takenAnnots.filter((id) => !objects.some((o) => o.pageId === p.id && o.fileAnnot?.ref === id)));
    const mine = rows.filter((r) => r.pageId === p.id && r.file);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of mine) {
        if (r.file!.inReplyTo && gone.has(r.file!.inReplyTo) && !gone.has(r.file!.id)) {
          gone.add(r.file!.id);
          grew = true;
        }
      }
    }
    for (const r of mine) if (taken.has(r.file!.id) || gone.has(r.file!.id)) out.add(r.key);
  }
  return out;
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
  Link: 'Link',
  Callout: 'Callout',
  TextBox: 'Text box',
  Cloud: 'Cloud',
  Distance: 'Distance',
  Perimeter: 'Perimeter',
  Area: 'Area',
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

type RawAnnot = PageAnnotation & { contentsObj?: { str?: string }; titleObj?: { str?: string }; modificationDate?: string; creationDate?: string; id?: string; inReplyTo?: string | null; state?: string | null; stateModel?: string | null; rect: number[] };

export function CommentsPanel() {
  const pages = usePDFStore((s) => s.pages);
  const objects = usePDFStore((s) => s.objects);
  const selectedIds = usePDFStore((s) => s.selectedIds);
  const labels = usePageLabels();
  const [existing, setExisting] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | ReviewState>('all');

  // Comments already stored in the file(s), read through pdf.js.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows: Row[] = [];
      for (const p of pages) {
        if (p.kind !== 'source' || !p.sourceId) continue;
        const annots = (await getAnnotations(p.sourceId, p.sourceIndex).catch(() => [])) as RawAnnot[];
        // Review-state replies are the status of the comment they answer, not comments of their own.
        const states = new Map<string, { state: ReviewState; by: string; at: string }>();
        for (const a of annots) {
          if (!a.inReplyTo || a.stateModel !== 'Review' || !a.state) continue;
          const at = a.modificationDate ?? a.creationDate ?? '';
          const old = states.get(a.inReplyTo);
          if (!old || at >= old.at) states.set(a.inReplyTo, { state: a.state as ReviewState, by: a.titleObj?.str ?? '', at });
        }
        const list = annots.filter((a) => COMMENT_SUBTYPES.has(a.subtype) && !(a.inReplyTo && a.stateModel));
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
            status: a.id && states.get(a.id) && states.get(a.id)!.state !== 'None' ? { state: states.get(a.id)!.state, by: states.get(a.id)!.by } : null,
            match: { subtype: a.subtype, rect: a.rect, contents: a.contentsObj?.str ?? '' },
            file: a.id ? { id: a.id, inReplyTo: a.inReplyTo ?? null } : undefined,
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
        if (o.type === 'text' && o.annotation) return [{ key: o.id, pageId: o.pageId, y: o.y, kind: o.callout ? 'Callout' : o.border ? 'TextBox' : 'FreeText', author: o.author ?? '', date: null, text: o.text, objectId: o.id }];
        if (o.type === 'stamp') return [{ key: o.id, pageId: o.pageId, y: o.y, kind: 'Stamp', author: o.author, date: o.modifiedAt, text: o.text || [o.label, o.subtitle].filter(Boolean).join(' – ') || 'Picture stamp', objectId: o.id }];
        if (o.type === 'poly') return [{ key: o.id, pageId: o.pageId, y: o.y, kind: o.kind === 'cloud' ? 'Cloud' : o.kind === 'polygon' ? 'Polygon' : 'PolyLine', author: o.author, date: o.modifiedAt, text: o.text, objectId: o.id }];
        if (o.type === 'measure') return [{ key: o.id, pageId: o.pageId, y: o.y, kind: o.kind === 'distance' ? 'Distance' : o.kind === 'perimeter' ? 'Perimeter' : 'Area', author: o.author, date: o.modifiedAt, text: [measureValue(o.kind, o.points, o.scale).label, o.text].filter(Boolean).join(' · '), objectId: o.id }];
        if (o.type === 'attachment') return [{ key: o.id, pageId: o.pageId, y: o.y, kind: 'FileAttachment', author: o.author, date: o.modifiedAt, text: o.text || o.fileName, objectId: o.id }];
        // Shapes, lines, ink and links taken over from the file.
        if (o.fileAnnot) return [{ key: o.id, pageId: o.pageId, y: o.y, kind: o.fileAnnot.subtype, author: '', date: null, text: '', objectId: o.id }];
        return [];
      }).map((r) => {
        const obj = objects.find((x) => x.id === r.objectId);
        const row = obj?.fileAnnot ? { ...r, edited: !isUntouched(obj) } : r;
        const o = obj as { reviewStatus?: ReviewState; author?: string } | undefined;
        return o?.reviewStatus && o.reviewStatus !== 'None' ? { ...row, status: { state: o.reviewStatus, by: o.author ?? '' } } : row;
      }),
    [objects],
  );

  const pageOrder = new Map(pages.map((p, i) => [p.id, i]));
  const q = filter.trim().toLowerCase();
  const hiddenRows = hiddenFileRows(pages, objects, existing ?? []);
  const rows = [...mine, ...(existing ?? []).filter((r) => !hiddenRows.has(r.key))]
    .filter((r) => !q || `${r.text} ${r.author} ${KIND_LABEL[r.kind] ?? r.kind}`.toLowerCase().includes(q))
    .filter((r) => statusFilter === 'all' || (statusFilter === 'open' ? !r.status : r.status?.state === statusFilter))
    .sort((a, b) => (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) || a.y - b.y);

  const setStatus = async (r: Row, state: ReviewState) => {
    if (r.objectId) {
      const s = usePDFStore.getState();
      s.updateObject(r.objectId, { reviewStatus: state === 'None' ? undefined : state } as never);
      return;
    }
    if (!r.match) return;
    const { setFileCommentStatus } = await import('@/actions/pageTools');
    await setFileCommentStatus(pageOrder.get(r.pageId) ?? 0, r.match, state);
  };

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
        <span className="flex items-center gap-1 font-normal normal-case">
          {rows.length}
          <button
            type="button"
            aria-label="Merge reviewers' copies"
            title="Merge the comments of reviewers' copies of this document"
            className="rounded p-1 hover-app"
            onClick={() => void import('@/actions/pageTools').then((m) => m.mergeReviewCopies())}
            data-testid="comments-merge"
          >
            <GitMerge size={13} />
          </button>
        </span>
      </div>
      <div className="border-b border-app p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-app bg-panel-2 px-2">
          <Search size={12} className="text-muted" />
          <input aria-label="Filter comments" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7 min-w-0 flex-1 bg-transparent text-[12px] outline-none" />
        </div>
        <select
          aria-label="Filter by status"
          className="mt-1.5 h-7 w-full rounded-md border border-app bg-panel-2 px-1 text-[12px]"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          data-testid="comments-status-filter"
        >
          <option value="all">All statuses</option>
          <option value="open">No status yet</option>
          <option value="Accepted">Accepted</option>
          <option value="Rejected">Rejected</option>
          <option value="Completed">Completed</option>
          <option value="Cancelled">Cancelled</option>
        </select>
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
              <div
                role="button"
                tabIndex={0}
                data-testid="comment-row"
                data-status={r.status?.state ?? ''}
                onClick={() => open(r)}
                onKeyDown={(e) => (e.key === 'Enter' ? open(r) : undefined)}
                className={cn('mb-1 block w-full rounded-md border px-2 py-1.5 text-left', r.objectId && selectedIds.includes(r.objectId) ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/30' : 'border-app hover-app')}
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  {icon(r.kind)}
                  <span className="font-semibold">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-muted" data-no-translate>
                    {r.author}
                  </span>
                  {r.objectId && r.edited !== false ? <span className="rounded bg-brand-100 px-1 text-[9.5px] text-brand-700 dark:bg-brand-900/50 dark:text-brand-200">{r.edited ? 'edited' : 'new'}</span> : null}
                  {r.file && EDITABLE.has(r.kind) ? (
                    <button
                      type="button"
                      aria-label="Edit comment"
                      title="Edit this comment: move it, change its colour or text"
                      className="rounded p-0.5 text-muted hover-app"
                      onClick={(e) => {
                        e.stopPropagation();
                        void takeOverAnnot(r.pageId, r.file!.id);
                      }}
                      data-testid="comment-edit"
                    >
                      <Pencil size={12} />
                    </button>
                  ) : null}
                  {r.file || r.objectId ? (
                    <button
                      type="button"
                      aria-label="Delete comment"
                      title="Delete this comment (with its replies)"
                      className="rounded p-0.5 text-muted hover-app hover:text-rose-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (r.file) void deleteFileAnnot(r.pageId, r.file.id);
                        else if (r.objectId) usePDFStore.getState().deleteObjects([r.objectId]);
                      }}
                      data-testid="comment-delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : null}
                </div>
                {r.text ? (
                  <div className="mt-0.5 line-clamp-3 break-words text-[12px]" data-no-translate>
                    {r.text}
                  </div>
                ) : null}
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
                  {r.date ? <span className="min-w-0 flex-1 truncate">{new Date(r.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span> : <span className="flex-1" />}
                  {r.status ? (
                    <span className={cn('rounded px-1', STATE_STYLE[r.status.state])} title={r.status.by} data-testid="comment-status">
                      {r.status.state}
                    </span>
                  ) : null}
                  <select
                    aria-label="Review status"
                    className="h-5 rounded border border-app bg-transparent text-[10px]"
                    value={r.status?.state ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => void setStatus(r, (e.target.value || 'None') as ReviewState)}
                    data-testid="comment-set-status"
                  >
                    <option value="">Status…</option>
                    <option value="Accepted">Accepted</option>
                    <option value="Rejected">Rejected</option>
                    <option value="Completed">Completed</option>
                    <option value="Cancelled">Cancelled</option>
                    <option value="None">None</option>
                  </select>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
