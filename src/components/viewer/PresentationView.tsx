/**
 * Presentation mode: full screen, one page at a time on black, fitted to
 * the screen. → / Space / PageDown / click: next; ← / PageUp / right-click:
 * previous; Home / End; Esc leaves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { displaySize } from '@/lib/geometry';
import { renderPageToCanvas } from '@/lib/pdf/pdfService';
import { setFullscreen } from '@/lib/platform';

export function PresentationView() {
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const index = Math.max(0, pages.findIndex((p) => p.id === currentPageId));
  const page = pages[index];

  const exit = useCallback(() => {
    usePDFStore.getState().setView({ presentation: false });
    void setFullscreen(false);
  }, []);

  const go = useCallback(
    (d: number) => {
      const next = pages[Math.max(0, Math.min(pages.length - 1, index + d))];
      if (next) usePDFStore.getState().setCurrentPage(next.id);
    },
    [pages, index],
  );

  useEffect(() => {
    void setFullscreen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Home') go(-pages.length);
      else if (e.key === 'End') go(pages.length);
      else if (e.key === 'Escape' || e.key === 'F5') {
        e.preventDefault();
        exit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, exit, pages.length]);

  // Render the page fitted to the screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    const size = displaySize(page);
    const scale = Math.min(window.innerWidth / size.width, window.innerHeight / size.height);
    const handle = renderPageToCanvas(page, canvas, scale);
    handle.promise.catch(() => undefined);
    canvas.style.width = `${size.width * scale}px`;
    canvas.style.height = `${size.height * scale}px`;
    return () => handle.cancel();
  }, [page]);

  // Hide the pointer after 2 s without movement.
  useEffect(() => {
    let t = setTimeout(() => setCursorHidden(true), 2000);
    const move = () => {
      setCursorHidden(false);
      clearTimeout(t);
      t = setTimeout(() => setCursorHidden(true), 2000);
    };
    window.addEventListener('mousemove', move);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousemove', move);
    };
  }, []);

  return (
    <div
      data-testid="presentation"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black"
      style={{ cursor: cursorHidden ? 'none' : 'default' }}
      onClick={() => go(1)}
      onContextMenu={(e) => {
        e.preventDefault();
        go(-1);
      }}
    >
      <canvas ref={canvasRef} />
      <div className="pointer-events-none absolute bottom-3 right-4 text-xs text-white/40">
        {index + 1} / {pages.length}
      </div>
    </div>
  );
}
