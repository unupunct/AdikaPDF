/**
 * Main document viewer: continuous vertical scroll of pages, fit-width /
 * fit-page zoom, Ctrl+wheel zoom anchored at the cursor, hand-tool panning,
 * current-page tracking and lazy mounting of page content.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { usePDFStore, MIN_ZOOM, MAX_ZOOM } from '@/store/usePDFStore';
import { displaySize } from '@/lib/geometry';
import { PageView } from './PageView';
import { cn } from '@/lib/cn';

export const PAGE_GAP = 20;
const PADDING = 24;

export function PDFCanvas() {
  const pages = usePDFStore((s) => s.pages);
  const zoom = usePDFStore((s) => s.zoom);
  const fitMode = usePDFStore((s) => s.fitMode);
  const tool = usePDFStore((s) => s.tool);
  const scrollRequest = usePDFStore((s) => s.scrollRequest);
  const setZoom = usePDFStore((s) => s.setZoom);
  const setCurrentPage = usePDFStore((s) => s.setCurrentPage);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ docX: number; docY: number; clientX: number; clientY: number; zoom: number } | null>(null);

  const sizes = useMemo(() => pages.map((p) => displaySize(p)), [pages]);
  const maxWidth = useMemo(() => Math.max(1, ...sizes.map((s) => s.width)), [sizes]);

  // Page top offsets (in CSS px at the current zoom).
  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = PADDING;
    for (const s of sizes) {
      out.push(y);
      y += s.height * zoom + PAGE_GAP;
    }
    return out;
  }, [sizes, zoom]);

  // Fit modes follow the container size.
  const applyFit = useCallback(() => {
    const el = containerRef.current;
    const mode = usePDFStore.getState().fitMode;
    if (!el || !mode || sizes.length === 0) return;
    const availW = el.clientWidth - PADDING * 2 - 12;
    let z = availW / maxWidth;
    if (mode === 'page') {
      const current = usePDFStore.getState().currentPageId;
      const idx = Math.max(0, usePDFStore.getState().pages.findIndex((p) => p.id === current));
      const s = sizes[idx] ?? sizes[0];
      z = Math.min(availW / s.width, (el.clientHeight - PADDING * 2) / s.height);
    }
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - usePDFStore.getState().zoom) > 0.001) setZoom(z, mode);
  }, [maxWidth, sizes, setZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit]);

  useEffect(() => {
    applyFit();
  }, [fitMode, applyFit]);

  // Keep the point under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = containerRef.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    const rect = el.getBoundingClientRect();
    el.scrollLeft = a.docX * (zoom / a.zoom) - (a.clientX - rect.left);
    el.scrollTop = a.docY * (zoom / a.zoom) - (a.clientY - rect.top);
  }, [zoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const current = usePDFStore.getState().zoom;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * Math.exp(-e.deltaY * 0.0015)));
      zoomAnchor.current = {
        docX: el.scrollLeft + (e.clientX - rect.left),
        docY: el.scrollTop + (e.clientY - rect.top),
        clientX: e.clientX,
        clientY: e.clientY,
        zoom: current,
      };
      setZoom(next, null);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // Track the page in the middle of the viewport.
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || offsets.length === 0) return;
    const mid = el.scrollTop + el.clientHeight * 0.4;
    let idx = 0;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= mid) idx = i;
    const id = usePDFStore.getState().pages[idx]?.id;
    if (id) setCurrentPage(id);
  }, [offsets, setCurrentPage]);

  useEffect(() => {
    if (!scrollRequest) return;
    const el = containerRef.current;
    const idx = pages.findIndex((p) => p.id === scrollRequest.pageId);
    if (!el || idx < 0) return;
    const y = offsets[idx] + (scrollRequest.y !== undefined ? scrollRequest.y * zoom - el.clientHeight / 3 : -12);
    el.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    // Only react to new requests, not to zoom/offset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.seq]);

  // Hand tool (or middle mouse button) panning.
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    if (tool === 'pan' || e.button === 1) {
      e.preventDefault();
      pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el || !pan.current) return;
    el.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.top - (e.clientY - pan.current.y);
  };
  const endPan = () => {
    pan.current = null;
  };

  const totalHeight = offsets.length ? offsets[offsets.length - 1] + sizes[sizes.length - 1].height * zoom + PADDING : 0;
  const contentWidth = maxWidth * zoom + PADDING * 2;

  return (
    <div
      ref={containerRef}
      data-testid="pdf-canvas"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      className={cn('relative h-full w-full overflow-auto bg-canvas', tool === 'pan' && 'cursor-grab active:cursor-grabbing')}
    >
      <div className="relative mx-auto" style={{ width: contentWidth, height: totalHeight, minWidth: '100%' }}>
        {pages.map((page, i) => (
          <div
            key={page.id}
            className="absolute left-1/2 -translate-x-1/2"
            style={{ top: offsets[i], width: sizes[i].width * zoom, height: sizes[i].height * zoom }}
          >
            <PageView page={page} index={i} zoom={zoom} scrollRoot={containerRef} />
          </div>
        ))}
      </div>
    </div>
  );
}
