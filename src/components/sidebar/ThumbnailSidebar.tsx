/** Left sidebar: page thumbnails with drag-and-drop reordering and page actions; long documents mount only the thumbnails in view. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FilePlus2, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { PageThumbnail } from './PageThumbnail';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { usePageLabels } from '@/hooks/usePageLabels';
import { displaySize } from '@/lib/geometry';
import { visibleRows, VIRTUAL_MIN_PAGES } from '@/lib/pdf/pageSizes';

const THUMB_WIDTH = 132;
/** Button padding, gap and label line around the thumbnail, and the margin below an item. */
const ITEM_CHROME = 32;
const ITEM_GAP = 12;

export function ThumbnailSidebar() {
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const readOnly = usePDFStore((s) => blockedReason(s, 'pages') !== null);
  const labels = usePageLabels();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const store = usePDFStore.getState;

  // Fixed item heights, so only the items in view need to exist.
  const bands = useMemo(() => {
    let top = 0;
    return pages.map((p) => {
      const { width, height } = displaySize(p);
      const h = Math.round((THUMB_WIDTH / width) * height) + ITEM_CHROME;
      const band = { top, height: h };
      top += h + ITEM_GAP;
      return band;
    });
  }, [pages]);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const frame = useRef(0);
  const readView = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      if (el) setView({ top: el.scrollTop, height: el.clientHeight });
    });
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(readView);
    ro.observe(el);
    return () => ro.disconnect();
  }, [readView]);
  const virtual = pages.length > VIRTUAL_MIN_PAGES;
  const [first, last] = virtual ? visibleRows(bands, view.top, view.height, 2) : [0, pages.length - 1];
  const total = bands.length ? bands[bands.length - 1].top + bands[bands.length - 1].height : 0;
  const before = bands[first]?.top ?? 0;
  const after = last >= 0 && bands[last] ? total - bands[last].top - bands[last].height : 0;

  const onDrop = () => {
    if (dragId === null || dropIndex === null) return;
    const ids = pages.map((p) => p.id).filter((id) => id !== dragId);
    const from = pages.findIndex((p) => p.id === dragId);
    const target = dropIndex > from ? dropIndex - 1 : dropIndex;
    ids.splice(target, 0, dragId);
    store().reorderPages(ids);
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <div data-testid="thumbnail-sidebar" className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center justify-between border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>Pages</span>
        <span className="font-normal normal-case">{pages.length}</span>
      </div>
      <div
        ref={scroller}
        onScroll={readView}
        className="flex-1 overflow-y-auto px-2 py-3"
        onDragOver={(e) => {
          if (dragId) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
      >
        {before > 0 ? <div style={{ height: before }} /> : null}
        {pages.slice(first, last + 1).map((page, k) => {
          const i = first + k;
          return (
            <div
              key={page.id}
              style={{ height: bands[i].height }}
              draggable={!readOnly}
              onDragStart={(e) => {
                setDragId(page.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/x-adika-page', page.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDropIndex(e.clientY < r.top + r.height / 2 ? i : i + 1);
              }}
              className="group relative mb-3"
            >
              {dropIndex === i && dragId ? <div className="absolute -top-2 left-2 right-2 h-0.5 rounded bg-brand-500" /> : null}
              <button
                type="button"
                data-testid={`thumb-${i + 1}`}
                onClick={() => store().scrollToPage(page.id)}
                className={cn(
                  'mx-auto flex flex-col items-center gap-1 rounded-md p-1.5',
                  page.id === currentPageId ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover-app',
                  dragId === page.id && 'opacity-40',
                )}
              >
                <PageThumbnail page={page} width={THUMB_WIDTH} />
                <span className="text-[11px] leading-4 text-muted" data-testid={`thumb-label-${i + 1}`}>{labels[page.id] ?? i + 1}</span>
              </button>
              {!readOnly ? (
                <div className="absolute right-3 top-2 hidden flex-col gap-0.5 rounded-md bg-panel/95 p-0.5 shadow ring-1 ring-black/10 group-hover:flex">
                  <ThumbAction label="Rotate left" onClick={() => store().rotatePages([page.id], 270)}>
                    <RotateCcw size={13} />
                  </ThumbAction>
                  <ThumbAction label="Rotate right" onClick={() => store().rotatePages([page.id], 90)}>
                    <RotateCw size={13} />
                  </ThumbAction>
                  <ThumbAction label="Duplicate page" onClick={() => store().duplicatePages([page.id])}>
                    <Copy size={13} />
                  </ThumbAction>
                  <ThumbAction label="Insert blank page after" onClick={() => store().insertBlankPage(i + 1)}>
                    <FilePlus2 size={13} />
                  </ThumbAction>
                  <ThumbAction label="Delete page" onClick={() => store().deletePages([page.id])}>
                    <Trash2 size={13} className="text-rose-600" />
                  </ThumbAction>
                </div>
              ) : null}
            </div>
          );
        })}
        {after > 0 ? <div style={{ height: after }} /> : null}
        {dropIndex === pages.length && dragId ? <div className="mx-2 h-0.5 rounded bg-brand-500" /> : null}
      </div>
    </div>
  );
}

function ThumbAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label} side="right">
      <button type="button" aria-label={label} onClick={onClick} className="flex h-6 w-6 items-center justify-center rounded hover-app">
        {children}
      </button>
    </Tooltip>
  );
}
