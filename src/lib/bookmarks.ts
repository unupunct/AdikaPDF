/** Pure edits on a bookmark tree (the Bookmarks panel). Every function returns a new tree. */
import type { BookmarkItem } from '@/types';

type Tree = BookmarkItem[];

interface Place {
  list: Tree;
  index: number;
  parent: BookmarkItem | null;
}

/** Where `id` sits: its sibling list, index and parent. */
export function locate(tree: Tree, id: string, parent: BookmarkItem | null = null): Place | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return { list: tree, index: i, parent };
    const inner = locate(tree[i].children, id, tree[i]);
    if (inner) return inner;
  }
  return null;
}

export function findBookmark(tree: Tree, id: string): BookmarkItem | null {
  const p = locate(tree, id);
  return p ? p.list[p.index] : null;
}

/** Deep copy so edits never touch the undo history's snapshots. */
function clone(tree: Tree): Tree {
  return tree.map((it) => ({ ...it, children: clone(it.children) }));
}

/** Inserts `item` after `afterId` (same level), or at the end when afterId is null or unknown. */
export function insertBookmark(tree: Tree, item: BookmarkItem, afterId: string | null): Tree {
  const t = clone(tree);
  const p = afterId ? locate(t, afterId) : null;
  if (p) p.list.splice(p.index + 1, 0, item);
  else t.push(item);
  return t;
}

export function removeBookmark(tree: Tree, id: string): Tree {
  const t = clone(tree);
  const p = locate(t, id);
  if (p) p.list.splice(p.index, 1);
  return t;
}

export function updateBookmark(tree: Tree, id: string, patch: Partial<BookmarkItem>): Tree {
  const t = clone(tree);
  const p = locate(t, id);
  if (p) p.list[p.index] = { ...p.list[p.index], ...patch };
  return t;
}

/** Moves among its siblings (-1 up, +1 down). */
export function moveBookmark(tree: Tree, id: string, dir: -1 | 1): Tree {
  const t = clone(tree);
  const p = locate(t, id);
  if (!p) return t;
  const j = p.index + dir;
  if (j < 0 || j >= p.list.length) return t;
  [p.list[p.index], p.list[j]] = [p.list[j], p.list[p.index]];
  return t;
}

/** Makes it the last child of the sibling above. */
export function indentBookmark(tree: Tree, id: string): Tree {
  const t = clone(tree);
  const p = locate(t, id);
  if (!p || p.index === 0) return t;
  const [item] = p.list.splice(p.index, 1);
  const above = p.list[p.index - 1];
  above.children.push(item);
  above.open = true;
  return t;
}

/** Moves it out of its parent, right after the parent. */
export function outdentBookmark(tree: Tree, id: string): Tree {
  const t = clone(tree);
  const p = locate(t, id);
  if (!p || !p.parent) return t;
  const [item] = p.list.splice(p.index, 1);
  const outer = locate(t, p.parent.id);
  if (outer) outer.list.splice(outer.index + 1, 0, item);
  return t;
}

export function countBookmarks(tree: Tree): number {
  return tree.reduce((n, it) => n + 1 + countBookmarks(it.children), 0);
}
