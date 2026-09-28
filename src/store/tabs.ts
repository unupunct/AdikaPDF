/**
 * Document tabs. The main store always holds the *active* document; other
 * tabs keep a parked copy of their document-specific state (sources, pages,
 * edits, undo history, view position, search). Switching swaps slices, so
 * the rest of the app keeps working with a single-document store.
 */
import { create } from 'zustand';
import { usePDFStore } from './usePDFStore';
import { releaseSource } from '@/lib/pdf/pdfService';
import { uid } from '@/lib/uid';

type StoreState = ReturnType<typeof usePDFStore.getState>;

const DOC_KEYS = [
  'sources',
  'pages',
  'objects',
  'fieldValues',
  'past',
  'future',
  'fileName',
  'filePath',
  'readOnlyReason',
  'dirty',
  'signatureStatus',
  'zoom',
  'fitMode',
  'currentPageId',
  'selectedIds',
  'editingTextId',
  'search',
  'navBack',
  'navForward',
  'viewRotation',
  'docMeta',
  'fileStamp',
  'scrollRequest',
] as const satisfies ReadonlyArray<keyof StoreState>;

export type DocSlice = Pick<StoreState, (typeof DOC_KEYS)[number]>;

export interface DocTab {
  id: string;
  /** Parked state for inactive tabs; null for the active one (it lives in the store). */
  slice: DocSlice | null;
}

interface TabsState {
  tabs: DocTab[];
  activeId: string;
}

const firstId = uid('tab');
export const useTabs = create<TabsState>()(() => ({ tabs: [{ id: firstId, slice: null }], activeId: firstId }));

function capture(): DocSlice {
  const s = usePDFStore.getState();
  const out = {} as Record<string, unknown>;
  for (const k of DOC_KEYS) out[k] = s[k];
  return out as DocSlice;
}

function emptySlice(): DocSlice {
  return {
    sources: {},
    pages: [],
    objects: [],
    fieldValues: {},
    past: [],
    future: [],
    fileName: null,
    filePath: null,
    readOnlyReason: null,
    dirty: false,
    signatureStatus: [],
    zoom: 1,
    fitMode: 'width',
    currentPageId: null,
    selectedIds: [],
    editingTextId: null,
    search: { query: '', hits: [], active: 0, open: false, running: false },
    navBack: [],
    navForward: [],
    viewRotation: 0,
    docMeta: null,
    fileStamp: null,
    scrollRequest: null,
  };
}

function apply(slice: DocSlice): void {
  usePDFStore.setState({ ...slice, tool: slice.pages.length ? 'selectText' : 'selectText', modal: null });
  // Bring the remembered page back into view after the swap.
  const page = slice.currentPageId;
  if (page) requestAnimationFrame(() => usePDFStore.getState().scrollToPage(page));
}

/** Parks the current document and opens an empty tab. Returns the new tab id. */
export function newTab(): string {
  const { tabs, activeId } = useTabs.getState();
  const id = uid('tab');
  const parked = tabs.map((t) => (t.id === activeId ? { ...t, slice: capture() } : t));
  const at = parked.findIndex((t) => t.id === activeId) + 1;
  parked.splice(at, 0, { id, slice: null });
  useTabs.setState({ tabs: parked, activeId: id });
  apply(emptySlice());
  return id;
}

export function switchTab(id: string): void {
  const { tabs, activeId } = useTabs.getState();
  if (id === activeId) return;
  const target = tabs.find((t) => t.id === id);
  if (!target?.slice) return;
  const current = capture();
  useTabs.setState({ tabs: tabs.map((t) => (t.id === activeId ? { ...t, slice: current } : t.id === id ? { ...t, slice: null } : t)), activeId: id });
  apply(target.slice);
}

export function cycleTab(delta: number): void {
  const { tabs, activeId } = useTabs.getState();
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  switchTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/** Tab title/dirty flag, reading live state for the active tab. */
export function tabInfo(tab: DocTab, activeId: string): { name: string | null; dirty: boolean } {
  if (tab.id === activeId) {
    const s = usePDFStore.getState();
    return { name: s.fileName, dirty: s.dirty };
  }
  return { name: tab.slice?.fileName ?? null, dirty: tab.slice?.dirty ?? false };
}

function releaseSlice(slice: DocSlice): void {
  for (const id of Object.keys(slice.sources)) void releaseSource(id);
}

/**
 * Closes a tab without asking (callers confirm unsaved changes first).
 * Closing the last tab leaves one empty tab (the welcome screen).
 */
export function removeTab(id: string): void {
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (id !== activeId) {
    if (tab.slice) releaseSlice(tab.slice);
    useTabs.setState({ tabs: tabs.filter((t) => t.id !== id) });
    return;
  }
  releaseSlice(capture());
  const rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) {
    const fresh = uid('tab');
    useTabs.setState({ tabs: [{ id: fresh, slice: null }], activeId: fresh });
    apply(emptySlice());
    return;
  }
  const i = tabs.findIndex((t) => t.id === id);
  const next = rest[Math.min(i, rest.length - 1)];
  useTabs.setState({ tabs: rest.map((t) => (t.id === next.id ? { ...t, slice: null } : t)), activeId: next.id });
  apply(next.slice ?? emptySlice());
}

/** True when the active tab is empty (welcome screen). */
export function activeTabIsEmpty(): boolean {
  return usePDFStore.getState().pages.length === 0;
}

/** Every tab with unsaved changes (for the close-window prompt). */
export function dirtyTabCount(): number {
  const { tabs, activeId } = useTabs.getState();
  return tabs.filter((t) => tabInfo(t, activeId).dirty).length;
}
