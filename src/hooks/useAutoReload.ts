/**
 * Reloads the active document when its file changes on disk (e.g. a LaTeX
 * build or another program saved it), keeping the page and zoom. With
 * unsaved edits it only warns, so nothing is lost.
 */
import { useEffect } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { fileStamp, isDesktop, readFile } from '@/lib/platform';

export function useAutoReload(): void {
  useEffect(() => {
    if (!isDesktop) return;
    let busy = false;
    let warned = '';
    const timer = setInterval(async () => {
      const s = usePDFStore.getState();
      if (busy || !s.filePath || !s.fileStamp || s.busy || s.modal) return;
      busy = true;
      try {
        const path = s.filePath;
        const stamp = await fileStamp(path);
        const now = usePDFStore.getState();
        if (!stamp || stamp === now.fileStamp || now.filePath !== path) return;
        if (now.dirty) {
          // fileStamp stays the one we opened or saved: Save then asks before overwriting the other program's version.
          if (warned === `${path}|${stamp}`) return;
          warned = `${path}|${stamp}`;
          now.toast(`${now.fileName} was changed by another program. Your unsaved edits are kept; save to a new file or reopen it to see the other changes.`, 'info');
          return;
        }
        const pageIndex = now.pages.findIndex((p) => p.id === now.currentPageId);
        const { zoom, fitMode } = now;
        const bytes = await readFile(path);
        const { openPdfBytes } = await import('@/actions/document');
        if (await openPdfBytes(bytes, now.fileName ?? path, path, true)) {
          const after = usePDFStore.getState();
          after.setZoom(zoom, fitMode);
          const target = after.pages[Math.min(Math.max(0, pageIndex), after.pages.length - 1)];
          if (target) after.scrollToPage(target.id);
          after.toast('Reloaded: the file changed on disk.', 'info');
        }
      } finally {
        busy = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, []);
}
