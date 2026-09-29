/** Home and View ribbon tabs (reading-oriented commands). */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BookText,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns2,
  Expand,
  File as FileIcon,
  FileDown,
  FilePlus2,
  FileText,
  FolderOpen,
  Hand,
  Info,
  Layers as LayersIcon,
  LayoutGrid,
  Maximize,
  Minimize,
  MonitorPlay,
  Moon,
  MousePointer2,
  MoveHorizontal,
  Paperclip,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Rows3,
  Save,
  SaveAll,
  Search,
  Signature,
  TextCursor,
  TextCursorInput,
  Undo2,
  ZoomIn,
  ZoomOut,
  FileOutput,
  Wrench,
  StickyNote,
  Keyboard,
  Highlighter,
  Underline,
  Strikethrough,
  Waves,
  PaintbrushVertical,
  Square,
  Circle,
  Brush,
  Minus,
  ArrowUpRight,
  MessagesSquare,
  ChevronsDown,
  MessageSquareQuote,
  SquareDashedText,
  Cloud,
  Pentagon,
  Spline,
} from 'lucide-react';
import { CommentFileMenu, StampMenu } from './CommentTools';
import { ReadAloudGroup, ReadingToolsGroup } from './ReadingTools';
import { MeasureGroup } from './MeasureTools';
import { useAutoScroll } from '@/components/viewer/AutoScroll';
import { toggleSplit, useSplit } from '@/components/viewer/SplitView';
import { getAuthor, setAuthor } from '@/lib/author';
import { usePDFStore } from '@/store/usePDFStore';
import { closeDocumentAction, openDialog, openPdfPath, saveDocument } from '@/actions/document';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger, Tooltip } from '@/components/ui/primitives';
import { clearRecent, getRecent, removeRecent, type RecentFile } from '@/lib/recent';
import { findPageByInput, usePageLabels } from '@/hooks/usePageLabels';
import { normalizeRotation } from '@/lib/geometry';
import { setFullscreen } from '@/lib/platform';
import { cn } from '@/lib/cn';
import type { ToolId } from '@/types';

export interface BtnProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tip?: string;
  testId?: string;
}

export const I = 22;
export const i = 14;

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col border-r border-app px-1.5 last:border-r-0">
      <div className="flex flex-1 items-start gap-0.5">{children}</div>
      <div className="text-center text-[10px] leading-3 text-muted">{label}</div>
    </div>
  );
}

export function Big({ icon, label, onClick, active, disabled, tip, testId }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        data-tip={tip}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-[60px] min-w-[54px] flex-col items-center justify-center gap-1 rounded-md px-1.5 text-[11px] leading-tight disabled:opacity-40',
          active ? 'bg-brand-100 text-brand-800 ring-1 ring-brand-300 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700' : 'hover-app',
        )}
      >
        <span className={cn(active ? 'text-brand-700 dark:text-brand-200' : 'text-brand-600 dark:text-brand-400')}>{icon}</span>
        <span className="max-w-[72px] text-center">{label}</span>
      </button>
    </Tooltip>
  );
}

export function Small({ icon, label, onClick, active, disabled, tip, testId }: BtnProps) {
  return (
    <Tooltip content={tip ?? label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label || tip}
        data-tip={tip}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn('flex h-[19px] items-center gap-1.5 rounded px-1.5 text-[11.5px] disabled:opacity-40', active ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-100' : 'hover-app')}
      >
        <span className="text-brand-600 dark:text-brand-400">{icon}</span>
        {label}
      </button>
    </Tooltip>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col justify-start gap-px py-0.5">{children}</div>;
}

export function ToolBtn({ tool, icon, label, tip, big = true }: { tool: ToolId; icon: ReactNode; label: string; tip?: string; big?: boolean }) {
  const active = usePDFStore((s) => s.tool === tool);
  const reading = tool === 'selectText' || tool === 'pan' || tool === 'select' || tool === 'snapshot';
  const enabled = usePDFStore((s) => s.pages.length > 0 && (reading || !s.readOnlyReason));
  const setTool = usePDFStore((s) => s.setTool);
  const B = big ? Big : Small;
  return <B icon={icon} label={label} tip={tip} active={active} disabled={!enabled} onClick={() => setTool(active && tool !== 'selectText' ? 'selectText' : tool)} testId={`tool-${tool}`} />;
}

// ------------------------------------------------------------------ recent files

export function useRecentFiles(): RecentFile[] {
  const [list, setList] = useState(getRecent);
  useEffect(() => {
    const update = () => setList(getRecent());
    window.addEventListener('adika:recent', update);
    return () => window.removeEventListener('adika:recent', update);
  }, []);
  return list;
}

function RecentMenu() {
  const recent = useRecentFiles();
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <button type="button" data-testid="btn-recent" className="flex h-[19px] items-center gap-1.5 rounded px-1.5 text-[11.5px] hover-app">
          <Clock size={i} className="text-brand-600 dark:text-brand-400" /> Recent <ChevronDown size={10} />
        </button>
      </DropdownTrigger>
      <DropdownContent>
        {recent.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted">No recent files</div> : null}
        {recent.slice(0, 12).map((r) => (
          <DropdownItem key={r.path} onSelect={() => void openRecent(r)} icon={<FileText size={13} />}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px]">{r.name}</span>
              <span className="max-w-[340px] truncate text-[10.5px] opacity-70">{r.path}</span>
            </span>
          </DropdownItem>
        ))}
        {recent.length ? (
          <>
            <DropdownSeparator />
            <DropdownItem onSelect={clearRecent}>Clear list</DropdownItem>
          </>
        ) : null}
      </DropdownContent>
    </DropdownMenu>
  );
}

export async function openRecent(r: RecentFile): Promise<void> {
  const ok = await openPdfPath(r.path);
  if (!ok) removeRecent(r.path);
}

// ------------------------------------------------------------------ page navigation

export function PageNavigator() {
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const labels = usePageLabels();
  const idx = pages.findIndex((p) => p.id === currentPageId);
  const current = pages[idx];
  const shown = current ? (labels[current.id] ?? String(idx + 1)) : '';
  const [text, setText] = useState(shown);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(shown), [shown]);
  const go = () => {
    const id = findPageByInput(text, pages.map((p) => p.id), labels);
    if (id) usePDFStore.getState().navigateTo(id);
    else setText(shown);
  };
  const step = (d: number) => {
    const next = pages[Math.max(0, Math.min(pages.length - 1, idx + d))];
    if (next) usePDFStore.getState().scrollToPage(next.id);
  };
  const hasLabel = current && labels[current.id] && labels[current.id] !== String(idx + 1);
  return (
    <div className="flex items-center gap-0.5">
      <Small icon={<ChevronLeft size={i} />} label="" tip="Previous page (PageUp)" disabled={idx <= 0} onClick={() => step(-1)} testId="btn-prev-page" />
      <input
        ref={ref}
        data-testid="page-input"
        aria-label="Page number"
        value={text}
        disabled={!pages.length}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            go();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setText(shown);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => setText(shown)}
        className="h-[19px] w-12 rounded border border-app bg-panel-2 px-1 text-center text-[11.5px] tabular-nums outline-none focus:border-brand-500"
      />
      <span className="px-0.5 text-[11px] text-muted" data-testid="page-count">
        {hasLabel ? `(${idx + 1} of ${pages.length})` : `of ${pages.length}`}
      </span>
      <Small icon={<ChevronRight size={i} />} label="" tip="Next page (PageDown)" disabled={idx < 0 || idx >= pages.length - 1} onClick={() => step(1)} testId="btn-next-page" />
    </div>
  );
}

// ------------------------------------------------------------------ Home

export function HomeTab() {
  const s = usePDFStore();
  const hasDoc = s.pages.length > 0;
  const editable = hasDoc && !s.readOnlyReason;
  const zoomPct = Math.round(s.zoom * 100);
  return (
    <>
      <Group label="File">
        <Big icon={<FolderOpen size={I} />} label="Open" onClick={() => void openDialog()} tip="Open a PDF (Ctrl+O)" testId="btn-open" />
        <Big icon={<Save size={I} />} label="Save" disabled={!editable} onClick={() => void saveDocument(false)} tip="Save (Ctrl+S)" testId="btn-save" />
        <Big icon={<Printer size={I} />} label="Print" disabled={!hasDoc} onClick={() => usePDFStore.getState().openModal('print')} tip="Print (Ctrl+P): several pages per sheet, booklet, poster" testId="btn-print" />
        <Stack>
          <Small icon={<SaveAll size={i} />} label="Save as…" disabled={!editable} onClick={() => void saveDocument(true)} tip="Save a copy (Ctrl+Shift+S)" testId="btn-save-as" />
          <RecentMenu />
          <Small icon={<FilePlus2 size={i} />} label="Create PDF" onClick={() => s.openModal('import')} testId="btn-create" />
        </Stack>
        <Stack>
          <Small icon={<Info size={i} />} label="Properties" disabled={!hasDoc} onClick={() => s.openModal('properties')} tip="Document properties (Ctrl+D)" testId="btn-properties" />
          <Small icon={<FileDown size={i} />} label="Close" disabled={!hasDoc} onClick={() => void closeDocumentAction()} tip="Close (Ctrl+W)" />
        </Stack>
      </Group>
      <Group label="History">
        <Stack>
          <Small icon={<Undo2 size={i} />} label="Undo" disabled={s.past.length === 0} onClick={s.undo} tip="Undo (Ctrl+Z)" testId="btn-undo" />
          <Small icon={<Redo2 size={i} />} label="Redo" disabled={s.future.length === 0} onClick={s.redo} tip="Redo (Ctrl+Y)" testId="btn-redo" />
        </Stack>
      </Group>
      <Group label="Tools">
        <ToolBtn tool="selectText" icon={<TextCursor size={I} />} label="Select text" tip="Select and copy text, follow links (S)" />
        <ToolBtn tool="select" icon={<MousePointer2 size={I} />} label="Select" tip="Select and move your edits (V)" />
        <ToolBtn tool="pan" icon={<Hand size={I} />} label="Hand" tip="Pan the page (H, or hold the middle mouse button)" />
        <ToolBtn tool="editText" icon={<TextCursorInput size={I} />} label="Edit text" tip="Click existing text to edit it" />
      </Group>
      <Group label="Navigate">
        <Stack>
          <PageNavigator />
          <div className="flex gap-0.5">
            <Small icon={<ArrowLeft size={i} />} label="Back" disabled={s.navBack.length === 0} onClick={s.goBack} tip="Back to the previous view (Alt+←)" testId="btn-back" />
            <Small icon={<ArrowRight size={i} />} label="Forward" disabled={s.navForward.length === 0} onClick={s.goForward} tip="Forward (Alt+→)" testId="btn-forward" />
          </div>
        </Stack>
      </Group>
      <Group label="Zoom">
        <Stack>
          <div className="flex items-center gap-0.5">
            <Small icon={<ZoomOut size={i} />} label="" tip="Zoom out (Ctrl+-)" disabled={!hasDoc} onClick={() => s.setZoom(s.zoom / 1.2)} testId="btn-zoom-out" />
            <span data-testid="zoom-level" className="w-12 text-center text-[11.5px] tabular-nums">
              {zoomPct}%
            </span>
            <Small icon={<ZoomIn size={i} />} label="" tip="Zoom in (Ctrl+=)" disabled={!hasDoc} onClick={() => s.setZoom(s.zoom * 1.2)} testId="btn-zoom-in" />
          </div>
          <Small icon={<MoveHorizontal size={i} />} label="Fit width" active={s.fitMode === 'width'} disabled={!hasDoc} onClick={() => s.setZoom(s.zoom, 'width')} />
          <Small icon={<Maximize size={i} />} label="Fit page" active={s.fitMode === 'page'} disabled={!hasDoc} onClick={() => s.setZoom(s.zoom, 'page')} />
        </Stack>
        <Big icon={<Search size={I} />} label="Find" disabled={!hasDoc} onClick={() => s.setSearch({ open: true })} tip="Search the document (Ctrl+F)" testId="btn-find" />
      </Group>
      <Group label="Quick actions">
        <Big icon={<Signature size={I} />} label="Fill & Sign" disabled={!editable} onClick={() => s.openModal('signature')} />
        <Big icon={<LayoutGrid size={I} />} label="Organize" disabled={!editable} onClick={() => s.openModal('organizer')} />
        <Big icon={<FileOutput size={I} />} label="Export" disabled={!hasDoc} onClick={() => s.openModal('export')} />
        <Big icon={<Wrench size={I} />} label="Tools" onClick={() => s.openModal('tools')} tip="PDF to Word, JPG to PDF, Merge, Compress…" testId="btn-tools" />
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ View

export async function toggleFullscreen(): Promise<void> {
  const on = !usePDFStore.getState().fullscreen;
  usePDFStore.getState().setView({ fullscreen: on });
  await setFullscreen(on);
}

export function startPresentation(): void {
  const s = usePDFStore.getState();
  if (s.pages.length === 0) return;
  s.setView({ presentation: true });
}

export function rotateView(delta: 90 | -90): void {
  const s = usePDFStore.getState();
  if (s.tool !== 'selectText' && s.tool !== 'pan' && s.tool !== 'select') s.setTool('selectText');
  s.setView({ viewRotation: normalizeRotation(s.viewRotation + delta) });
}

function SplitButton({ disabled }: { disabled: boolean }) {
  const on = useSplit((s) => s.open);
  return <Big icon={<Columns2 size={I} />} label="Split" active={on} disabled={disabled} onClick={toggleSplit} tip="Split view: another part of this document, or another open document, side by side (Ctrl+\)" testId="btn-split-view" />;
}

function AutoScrollButton({ disabled }: { disabled: boolean }) {
  const on = useAutoScroll((s) => s.on);
  return (
    <Big
      icon={<ChevronsDown size={I} />}
      label="Auto-scroll"
      active={on}
      disabled={disabled}
      onClick={() => useAutoScroll.getState().toggle()}
      tip="Scroll automatically (Ctrl+Shift+H) · ↑/↓ speed · − reverse · Esc stop"
      testId="btn-autoscroll"
    />
  );
}

export function ViewTab() {
  const s = usePDFStore();
  const hasDoc = s.pages.length > 0;
  const openPanel = (sidebarTab: typeof s.sidebarTab) => usePDFStore.setState({ sidebarOpen: true, sidebarTab });
  return (
    <>
      <Group label="Page layout">
        <Big icon={<FileIcon size={I} />} label="Single page" active={s.viewScroll === 'single' && s.viewSpread === 'none'} disabled={!hasDoc} onClick={() => s.setView({ viewScroll: 'single', viewSpread: 'none' })} testId="view-single" />
        <Big icon={<Rows3 size={I} />} label="Continuous" active={s.viewScroll === 'continuous' && s.viewSpread === 'none'} disabled={!hasDoc} onClick={() => s.setView({ viewScroll: 'continuous', viewSpread: 'none' })} testId="view-continuous" />
        <Big icon={<Columns2 size={I} />} label="Two pages" active={s.viewSpread === 'odd'} disabled={!hasDoc} onClick={() => s.setView({ viewSpread: 'odd' })} tip="Facing pages" testId="view-two" />
        <Big icon={<BookOpen size={I} />} label="Book view" active={s.viewSpread === 'even'} disabled={!hasDoc} onClick={() => s.setView({ viewSpread: 'even' })} tip="Facing pages with a separate cover" testId="view-book" />
      </Group>
      <Group label="Rotate view">
        <Stack>
          <Small icon={<RotateCcw size={i} />} label="Left" disabled={!hasDoc} onClick={() => rotateView(-90)} tip="Rotate the view (the file is not changed) — Ctrl+Shift+-" testId="btn-rotate-view-left" />
          <Small icon={<RotateCw size={i} />} label="Right" disabled={!hasDoc} onClick={() => rotateView(90)} tip="Rotate the view (the file is not changed) — Ctrl+Shift++" testId="btn-rotate-view-right" />
          <Small icon={<Expand size={i} />} label="Reset" disabled={!hasDoc || s.viewRotation === 0} onClick={() => s.setView({ viewRotation: 0 })} />
        </Stack>
      </Group>
      <Group label="Reading">
        <Big icon={<BookText size={I} />} label="Reading view" disabled={!hasDoc} onClick={() => s.openModal('readingview')} tip="The text reflowed like an e-book: adjustable size, width, font and colours" testId="btn-reading-view" />
        <Big icon={<Moon size={I} />} label="Night mode" active={s.nightMode} disabled={!hasDoc} onClick={() => s.setView({ nightMode: !s.nightMode })} tip="Dark pages for reading at night" testId="btn-night" />
        <Big icon={s.fullscreen ? <Minimize size={I} /> : <Maximize size={I} />} label="Full screen" active={s.fullscreen} onClick={() => void toggleFullscreen()} tip="Full screen (F11)" testId="btn-fullscreen" />
        <Big icon={<MonitorPlay size={I} />} label="Present" disabled={!hasDoc} onClick={startPresentation} tip="Presentation mode (F5)" testId="btn-present" />
        <AutoScrollButton disabled={!hasDoc} />
        <SplitButton disabled={!hasDoc} />
      </Group>
      <ReadAloudGroup />
      <ReadingToolsGroup />
      <Group label="Panels">
        <Stack>
          <Small icon={<LayoutGrid size={i} />} label="Pages" onClick={() => openPanel('pages')} disabled={!hasDoc} />
          <Small icon={<Bookmark size={i} />} label="Bookmarks" onClick={() => openPanel('bookmarks')} disabled={!hasDoc} testId="btn-panel-bookmarks" />
          <Small icon={<Paperclip size={i} />} label="Attachments" onClick={() => openPanel('attachments')} disabled={!hasDoc} />
        </Stack>
        <Stack>
          <Small icon={<LayersIcon size={i} />} label="Layers" onClick={() => openPanel('layers')} disabled={!hasDoc} />
          <Small icon={<Search size={i} />} label="Search results" onClick={() => openPanel('search')} disabled={!hasDoc} />
        </Stack>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ Comment

export function CommentTab() {
  const s = usePDFStore();
  const hasDoc = s.pages.length > 0;
  const [author, setAuthorState] = useState(getAuthor);
  useEffect(() => {
    const update = () => setAuthorState(getAuthor());
    window.addEventListener('adika:author', update);
    return () => window.removeEventListener('adika:author', update);
  }, []);
  const count = s.objects.filter((o) => o.type === 'note' || o.type === 'markup' || o.type === 'stamp' || o.type === 'poly' || o.type === 'attachment' || o.type === 'measure' || (o.type === 'text' && o.annotation)).length;
  return (
    <>
      <Group label="Tools">
        <ToolBtn tool="pan" icon={<Hand size={I} />} label="Hand" tip="Pan the page (H)" />
        <ToolBtn tool="select" icon={<MousePointer2 size={I} />} label="Select" tip="Select, move and edit comments (V)" />
        <ToolBtn tool="selectText" icon={<TextCursor size={I} />} label="Select text" tip="Select text — a mini toolbar offers highlight and more (S)" />
      </Group>
      <Group label="Comment">
        <ToolBtn tool="note" icon={<StickyNote size={I} />} label="Note" tip="Click to add a sticky note (N)" />
        <ToolBtn tool="typewriter" icon={<Keyboard size={I} />} label="Typewriter" tip="Click and type text onto the page, as a comment others can edit" />
        <Stack>
          <ToolBtn big={false} tool="textbox" icon={<SquareDashedText size={i} />} label="Text box" tip="Drag a box and type a comment in it" />
          <ToolBtn big={false} tool="callout" icon={<MessageSquareQuote size={i} />} label="Callout" tip="Press on the point to comment on, drag to where the text box goes" />
          <ToolBtn big={false} tool="attach" icon={<Paperclip size={i} />} label="Attach file" tip="Click on the page, then choose a file to attach as a comment" />
        </Stack>
        <StampMenu />
      </Group>
      <Group label="Text markup">
        <ToolBtn tool="markup-highlight" icon={<Highlighter size={I} />} label="Highlight" tip="Select text to highlight it" />
        <Stack>
          <ToolBtn big={false} tool="markup-underline" icon={<Underline size={i} />} label="Underline" tip="Select text to underline it" />
          <ToolBtn big={false} tool="markup-strikeout" icon={<Strikethrough size={i} />} label="Strikeout" tip="Select text to strike it out" />
          <ToolBtn big={false} tool="markup-squiggly" icon={<Waves size={i} />} label="Squiggly" tip="Select text to add a squiggly underline" />
        </Stack>
      </Group>
      <Group label="Drawing">
        <ToolBtn tool="highlight" icon={<PaintbrushVertical size={I} />} label="Area highlight" tip="Highlight any area (images, scans)" />
        <Stack>
          <ToolBtn big={false} tool="rect" icon={<Square size={i} />} label="Rectangle" />
          <ToolBtn big={false} tool="ellipse" icon={<Circle size={i} />} label="Ellipse" />
          <ToolBtn big={false} tool="pen" icon={<Brush size={i} />} label="Pencil" />
        </Stack>
        <Stack>
          <ToolBtn big={false} tool="line" icon={<Minus size={i} />} label="Line" />
          <ToolBtn big={false} tool="arrow" icon={<ArrowUpRight size={i} />} label="Arrow" />
          <ToolBtn big={false} tool="cloud" icon={<Cloud size={i} />} label="Cloud" tip="Drag a box to draw a cloud around something" />
        </Stack>
        <Stack>
          <ToolBtn big={false} tool="polygon" icon={<Pentagon size={i} />} label="Polygon" tip="Click the corners; double-click, Enter or click the first point to finish" />
          <ToolBtn big={false} tool="polyline" icon={<Spline size={i} />} label="Polyline" tip="Click the points; double-click or Enter to finish" />
        </Stack>
      </Group>
      <MeasureGroup />
      <Group label="Manage">
        <Big icon={<MessagesSquare size={I} />} label={count ? `Comments (${count})` : 'Comments'} disabled={!hasDoc} onClick={() => usePDFStore.setState({ sidebarOpen: true, sidebarTab: 'comments' })} tip="List all comments" testId="btn-comments" />
        <CommentFileMenu />
        <Stack>
          <label className="flex h-[19px] items-center gap-1 px-1 text-[11px] text-muted">
            Author
            <input
              aria-label="Comment author"
              data-testid="comment-author"
              value={author}
              onChange={(e) => setAuthorState(e.target.value)}
              onBlur={() => setAuthor(author)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="h-[19px] w-28 rounded border border-app bg-panel-2 px-1 text-[11.5px] text-[var(--text)] outline-none focus:border-brand-500"
            />
          </label>
        </Stack>
      </Group>
    </>
  );
}
