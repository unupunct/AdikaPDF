/**
 * Automatic backup of unsaved documents. A few seconds after each change the
 * active document (its source PDFs once, then pages, edits, form values,
 * bookmarks) is written to the Recovery folder; a tab is backed up again
 * when you switch away from it, so every tab with unsaved changes has one.
 * Saving or closing the document removes its backup; after a crash the next
 * start offers to recover what was left.
 */
import { invoke } from '@tauri-apps/api/core';
import { protectionOf, usePDFStore } from '@/store/usePDFStore';
import { activeTabIsEmpty, newTab, tabSlice, useTabs, type DocSlice } from '@/store/tabs';
import { isDesktop } from './platform';
import { uid } from './uid';
import type { BookmarkItem, EditorObject, PageRef } from '@/types';
import type { FieldValue } from '@/store/usePDFStore';

const DELAY = 4000;
const session = uid('s').replace(/[^A-Za-z0-9_-]/g, '_');
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

interface BackupSource {
  id: string;
  name: string;
  pageCount: number;
  file: string;
  /** Opened with a password: asked again when restored (passwords are never written). */
  password?: boolean;
  /** The bytes are the file as on disk (incremental saves). */
  original?: boolean;
  /** A converted dynamic XFA form: the original XFA file, so saving keeps it an XFA form. */
  xfa?: string;
}

interface BackupState {
  version: 1;
  savedAt: string;
  fileName: string | null;
  filePath: string | null;
  /** The file's stamp when it was opened or last saved (Save checks whether it changed since). */
  fileStamp?: string | null;
  readOnlyReason?: string | null;
  /** The source opened in the tab (see primarySourceId). */
  primary?: string | null;
  docMeta: unknown;
  pages: PageRef[];
  objects: EditorObject[];
  fieldValues: Record<string, FieldValue>;
  outline: BookmarkItem[] | null;
  sources: BackupSource[];
  /** Snapshots handed to another window: whether the document had unsaved changes. */
  dirty?: boolean;
  /** Snapshots: the owner password was given; saving keeps the protection. */
  protection?: { owner: boolean; keep: boolean };
}

export interface BackupInfo {
  dir: string;
  fileName: string;
  savedAt: string;
  pages: number;
  edits: number;
}

type Doc = Pick<DocSlice, 'primarySource' | 'sources' | 'pages' | 'objects' | 'fieldValues' | 'outline' | 'fileName' | 'filePath' | 'fileStamp' | 'readOnlyReason' | 'protection' | 'docMeta' | 'dirty'>;

async function write(name: string, bytes: Uint8Array): Promise<void> {
  await invoke('recovery_write', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
}
async function read(name: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('recovery_read', { name }));
}
async function remove(dir: string): Promise<void> {
  await invoke('recovery_remove', { dir }).catch(() => undefined);
}

const folderFor = (tabId: string) => `${session}-${safe(tabId)}`;
/** Folder -> source ids already written there. */
const written = new Map<string, Set<string>>();
/** Tabs waiting for their backup. */
const pending = new Set<string>();
let timer: number | undefined;
let busy: Promise<void> = Promise.resolve();

async function backupTab(tabId: string): Promise<void> {
  const doc = tabSlice(tabId);
  const dir = folderFor(tabId);
  // A document that needs a password to open is never written to disk decrypted (pages it rewrote would be).
  if (!doc || !doc.dirty || !doc.pages.length || doc.readOnlyReason || doc.protection?.unlocked.userPassword) {
    if (written.has(dir)) {
      written.delete(dir);
      await remove(dir);
    }
    return;
  }
  let done = written.get(dir);
  if (!done) written.set(dir, (done = new Set()));
  await writeState(dir, done, doc);
}

/** Writes a document (sources not yet in done, then its state) into a backup folder. */
async function writeState(dir: string, done: Set<string>, s: Doc, extra: Partial<BackupState> = {}): Promise<void> {
  const used = new Set(s.pages.map((p) => p.sourceId).filter((id): id is string => !!id));
  const { xfaOriginalOf } = await import('@/actions/xfaForms');
  const sources: BackupSource[] = [];
  for (const id of used) {
    const src = s.sources[id];
    if (!src) continue;
    const file = `src-${safe(id)}.pdf`;
    const xfaBytes = xfaOriginalOf(id);
    const xfa = xfaBytes ? `xfa-${safe(id)}.pdf` : undefined;
    if (!done.has(id)) {
      // A protected file is written as it is (encrypted), and decrypted again when restored.
      await write(`${dir}/${file}`, src.encryption?.file ?? src.bytes);
      if (xfaBytes) await write(`${dir}/${xfa}`, xfaBytes);
      done.add(id);
    }
    sources.push({ id, name: src.name, pageCount: src.pageCount, file, ...(src.password ? { password: true } : {}), ...(src.original ? { original: true } : {}), ...(xfa ? { xfa } : {}) });
  }
  const state: BackupState = {
    version: 1,
    savedAt: new Date().toISOString(),
    fileName: s.fileName,
    filePath: s.filePath,
    fileStamp: s.fileStamp,
    primary: s.primarySource,
    docMeta: s.docMeta,
    pages: s.pages,
    objects: s.objects,
    fieldValues: s.fieldValues,
    outline: s.outline,
    sources,
    ...extra,
  };
  // state.json last: a backup only counts once it is complete.
  await write(`${dir}/state.json`, new TextEncoder().encode(JSON.stringify(state)));
}

function flush(): void {
  const ids = [...pending];
  pending.clear();
  for (const id of ids) busy = busy.then(() => backupTab(id)).catch((e) => console.warn('Backup failed', e));
}

function schedule(delay = DELAY) {
  pending.add(useTabs.getState().activeId);
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, delay);
}

/** Starts watching the documents. Desktop only. */
export function startAutoBackup(): void {
  if (!isDesktop) return;
  usePDFStore.subscribe((s, prev) => {
    if (s.objects !== prev.objects || s.pages !== prev.pages || s.fieldValues !== prev.fieldValues || s.outline !== prev.outline || s.docMeta !== prev.docMeta) schedule();
    else if (s.dirty !== prev.dirty) schedule(s.dirty ? DELAY : 0); // saved: remove the backup now
  });
  useTabs.subscribe((t, prev) => {
    const gone = prev.tabs.filter((x) => !t.tabs.some((y) => y.id === x.id));
    for (const tab of gone) {
      pending.delete(tab.id);
      const dir = folderFor(tab.id);
      if (written.delete(dir)) void remove(dir);
    }
    if (t.activeId !== prev.activeId) {
      // Switched away: that tab's latest changes are backed up now (it is parked, nothing changes it until it is back).
      if (t.tabs.some((x) => x.id === prev.activeId)) {
        pending.add(prev.activeId);
        window.clearTimeout(timer);
        flush();
      }
    }
  });
}

/** Backs up every tab with unsaved changes now (e.g. after recovering several documents). */
export async function backupAllTabs(): Promise<void> {
  if (!isDesktop) return;
  for (const t of useTabs.getState().tabs) pending.add(t.id);
  window.clearTimeout(timer);
  flush();
  await busy;
}

/** Removes every backup of this session (the user closed without saving). */
export async function discardSessionBackups(): Promise<void> {
  window.clearTimeout(timer);
  pending.clear();
  await busy;
  await Promise.all([...written.keys()].map(remove));
  written.clear();
}

/** Backups left by an earlier run (after a crash). */
export async function listBackups(): Promise<BackupInfo[]> {
  if (!isDesktop) return [];
  const entries = await invoke<Array<{ dir: string; modified: number }>>('recovery_list').catch(() => []);
  const out: BackupInfo[] = [];
  for (const e of entries) {
    if (e.dir.startsWith(`${session}-`)) continue;
    if (e.dir.startsWith('move-')) continue; // a tab being handed to another window right now
    try {
      const st = JSON.parse(new TextDecoder().decode(await read(`${e.dir}/state.json`))) as BackupState;
      out.push({ dir: e.dir, fileName: st.fileName ?? 'Untitled.pdf', savedAt: st.savedAt, pages: st.pages.length, edits: st.objects.length });
    } catch {
      await remove(e.dir); // unreadable: nothing to recover
    }
  }
  return out;
}

export async function discardBackups(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map(remove));
}

/** The active document as a snapshot another window can open (`adoptSnapshot`). Passwords are not written. */
export async function writeSnapshot(dir: string): Promise<void> {
  const s = usePDFStore.getState();
  await writeState(dir, new Set(), s, { dirty: s.dirty, readOnlyReason: s.readOnlyReason, ...(s.protection ? { protection: { owner: s.protection.unlocked.owner, keep: s.protection.keep } } : {}) });
}

/** Passwords of the active document's sources, by source id (memory only: for the window that adopts it). */
export function snapshotPasswords(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of Object.values(usePDFStore.getState().sources)) if (src.password) out[src.id] = src.password;
  return out;
}

/** Opens a snapshot written by another window (a tab moved here), then removes it. */
export async function adoptSnapshot(dir: string, passwords: Record<string, string> = {}): Promise<void> {
  if (!(await restore(dir, false, passwords))) throw new Error('The document needs its password to open.');
}

/** Opens each backup in its own tab, with its edits (unsaved), then removes the old backup. */
export async function recoverBackups(dirs: string[]): Promise<number> {
  let n = 0;
  for (const dir of dirs) {
    if (await restore(dir, true)) n++;
  }
  // Only the active tab would be backed up by the watcher: back up all of them under this session.
  await backupAllTabs();
  return n;
}

/** Opens a source of a backup; asks for its password when it was opened with one. */
async function openSource(bytes: Uint8Array, src: BackupSource, password: string | undefined): Promise<string | null> {
  const store = usePDFStore.getState();
  const { PasswordRequiredError } = await import('@/lib/pdf/pdfService');
  let pw = password;
  let incorrect = false;
  for (;;) {
    try {
      const { source } = await store.addSource(bytes, src.name, pw, src.original);
      return source.id;
    } catch (e) {
      if (!(e instanceof PasswordRequiredError)) throw e;
      const { askPassword } = await import('@/store/useDialogs');
      const next = await askPassword(src.name, incorrect || e.incorrect);
      if (next === null) return null;
      pw = next;
      incorrect = true;
    }
  }
}

async function restore(dir: string, crashed: boolean, passwords: Record<string, string> = {}): Promise<boolean> {
  const st = JSON.parse(new TextDecoder().decode(await read(`${dir}/state.json`))) as BackupState;
  const createdTab = !activeTabIsEmpty() ? newTab() : null;
  const map = new Map<string, string>();
  const xfa: Array<[string, Uint8Array]> = [];
  try {
    for (const src of st.sources) {
      const id = await openSource(await read(`${dir}/${src.file}`), src, passwords[src.id]);
      if (!id) {
        // No password: the backup stays for the next start.
        if (createdTab) (await import('@/store/tabs')).removeTab(createdTab);
        else await usePDFStore.getState().closeDocument();
        return false;
      }
      map.set(src.id, id);
      if (src.xfa) xfa.push([id, await read(`${dir}/${src.xfa}`)]);
    }
  } catch (e) {
    for (const id of map.values()) void (await import('@/lib/pdf/pdfService')).releaseSource(id);
    if (createdTab) (await import('@/store/tabs')).removeTab(createdTab);
    throw e;
  }
  const pages = st.pages.map((p) => (p.sourceId && map.has(p.sourceId) ? { ...p, sourceId: map.get(p.sourceId)! } : p));
  const fieldValues = Object.fromEntries(
    Object.entries(st.fieldValues).map(([k, v]) => {
      const [sid, ...rest] = k.split('::');
      return [map.has(sid) ? `${map.get(sid)}::${rest.join('::')}` : k, v];
    }),
  );
  const dirty = crashed ? true : (st.dirty ?? true);
  const doc = { pages, objects: st.objects, fieldValues, outline: st.outline };
  // The opened file's protection comes back with its source (decrypted again with the password asked for).
  const sources = usePDFStore.getState().sources;
  const primaryId = st.primary ? map.get(st.primary) : undefined;
  const enc = (primaryId ? sources[primaryId]?.encryption : undefined) ?? [...map.values()].map((id) => sources[id]?.encryption).find(Boolean);
  const protection = enc ? { ...protectionOf(enc.unlocked, enc.unlocked.owner || !!st.protection?.owner), keep: st.protection?.keep ?? true } : null;
  usePDFStore.setState({
    protection,
    ...doc,
    docMeta: st.docMeta as never,
    fileName: st.fileName,
    filePath: st.filePath,
    fileStamp: st.fileStamp ?? null,
    primarySource: st.primary ? (map.get(st.primary) ?? null) : null,
    readOnlyReason: crashed ? null : (st.readOnlyReason ?? null),
    dirty,
    savedDoc: dirty ? null : doc,
    past: [],
    future: [],
    selectedIds: [],
    currentPageId: pages[0]?.id ?? null,
  });
  const xfaForms = await import('@/actions/xfaForms');
  for (const [id, bytes] of xfa) await xfaForms.noteXfaSource(id, bytes, true);
  const primary = pages.find((p) => p.kind === 'source')?.sourceId;
  if (primary && !xfa.some(([id]) => id === primary)) await xfaForms.noteXfaSource(primary, null);
  void import('@/actions/document').then((m) => m.refreshSignatureStatus());
  await remove(dir);
  return true;
}
