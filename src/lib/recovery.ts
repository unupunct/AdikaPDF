/**
 * Automatic backup of unsaved documents. A few seconds after each change the
 * active document (its source PDFs once, then pages, edits, form values,
 * bookmarks) is written to the Recovery folder. Saving or closing the
 * document removes its backup; after a crash the next start offers to
 * recover what was left.
 */
import { invoke } from '@tauri-apps/api/core';
import { usePDFStore } from '@/store/usePDFStore';
import { activeTabIsEmpty, newTab, useTabs } from '@/store/tabs';
import { isDesktop } from './platform';
import { uid } from './uid';
import type { BookmarkItem, EditorObject, PageRef } from '@/types';
import type { FieldValue } from '@/store/usePDFStore';

const DELAY = 4000;
const session = uid('s').replace(/[^A-Za-z0-9_-]/g, '_');
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

interface BackupState {
  version: 1;
  savedAt: string;
  fileName: string | null;
  filePath: string | null;
  docMeta: unknown;
  pages: PageRef[];
  objects: EditorObject[];
  fieldValues: Record<string, FieldValue>;
  outline: BookmarkItem[] | null;
  sources: Array<{ id: string; name: string; pageCount: number; file: string }>;
}

export interface BackupInfo {
  dir: string;
  fileName: string;
  savedAt: string;
  pages: number;
  edits: number;
}

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
let timer: number | undefined;
let busy: Promise<void> = Promise.resolve();

async function backupActive(): Promise<void> {
  const s = usePDFStore.getState();
  const dir = folderFor(useTabs.getState().activeId);
  if (!s.dirty || !s.pages.length || s.readOnlyReason) {
    if (written.has(dir)) {
      written.delete(dir);
      await remove(dir);
    }
    return;
  }
  let done = written.get(dir);
  if (!done) written.set(dir, (done = new Set()));
  const used = new Set(s.pages.map((p) => p.sourceId).filter((id): id is string => !!id));
  const sources: BackupState['sources'] = [];
  for (const id of used) {
    const src = s.sources[id];
    if (!src) continue;
    const file = `src-${safe(id)}.pdf`;
    if (!done.has(id)) {
      await write(`${dir}/${file}`, src.bytes);
      done.add(id);
    }
    sources.push({ id, name: src.name, pageCount: src.pageCount, file });
  }
  const state: BackupState = {
    version: 1,
    savedAt: new Date().toISOString(),
    fileName: s.fileName,
    filePath: s.filePath,
    docMeta: s.docMeta,
    pages: s.pages,
    objects: s.objects,
    fieldValues: s.fieldValues,
    outline: s.outline,
    sources,
  };
  // state.json last: a backup only counts once it is complete.
  await write(`${dir}/state.json`, new TextEncoder().encode(JSON.stringify(state)));
}

function schedule(delay = DELAY) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    busy = busy.then(backupActive).catch((e) => console.warn('Backup failed', e));
  }, delay);
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
      const dir = folderFor(tab.id);
      if (written.delete(dir)) void remove(dir);
    }
  });
}

/** Removes every backup of this session (the user closed without saving). */
export async function discardSessionBackups(): Promise<void> {
  window.clearTimeout(timer);
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

/** Opens each backup in its own tab, with its edits (unsaved), then removes the old backup. */
export async function recoverBackups(dirs: string[]): Promise<number> {
  let n = 0;
  for (const dir of dirs) {
    const st = JSON.parse(new TextDecoder().decode(await read(`${dir}/state.json`))) as BackupState;
    if (!activeTabIsEmpty()) newTab();
    const store = usePDFStore.getState();
    const map = new Map<string, string>();
    for (const src of st.sources) {
      const { source } = await store.addSource(await read(`${dir}/${src.file}`), src.name);
      map.set(src.id, source.id);
    }
    const pages = st.pages.map((p) => (p.sourceId && map.has(p.sourceId) ? { ...p, sourceId: map.get(p.sourceId)! } : p));
    const fieldValues = Object.fromEntries(
      Object.entries(st.fieldValues).map(([k, v]) => {
        const [sid, ...rest] = k.split('::');
        return [map.has(sid) ? `${map.get(sid)}::${rest.join('::')}` : k, v];
      }),
    );
    usePDFStore.setState({
      pages,
      objects: st.objects,
      fieldValues,
      outline: st.outline,
      docMeta: st.docMeta as never,
      fileName: st.fileName,
      filePath: st.filePath,
      dirty: true,
      past: [],
      future: [],
      selectedIds: [],
      currentPageId: pages[0]?.id ?? null,
    });
    await remove(dir);
    n++;
  }
  return n;
}
