/**
 * Reading aids: read aloud (page, to the end, selection), snapshot (copy an
 * area of the page as a picture) and the magnifier's settings.
 */
import { create } from 'zustand';
import { usePDFStore } from '@/store/usePDFStore';
import { getTextContent, renderPageToCanvas } from '@/lib/pdf/pdfService';
import { pauseReading, read, resumeReading, speechAvailable, speechText, stopReading, useReadAloud, type TextPiece } from '@/lib/readAloud';
import { saveBytes } from '@/lib/platform';
import { log } from '@/lib/log';
import type { PageRef } from '@/types';
import { useAutoScroll } from '@/components/viewer/AutoScroll';

// ------------------------------------------------------------------ read aloud

async function pageSpeech(page: PageRef): Promise<string> {
  if (page.kind !== 'source' || !page.sourceId) return '';
  const tc = await getTextContent(page.sourceId, page.sourceIndex).catch(() => null);
  return tc ? speechText(tc.items as TextPiece[]) : '';
}

function startReading(fromIndex: number, toIndex: number): void {
  const s = usePDFStore.getState();
  if (!speechAvailable()) {
    s.toast('Read aloud needs a Windows speech voice (Settings → Time & language → Speech).', 'error');
    return;
  }
  let i = fromIndex;
  let spokeAnything = false;
  void read({
    next: async () => {
      const pages = usePDFStore.getState().pages;
      while (i <= Math.min(toIndex, pages.length - 1)) {
        const page = pages[i++];
        const text = await pageSpeech(page);
        if (text) {
          spokeAnything = true;
          return { text, pageId: page.id };
        }
      }
      return null;
    },
    onPage: (pageId) => {
      const st = usePDFStore.getState();
      if (st.currentPageId !== pageId) st.navigateTo(pageId);
    },
  })
    .then(() => {
      if (!spokeAnything) usePDFStore.getState().toast('There is no text to read on these pages (a scan? Run OCR first).', 'info');
    })
    .catch((e: unknown) => {
      usePDFStore.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      log('error', `Read aloud failed: ${String(e)}`);
    });
}

function currentIndex(): number {
  const s = usePDFStore.getState();
  return Math.max(0, s.pages.findIndex((p) => p.id === s.currentPageId));
}

/** Reads the current page (Ctrl+Shift+V). */
export function readCurrentPage(): void {
  const i = currentIndex();
  startReading(i, i);
}

/** Reads from the current page to the end of the document (Ctrl+Shift+B). */
export function readToEnd(): void {
  startReading(currentIndex(), Number.MAX_SAFE_INTEGER);
}

/** Reads the text selected on the page. */
export function readSelection(): void {
  const text = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return;
  if (!speechAvailable()) {
    usePDFStore.getState().toast('Read aloud needs a Windows speech voice (Settings → Time & language → Speech).', 'error');
    return;
  }
  let done = false;
  void read({ next: async () => (done ? null : ((done = true), { text, pageId: null })) });
}

/** Pause / resume (Ctrl+Shift+C). */
export function togglePauseReading(): void {
  const st = useReadAloud.getState().status;
  if (st === 'speaking') pauseReading();
  else if (st === 'paused') resumeReading();
}

export { stopReading };

// Another document (or none) on screen: stop talking about the old one and put the lens away.
usePDFStore.subscribe((s, prev) => {
  if (s.sources === prev.sources) return;
  if (useReadAloud.getState().status !== 'idle') stopReading();
  if (!s.pages.length) useMagnifier.setState({ on: false });
  useAutoScroll.getState().stop();
});

// ------------------------------------------------------------------ snapshot

interface SnapshotState {
  last: { blob: Blob; width: number; height: number } | null;
}

export const useSnapshot = create<SnapshotState>()(() => ({ last: null }));

/** Snapshot resolution: at least 2× the page at 100% (144 dpi), sharper when zoomed in. */
const SNAPSHOT_SCALE = 2;

/**
 * Copies `rect` (page display points) of a page as a PNG: the page itself
 * rendered sharply, with the editor objects (comments, drawings) on top.
 */
export async function captureSnapshot(page: PageRef, rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  const s = usePDFStore.getState();
  const scale = Math.max(SNAPSHOT_SCALE, s.zoom);
  const full = document.createElement('canvas');
  try {
    await renderPageToCanvas(page, full, scale, 1).promise;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(rect.width * scale));
    out.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(full, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale, 0, 0, out.width, out.height);
    // Editor objects: the page's Konva canvas (drawn at the on-screen resolution), scaled to match.
    const stage = document.querySelector<HTMLCanvasElement>(`[data-page-id="${page.id}"] .konvajs-content canvas`);
    if (stage && stage.width > 0) {
      const k = stage.width / (full.width / scale);
      ctx.drawImage(stage, rect.x * k, rect.y * k, rect.width * k, rect.height * k, 0, 0, out.width, out.height);
    }
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Could not encode the picture');
    useSnapshot.setState({ last: { blob, width: out.width, height: out.height } });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      s.toast(`Snapshot copied (${out.width} × ${out.height} px). Paste it into Word, e-mail or any app — or use Save snapshot.`, 'success');
    } catch {
      s.toast('Snapshot taken. The clipboard is not available here: use Save snapshot.', 'info');
    }
  } catch (e) {
    s.toast(`Snapshot failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    full.width = 0;
    full.height = 0;
  }
}

export async function saveLastSnapshot(): Promise<void> {
  const last = useSnapshot.getState().last;
  if (!last) return;
  const base = (usePDFStore.getState().fileName ?? 'snapshot').replace(/\.pdf$/i, '');
  const path = await saveBytes(new Uint8Array(await last.blob.arrayBuffer()), `${base} - snapshot.png`, [{ name: 'PNG image', extensions: ['png'] }]);
  if (path) usePDFStore.getState().toast(path === 'downloaded' ? 'Downloaded.' : `Saved to ${path}`, 'success');
}

// ------------------------------------------------------------------ magnifier

interface MagnifierState {
  on: boolean;
  factor: 2 | 3 | 4;
  toggle: () => void;
  setFactor: (f: 2 | 3 | 4) => void;
}

export const useMagnifier = create<MagnifierState>()((set) => ({
  on: false,
  factor: 3,
  toggle: () => set((s) => ({ on: !s.on })),
  setFactor: (factor) => set({ factor }),
}));
