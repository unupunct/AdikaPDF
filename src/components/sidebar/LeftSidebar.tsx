/**
 * Left sidebar: Pages (thumbnails), Bookmarks (outline), Attachments,
 * Layers (optional content) and Search results.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MessagesSquare, Bookmark, FileSearch, Layers as LayersIcon, LayoutGrid, Paperclip, Save, ExternalLink, Tags as TagsIcon } from 'lucide-react';
import { TagsPanel } from './TagsPanel';
import { blockedReason, usePDFStore, type SidebarTab } from '@/store/usePDFStore';
import { ThumbnailSidebar } from './ThumbnailSidebar';
import { Tooltip } from '@/components/ui/primitives';
import { getEmbeddedFiles, getLayerConfig, type EmbeddedFile } from '@/lib/pdf/pdfService';
import { saveFileQuiet } from '@/actions/saveGuard';
import { usePageLabels } from '@/hooks/usePageLabels';
import { cn } from '@/lib/cn';
import { CommentsPanel } from './CommentsPanel';
import { BookmarksPanel } from './BookmarksPanel';

const TABS: Array<{ id: SidebarTab; label: string; icon: ReactNode }> = [
  { id: 'pages', label: 'Pages', icon: <LayoutGrid size={16} /> },
  { id: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={16} /> },
  { id: 'comments', label: 'Comments', icon: <MessagesSquare size={16} /> },
  { id: 'attachments', label: 'Attachments', icon: <Paperclip size={16} /> },
  { id: 'layers', label: 'Layers', icon: <LayersIcon size={16} /> },
  { id: 'tags', label: 'Tags', icon: <TagsIcon size={16} /> },
  { id: 'search', label: 'Search results', icon: <FileSearch size={16} /> },
];

export function LeftSidebar() {
  const tab = usePDFStore((s) => s.sidebarTab);
  const setView = usePDFStore((s) => s.setView);
  return (
    <aside data-testid="left-sidebar" className="flex h-full w-[232px] shrink-0 border-r border-app bg-panel">
      <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-app py-2" aria-label="Sidebar panels">
        {TABS.map((t) => (
          <Tooltip key={t.id} content={t.label} side="right">
            <button
              type="button"
              aria-label={t.label}
              aria-pressed={tab === t.id}
              data-testid={`sidebar-${t.id}`}
              onClick={() => setView({ sidebarTab: t.id })}
              className={cn('flex h-8 w-8 items-center justify-center rounded-md', tab === t.id ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-200' : 'text-muted hover-app')}
            >
              {t.icon}
            </button>
          </Tooltip>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {tab === 'pages' ? <ThumbnailSidebar /> : null}
        {tab === 'bookmarks' ? <BookmarksPanel /> : null}
        {tab === 'comments' ? <CommentsPanel /> : null}
        {tab === 'attachments' ? <AttachmentsPanel /> : null}
        {tab === 'layers' ? <LayersPanel /> : null}
        {tab === 'tags' ? <TagsPanel /> : null}
        {tab === 'search' ? <SearchResultsPanel /> : null}
      </div>
    </aside>
  );
}

function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span>{title}</span>
      {right}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-xs text-muted">{children}</p>;
}

/** Distinct sources in page order (the opened file first, then merged ones). */
function useSourceIds(): Array<{ id: string; name: string }> {
  const pages = usePDFStore((s) => s.pages);
  const sources = usePDFStore((s) => s.sources);
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const p of pages) {
    if (p.sourceId && !seen.has(p.sourceId) && sources[p.sourceId]) {
      seen.add(p.sourceId);
      out.push({ id: p.sourceId, name: sources[p.sourceId].name });
    }
  }
  return out;
}

// ------------------------------------------------------------------ attachments

function AttachmentsPanel() {
  const sources = useSourceIds();
  const [files, setFiles] = useState<Array<EmbeddedFile & { sourceName: string }> | null>(null);
  const key = sources.map((s) => s.id).join('|');
  useEffect(() => {
    let alive = true;
    void Promise.all(sources.map(async (s) => (await getEmbeddedFiles(s.id).catch(() => [])).map((f) => ({ ...f, sourceName: s.name })))).then((l) => alive && setFiles(l.flat()));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const save = async (f: EmbeddedFile) => {
    const path = await saveFileQuiet(f.content, f.filename, [{ name: 'Attachment', extensions: [f.filename.split('.').pop() ?? '*'] }]);
    if (path) usePDFStore.getState().toast(path === 'downloaded' ? 'Downloaded.' : `Saved to ${path}`, 'success');
  };
  const openPdf = async (f: EmbeddedFile) => {
    const { openPdfBytes } = await import('@/actions/document');
    await openPdfBytes(f.content, f.filename, null);
  };
  return (
    <>
      <PanelHeader title="Attachments" right={files?.length ? <span className="font-normal normal-case">{files.length}</span> : undefined} />
      <div className="flex-1 overflow-auto p-2" data-testid="attachments-panel">
        {files && files.length === 0 ? <Empty>No files are attached to this document.</Empty> : null}
        {files?.map((f, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-app p-2">
            <div className="flex items-center gap-1.5">
              <Paperclip size={13} className="shrink-0 text-brand-600" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={f.filename} data-testid="attachment-name">
                {f.filename}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
              {(f.content.length / 1024).toFixed(1)} KB{f.description ? ` · ${f.description}` : ''}
            </div>
            <div className="mt-1.5 flex gap-1">
              <button type="button" onClick={() => void save(f)} className="flex items-center gap-1 rounded border border-app px-1.5 py-0.5 text-[11px] hover-app">
                <Save size={11} /> Save…
              </button>
              {/\.pdf$/i.test(f.filename) ? (
                <button type="button" onClick={() => void openPdf(f)} className="flex items-center gap-1 rounded border border-app px-1.5 py-0.5 text-[11px] hover-app">
                  <ExternalLink size={11} /> Open
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ layers

interface LayerRow {
  sourceId: string;
  id: string;
  name: string;
  visible: boolean;
}

function LayersPanel() {
  const sources = useSourceIds();
  const [rows, setRows] = useState<LayerRow[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const key = sources.map((s) => s.id).join('|');
  const rowKey = (r: LayerRow) => `${r.sourceId}:${r.id}`;
  const load = async () => {
    const out: LayerRow[] = [];
    for (const s of sources) {
      const config = await getLayerConfig(s.id).catch(() => null);
      if (!config) continue;
      for (const [id, group] of config as unknown as Iterable<[string, { name: string | null; visible: boolean }]>) {
        out.push({ sourceId: s.id, id, name: group.name || 'Unnamed layer', visible: group.visible });
      }
    }
    setRows(out);
    setSelected((sel) => sel.filter((k) => out.some((r) => rowKey(r) === k)));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const toggle = async (r: LayerRow) => {
    const config = await getLayerConfig(r.sourceId);
    config.setVisibility(r.id, !r.visible);
    usePDFStore.getState().bumpRenderEpoch();
    await load();
  };
  const readOnly = usePDFStore((s) => blockedReason(s, 'content') !== null);
  const chosen = (rows ?? []).filter((r) => selected.includes(rowKey(r)));
  // Layer edits work within one document: the first selected layer's.
  const sameSource = chosen.filter((r) => r.sourceId === chosen[0]?.sourceId);
  const act = async (fn: (m: typeof import('@/actions/layers')) => Promise<void>) => {
    await fn(await import('@/actions/layers'));
    setSelected([]);
  };
  return (
    <>
      <PanelHeader title="Layers" />
      <div className="flex-1 overflow-auto p-2" data-testid="layers-panel">
        {rows && rows.length === 0 ? <Empty>This document has no layers.</Empty> : null}
        {rows?.map((r) => {
          const k = rowKey(r);
          const isSel = selected.includes(k);
          return (
            <div
              key={k}
              data-testid="layer-row"
              onClick={(e) => setSelected(e.ctrlKey || e.metaKey ? (isSel ? selected.filter((x) => x !== k) : [...selected, k]) : isSel && selected.length === 1 ? [] : [k])}
              className={cn('flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px]', isSel ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover-app')}
            >
              <input
                type="checkbox"
                checked={r.visible}
                onClick={(e) => e.stopPropagation()}
                onChange={() => void toggle(r)}
                aria-label="Show layer"
                className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                data-testid="layer-toggle"
              />
              {renaming?.key === k ? (
                <input
                  autoFocus
                  value={renaming.name}
                  aria-label="Layer name"
                  data-testid="layer-name-input"
                  data-no-translate
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenaming({ key: k, name: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      const name = renaming.name;
                      setRenaming(null);
                      void act((m) => m.renameLayerIn(r.sourceId, r.id, name));
                    } else if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                  className="h-6 min-w-0 flex-1 rounded border border-brand-500 bg-panel-2 px-1 text-[12px] outline-none"
                />
              ) : (
                <span className="truncate" title={r.name} data-no-translate onDoubleClick={() => !readOnly && setRenaming({ key: k, name: r.name })}>
                  {r.name}
                </span>
              )}
            </div>
          );
        })}
        {rows?.length && !readOnly ? (
          <div className="mt-2 flex flex-wrap gap-1 px-1">
            <LayerBtn disabled={sameSource.length !== 1} onClick={() => setRenaming({ key: rowKey(sameSource[0]), name: sameSource[0].name })} testId="layer-rename">
              Rename
            </LayerBtn>
            <LayerBtn disabled={!sameSource.length} onClick={() => void act((m) => m.deleteLayersIn(sameSource[0].sourceId, sameSource.map((r) => r.id), sameSource.map((r) => r.name)))} testId="layer-delete">
              Delete
            </LayerBtn>
            <LayerBtn disabled={sameSource.length < 2} onClick={() => void act((m) => m.mergeLayersIn(sameSource[0].sourceId, sameSource.map((r) => r.id), sameSource[0].id))} testId="layer-merge">
              Merge
            </LayerBtn>
            <LayerBtn
              onClick={() => {
                const src = (chosen[0] ?? rows[0]).sourceId;
                void act((m) => m.flattenLayersIn(src, rows.filter((r) => r.sourceId === src && !r.visible).map((r) => r.id)));
              }}
              testId="layer-flatten"
            >
              Flatten
            </LayerBtn>
          </div>
        ) : null}
        {rows?.length ? (
          <p className="mt-2 px-1.5 text-[11px] text-muted">
            The checkbox shows or hides a layer on screen. Select layers (Ctrl+click for several) to rename, delete or merge them; Flatten keeps what is visible as ordinary page content.
          </p>
        ) : null}
      </div>
    </>
  );
}

function LayerBtn({ children, onClick, disabled, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} data-testid={testId} className="rounded border border-app px-2 py-0.5 text-[11.5px] hover-app disabled:cursor-default disabled:opacity-40">
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ search results

function SearchResultsPanel() {
  const search = usePDFStore((s) => s.search);
  const pages = usePDFStore((s) => s.pages);
  const labels = usePageLabels();
  const setSearch = usePDFStore((s) => s.setSearch);
  const open = (i: number) => {
    const h = search.hits[i];
    if (!h) return;
    setSearch({ active: i, open: true });
    usePDFStore.getState().navigateTo(h.pageId, h.rects[0]?.y);
  };
  return (
    <>
      <PanelHeader title="Search results" right={search.hits.length ? <span className="font-normal normal-case">{search.hits.length}</span> : undefined} />
      <div className="flex-1 overflow-auto p-1" data-testid="search-results">
        {!search.query ? <Empty>Press Ctrl+F and type to search. Results are listed here.</Empty> : search.hits.length === 0 && !search.running ? <Empty>No matches for “{search.query}”.</Empty> : null}
        {search.hits.slice(0, 1000).map((h, i) => {
          const parts = (h.snippet ?? '').split(/\[\[|\]\]/);
          return (
            <button
              type="button"
              key={i}
              onClick={() => open(i)}
              data-testid="search-result"
              className={cn('mb-0.5 block w-full rounded-md px-2 py-1.5 text-left text-[12px]', i === search.active ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover-app')}
            >
              <div className="text-[10.5px] font-semibold text-muted">Page {labels[h.pageId] ?? pages.findIndex((p) => p.id === h.pageId) + 1}</div>
              <div className="line-clamp-2 break-words">
                {parts[0]}
                <mark className="rounded bg-amber-300/70 px-0.5 text-inherit dark:bg-amber-500/50">{parts[1]}</mark>
                {parts[2]}
              </div>
            </button>
          );
        })}
        {search.hits.length > 1000 ? <Empty>Showing the first 1000 of {search.hits.length} matches.</Empty> : null}
      </div>
    </>
  );
}
