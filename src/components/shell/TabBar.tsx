import { FileText, Plus, X } from 'lucide-react';
import { useTabs, switchTab, tabInfo } from '@/store/tabs';
import { usePDFStore } from '@/store/usePDFStore';
import { closeTabAction, openDialog } from '@/actions/document';
import { cn } from '@/lib/cn';

/** Document tabs (hidden while only the welcome screen is open). */
export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  // Re-render when the active document's name/dirty flag change.
  usePDFStore((s) => `${s.fileName}|${s.dirty}`);
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  if (tabs.length === 1 && !hasDoc) return null;
  return (
    <div role="tablist" aria-label="Open documents" className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-app bg-app px-2" data-testid="tab-bar">
      {tabs.map((t) => {
        const info = tabInfo(t, activeId);
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            data-testid="doc-tab"
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeTabAction(t.id);
              }
            }}
            onClick={() => switchTab(t.id)}
            className={cn(
              'group flex h-7 max-w-[220px] min-w-[120px] cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[12px]',
              active ? 'border-app bg-panel font-medium' : 'border-transparent text-muted hover:bg-panel/60',
            )}
            title={info.name ?? 'New tab'}
          >
            <FileText size={13} className={active ? 'text-brand-600' : ''} />
            <span className="min-w-0 flex-1 truncate" data-no-translate={info.name ? '' : undefined}>
              {info.name ?? 'New tab'}
            </span>
            {info.dirty ? <span className="text-brand-600" aria-label="Unsaved changes">●</span> : null}
            <button
              type="button"
              aria-label={`Close ${info.name ?? 'tab'}`}
              data-testid="doc-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTabAction(t.id);
              }}
              className="flex h-4 w-4 items-center justify-center rounded opacity-60 hover:bg-[var(--hover)] hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <button type="button" aria-label="Open another PDF" title="Open another PDF (Ctrl+O)" onClick={() => void openDialog()} className="mb-0.5 flex h-6 w-6 items-center justify-center rounded text-muted hover-app">
        <Plus size={14} />
      </button>
    </div>
  );
}
