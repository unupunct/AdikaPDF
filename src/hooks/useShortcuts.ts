/** Global keyboard shortcuts. Ignored while typing in inputs. */
import { useEffect } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { closeDocumentAction, openDialog, saveDocument } from '@/actions/document';
import { cycleTab } from '@/store/tabs';
import { readCurrentPage, readToEnd, stopReading, togglePauseReading } from '@/actions/readingAids';
import { useAutoScroll } from '@/components/viewer/AutoScroll';
import { rotateView, startPresentation, toggleFullscreen } from '@/components/ribbon/ReaderTabs';

/** Selects all text on a page's text layer (Ctrl+A in the Select text tool). */
function selectPageText(pageId: string | null): void {
  const layer = document.querySelector(`[data-page-id="${pageId}"] .textLayer`);
  if (!layer) return;
  const range = document.createRange();
  range.selectNodeContents(layer);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
import type { ToolId } from '@/types';

const TOOL_KEYS: Record<string, ToolId> = {
  s: 'selectText',
  n: 'note',
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
      if (s.modal || s.busy || s.presentation) return;

      if (key === 'f11') {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (key === 'escape' && s.fullscreen) {
        void toggleFullscreen();
        return;
      }
      // Auto-scroll (Acrobat: Ctrl+Shift+H).
      if (mod && e.shiftKey && key === 'h' && s.pages.length) {
        e.preventDefault();
        useAutoScroll.getState().toggle();
        return;
      }
      // Read aloud (Acrobat's keys): V page, B to the end, C pause/resume, E stop.
      if (mod && e.shiftKey && ['v', 'b', 'c', 'e'].includes(key) && s.pages.length) {
        e.preventDefault();
        if (key === 'v') readCurrentPage();
        else if (key === 'b') readToEnd();
        else if (key === 'c') togglePauseReading();
        else stopReading();
        return;
      }
      if (mod && key === 'tab') {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && key === 'w') {
        e.preventDefault();
        void closeDocumentAction();
        return;
      }

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
      if (key === 'f5') {
        e.preventDefault();
        startPresentation();
        return;
      }
      if (key === 'f7' && !s.readOnlyReason) {
        e.preventDefault();
        s.openModal('spell');
        return;
      }
      if (mod && key === 'p') {
        e.preventDefault();
        s.openModal('print');
        return;
      }
      if (mod && key === 'g') {
        e.preventDefault();
        usePDFStore.setState({ ribbonTab: 'home' });
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="page-input"]')?.focus());
        return;
      }
      if (mod && !e.shiftKey && key === 'd') {
        e.preventDefault();
        s.openModal('properties');
        return;
      }
      if (e.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        e.preventDefault();
        if (key === 'arrowleft') s.goBack();
        else s.goForward();
        return;
      }
      if (mod && e.shiftKey && (key === '-' || key === '_' || key === '+' || key === '=')) {
        e.preventDefault();
        rotateView(key === '-' || key === '_' ? -90 : 90);
        return;
      }
      if (mod && key === 'f') {
        e.preventDefault();
        s.setSearch({ open: true });
        return;
      }
      // Split view.
      if (mod && key === '\\' && s.pages.length) {
        e.preventDefault();
        void import('@/components/viewer/SplitView').then((m) => m.toggleSplit());
        return;
      }
      // Tool search.
      if (mod && !e.shiftKey && key === 'k') {
        e.preventDefault();
        void import('@/components/shell/CommandPalette').then((m) => m.usePalette.setState({ open: true }));
        return;
      }
      // Find & replace (as in Word).
      if (mod && !e.shiftKey && key === 'h' && s.pages.length) {
        e.preventDefault();
        s.setSearch({ open: true, replace: true });
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
      if (mod && e.shiftKey && key === 'd') {
        e.preventDefault();
        s.duplicateObjects(s.selectedIds);
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        if (s.tool === 'selectText') selectPageText(s.currentPageId);
        else s.select(s.objects.filter((o) => o.pageId === s.currentPageId && !o.locked).map((o) => o.id));
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
      if (key === 'home' || key === 'end') {
        const target = key === 'home' ? s.pages[0] : s.pages[s.pages.length - 1];
        if (target) {
          e.preventDefault();
          s.navigateTo(target.id);
        }
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
