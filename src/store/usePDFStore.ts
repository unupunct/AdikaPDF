/**
 * Central editor state (Zustand).
 *
 * Undoable document state is { pages, objects, fieldValues }. Every mutation
 * goes through `commit`, which pushes the previous snapshot onto `past`.
 * Source PDF bytes are append-only and never part of a snapshot, so undo is
 * cheap: snapshots share all unchanged objects by reference.
 */
import { create } from 'zustand';
import type {
  BookmarkItem,
  DocSnapshot,
  EditorObject,
  PageRef,
  RibbonTab,
  Rotation,
  SavedSignature,
  SearchHit,
  SignatureValidation,
  SourceDoc,
  ToolId,
  ToolStyle,
} from '@/types';
import {
  displaySize,
  normalizeRotation,
  objectDisplayBounds,
  rectsIntersect,
  rotateObjectWithPage,
} from '@/lib/geometry';
import { openPdf, registerSource, releaseSource } from '@/lib/pdf/pdfService';
import { uid } from '@/lib/uid';
import type { StampTemplate } from '@/lib/objectFactory';

const HISTORY_LIMIT = 200;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export type FieldValue = string | boolean | string[];

export interface UndoableState {
  pages: PageRef[];
  objects: EditorObject[];
  /** Values for form fields that already exist in a source, keyed `${sourceId}::${fieldName}`. */
  fieldValues: Record<string, FieldValue>;
  /** Edited bookmarks; null keeps the file's own outline. */
  outline: BookmarkItem[] | null;
}

export type ModalId =
  | null
  | 'signature'
  | 'certificate'
  | 'token'
  | 'winstore'
  | 'cloudsign'
  | 'organizer'
  | 'password'
  | 'compress'
  | 'ocr'
  | 'export'
  | 'import'
  | 'verify'
  | 'pdfa'
  | 'about'
  | 'split'
  | 'unlock'
  | 'properties'
  | 'print'
  | 'tools'
  | 'link'
  | 'crop'
  | 'pageMarks'
  | 'compare'
  | 'find-redact'
  | 'batch'
  | 'mailmerge'
  | 'accessibility'
  | 'readingview'
  | 'scan'
  | 'printprod'
  | 'foldersearch'
  | 'certencrypt'
  | 'recover'
  | 'replacePages'
  | 'spell'
  | 'einvoice'
  | 'portfolio'
  | 'pageSize'
  | 'customize'
  | 'hiddenInfo';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
  /** A button on the toast, e.g. "Save as…" after a failed save. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export type SidebarTab = 'pages' | 'bookmarks' | 'comments' | 'attachments' | 'layers' | 'tags' | 'search';

export interface NavPoint {
  pageId: string;
  y?: number;
}

/** Document metadata edited in Properties; applied when the file is saved. */
export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  /** Copyright (XMP rights): status, notice and a web page with the terms. */
  rightsStatus?: 'unknown' | 'copyrighted' | 'public';
  copyright?: string;
  copyrightUrl?: string;
  /** Custom properties of the document (Info dictionary), replacing the file's own. */
  custom?: Record<string, string>;
}

export interface BusyState {
  message: string;
  /** 0..1, or null for indeterminate. */
  progress: number | null;
  /** Set when the operation can be cancelled: the overlay shows a Cancel button. */
  abort?: AbortController;
}

interface PDFState extends UndoableState {
  // Document
  sources: Record<string, SourceDoc>;
  fileName: string | null;
  filePath: string | null;
  /** Set when the file can be viewed but not re-written (e.g. opened with a password). */
  readOnlyReason: string | null;
  dirty: boolean;
  /** The document as last opened or saved (same object references), so undo back to it is clean again; null when unsaved changes lie outside the history. */
  savedDoc: UndoableState | null;
  past: UndoableState[];
  future: UndoableState[];
  signatureStatus: SignatureValidation[];

  // UI
  tool: ToolId;
  ribbonTab: RibbonTab;
  style: ToolStyle;
  zoom: number;
  fitMode: 'width' | 'page' | null;
  selectedIds: string[];
  currentPageId: string | null;
  editingTextId: string | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  theme: 'light' | 'dark';
  modal: ModalId;
  busy: BusyState | null;
  toasts: Toast[];
  /** `replace`: the search bar shows its Replace row. */
  search: { query: string; hits: SearchHit[]; active: number; open: boolean; running: boolean; replace?: boolean };
  savedSignatures: SavedSignature[];
  pendingSignature: SavedSignature | null;
  pendingImage: { src: string; width: number; height: number } | null;
  /** Stamp chosen in the Stamp menu, placed with the next click. */
  pendingStamp: StampTemplate | null;
  clipboard: EditorObject[];
  /** Incremented to ask the viewer to scroll a page into view. */
  scrollRequest: { pageId: string; seq: number; y?: number } | null;
  /** Bumped when page rasters must be redrawn (e.g. form values changed). */
  renderEpoch: number;
  bumpRenderEpoch: () => void;

  // Reader view
  viewScroll: 'continuous' | 'single';
  viewSpread: 'none' | 'odd' | 'even';
  /** Rotation of the view only (the file is not changed). */
  viewRotation: Rotation;
  nightMode: boolean;
  presentation: boolean;
  /** Window full screen with the toolbars hidden (F11). */
  fullscreen: boolean;
  sidebarTab: SidebarTab;
  navBack: NavPoint[];
  navForward: NavPoint[];
  searchOptions: { caseSensitive: boolean; wholeWord: boolean };
  docMeta: DocMeta | null;
  /** Size + mtime of the file on disk when opened/saved, for auto-reload. */
  fileStamp: string | null;
  /** The source opened in this tab (the base its edits are saved into), see `primarySourceId`. */
  primarySource: string | null;
  setView: (patch: Partial<Pick<PDFState, 'viewScroll' | 'viewSpread' | 'viewRotation' | 'nightMode' | 'presentation' | 'fullscreen' | 'sidebarTab'>>) => void;
  /** Jumps to a page (and optional y), remembering where we came from. */
  navigateTo: (pageId: string, y?: number) => void;
  goBack: () => void;
  goForward: () => void;
  setSearchOptions: (patch: Partial<PDFState['searchOptions']>) => void;
  setDocMeta: (meta: DocMeta) => void;

  // Document actions
  /** `original`: `bytes` are exactly the file at `path` (not decrypted, converted or repaired). */
  loadDocument: (bytes: Uint8Array, name: string, path?: string | null, password?: string, original?: boolean) => Promise<void>;
  closeDocument: () => Promise<void>;
  /** `original`: the bytes are the file as it is on disk (incremental saves can append to them). */
  addSource: (bytes: Uint8Array, name: string, password?: string, original?: boolean) => Promise<{ source: SourceDoc; pages: PageRef[] }>;
  /** Releases sources that neither the document nor its undo history uses any more. */
  releaseUnusedSources: () => void;
  mergeDocument: (bytes: Uint8Array, name: string, atIndex?: number) => Promise<void>;
  markSaved: (path: string | null, name?: string) => void;
  setSignatureStatus: (s: SignatureValidation[]) => void;

  // History
  commit: (recipe: (s: UndoableState) => Partial<UndoableState>) => void;
  undo: () => void;
  redo: () => void;

  // Objects
  addObject: (obj: EditorObject, select?: boolean) => void;
  updateObject: (id: string, patch: Partial<EditorObject>) => void;
  updateObjects: (patches: Array<{ id: string; patch: Partial<EditorObject> }>) => void;
  deleteObjects: (ids: string[]) => void;
  /** Removes a just-created object as if it was never added (e.g. an empty new text box). */
  abandonNewObject: (id: string) => void;
  duplicateObjects: (ids: string[]) => void;
  reorderObject: (id: string, where: 'front' | 'back' | 'forward' | 'backward') => void;
  copySelection: () => void;
  paste: () => void;
  setFieldValue: (key: string, value: FieldValue) => void;
  /** Several field values in one undo step (a value and the totals it changes). */
  setFieldValues: (patch: Record<string, FieldValue>) => void;

  // Pages
  rotatePages: (pageIds: string[], delta: Rotation) => void;
  deletePages: (pageIds: string[]) => void;
  reorderPages: (orderedIds: string[]) => void;
  insertBlankPage: (index: number, size?: { width: number; height: number }) => void;
  duplicatePages: (pageIds: string[]) => void;

  // UI actions
  setTool: (tool: ToolId) => void;
  setRibbonTab: (tab: RibbonTab) => void;
  setStyle: (patch: Partial<ToolStyle>) => void;
  setZoom: (zoom: number, fitMode?: 'width' | 'page' | null) => void;
  select: (ids: string[], additive?: boolean) => void;
  selectInRect: (pageId: string, rect: { x: number; y: number; width: number; height: number }) => void;
  setCurrentPage: (pageId: string) => void;
  scrollToPage: (pageId: string, y?: number) => void;
  setEditingText: (id: string | null) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  setTheme: (t: 'light' | 'dark') => void;
  openModal: (m: ModalId) => void;
  setBusy: (b: BusyState | null) => void;
  toast: (message: string, kind?: Toast['kind'], action?: ToastAction) => void;
  dismissToast: (id: string) => void;
  setSearch: (patch: Partial<PDFState['search']>) => void;
  saveSignature: (sig: SavedSignature) => void;
  removeSavedSignature: (id: string) => void;
  setPendingSignature: (sig: SavedSignature | null) => void;
  setPendingImage: (img: PDFState['pendingImage']) => void;
  setPendingStamp: (t: StampTemplate | null) => void;
}

const DEFAULT_STYLE: ToolStyle = {
  stroke: '#e11d48',
  fill: null,
  strokeWidth: 2,
  opacity: 1,
  highlightColor: '#facc15',
  fontFamily: 'sans',
  fontSize: 14,
  color: '#0f172a',
  bold: false,
  italic: false,
};

const SIG_KEY = 'adika.savedSignatures.v1';
const THEME_KEY = 'adika.theme';

function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(SIG_KEY);
    return raw ? (JSON.parse(raw) as SavedSignature[]) : [];
  } catch {
    return [];
  }
}

function persistSignatures(list: SavedSignature[]): void {
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable: signatures stay for this session only */
  }
}

function initialTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function snapshot(s: UndoableState): UndoableState {
  return { pages: s.pages, objects: s.objects, fieldValues: s.fieldValues, outline: s.outline };
}

const EMPTY_DOC: UndoableState = { pages: [], objects: [], fieldValues: {}, outline: null };

const UNDOABLE_KEYS = ['pages', 'objects', 'fieldValues', 'outline'] as const;

/** Same document state (by reference: undo restores the very same objects). */
export function sameDoc(a: UndoableState, b: UndoableState | null): boolean {
  return !!b && UNDOABLE_KEYS.every((k) => a[k] === b[k]);
}

export const PASSWORD_READ_ONLY =
  'This PDF is password-protected, so it opens read-only. To edit it, open the original unprotected file (or ask its owner for one).';
export const OWNER_PASSWORD_READ_ONLY =
  'This PDF is protected by its author (an owner password restricts changes), so it opens read-only: Adika cannot save it without removing that protection. To edit it, use an unprotected copy from its author.';

/** Sources whose pages were in the document at some point (a source loaded just now and not used yet is kept). */
const usedSources = new Set<string>();

/** Source ids the document refers to now or in its undo/redo history. */
function referencedSources(s: Pick<PDFState, 'pages' | 'past' | 'future'>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<PageRef[]>();
  for (const pages of [s.pages, ...s.past.map((p) => p.pages), ...s.future.map((p) => p.pages)]) {
    if (seen.has(pages)) continue;
    seen.add(pages);
    for (const p of pages) if (p.sourceId) out.add(p.sourceId);
  }
  return out;
}

export const usePDFStore = create<PDFState>()((set, get) => ({
  ...EMPTY_DOC,
  sources: {},
  fileName: null,
  filePath: null,
  readOnlyReason: null,
  dirty: false,
  savedDoc: EMPTY_DOC,
  past: [],
  future: [],
  signatureStatus: [],

  tool: 'selectText',
  ribbonTab: 'home',
  style: DEFAULT_STYLE,
  zoom: 1,
  fitMode: 'width',
  selectedIds: [],
  currentPageId: null,
  editingTextId: null,
  sidebarOpen: true,
  inspectorOpen: true,
  theme: initialTheme(),
  modal: null,
  busy: null,
  toasts: [],
  search: { query: '', hits: [], active: 0, open: false, running: false },
  savedSignatures: loadSavedSignatures(),
  pendingSignature: null,
  pendingImage: null,
  pendingStamp: null,
  clipboard: [],
  scrollRequest: null,
  renderEpoch: 0,
  bumpRenderEpoch: () => set((s) => ({ renderEpoch: s.renderEpoch + 1 })),

  viewScroll: 'continuous',
  viewSpread: 'none',
  viewRotation: 0,
  nightMode: false,
  presentation: false,
  fullscreen: false,
  sidebarTab: 'pages',
  navBack: [],
  navForward: [],
  searchOptions: { caseSensitive: false, wholeWord: false },
  docMeta: null,
  fileStamp: null,
  primarySource: null,
  setView: (patch) => set(patch),
  navigateTo: (pageId, y) => {
    const s = get();
    const here: NavPoint | null = s.currentPageId ? { pageId: s.currentPageId } : null;
    set({ navBack: here ? [...s.navBack.slice(-49), here] : s.navBack, navForward: [] });
    get().scrollToPage(pageId, y);
  },
  goBack: () => {
    const s = get();
    const target = s.navBack[s.navBack.length - 1];
    if (!target || !s.pages.some((p) => p.id === target.pageId)) return;
    set({ navBack: s.navBack.slice(0, -1), navForward: s.currentPageId ? [{ pageId: s.currentPageId }, ...s.navForward] : s.navForward });
    get().scrollToPage(target.pageId, target.y);
  },
  goForward: () => {
    const s = get();
    const target = s.navForward[0];
    if (!target || !s.pages.some((p) => p.id === target.pageId)) return;
    set({ navForward: s.navForward.slice(1), navBack: s.currentPageId ? [...s.navBack, { pageId: s.currentPageId }] : s.navBack });
    get().scrollToPage(target.pageId, target.y);
  },
  setSearchOptions: (patch) => set((s) => ({ searchOptions: { ...s.searchOptions, ...patch } })),
  setDocMeta: (docMeta) => set({ docMeta, dirty: true, savedDoc: null }),

  // ------------------------------------------------------------ document

  addSource: async (bytes, name, password, original) => {
    const doc = await openPdf(bytes, password);
    const id = uid('src');
    registerSource(id, doc);
    const pages: PageRef[] = [];
    try {
      for (let i = 0; i < doc.numPages; i++) {
        const p = await doc.getPage(i + 1);
        const [x0, y0, x1, y1] = p.view;
        pages.push({
          id: uid('pg'),
          kind: 'source',
          sourceId: id,
          sourceIndex: i,
          baseRotation: normalizeRotation(p.rotate),
          userRotation: 0,
          width: Math.abs(x1 - x0),
          height: Math.abs(y1 - y0),
        });
      }
    } catch (e) {
      // A page that cannot be read: nothing of this source stays registered.
      void releaseSource(id);
      throw e;
    }
    const source: SourceDoc = { id, name, bytes, pageCount: doc.numPages, ...(password ? { password } : {}), ...(original ? { original } : {}) };
    set((s) => ({ sources: { ...s.sources, [id]: source } }));
    return { source, pages };
  },

  releaseUnusedSources: () => {
    const s = get();
    const live = referencedSources(s);
    for (const id of live) usedSources.add(id);
    const gone = Object.keys(s.sources).filter((id) => !live.has(id) && usedSources.has(id));
    if (!gone.length) return;
    set((st) => ({ sources: Object.fromEntries(Object.entries(st.sources).filter(([k]) => !gone.includes(k))) }));
    for (const id of gone) {
      usedSources.delete(id);
      void releaseSource(id);
    }
  },

  loadDocument: async (bytes, name, path = null, password, original = false) => {
    const previous = Object.keys(get().sources);
    const { isPdfEncrypted } = await import('@/lib/crypto/encrypt');
    // Opened without a password but encrypted: an owner password limits changes, and saving cannot re-encrypt it.
    const ownerLocked = !password && isPdfEncrypted(bytes);
    const { pages } = await get().addSource(bytes, name, password, original && !!path);
    for (const id of previous) {
      usedSources.delete(id);
      void releaseSource(id);
    }
    const doc: UndoableState = { ...EMPTY_DOC, pages };
    set((s) => ({
      ...doc,
      sources: Object.fromEntries(Object.entries(s.sources).filter(([k]) => !previous.includes(k))),
      fileName: name,
      filePath: path,
      readOnlyReason: password ? PASSWORD_READ_ONLY : ownerLocked ? OWNER_PASSWORD_READ_ONLY : null,
      dirty: false,
      savedDoc: doc,
      past: [],
      future: [],
      selectedIds: [],
      editingTextId: null,
      currentPageId: pages[0]?.id ?? null,
      signatureStatus: [],
      search: { query: '', hits: [], active: 0, open: false, running: false },
      fitMode: 'width',
      tool: 'selectText',
      navBack: [],
      navForward: [],
      viewRotation: 0,
      docMeta: null,
      fileStamp: null,
      primarySource: pages[0]?.sourceId ?? null,
    }));
  },

  closeDocument: async () => {
    // The tab stays open, empty (the welcome screen); other tabs are not touched.
    const ids = Object.keys(get().sources);
    for (const id of ids) usedSources.delete(id);
    set({
      ...EMPTY_DOC,
      sources: {},
      fileName: null,
      filePath: null,
      readOnlyReason: null,
      dirty: false,
      savedDoc: EMPTY_DOC,
      past: [],
      future: [],
      selectedIds: [],
      currentPageId: null,
      signatureStatus: [],
      editingTextId: null,
      search: { query: '', hits: [], active: 0, open: false, running: false },
      navBack: [],
      navForward: [],
      viewRotation: 0,
      docMeta: null,
      fileStamp: null,
      primarySource: null,
      scrollRequest: null,
    });
    await Promise.all(ids.map((id) => releaseSource(id)));
  },

  mergeDocument: async (bytes, name, atIndex) => {
    const { isPdfEncrypted } = await import('@/lib/crypto/encrypt');
    if (isPdfEncrypted(bytes)) throw new Error(`${name} is password-protected and cannot be merged. Use an unprotected copy.`);
    const { pages: added } = await get().addSource(bytes, name);
    get().commit((s) => {
      const pages = [...s.pages];
      pages.splice(atIndex ?? pages.length, 0, ...added);
      return { pages };
    });
  },

  markSaved: (path, name) => set((s) => ({ dirty: false, savedDoc: snapshot(s), filePath: path ?? s.filePath, fileName: name ?? s.fileName })),
  setSignatureStatus: (signatureStatus) => set({ signatureStatus }),

  // ------------------------------------------------------------ history

  commit: (recipe) => {
    const s = get();
    const before = snapshot(s);
    const patch = recipe(before);
    // Nothing changed (e.g. the recipe returned {}): no undo step, still clean.
    if (UNDOABLE_KEYS.every((k) => !(k in patch) || patch[k] === before[k])) return;
    const past = [...s.past, before];
    const trimmed = past.length > HISTORY_LIMIT;
    if (trimmed) past.shift();
    const hadFuture = s.future.length > 0;
    const next = { ...before, ...patch };
    set({ ...patch, past, future: [], dirty: !sameDoc(next, s.savedDoc) });
    if (trimmed || hadFuture || patch.pages) get().releaseUnusedSources();
  },

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({
      ...prev,
      past: s.past.slice(0, -1),
      future: [snapshot(s), ...s.future],
      dirty: !sameDoc(prev, s.savedDoc),
      selectedIds: s.selectedIds.filter((id) => prev.objects.some((o) => o.id === id)),
      editingTextId: null,
    });
  },

  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      ...next,
      past: [...s.past, snapshot(s)],
      future: s.future.slice(1),
      dirty: !sameDoc(next, s.savedDoc),
      selectedIds: s.selectedIds.filter((id) => next.objects.some((o) => o.id === id)),
      editingTextId: null,
    });
  },

  // ------------------------------------------------------------ objects

  addObject: (obj, selectIt = true) => {
    get().commit((s) => ({ objects: [...s.objects, obj] }));
    if (selectIt) set({ selectedIds: [obj.id] });
  },

  updateObject: (id, patch) => get().updateObjects([{ id, patch }]),

  updateObjects: (patches) => {
    const map = new Map(patches.map((p) => [p.id, p.patch]));
    get().commit((s) => ({
      objects: s.objects.map((o) => {
        const p = map.get(o.id);
        return p ? ({ ...o, ...p } as EditorObject) : o;
      }),
    }));
  },

  deleteObjects: (ids) => {
    if (ids.length === 0) return;
    const set_ = new Set(ids);
    get().commit((s) => ({ objects: s.objects.filter((o) => !set_.has(o.id) || o.locked) }));
    set((s) => ({ selectedIds: s.selectedIds.filter((id) => !set_.has(id)), editingTextId: null }));
  },

  abandonNewObject: (id) => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    const createdByLastCommit = prev && !prev.objects.some((o) => o.id === id) && s.objects.some((o) => o.id === id);
    if (createdByLastCommit) {
      set({ ...prev, past: s.past.slice(0, -1), future: [], dirty: !sameDoc(prev, s.savedDoc), selectedIds: [], editingTextId: null });
    } else {
      get().deleteObjects([id]);
    }
  },

  duplicateObjects: (ids) => {
    const src = get().objects.filter((o) => ids.includes(o.id));
    if (src.length === 0) return;
    const copies = src.map((o) => ({ ...o, id: uid('obj'), x: o.x + 12, y: o.y + 12, locked: false }) as EditorObject);
    get().commit((s) => ({ objects: [...s.objects, ...copies] }));
    set({ selectedIds: copies.map((c) => c.id) });
  },

  reorderObject: (id, where) => {
    get().commit((s) => {
      const objs = [...s.objects];
      const i = objs.findIndex((o) => o.id === id);
      if (i < 0) return {};
      const [obj] = objs.splice(i, 1);
      const samePage = (o: EditorObject) => o.pageId === obj.pageId;
      if (where === 'front') objs.push(obj);
      else if (where === 'back') objs.unshift(obj);
      else if (where === 'forward') {
        let j = i;
        while (j < objs.length && !samePage(objs[j])) j++;
        objs.splice(Math.min(j + 1, objs.length), 0, obj);
      } else {
        let j = i - 1;
        while (j >= 0 && !samePage(objs[j])) j--;
        objs.splice(Math.max(j, 0), 0, obj);
      }
      return { objects: objs };
    });
  },

  copySelection: () => {
    const s = get();
    set({ clipboard: s.objects.filter((o) => s.selectedIds.includes(o.id)) });
  },

  paste: () => {
    const s = get();
    if (s.clipboard.length === 0) return;
    const target = s.currentPageId ?? s.pages[0]?.id;
    if (!target) return;
    const sameTarget = s.clipboard.every((o) => o.pageId === target);
    const copies = s.clipboard.map(
      (o) =>
        ({ ...o, id: uid('obj'), pageId: target, x: o.x + (sameTarget ? 14 : 0), y: o.y + (sameTarget ? 14 : 0), locked: false }) as EditorObject,
    );
    get().commit((st) => ({ objects: [...st.objects, ...copies] }));
    set({ selectedIds: copies.map((c) => c.id), clipboard: copies });
  },

  setFieldValue: (key, value) => get().commit((s) => ({ fieldValues: { ...s.fieldValues, [key]: value } })),
  setFieldValues: (patch) => get().commit((s) => ({ fieldValues: { ...s.fieldValues, ...patch } })),

  // ------------------------------------------------------------ pages

  rotatePages: (pageIds, delta) => {
    const d = normalizeRotation(delta);
    if (d === 0 || pageIds.length === 0) return;
    get().commit((s) => {
      const target = new Set(pageIds);
      const before = new Map(s.pages.filter((p) => target.has(p.id)).map((p) => [p.id, displaySize(p)]));
      return {
        pages: s.pages.map((p) => (target.has(p.id) ? { ...p, userRotation: normalizeRotation(p.userRotation + d) } : p)),
        // Objects are stored in display space, so they rotate with the page.
        objects: s.objects.map((o) => {
          const size = before.get(o.pageId);
          return size ? rotateObjectWithPage(o, d, size.width, size.height) : o;
        }),
      };
    });
  },

  deletePages: (pageIds) => {
    const s = get();
    const remove = new Set(pageIds);
    if (s.pages.every((p) => remove.has(p.id))) {
      get().toast('A document needs at least one page.', 'error');
      return;
    }
    get().commit((st) => ({
      pages: st.pages.filter((p) => !remove.has(p.id)),
      objects: st.objects.filter((o) => !remove.has(o.pageId)),
    }));
    const remaining = get().pages;
    if (!remaining.some((p) => p.id === get().currentPageId)) set({ currentPageId: remaining[0]?.id ?? null });
    set((st) => ({ selectedIds: st.selectedIds.filter((id) => st.objects.some((o) => o.id === id)) }));
  },

  reorderPages: (orderedIds) => {
    const s = get();
    const byId = new Map(s.pages.map((p) => [p.id, p]));
    const next = orderedIds.map((id) => byId.get(id)).filter((p): p is PageRef => !!p);
    if (next.length !== s.pages.length) return;
    if (next.every((p, i) => p.id === s.pages[i].id)) return;
    get().commit(() => ({ pages: next }));
  },

  insertBlankPage: (index, size) => {
    const s = get();
    const ref = s.pages[Math.max(0, Math.min(index - 1, s.pages.length - 1))];
    const dims = size ?? (ref ? displaySize(ref) : { width: 595.28, height: 841.89 });
    const page: PageRef = {
      id: uid('pg'),
      kind: 'blank',
      sourceId: null,
      sourceIndex: 0,
      baseRotation: 0,
      userRotation: 0,
      width: dims.width,
      height: dims.height,
    };
    get().commit((st) => {
      const pages = [...st.pages];
      pages.splice(Math.max(0, Math.min(index, pages.length)), 0, page);
      return { pages };
    });
    set({ currentPageId: page.id });
  },

  duplicatePages: (pageIds) => {
    get().commit((s) => {
      const pages: PageRef[] = [];
      const objects = [...s.objects];
      for (const p of s.pages) {
        pages.push(p);
        if (pageIds.includes(p.id)) {
          const copy = { ...p, id: uid('pg') };
          pages.push(copy);
          for (const o of s.objects) if (o.pageId === p.id) objects.push({ ...o, id: uid('obj'), pageId: copy.id } as EditorObject);
        }
      }
      return { pages, objects };
    });
  },

  // ------------------------------------------------------------ UI

  setTool: (tool) => {
    // Editing works in page coordinates; a rotated *view* only supports reading.
    if (get().viewRotation !== 0 && !['selectText', 'pan', 'select'].includes(tool)) {
      get().toast('Reset the view rotation (View → Rotate view) to edit.', 'info');
      return;
    }
    set({ tool, editingTextId: null, ...(tool !== 'select' ? { selectedIds: [] } : {}) });
  },
  setRibbonTab: (ribbonTab) => set({ ribbonTab }),
  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
  setZoom: (zoom, fitMode = null) =>
    set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 1000) / 1000)), fitMode }),
  select: (ids, additive = false) =>
    set((s) => ({
      selectedIds: additive ? [...new Set([...s.selectedIds.filter((i) => !ids.includes(i)), ...ids.filter((i) => !s.selectedIds.includes(i))])] : ids,
    })),
  selectInRect: (pageId, rect) => {
    const ids = get()
      .objects.filter((o) => o.pageId === pageId && !o.locked && rectsIntersect(objectDisplayBounds(o), rect))
      .map((o) => o.id);
    set({ selectedIds: ids });
  },
  setCurrentPage: (currentPageId) => {
    if (get().currentPageId !== currentPageId) set({ currentPageId });
  },
  scrollToPage: (pageId, y) =>
    set((s) => ({ currentPageId: pageId, scrollRequest: { pageId, y, seq: (s.scrollRequest?.seq ?? 0) + 1 } })),
  setEditingText: (editingTextId) => set({ editingTextId }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    set({ theme });
  },
  openModal: (modal) => set({ modal }),
  setBusy: (busy) => set({ busy }),
  toast: (message, kind = 'info', action) => {
    const id = uid('toast');
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, action }] }));
    setTimeout(() => get().dismissToast(id), action ? 15000 : kind === 'error' ? 9000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setSearch: (patch) => set((s) => ({ search: { ...s.search, ...patch } })),
  saveSignature: (sig) => {
    const list = [sig, ...get().savedSignatures.filter((s) => s.id !== sig.id)].slice(0, 12);
    persistSignatures(list);
    set({ savedSignatures: list });
  },
  removeSavedSignature: (id) => {
    const list = get().savedSignatures.filter((s) => s.id !== id);
    persistSignatures(list);
    set({ savedSignatures: list });
  },
  setPendingSignature: (pendingSignature) => set({ pendingSignature, tool: pendingSignature ? 'signature' : 'select' }),
  setPendingImage: (pendingImage) => set({ pendingImage, tool: pendingImage ? 'image' : 'select' }),
  setPendingStamp: (pendingStamp) => set({ pendingStamp, tool: pendingStamp ? 'stamp' : 'select' }),
}));

// Marked unsaved from outside the history (a converted or repaired file, a tool's result): undo cannot make it clean.
usePDFStore.subscribe((s, prev) => {
  if (s.dirty && !prev.dirty && s.savedDoc && sameDoc(s, s.savedDoc)) usePDFStore.setState({ savedDoc: null });
});

/**
 * The tab's own document: the opened file while any of its pages is still in
 * the document (also when another file's page was put first), else the first page's source.
 */
export function primarySourceId(s: Pick<PDFState, 'pages' | 'primarySource'> = usePDFStore.getState()): string | null {
  if (s.primarySource && s.pages.some((p) => p.sourceId === s.primarySource)) return s.primarySource;
  return s.pages.find((p) => p.kind === 'source' && p.sourceId)?.sourceId ?? null;
}

/** Snapshot of the undoable document, e.g. for export. */
export function currentDoc(): DocSnapshot & { sources: Record<string, SourceDoc>; fieldValues: Record<string, FieldValue>; baseSourceId: string | null } {
  const s = usePDFStore.getState();
  return { pages: s.pages, objects: s.objects, sources: s.sources, fieldValues: s.fieldValues, outline: s.outline, baseSourceId: primarySourceId(s) };
}
