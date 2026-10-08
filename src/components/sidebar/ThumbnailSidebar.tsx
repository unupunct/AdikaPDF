/** Left sidebar: page thumbnails with drag-and-drop reordering and page actions. */
import { useState } from 'react';
import { Copy, FilePlus2, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { PageThumbnail } from './PageThumbnail';
import { Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { usePageLabels } from '@/hooks/usePageLabels';

const THUMB_WIDTH = 132;

export function ThumbnailSidebar() {
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const readOnly = usePDFStore((s) => blockedReason(s, 'pages') !== null);
  const labels = usePageLabels();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const store = usePDFStore.getState;

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
        className="flex-1 overflow-y-auto px-2 py-3"
        onDragOver={(e) => {
          if (dragId) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
      >
        {pages.map((page, i) => (
          <div
            key={page.id}
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
              <span className="text-[11px] text-muted" data-testid={`thumb-label-${i + 1}`}>{labels[page.id] ?? i + 1}</span>
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
        ))}
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
