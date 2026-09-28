/**
 * Main document viewer. Pages are laid out in rows (one page per row, or two
 * for facing / book view), scrolled continuously or one row at a time, with
 * fit-width / fit-page zoom, Ctrl+wheel zoom anchored at the cursor, hand-tool
 * panning, current-page tracking, lazy page mounting and a view-only rotation.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { usePDFStore, MIN_ZOOM, MAX_ZOOM } from '@/store/usePDFStore';
import { displaySize } from '@/lib/geometry';
import type { PageRef } from '@/types';
import { PageView } from './PageView';
import { Magnifier } from './Magnifier';
import { AutoScroller } from './AutoScroll';
import { cn } from '@/lib/cn';

export const PAGE_GAP = 20;
const PADDING = 24;

interface Slot {
  index: number;
  page: PageRef;
  /** Unrotated (page display) size in points. */
  w: number;
  h: number;
  /** Size of the slot after the view rotation, in points. */
  sw: number;
  sh: number;
}

interface Row {
  slots: Slot[];
  top: number;
  width: number;
  height: number;
}

/** Groups page indices into rows for the spread mode. */
export function spreadRows(count: number, spread: 'none' | 'odd' | 'even'): number[][] {
  const rows: number[][] = [];
  if (spread === 'none') {
    for (let i = 0; i < count; i++) rows.push([i]);
    return rows;
  }
  let i = 0;
  if (spread === 'even' && count > 0) {
    rows.push([0]); // book view: the cover stands alone
    i = 1;
  }
  for (; i < count; i += 2) rows.push(i + 1 < count ? [i, i + 1] : [i]);
  return rows;
}

export function PDFCanvas() {
  const pages = usePDFStore((s) => s.pages);
  const zoom = usePDFStore((s) => s.zoom);
  const fitMode = usePDFStore((s) => s.fitMode);
  const tool = usePDFStore((s) => s.tool);
  const scrollRequest = usePDFStore((s) => s.scrollRequest);
  const viewScroll = usePDFStore((s) => s.viewScroll);
  const viewSpread = usePDFStore((s) => s.viewSpread);
  const viewRotation = usePDFStore((s) => s.viewRotation);
  const nightMode = usePDFStore((s) => s.nightMode);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const setZoom = usePDFStore((s) => s.setZoom);
  const setCurrentPage = usePDFStore((s) => s.setCurrentPage);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ docX: number; docY: number; clientX: number; clientY: number; zoom: number } | null>(null);

  const swapped = viewRotation % 180 !== 0;
  const allRows = useMemo(() => {
    const groups = spreadRows(pages.length, viewSpread);
    return groups.map((g) =>
      g.map((index): Slot => {
        const { width: w, height: h } = displaySize(pages[index]);
        return { index, page: pages[index], w, h, sw: swapped ? h : w, sh: swapped ? w : h };
      }),
    );
  }, [pages, viewSpread, swapped]);

  const currentRow = useMemo(() => {
    const i = allRows.findIndex((r) => r.some((s) => s.page.id === currentPageId));
    return i < 0 ? 0 : i;
  }, [allRows, currentPageId]);

  // Rows actually laid out (all, or the current one in single-page mode).
  const rows = useMemo((): Row[] => {
    const source = viewScroll === 'single' ? allRows.slice(currentRow, currentRow + 1) : allRows;
    const out: Row[] = [];
    let y = PADDING;
    for (const slots of source) {
      const width = slots.reduce((n, s) => n + s.sw * zoom, 0) + PAGE_GAP * (slots.length - 1);
      const height = Math.max(...slots.map((s) => s.sh * zoom));
      out.push({ slots, top: y, width, height });
      y += height + PAGE_GAP;
    }
    return out;
  }, [allRows, currentRow, viewScroll, zoom]);

  // Fit modes follow the container size.
  const applyFit = useCallback(() => {
    const el = containerRef.current;
    const mode = usePDFStore.getState().fitMode;
    if (!el || !mode || allRows.length === 0) return;
    const availW = el.clientWidth - PADDING * 2 - 12;
    const rowWidth = (r: Slot[]) => r.reduce((n, s) => n + s.sw, 0);
    let z: number;
    if (mode === 'width') {
      // Fit the widest row (points) plus its fixed pixel gaps.
      const widest = allRows.reduce((best, r) => (rowWidth(r) > rowWidth(best) ? r : best), allRows[0]);
      z = (availW - PAGE_GAP * (widest.length - 1)) / rowWidth(widest);
    } else {
      const row = allRows[currentRow] ?? allRows[0];
      const rowH = Math.max(...row.map((s) => s.sh));
      z = Math.min((availW - PAGE_GAP * (row.length - 1)) / rowWidth(row), (el.clientHeight - PADDING * 2) / rowH);
    }
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - usePDFStore.getState().zoom) > 0.001) setZoom(z, mode);
  }, [allRows, currentRow, setZoom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit]);

  useEffect(() => {
    applyFit();
  }, [fitMode, viewSpread, viewRotation, applyFit]);

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

  const stepRow = useCallback(
    (d: number) => {
      const next = allRows[Math.max(0, Math.min(allRows.length - 1, currentRow + d))];
      if (next && next[0].page.id !== currentPageId) setCurrentPage(next[0].page.id);
      return !!next;
    },
    [allRows, currentRow, currentPageId, setCurrentPage],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
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
        return;
      }
      // Single-page mode: scrolling past the page edge turns the page.
      if (usePDFStore.getState().viewScroll !== 'single') return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 1;
      if (e.deltaY > 0 && atBottom) {
        e.preventDefault();
        if (stepRow(1)) el.scrollTop = 0;
      } else if (e.deltaY < 0 && atTop) {
        e.preventDefault();
        if (stepRow(-1)) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom, stepRow]);

  // Track the page in the middle of the viewport (continuous mode).
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || rows.length === 0 || viewScroll === 'single') return;
    const mid = el.scrollTop + el.clientHeight * 0.4;
    let r = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].top <= mid) r = i;
    const row = rows[r];
    if (!row.slots.some((s) => s.page.id === usePDFStore.getState().currentPageId)) setCurrentPage(row.slots[0].page.id);
  }, [rows, viewScroll, setCurrentPage]);

  useEffect(() => {
    if (!scrollRequest) return;
    const el = containerRef.current;
    if (!el) return;
    if (viewScroll === 'single') {
      // The current page changed already (scrollToPage sets it); show its top or y.
      requestAnimationFrame(() => {
        const y = scrollRequest.y !== undefined && viewRotation === 0 ? scrollRequest.y * zoom - el.clientHeight / 3 : 0;
        el.scrollTo({ top: Math.max(0, y) });
      });
      return;
    }
    const r = rows.findIndex((row) => row.slots.some((s) => s.page.id === scrollRequest.pageId));
    if (r < 0) return;
    const y = rows[r].top + (scrollRequest.y !== undefined && viewRotation === 0 ? scrollRequest.y * zoom - el.clientHeight / 3 : -12);
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

  const last = rows[rows.length - 1];
  const totalHeight = last ? last.top + last.height + PADDING : 0;
  const contentWidth = Math.max(...rows.map((r) => r.width), 0) + PADDING * 2;

  return (
    <div
      ref={containerRef}
      data-testid="pdf-canvas"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      className={cn('relative h-full w-full overflow-auto', nightMode ? 'bg-[#0b0b0b]' : 'bg-canvas', tool === 'pan' && 'cursor-grab active:cursor-grabbing')}
    >
      <div className="relative mx-auto" style={{ width: contentWidth, height: totalHeight, minWidth: '100%' }}>
        {rows.map((row) => {
          let x = 0;
          return row.slots.map((s) => {
            const left = x;
            x += s.sw * zoom + PAGE_GAP;
            const w = s.w * zoom;
            const h = s.h * zoom;
            const sw = s.sw * zoom;
            const sh = s.sh * zoom;
            return (
              <div
                key={s.page.id}
                className="absolute"
                style={{ top: row.top + (row.height - sh) / 2, left: `calc(50% - ${row.width / 2}px + ${left}px)`, width: sw, height: sh }}
              >
                <div
                  className="absolute"
                  style={{
                    width: w,
                    height: h,
                    left: (sw - w) / 2,
                    top: (sh - h) / 2,
                    transform: viewRotation ? `rotate(${viewRotation}deg)` : undefined,
                  }}
                >
                  <PageView page={s.page} index={s.index} zoom={zoom} scrollRoot={containerRef} />
                </div>
              </div>
            );
          });
        })}
      </div>
      <Magnifier container={containerRef} />
      <AutoScroller container={containerRef} />
    </div>
  );
}
