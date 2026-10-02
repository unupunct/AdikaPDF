/**
 * One page: the pdf.js raster underneath and the interactive editing
 * overlay on top. Rendering is lazy (only near the viewport) and re-renders
 * at the new resolution shortly after zoom changes settle; in between, the
 * previous bitmap is CSS-scaled so zooming feels instant.
 */
import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { PageRef } from '@/types';
import { isRenderCancelled, renderPageToCanvas } from '@/lib/pdf/pdfService';
import { usePDFStore } from '@/store/usePDFStore';
import { PageOverlay } from './PageOverlay';
import { LinkLayer, TextSelectionLayer } from './ReaderLayers';
import { FormFillLayer } from './FormFillLayer';
import { isTextTool } from '@/lib/tools';
import { cn } from '@/lib/cn';

interface Props {
  page: PageRef;
  index: number;
  zoom: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
}

function useNearViewport(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      root: root.current,
      rootMargin: '150% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root]);
  return near;
}

export const PageView = memo(function PageView({ page, index, zoom, scrollRoot }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNearViewport(wrapRef, scrollRoot);
  const [renderedZoom, setRenderedZoom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = usePDFStore((s) => s.currentPageId === page.id);
  const renderEpoch = usePDFStore((s) => s.renderEpoch);
  const tool = usePDFStore((s) => s.tool);
  const nightMode = usePDFStore((s) => s.nightMode);
  const reading = tool === 'selectText' || tool === 'pan';

  useEffect(() => {
    if (!near) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: ReturnType<typeof renderPageToCanvas> | null = null;
    // Render immediately the first time, debounce during zoom gestures.
    const delay = renderedZoom === null ? 0 : 160;
    const timer = setTimeout(() => {
      handle = renderPageToCanvas(page, canvas, zoom);
      handle.promise.then(
        () => {
          setRenderedZoom(zoom);
          setError(null);
        },
        // A cancelled render drew nothing at this zoom: renderedZoom stays as it was.
        (e: unknown) => {
          if (!isRenderCancelled(e)) setError(e instanceof Error ? e.message : 'Render failed');
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      handle?.cancel();
    };
    // renderedZoom is intentionally excluded: it only chooses the delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, zoom, page.sourceId, page.sourceIndex, page.baseRotation, page.userRotation, page.kind, renderEpoch]);

  // Free bitmap memory for pages far away.
  useEffect(() => {
    if (near) return;
    const c = canvasRef.current;
    if (c && renderedZoom !== null) {
      c.width = 0;
      c.height = 0;
      setRenderedZoom(null);
    }
  }, [near, renderedZoom]);

  return (
    <div
      ref={wrapRef}
      data-testid={`page-${index + 1}`}
      data-page-id={page.id}
      className={cn('relative h-full w-full', nightMode ? 'bg-[#1b1b1b]' : 'bg-white', 'shadow-[0_1px_3px_rgba(15,23,42,0.18),0_8px_24px_rgba(15,23,42,0.10)]', isCurrent && 'ring-2 ring-brand-500/40')}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden style={nightMode ? { filter: 'invert(0.92) hue-rotate(180deg)' } : undefined} />
      {renderedZoom === null && !error ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">Loading page {index + 1}…</div>
      ) : null}
      {error ? <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-rose-600">Page {index + 1} could not be rendered: {error}</div> : null}
      {near ? <TextSelectionLayer page={page} zoom={zoom} active={isTextTool(tool)} /> : null}
      {near ? <LinkLayer page={page} zoom={zoom} active={reading} /> : null}
      {near ? <PageOverlay page={page} zoom={zoom} /> : null}
      {near ? <FormFillLayer page={page} zoom={zoom} active={reading || tool === 'select'} /> : null}
      <div className="pointer-events-none absolute -left-9 top-0 hidden text-[11px] font-medium text-muted xl:block">{index + 1}</div>
    </div>
  );
});
