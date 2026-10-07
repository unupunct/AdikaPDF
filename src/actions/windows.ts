/**
 * A document tab in its own window (drag a tab out of the tab bar): the tab
 * is handed over as a snapshot (pages, edits, unsaved changes, undo starts
 * fresh) that the new window opens. Passwords go from window to window in
 * memory, never through the snapshot on disk. The tab closes here only
 * once the new window says it has the document.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { removeTab, switchTab, useTabs } from '@/store/tabs';
import { isDesktop } from '@/lib/platform';
import { uid } from '@/lib/uid';
import { errorMessage, withBusy } from './document';

const HELLO = 'adika://adopt-hello';
const SECRETS = 'adika://adopt-secrets';
const RESULT = 'adika://adopt-result';
/** How long the new window may take to open the document before the tab stays here. */
const ADOPT_TIMEOUT = 120_000;

interface AdoptResult {
  dir: string;
  ok: boolean;
  error?: string;
}

/** The window's label ("main" for the first window). */
export async function windowLabel(): Promise<string> {
  if (!isDesktop) return 'main';
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().label;
}

/** The snapshot a new window was opened for (?adopt=…). */
export function adoptRequest(): string | null {
  return new URLSearchParams(window.location.search).get('adopt');
}

export async function moveTabToWindow(tabId: string): Promise<boolean> {
  const s0 = usePDFStore.getState();
  if (!isDesktop) {
    s0.toast('Separate windows need the desktop app.', 'info');
    return false;
  }
  if (useTabs.getState().activeId !== tabId) switchTab(tabId);
  if (!usePDFStore.getState().pages.length) return false;
  const dir = `move-${uid('w').replace(/[^\w-]/g, '')}`;
  const { listen, emit } = await import('@tauri-apps/api/event');
  const { writeSnapshot, snapshotPasswords, discardBackups } = await import('@/lib/recovery');
  const passwords = snapshotPasswords();
  const offs: Array<() => void> = [];
  const result = await withBusy('Opening a new window…', async () => {
    await writeSnapshot(dir);
    const done = new Promise<AdoptResult>((resolve) => {
      const timer = window.setTimeout(() => resolve({ dir, ok: false, error: 'The new window did not open the document in time.' }), ADOPT_TIMEOUT);
      void listen<AdoptResult>(RESULT, (e) => {
        if (e.payload.dir !== dir) return;
        window.clearTimeout(timer);
        resolve(e.payload);
      }).then((off) => offs.push(off));
    });
    // The new window asks for the passwords once it is listening.
    offs.push(
      await listen<{ dir: string }>(HELLO, (e) => {
        if (e.payload.dir === dir) void emit(SECRETS, { dir, passwords });
      }),
    );
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_document_window', { adopt: dir });
    return done;
  }).catch((e: unknown): AdoptResult => ({ dir, ok: false, error: errorMessage(e) }));
  for (const off of offs) off();
  if (!result?.ok) {
    void discardBackups([dir]);
    usePDFStore.getState().toast(`The document stays in this window: ${result?.error ?? 'the new window could not open it.'}`, 'error');
    return false;
  }
  // The new window has the document now (with its unsaved changes): close it here without asking.
  if (useTabs.getState().activeId === tabId) usePDFStore.setState({ dirty: false });
  removeTab(tabId);
  return true;
}

/** In a window opened for a moved tab: gets the passwords, opens the snapshot, and tells the old window. */
export async function adoptIntoThisWindow(dir: string): Promise<void> {
  const { listen, emit } = await import('@tauri-apps/api/event');
  const { adoptSnapshot } = await import('@/lib/recovery');
  let off: (() => void) | undefined;
  const passwords = await new Promise<Record<string, string>>((resolve) => {
    // Without an answer (the old window is gone) the document opens as far as it can.
    const timer = window.setTimeout(() => resolve({}), 10_000);
    void listen<{ dir: string; passwords: Record<string, string> }>(SECRETS, (e) => {
      if (e.payload.dir !== dir) return;
      window.clearTimeout(timer);
      resolve(e.payload.passwords ?? {});
    }).then((f) => {
      off = f;
      void emit(HELLO, { dir });
    });
  });
  off?.();
  try {
    await adoptSnapshot(dir, passwords);
    await emit(RESULT, { dir, ok: true } satisfies AdoptResult);
  } catch (e) {
    await emit(RESULT, { dir, ok: false, error: errorMessage(e) } satisfies AdoptResult);
    throw e;
  }
}
