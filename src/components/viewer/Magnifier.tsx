/**
 * Magnifier (loupe): a round lens following the mouse over the pages. The
 * page under the cursor is rendered once at the lens resolution, so the
 * close-up is sharp; comments and drawings are drawn on top.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { renderPageToCanvas } from '@/lib/pdf/pdfService';
import { useMagnifier } from '@/actions/readingAids';

const LENS = 220; // CSS px
const MAX_PIXELS = 40_000_000;

interface Hover {
  clientX: number;
  clientY: number;
  pageId: string;
  /** Point on the page, display points at scale 1. */
  px: number;
  py: number;
}

interface Cached {
  key: string;
  canvas: HTMLCanvasElement;
  /** Canvas pixels per page point. */
  scale: number;
  ready: boolean;
}

export function Magnifier({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const on = useMagnifier((s) => s.on);
  const factor = useMagnifier((s) => s.factor);
  const zoom = usePDFStore((s) => s.zoom);
  const nightMode = usePDFStore((s) => s.nightMode);
  const renderEpoch = usePDFStore((s) => s.renderEpoch);
  const [hover, setHover] = useState<Hover | null>(null);
  const [tick, setTick] = useState(0);
  const lensRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef<Cached[]>([]);

  // Track the pointer over pages.
  useEffect(() => {
    const el = container.current;
    if (!on || !el) {
      setHover(null);
      return;
    }
    const move = (e: PointerEvent) => {
      const pageEl = (e.target as Element | null)?.closest?.('[data-page-id]') as HTMLElement | null;
      if (!pageEl) {
        setHover(null);
        return;
      }
      const r = pageEl.getBoundingClientRect();
      const z = usePDFStore.getState().zoom;
      setHover({ clientX: e.clientX, clientY: e.clientY, pageId: pageEl.dataset.pageId ?? '', px: (e.clientX - r.left) / z, py: (e.clientY - r.top) / z });
    };
    const leave = () => setHover(null);
    el.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [on, container]);

  // Escape turns the magnifier off.
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useMagnifier.getState().toggle();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [on]);

  // Sharp render of the hovered page at lens resolution (two pages kept).
  const pageId = hover?.pageId ?? null;
  useEffect(() => {
    if (!on || !pageId) return;
    const page = usePDFStore.getState().pages.find((p) => p.id === pageId);
    if (!page) return;
    const dpr = window.devicePixelRatio || 1;
    const rot = (page.baseRotation + page.userRotation) % 180 === 0;
    const w = rot ? page.width : page.height;
    const h = rot ? page.height : page.width;
    const scale = Math.min(zoom * factor * dpr, Math.sqrt(MAX_PIXELS / (w * h)));
    const key = `${pageId}|${scale.toFixed(3)}|${renderEpoch}|${page.userRotation}`;
    if (cache.current.some((c) => c.key === key)) return;
    const canvas = document.createElement('canvas');
    const entry: Cached = { key, canvas, scale, ready: false };
    cache.current = [entry, ...cache.current.filter((c) => !c.key.startsWith(`${pageId}|`))].slice(0, 2);
    const handle = renderPageToCanvas(page, canvas, scale, 1);
    handle.promise.then(
      () => {
        entry.ready = true;
        setTick((t) => t + 1);
      },
      () => undefined,
    );
    return () => handle.cancel();
  }, [on, pageId, zoom, factor, renderEpoch]);

  // Free the renders when the magnifier is switched off.
  useEffect(() => {
    if (on) return;
    for (const c of cache.current) {
      c.canvas.width = 0;
      c.canvas.height = 0;
    }
    cache.current = [];
  }, [on]);

  // Paint the lens.
  useEffect(() => {
    const lens = lensRef.current;
    if (!lens || !hover) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(LENS * dpr);
    if (lens.width !== size) {
      lens.width = size;
      lens.height = size;
    }
    const ctx = lens.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    const pageEl = document.querySelector(`[data-page-id="${hover.pageId}"]`);
    // Lens shows LENS / factor CSS px of the page around the cursor, i.e. this many page points:
    const spanPt = LENS / (zoom * factor);
    const cached = cache.current.find((c) => c.key.startsWith(`${hover.pageId}|`) && c.ready);
    const draw = (src: CanvasImageSource, pxPerPt: number) =>
      ctx.drawImage(src, (hover.px - spanPt / 2) * pxPerPt, (hover.py - spanPt / 2) * pxPerPt, spanPt * pxPerPt, spanPt * pxPerPt, 0, 0, size, size);
    if (cached) draw(cached.canvas, cached.scale);
    else {
      // Until the sharp render is ready, enlarge what is on screen.
      const shown = pageEl?.querySelector<HTMLCanvasElement>(':scope > canvas');
      if (shown && shown.width) draw(shown, shown.width / (shown.getBoundingClientRect().width / zoom));
    }
    const stage = pageEl?.querySelector<HTMLCanvasElement>('.konvajs-content canvas');
    if (stage && stage.width) draw(stage, stage.width / (stage.getBoundingClientRect().width / zoom));
  }, [hover, zoom, factor, tick]);

  if (!on || !hover) return null;
  return (
    <div
      data-testid="magnifier"
      aria-hidden
      className="pointer-events-none fixed z-40 overflow-hidden rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,0.35),0_10px_30px_rgba(15,23,42,0.35)]"
      style={{ left: hover.clientX - LENS / 2, top: hover.clientY - LENS / 2, width: LENS, height: LENS }}
    >
      <canvas ref={lensRef} className="h-full w-full" style={nightMode ? { filter: 'invert(0.92) hue-rotate(180deg)' } : undefined} />
      <div className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-brand-500/70" />
      <div className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 -translate-y-1/2 bg-brand-500/70" />
    </div>
  );
}
