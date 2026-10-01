/**
 * A document tab in its own window (drag a tab out of the tab bar): the tab
 * is handed over as a snapshot (pages, edits, unsaved changes, undo starts
 * fresh) that the new window opens, then it closes here.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { removeTab, switchTab, useTabs } from '@/store/tabs';
import { isDesktop } from '@/lib/platform';
import { uid } from '@/lib/uid';
import { errorMessage, withBusy } from './document';

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
  const ok = await withBusy('Opening a new window…', async () => {
    const { writeSnapshot } = await import('@/lib/recovery');
    await writeSnapshot(dir);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_document_window', { adopt: dir });
    return true;
  }).catch((e: unknown) => {
    usePDFStore.getState().toast(errorMessage(e), 'error');
    return false;
  });
  if (!ok) return false;
  // The new window has the document now (with its unsaved changes): close it here without asking.
  usePDFStore.setState({ dirty: false });
  removeTab(tabId);
  return true;
}
