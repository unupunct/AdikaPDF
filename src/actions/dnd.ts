/**
 * Drag and drop: files from Explorer, pages between documents, file lists in
 * dialogs. Routing is in lib/dnd.ts; this file reads the drop, finds the
 * target under the pointer and carries the plan out.
 *
 * Files from Explorer come as WebView `File` objects; their locations come
 * from the native side (droppaths.rs) where WebView2 provides them. Without
 * a location a file still opens from its bytes (Office conversion and the
 * batch lists need the location).
 *
 * Pages dragged onto another tab's document are copied (the source document
 * keeps them): moving would change a document that is not on screen.
 */
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { useDnd } from '@/store/dnd';
import { switchTab, tabSlice, useTabs } from '@/store/tabs';
import { askChoice, askConfirm } from '@/store/useDialogs';
import { fileKind } from '@/lib/fileKinds';
import { dropLabel, NOTHING_SUPPORTED, planDrop, planPageDrop, reorderedIds, type DropDoc, type DropEntry, type DropTarget } from '@/lib/dnd';
import { isDesktop, readFile } from '@/lib/platform';
import { uid } from '@/lib/uid';
import { errorMessage, openPdfBytes, openPdfPath, withBusy } from './document';

export interface DroppedFile {
  name: string;
  /** Location on disk (desktop app); null when the WebView did not give one. */
  path: string | null;
  isDir: boolean;
  read: () => Promise<Uint8Array>;
  /** A folder without a location: the files in it (and in its subfolders when asked). */
  list?: (deep: boolean) => Promise<DroppedFile[]>;
}

export { useDnd };

/** Hovering a tab this long during a drag switches to it. */
export const TAB_HOVER_MS = 600;
/** Opening more PDFs from a dropped folder than this asks first. */
export const FOLDER_OPEN_LIMIT = 20;

// ---------------------------------------------------------------- dialog lists

type ListHandler = (files: DroppedFile[]) => void | Promise<void>;
const lists = new Map<string, ListHandler>();

/** A dialog's file list accepts drops (`data-drop-list={name}` on its element). Returns the unregister function. */
export function registerDropList(name: string, handler: ListHandler): () => void {
  lists.set(name, handler);
  return () => {
    if (lists.get(name) === handler) lists.delete(name);
  };
}

/**
 * Dropped files and folders as PDF paths for a file list: folders give their
 * PDFs (with subfolders when `deep`); other files are skipped; files without
 * a location cannot be listed.
 */
export async function listPaths(
  files: DroppedFile[],
  deep: boolean,
  collect: (folder: string, deep: boolean) => Promise<string[]> = async (f, d) => (await import('./batchSign')).collectPdfs(f, d),
): Promise<{ paths: string[]; skipped: string[]; noPath: string[] }> {
  const out = { paths: [] as string[], skipped: [] as string[], noPath: [] as string[] };
  for (const f of files) {
    if (!f.path) out.noPath.push(f.name);
    else if (f.isDir) out.paths.push(...(await collect(f.path, deep)));
    else if (fileKind(f.name) === 'pdf') out.paths.push(f.path);
    else out.skipped.push(f.name);
  }
  out.paths = [...new Set(out.paths)];
  return out;
}

/** Adds dropped files to a dialog's list of paths, with the toasts for what was left out. */
export async function dropIntoList(files: DroppedFile[], deep: boolean, add: (paths: string[]) => void): Promise<void> {
  const r = await listPaths(files, deep);
  const store = usePDFStore.getState();
  if (r.noPath.length) store.toast('Adika could not find where the dropped files are on disk. Use the Add button instead.', 'error');
  if (r.skipped.length) store.toast(`Only PDFs can be added. Left out: ${r.skipped.join(', ')}`, 'info');
  if (r.paths.length) {
    add(r.paths);
    store.toast(r.paths.length === 1 ? 'Added 1 PDF to the list.' : `Added ${r.paths.length} PDFs to the list.`, 'success');
  } else if (!r.noPath.length && !r.skipped.length) store.toast('No PDFs found in the dropped folder.', 'info');
}

// ---------------------------------------------------------------- targets

function docState(): DropDoc {
  const s = usePDFStore.getState();
  return { hasDoc: s.pages.length > 0, pagesBlocked: blockedReason(s, 'pages'), contentBlocked: blockedReason(s, 'content') };
}

function thumbIndexAt(area: Element, clientY: number): number {
  const items = Array.from(area.querySelectorAll<HTMLElement>('[data-thumb-index]'));
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return Number(it.dataset.thumbIndex);
  }
  const last = items[items.length - 1];
  return last ? Number(last.dataset.thumbIndex) + 1 : usePDFStore.getState().pages.length;
}

function pageTarget(el: HTMLElement, clientX: number, clientY: number, onPage: boolean): DropTarget {
  const s = usePDFStore.getState();
  const pageId = el.dataset.pageId!;
  const r = el.getBoundingClientRect();
  const zoom = s.zoom || 1;
  return {
    kind: 'page',
    pageId,
    pageIndex: Math.max(0, s.pages.findIndex((p) => p.id === pageId)),
    x: Math.max(0, (clientX - r.left) / zoom),
    y: Math.max(0, (clientY - r.top) / zoom),
    onPage,
  };
}

/** The drop target under the pointer. */
export function resolveTarget(el: Element | null, clientX: number, clientY: number): DropTarget {
  const list = el?.closest<HTMLElement>('[data-drop-list]');
  if (list) return { kind: 'list', list: list.dataset.dropList! };
  // A dialog is open: only its file lists take drops.
  if (el?.closest('[role="dialog"],[role="alertdialog"]') || document.querySelector('[role="dialog"],[role="alertdialog"]') || usePDFStore.getState().modal) return { kind: 'dialog' };
  if (!el) return { kind: 'app' };
  const tab = el.closest<HTMLElement>('[data-tab-id]');
  if (tab) return { kind: 'tab', tabId: tab.dataset.tabId! };
  const thumbs = el.closest('[data-drop-area="thumbs"]');
  if (thumbs) return { kind: 'thumbs', index: thumbIndexAt(thumbs, clientY) };
  const page = el.closest<HTMLElement>('[data-page-id]');
  if (page) return pageTarget(page, clientX, clientY, true);
  const area = el.closest('[data-drop-area="pages"]');
  if (area) {
    // Between pages: the nearest one.
    let best: HTMLElement | null = null;
    let dist = Infinity;
    for (const p of Array.from(area.querySelectorAll<HTMLElement>('[data-page-id]'))) {
      const r = p.getBoundingClientRect();
      const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      if (d < dist) [best, dist] = [p, d];
    }
    if (best) {
      const r = best.getBoundingClientRect();
      // Above the first page: before it.
      if (clientY < r.top && best.dataset.pageId === usePDFStore.getState().pages[0]?.id) return { kind: 'thumbs', index: 0 };
      return pageTarget(best, clientX, clientY, false);
    }
  }
  return { kind: 'app' };
}

export function resolveTargetAt(clientX: number, clientY: number): DropTarget {
  return resolveTarget(document.elementFromPoint(clientX, clientY), clientX, clientY);
}

// ---------------------------------------------------------------- hover feedback

let hoverTab: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

function hoverTabFor(target: DropTarget | null): void {
  const id = target?.kind === 'tab' && target.tabId !== useTabs.getState().activeId ? target.tabId : null;
  if (hoverTab?.id === id) return;
  if (hoverTab) clearTimeout(hoverTab.timer);
  hoverTab = id ? { id, timer: setTimeout(() => ((hoverTab = null), switchTab(id)), TAB_HOVER_MS) } : null;
}

/** What a drag over this target would do; updates the overlay. Returns the drop effect ('none': refused). */
export function previewDrag(kind: 'files' | 'pages', target: DropTarget, entries: DropEntry[]): 'copy' | 'move' | 'none' {
  const doc = docState();
  const pageCount = usePDFStore.getState().pages.length;
  let label: string;
  let rejected: string | null;
  let effect: 'copy' | 'move' = 'copy';
  let insertAt: number | null = null;
  if (kind === 'pages') {
    const drag = useDnd.getState().pageDrag;
    const r = drag ? planPageDrop(drag, useTabs.getState().activeId, target, doc) : { action: 'none' as const, at: null, rejected: null };
    rejected = r.rejected;
    insertAt = r.at;
    label = rejected ?? { switch: 'Hold to switch to this document', reorder: 'Move the page here', copy: 'Copy the page into this document', none: '' }[r.action];
    // Nothing to do here (the toolbar, the status bar): no drop, but nothing to explain either.
    if (r.action === 'none' && rejected === null) rejected = '';
    if (r.action === 'reorder') effect = 'move';
  } else if (target.kind === 'list') {
    rejected = lists.has(target.list) ? null : NOT_HERE;
    label = rejected ?? 'Add to the list';
  } else {
    const plan = planDrop(entries, target, doc);
    rejected = plan.rejected;
    label = dropLabel(plan, target, pageCount);
    insertAt = plan.insertAt;
  }
  hoverTabFor(target);
  useDnd.setState({ active: kind, target, label, rejected: rejected !== null, insertAt: rejected === null ? insertAt : null });
  return rejected === null ? effect : 'none';
}

const NOT_HERE = 'Files cannot be dropped here.';
const pagesWord = (verb: 'Inserted' | 'Copied', n: number) => (n === 1 ? `${verb} 1 page.` : `${verb} ${n} pages.`);

export function endDrag(): void {
  hoverTabFor(null);
  useDnd.setState({ active: null, target: null, label: '', rejected: false, insertAt: null, pageDrag: null });
}

// ---------------------------------------------------------------- reading a drop

let installed: Promise<unknown> | null = null;

/** Starts listening for the native side's file paths (once per window). */
export function installDropPaths(): void {
  if (!isDesktop || installed) return;
  installed = import('@tauri-apps/api/core').then(({ invoke }) => invoke('drop_paths_install')).catch(() => undefined);
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects?: (message: unknown, objects: ArrayLike<unknown>) => void;
}

/** Each file's location on disk, from WebView2 (null where it has none). */
export async function dropPaths(files: File[]): Promise<Array<string | null>> {
  const none = files.map(() => null);
  const bridge = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!isDesktop || !files.length || !bridge?.postMessageWithAdditionalObjects) return none;
  installDropPaths();
  await installed;
  const { invoke } = await import('@tauri-apps/api/core');
  const token = uid('drop').replace(/[^\w-]/g, '');
  try {
    bridge.postMessageWithAdditionalObjects({ adikaDropPaths: token }, files);
  } catch {
    return none;
  }
  for (let i = 0; i < 40; i++) {
    const got = await invoke<string[] | null>('drop_paths_take', { token }).catch(() => null);
    if (got) return files.map((_, k) => got[k] || null);
    await new Promise((r) => setTimeout(r, 25));
  }
  return none;
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string };
type FileEntry = Entry & { file: (ok: (f: File) => void, fail: (e: unknown) => void) => void };
type DirEntry = Entry & { createReader: () => { readEntries: (ok: (e: Entry[]) => void, fail: (e: unknown) => void) => void } };

function fromFile(f: File, path: string | null): DroppedFile {
  return { name: f.name, path, isDir: false, read: async () => (path ? readFile(path).catch(async () => new Uint8Array(await f.arrayBuffer())) : new Uint8Array(await f.arrayBuffer())) };
}

function fromDirEntry(dir: DirEntry): DroppedFile {
  return { name: dir.name, path: null, isDir: true, read: async () => new Uint8Array(), list: (deep) => listEntry(dir, deep) };
}

async function listEntry(dir: DirEntry, deep: boolean, depth = 0): Promise<DroppedFile[]> {
  const reader = dir.createReader();
  const out: DroppedFile[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail)).catch(() => []);
    if (!batch.length) break;
    for (const e of batch) {
      if (e.isFile) {
        const f = await new Promise<File>((ok, fail) => (e as FileEntry).file(ok, fail)).catch(() => null);
        if (f) out.push(fromFile(f, null));
      } else if (e.isDirectory && deep && depth < 32) out.push(...(await listEntry(e as DirEntry, deep, depth + 1)));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Takes what the drop event carries (call it during the event: the data is gone afterwards). */
export function captureDrop(dt: DataTransfer): () => Promise<DroppedFile[]> {
  const files = Array.from(dt.files ?? []);
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry?.() as Entry | null) ?? null);
  return async () => {
    const paths = await dropPaths(files);
    return files.map((f, i) => {
      const entry = entries.length === files.length ? entries[i] : entries.find((e) => e?.name === f.name) ?? null;
      const path = paths[i];
      if (entry?.isDirectory) return path ? { name: f.name, path, isDir: true, read: async () => new Uint8Array() } : fromDirEntry(entry as DirEntry);
      return fromFile(f, path);
    });
  };
}

/** Files on disk (the end-to-end tests drop these through `window.__adika.dnd`). */
export async function droppedFromPaths(paths: string[]): Promise<DroppedFile[]> {
  const { listDir } = await import('@/lib/platform');
  const out: DroppedFile[] = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() || path;
    const isDir = await listDir(path).then(() => true, () => false);
    out.push({ name, path, isDir, read: () => readFile(path) });
  }
  return out;
}

/**
 * The end-to-end tests' way in for drops from Explorer (a test cannot start an
 * OS drag): the same handling as a real drop of these files at a point in the
 * window (or an explicit target).
 */
export async function e2eDropPaths(paths: string[], at: { x: number; y: number } | DropTarget = { kind: 'app' }): Promise<DropTarget> {
  const target = 'kind' in at ? at : resolveTargetAt(at.x, at.y);
  await dropFiles(await droppedFromPaths(paths), target);
  return target;
}

export function entryOf(f: DroppedFile): DropEntry {
  return { kind: f.isDir ? 'folder' : fileKind(f.name) };
}

/** The PDFs in dropped folders (with their subfolders when `deep`). */
export async function folderPdfs(folders: DroppedFile[], deep: boolean): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const d of folders) {
    if (d.path) {
      const { collectPdfs } = await import('./batchSign');
      for (const p of await collectPdfs(d.path, deep)) out.push({ name: p.split(/[\\/]/).pop() || p, path: p, isDir: false, read: () => readFile(p) });
    } else if (d.list) out.push(...(await d.list(deep)).filter((f) => fileKind(f.name) === 'pdf'));
  }
  return out;
}

// ---------------------------------------------------------------- carrying out file drops

async function openPdfFile(f: DroppedFile): Promise<boolean> {
  return f.path ? openPdfPath(f.path) : openPdfBytes(await f.read(), f.name);
}

/** A dropped file as PDF bytes (PDFs as they are, the rest converted). */
async function asPdf(f: DroppedFile): Promise<Uint8Array> {
  if (fileKind(f.name) === 'pdf') return f.read();
  const { fileToPdf } = await import('./launch');
  return fileToPdf(f.name, f.path, f.path && fileKind(f.name) === 'office' ? null : await f.read());
}

async function decodeImages(files: DroppedFile[]): Promise<Array<{ src: string; width: number; height: number }>> {
  const { decodeImageFile } = await import('./convert');
  const out: Array<{ src: string; width: number; height: number }> = [];
  for (const f of files) out.push(...(await decodeImageFile(await f.read(), f.name)));
  return out;
}

/** Carries out a drop of files onto a target. */
export async function dropFiles(files: DroppedFile[], target: DropTarget): Promise<void> {
  const store = usePDFStore.getState();
  if (!files.length) return;
  if (target.kind === 'list') {
    const handler = lists.get(target.list);
    if (handler) await handler(files);
    return;
  }
  const plan = planDrop(files.map(entryOf), target, docState());
  const pick = (ix: number[]) => ix.map((i) => files[i]);
  if (plan.rejected) {
    store.toast(plan.rejected === NOTHING_SUPPORTED ? `Not opened (unsupported file type): ${files.map((f) => f.name).join(', ')}` : plan.rejected, 'error');
    return;
  }
  if (plan.unsupported.length) store.toast(`Not opened (unsupported file type): ${pick(plan.unsupported).map((f) => f.name).join(', ')}`, 'error');
  if (plan.note) store.toast(plan.note, 'info');

  try {
    if (plan.place) {
      const place = plan.place;
      const images = await withBusy('Placing pictures…', () => decodeImages(pick(plan.images)));
      if (images?.length) {
        const { makeImage } = await import('@/lib/objectFactory');
        const objs = images.map((img, i) => makeImage(place.pageId, place.x + i * 16, place.y + i * 16, img));
        const s = usePDFStore.getState();
        s.commit((st) => ({ objects: [...st.objects, ...objs] }));
        usePDFStore.setState({ selectedIds: objs.map((o) => o.id), tool: 'select' });
        s.toast(objs.length === 1 ? 'Placed 1 picture on the page.' : `Placed ${objs.length} pictures on the page.`, 'success');
      }
    }

    const pageFiles = [...pick(plan.pdfs), ...pick(plan.convert)];
    const pageImages = plan.place ? [] : pick(plan.images);
    if (pageFiles.length || pageImages.length) {
      let insert = false;
      if (plan.ask && plan.insertAt !== null) {
        const n = pageFiles.length + pageImages.length;
        const at = plan.insertAt;
        const count = usePDFStore.getState().pages.length;
        const choice = await askChoice({
          title: n === 1 ? 'Dropped file' : `Dropped ${n} files`,
          message:
            at <= 0
              ? 'Insert the pages at the beginning of this document, or open in a new tab?'
              : at >= count
                ? 'Insert the pages at the end of this document, or open in a new tab?'
                : `Insert the pages after page ${at} of this document, or open in a new tab?`,
          confirmLabel: 'Insert pages here',
          altLabel: 'Open in new tab',
        });
        if (choice === null) return;
        insert = choice === 'confirm';
      }
      if (insert) await insertFiles(pageFiles, pageImages, plan.insertAt!);
      else await openFiles(pageFiles, pageImages);
    }

    for (const f of pick(plan.einvoices)) {
      const { openEInvoice } = await import('./einvoice');
      await openEInvoice(await f.read(), f.name);
    }
    if (plan.folders.length) await openFolders(pick(plan.folders));
  } catch (e) {
    usePDFStore.getState().toast(errorMessage(e), 'error');
  }
}

async function insertFiles(files: DroppedFile[], images: DroppedFile[], at: number): Promise<void> {
  const before = usePDFStore.getState().pages.length;
  let pos = at;
  const failed: string[] = [];
  await withBusy('Adding pages…', async (progress) => {
    const total = files.length + (images.length ? 1 : 0);
    let k = 0;
    const add = async (bytes: Uint8Array, name: string) => {
      const n0 = usePDFStore.getState().pages.length;
      await usePDFStore.getState().mergeDocument(bytes, name, pos);
      pos += usePDFStore.getState().pages.length - n0;
    };
    for (const f of files) {
      progress(`Adding ${f.name}…`, k++ / total);
      try {
        await add(await asPdf(f), f.name);
      } catch (e) {
        failed.push(`${f.name}: ${errorMessage(e)}`);
      }
    }
    if (images.length) {
      progress('Adding pictures…', k / total);
      const { imagesToPdf } = await import('./convert');
      await add(await imagesToPdf(await decodeImages(images), { pageSize: 'a4', orientation: 'auto', marginMm: 10 }), images[0].name);
    }
  });
  const s = usePDFStore.getState();
  const added = s.pages.length - before;
  if (failed.length) s.toast(failed.join('\n'), 'error');
  if (added > 0) {
    s.toast(pagesWord('Inserted', added), 'success');
    const first = s.pages[at];
    if (first) s.scrollToPage(first.id);
  }
}

async function openFiles(files: DroppedFile[], images: DroppedFile[]): Promise<void> {
  const { deliverPdf, imagesToPdf } = await import('./convert');
  for (const f of files) {
    try {
      if (fileKind(f.name) === 'pdf') await openPdfFile(f);
      else {
        const pdf = await withBusy(`Converting ${f.name}…`, () => asPdf(f));
        if (pdf) await deliverPdf(pdf, f.name, false);
      }
    } catch (e) {
      usePDFStore.getState().toast(`${f.name}: ${errorMessage(e)}`, 'error');
    }
  }
  if (images.length) {
    const pdf = await withBusy('Creating PDF from images…', async () => imagesToPdf(await decodeImages(images), { pageSize: 'a4', orientation: 'auto', marginMm: 10 }));
    if (pdf) await deliverPdf(pdf, `${images[0].name}.pdf`, false);
  }
}

async function openFolders(folders: DroppedFile[]): Promise<void> {
  const pdfs = await folderPdfs(folders, false);
  const store = usePDFStore.getState();
  const folderName = folders.map((f) => f.name).join(', ');
  if (!pdfs.length) {
    store.toast(`No PDFs in ${folderName}.`, 'info');
    return;
  }
  const many = pdfs.length > FOLDER_OPEN_LIMIT;
  const ok = await askConfirm({
    title: 'Open the PDFs in this folder?',
    message: many
      ? `The folder has ${pdfs.length} PDFs. Opening them all takes a while and uses a lot of memory. Open all of them, each in its own tab?`
      : pdfs.length === 1
        ? 'Open the PDF in this folder?'
        : `Open the ${pdfs.length} PDFs in this folder, each in its own tab?`,
    confirmLabel: many ? `Open all ${pdfs.length}` : 'Open',
  });
  if (!ok) return;
  for (const f of pdfs) await openPdfFile(f);
}

// ---------------------------------------------------------------- pages between documents

export function startPageDrag(pageIds: string[]): void {
  const s = usePDFStore.getState();
  useDnd.setState({ pageDrag: { tabId: useTabs.getState().activeId, pageIds, copyBlocked: blockedReason(s, 'copy') } });
}

/** Carries out a drop of dragged pages (reorder in the same document, copy into another). */
export async function dropPages(target: DropTarget): Promise<void> {
  const drag = useDnd.getState().pageDrag;
  if (!drag) return;
  const r = planPageDrop(drag, useTabs.getState().activeId, target, docState());
  const s = usePDFStore.getState();
  if (r.rejected) {
    s.toast(r.rejected, 'error');
    return;
  }
  if (r.action === 'reorder' && r.at !== null) {
    s.reorderPages(reorderedIds(s.pages.map((p) => p.id), drag.pageIds, r.at));
    s.toast(drag.pageIds.length === 1 ? 'Page moved.' : `${drag.pageIds.length} pages moved.`, 'success');
  } else if (r.action === 'copy' && r.at !== null) await copyPagesFromTab(drag.tabId, drag.pageIds, r.at);
}

/** Copies pages of another tab's document (with their edits) into the active document at `at`. */
export async function copyPagesFromTab(tabId: string, pageIds: string[], at: number): Promise<void> {
  const src = tabSlice(tabId);
  if (!src) return;
  const ids = new Set(pageIds);
  const pages = src.pages.filter((p) => ids.has(p.id));
  if (!pages.length) return;
  const before = usePDFStore.getState().pages.length;
  await withBusy('Copying pages…', async () => {
    const [{ buildPdf }, { rasterizeWithRedactions }] = await Promise.all([import('@/lib/pdf/exportPdf'), import('./document')]);
    const bytes = await buildPdf(
      { sources: src.sources, pages, objects: src.objects.filter((o) => ids.has(o.pageId)), fieldValues: src.fieldValues },
      { rasterizeRedactedPage: (p, rects) => rasterizeWithRedactions(p, rects) },
    );
    await usePDFStore.getState().mergeDocument(bytes, src.fileName ?? 'Pages', at);
  });
  const s = usePDFStore.getState();
  const added = s.pages.length - before;
  if (added > 0) {
    s.toast(pagesWord('Copied', added), 'success');
    const first = s.pages[at];
    if (first) s.scrollToPage(first.id);
  }
}
