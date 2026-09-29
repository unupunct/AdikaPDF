/**
 * Bookmarks (outline) panel. Shows the file's own outline; the first edit
 * (add, rename, delete, move, indent) turns it into an editable tree kept in
 * the document state, written back as the PDF outline when saving.
 */
import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Tooltip } from '@/components/ui/primitives';
import { goToDestination } from '@/components/viewer/ReaderLayers';
import { openExternal } from '@/lib/platform';
import { findBookmark, indentBookmark, insertBookmark, moveBookmark, outdentBookmark, removeBookmark, updateBookmark } from '@/lib/bookmarks';
import { uid } from '@/lib/uid';
import { toEditable } from '@/lib/pdf/outlineTree';
import { cn } from '@/lib/cn';
import type { BookmarkItem } from '@/types';

type Tree = BookmarkItem[];

function useSources(): Array<{ id: string }> {
  const pages = usePDFStore((s) => s.pages);
  const seen = new Set<string>();
  const out: Array<{ id: string }> = [];
  for (const p of pages) if (p.sourceId && !seen.has(p.sourceId)) {
    seen.add(p.sourceId);
    out.push({ id: p.sourceId });
  }
  return out;
}

export function BookmarksPanel() {
  const outline = usePDFStore((s) => s.outline);
  const pages = usePDFStore((s) => s.pages);
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);
  const sources = useSources();
  const [original, setOriginal] = useState<Tree | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const key = sources.map((s) => s.id).join('|');

  // The file's own outline, shown until the first edit.
  useEffect(() => {
    let alive = true;
    if (outline) return;
    void toEditable(sources, usePDFStore.getState().pages).then((t) => alive && setOriginal(t));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, outline === null]);

  const tree = outline ?? original ?? [];

  /** Applies an edit, starting the editable tree from the file's outline the first time. */
  const edit = (fn: (t: Tree) => Tree) => {
    const base = usePDFStore.getState().outline ?? original ?? [];
    usePDFStore.getState().commit(() => ({ outline: fn(base) }));
  };

  const add = () => {
    const s = usePDFStore.getState();
    const idx = Math.max(0, s.pages.findIndex((p) => p.id === s.currentPageId));
    const item: BookmarkItem = { id: uid('bm'), title: `Page ${idx + 1}`, pageId: s.pages[idx]?.id ?? null, top: null, url: null, bold: false, italic: false, open: false, children: [] };
    edit((t) => insertBookmark(t, item, selected));
    setSelected(item.id);
    setRenaming(item.id);
  };

  const follow = (it: BookmarkItem) => {
    setSelected(it.id);
    if (it.url) {
      void openExternal(it.url).catch(() => undefined);
      return;
    }
    const page = pages.find((p) => p.id === it.pageId);
    if (!page) return;
    if (page.sourceId && it.top !== null && page.userRotation === 0 && page.baseRotation === 0) {
      // Top of the view in display points from the page top.
      void goToDestination(page.sourceId, [page.sourceIndex, { name: 'XYZ' }, null, it.top, null]);
      return;
    }
    usePDFStore.getState().navigateTo(page.id);
  };

  const sel = selected && findBookmark(tree, selected) ? selected : null;
  const btn = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false, testId?: string) => (
    <Tooltip content={label}>
      <button type="button" aria-label={label} data-testid={testId} disabled={disabled || readOnly} onClick={onClick} className="flex h-6 w-6 items-center justify-center rounded text-muted hover-app disabled:opacity-30">
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <>
      <div className="flex h-9 shrink-0 items-center border-b border-app px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Bookmarks</div>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-app px-1.5 py-1" role="toolbar" aria-label="Bookmark tools">
        <div className="contents">
          {btn('Add a bookmark for the current page', <BookmarkPlus size={14} />, add, pages.length === 0, 'bm-add')}
          {btn('Rename', <Pencil size={13} />, () => sel && setRenaming(sel), !sel, 'bm-rename')}
          {btn('Delete', <Trash2 size={13} />, () => sel && edit((t) => removeBookmark(t, sel)), !sel, 'bm-delete')}
          {btn('Move up', <ChevronUp size={14} />, () => sel && edit((t) => moveBookmark(t, sel, -1)), !sel, 'bm-up')}
          {btn('Move down', <ChevronDown size={14} />, () => sel && edit((t) => moveBookmark(t, sel, 1)), !sel, 'bm-down')}
          {btn('Make it a sub-bookmark', <ChevronRight size={14} />, () => sel && edit((t) => indentBookmark(t, sel)), !sel, 'bm-indent')}
          {btn('Move it one level out', <ChevronLeft size={14} />, () => sel && edit((t) => outdentBookmark(t, sel)), !sel, 'bm-outdent')}
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1" data-testid="outline-panel">
        {tree.length === 0 && (outline || original) ? <p className="px-3 py-4 text-xs text-muted">This document has no bookmarks. Use + to add one for the current page.</p> : null}
        {tree.map((n) => (
          <Item
            key={n.id}
            node={n}
            depth={0}
            selected={sel}
            renaming={renaming}
            onFollow={follow}
            onToggle={(it) => {
              // Expanding is not an edit: the file's own outline stays untouched.
              if (outline) edit((t) => updateBookmark(t, it.id, { open: !it.open }));
              else setOriginal((t) => (t ? updateBookmark(t, it.id, { open: !it.open }) : t));
            }}
            onRename={(it, title) => {
              setRenaming(null);
              if (title.trim() && title !== it.title) edit((t) => updateBookmark(t, it.id, { title: title.trim() }));
            }}
            onStartRename={(it) => !readOnly && setRenaming(it.id)}
          />
        ))}
      </div>
    </>
  );
}

function Item({
  node,
  depth,
  selected,
  renaming,
  onFollow,
  onToggle,
  onRename,
  onStartRename,
}: {
  node: BookmarkItem;
  depth: number;
  selected: string | null;
  renaming: string | null;
  onFollow: (n: BookmarkItem) => void;
  onToggle: (n: BookmarkItem) => void;
  onRename: (n: BookmarkItem, title: string) => void;
  onStartRename: (n: BookmarkItem) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(node.title);
  const editing = renaming === node.id;
  useEffect(() => {
    if (editing) {
      setDraft(node.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, node.title]);
  return (
    <div>
      <div className={cn('group flex items-center rounded-md pr-2', selected === node.id ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover-app')} style={{ paddingLeft: 4 + depth * 12 }}>
        <button type="button" aria-label={node.open ? 'Collapse' : 'Expand'} onClick={() => onToggle(node)} className={cn('flex h-6 w-5 shrink-0 items-center justify-center text-muted', node.children.length === 0 && 'invisible')}>
          {node.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {editing ? (
          <input
            ref={inputRef}
            aria-label="Bookmark title"
            data-testid="bm-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRename(node, draft)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onRename(node, draft);
              if (e.key === 'Escape') onRename(node, node.title);
            }}
            className="h-6 min-w-0 flex-1 rounded border border-brand-500 bg-panel-2 px-1 text-[12.5px] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => onFollow(node)}
            onDoubleClick={() => onStartRename(node)}
            data-testid="outline-item"
            data-no-translate
            className={cn('min-w-0 flex-1 truncate py-1 text-left text-[12.5px]', node.bold && 'font-semibold', node.italic && 'italic', !node.pageId && !node.url && 'text-muted')}
            title={node.pageId || node.url ? node.title : `${node.title} (its page was deleted)`}
          >
            {node.title}
          </button>
        )}
      </div>
      {node.open
        ? node.children.map((c) => (
            <Item key={c.id} node={c} depth={depth + 1} selected={selected} renaming={renaming} onFollow={onFollow} onToggle={onToggle} onRename={onRename} onStartRename={onStartRename} />
          ))
        : null}
    </div>
  );
}
