/**
 * Window-wide drag and drop: files from Explorer and page thumbnails dragged
 * between documents. The target under the pointer decides what a drop does
 * (actions/dnd.ts); the overlay names it while dragging.
 */
import { useEffect } from 'react';
import { kindFromMime } from '@/lib/fileKinds';
import type { DropEntry } from '@/lib/dnd';
import { captureDrop, dropFiles, dropPages, endDrag, installDropPaths, previewDrag, resolveTarget, useDnd } from '@/actions/dnd';

export const PAGE_MIME = 'text/x-adika-page';

const has = (e: DragEvent, type: string) => Array.from(e.dataTransfer?.types ?? []).includes(type);

/** File kinds visible during the drag (MIME types only; names come with the drop). Unknown ones count as PDFs. */
function dragEntries(dt: DataTransfer | null): DropEntry[] {
  return Array.from(dt?.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => ({ kind: kindFromMime(i.type) ?? 'pdf' }));
}

export function useFileDrop(): void {
  useEffect(() => {
    installDropPaths();
    let depth = 0;
    const kindOf = (e: DragEvent): 'files' | 'pages' | null => (has(e, 'Files') ? 'files' : has(e, PAGE_MIME) || useDnd.getState().pageDrag ? 'pages' : null);
    const enter = (e: DragEvent) => {
      if (!kindOf(e)) return;
      e.preventDefault();
      depth++;
    };
    const over = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      const target = resolveTarget(e.target instanceof Element ? e.target : null, e.clientX, e.clientY);
      const effect = previewDrag(kind, target, dragEntries(e.dataTransfer));
      if (e.dataTransfer) e.dataTransfer.dropEffect = effect;
    };
    const leave = (e: DragEvent) => {
      if (!kindOf(e)) return;
      depth = Math.max(0, depth - 1);
      // Left the window (Explorer drags have no dragend here).
      if (depth === 0 && !e.relatedTarget) useDnd.setState({ active: null, target: null, label: '' });
    };
    const drop = (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      depth = 0;
      const target = resolveTarget(e.target instanceof Element ? e.target : null, e.clientX, e.clientY);
      if (kind === 'files') {
        const read = captureDrop(e.dataTransfer!);
        endDrag();
        void read().then((files) => dropFiles(files, target));
      } else {
        void dropPages(target).finally(endDrag);
      }
    };
    // A page drag that ends anywhere (also outside the window, or cancelled with Esc).
    const end = () => {
      depth = 0;
      if (useDnd.getState().active || useDnd.getState().pageDrag) endDrag();
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', end);
    // The dragged thumbnail can be gone (its tab was switched away), then no dragend comes.
    window.addEventListener('pointerdown', end);
    return () => {
      window.removeEventListener('pointerdown', end);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', end);
    };
  }, []);
}
