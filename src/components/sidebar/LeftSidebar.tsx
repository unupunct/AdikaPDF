/**
 * Left sidebar: Pages (thumbnails), Bookmarks (outline), Attachments,
 * Layers (optional content) and Search results.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MessagesSquare, Bookmark, ChevronDown, ChevronRight, FileSearch, Layers as LayersIcon, LayoutGrid, Paperclip, Save, ExternalLink } from 'lucide-react';
import { usePDFStore, type SidebarTab } from '@/store/usePDFStore';
import { ThumbnailSidebar } from './ThumbnailSidebar';
import { Tooltip } from '@/components/ui/primitives';
import { getEmbeddedFiles, getLayerConfig, getOutline, type EmbeddedFile, type OutlineNode } from '@/lib/pdf/pdfService';
import { goToDestination } from '@/components/viewer/ReaderLayers';
import { openExternal, saveBytes } from '@/lib/platform';
import { usePageLabels } from '@/hooks/usePageLabels';
import { cn } from '@/lib/cn';
import { CommentsPanel } from './CommentsPanel';

const TABS: Array<{ id: SidebarTab; label: string; icon: ReactNode }> = [
  { id: 'pages', label: 'Pages', icon: <LayoutGrid size={16} /> },
  { id: 'bookmarks', label: 'Bookmarks', icon: <Bookmark size={16} /> },
  { id: 'comments', label: 'Comments', icon: <MessagesSquare size={16} /> },
  { id: 'attachments', label: 'Attachments', icon: <Paperclip size={16} /> },
  { id: 'layers', label: 'Layers', icon: <LayersIcon size={16} /> },
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

// ------------------------------------------------------------------ bookmarks

function BookmarksPanel() {
  const sources = useSourceIds();
  const [trees, setTrees] = useState<Array<{ id: string; name: string; items: OutlineNode[] }> | null>(null);
  const key = sources.map((s) => s.id).join('|');
  useEffect(() => {
    let alive = true;
    void Promise.all(sources.map(async (s) => ({ ...s, items: await getOutline(s.id).catch(() => []) }))).then((t) => alive && setTrees(t));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const withItems = trees?.filter((t) => t.items.length) ?? [];
  return (
    <>
      <PanelHeader title="Bookmarks" />
      <div className="flex-1 overflow-auto py-1" data-testid="outline-panel">
        {trees && withItems.length === 0 ? <Empty>This document has no bookmarks.</Empty> : null}
        {withItems.map((t) => (
          <div key={t.id}>
            {withItems.length > 1 ? <div className="truncate px-3 pb-1 pt-2 text-[11px] font-semibold text-muted">{t.name}</div> : null}
            {t.items.map((n, i) => (
              <OutlineItem key={i} node={n} sourceId={t.id} depth={0} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function OutlineItem({ node, sourceId, depth }: { node: OutlineNode; sourceId: string; depth: number }) {
  const [open, setOpen] = useState(depth === 0 && node.items.length > 0 && node.items.length < 12);
  const follow = () => {
    if (node.url) void openExternal(node.url).catch(() => undefined);
    else void goToDestination(sourceId, node.dest);
  };
  return (
    <div>
      <div className="group flex items-center rounded-md pr-2 hover-app" style={{ paddingLeft: 4 + depth * 12 }}>
        <button type="button" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)} className={cn('flex h-6 w-5 shrink-0 items-center justify-center text-muted', node.items.length === 0 && 'invisible')}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          onClick={follow}
          data-testid="outline-item"
          className={cn('min-w-0 flex-1 truncate py-1 text-left text-[12.5px]', node.bold && 'font-semibold', node.italic && 'italic')}
          title={node.title}
        >
          {node.title}
        </button>
      </div>
      {open ? node.items.map((c, i) => <OutlineItem key={i} node={c} sourceId={sourceId} depth={depth + 1} />) : null}
    </div>
  );
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
    const path = await saveBytes(f.content, f.filename, [{ name: 'Attachment', extensions: [f.filename.split('.').pop() ?? '*'] }]);
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
  const key = sources.map((s) => s.id).join('|');
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
  return (
    <>
      <PanelHeader title="Layers" />
      <div className="flex-1 overflow-auto p-2" data-testid="layers-panel">
        {rows && rows.length === 0 ? <Empty>This document has no layers.</Empty> : null}
        {rows?.map((r) => (
          <label key={`${r.sourceId}:${r.id}`} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] hover-app">
            <input type="checkbox" checked={r.visible} onChange={() => void toggle(r)} className="h-3.5 w-3.5 accent-[var(--color-brand-600)]" data-testid="layer-toggle" />
            <span className="truncate" title={r.name}>
              {r.name}
            </span>
          </label>
        ))}
        {rows?.length ? <p className="mt-2 px-1.5 text-[11px] text-muted">Showing or hiding layers changes only the view; the file keeps all layers.</p> : null}
      </div>
    </>
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
