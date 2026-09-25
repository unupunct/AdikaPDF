/** Global keyboard shortcuts. Ignored while typing in inputs. */
import { useEffect } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { openDialog, saveDocument } from '@/actions/document';
import type { ToolId } from '@/types';

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  h: 'pan',
  t: 'text',
  r: 'rect',
  e: 'ellipse',
  l: 'line',
  a: 'arrow',
  p: 'pen',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = usePDFStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (s.modal || s.busy) return;

      if (mod && key === 'o') {
        e.preventDefault();
        void openDialog();
        return;
      }
      if (mod && key === 's') {
        e.preventDefault();
        void saveDocument(e.shiftKey);
        return;
      }
      if (s.pages.length === 0) return;
      if (mod && key === 'f') {
        e.preventDefault();
        s.setSearch({ open: true });
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        s.setZoom(s.zoom * 1.2);
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        s.setZoom(s.zoom / 1.2);
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        s.setZoom(s.zoom, 'width');
        return;
      }
      if (isTyping(e.target)) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && key === 'c') {
        s.copySelection();
        return;
      }
      if (mod && key === 'v') {
        s.paste();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        s.duplicateObjects(s.selectedIds);
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        s.select(s.objects.filter((o) => o.pageId === s.currentPageId && !o.locked).map((o) => o.id));
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        if (s.selectedIds.length) {
          e.preventDefault();
          s.deleteObjects(s.selectedIds);
        }
        return;
      }
      if (key === 'escape') {
        if (s.search.open) s.setSearch({ open: false, hits: [] });
        s.setPendingImage(null);
        s.setPendingSignature(null);
        s.setTool('select');
        s.select([]);
        return;
      }
      if (key.startsWith('arrow') && s.selectedIds.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
        s.updateObjects(
          s.objects.filter((o) => s.selectedIds.includes(o.id) && !o.locked).map((o) => ({ id: o.id, patch: { x: o.x + dx, y: o.y + dy } })),
        );
        return;
      }
      if (key === 'enter' && s.selectedIds.length === 1) {
        const o = s.objects.find((x) => x.id === s.selectedIds[0]);
        if (o?.type === 'text' && !o.locked) {
          e.preventDefault();
          s.setEditingText(o.id);
        }
        return;
      }
      if (!mod && !e.altKey && TOOL_KEYS[key] && !s.readOnlyReason) {
        s.setTool(TOOL_KEYS[key]);
        return;
      }
      if (key === 'pagedown' || key === 'pageup') {
        const i = s.pages.findIndex((p) => p.id === s.currentPageId);
        const next = s.pages[Math.max(0, Math.min(s.pages.length - 1, i + (key === 'pagedown' ? 1 : -1)))];
        if (next) {
          e.preventDefault();
          s.scrollToPage(next.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
