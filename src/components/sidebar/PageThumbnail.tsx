/** Lazily rendered page thumbnail (shared by the sidebar and the organizer). */
import { memo, useEffect, useRef, useState } from 'react';
import type { PageRef } from '@/types';
import { displaySize } from '@/lib/geometry';
import { renderPageToCanvas } from '@/lib/pdf/pdfService';
import { usePDFStore } from '@/store/usePDFStore';

export const PageThumbnail = memo(function PageThumbnail({ page, width }: { page: PageRef; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const size = displaySize(page);
  const scale = width / size.width;
  const height = size.height * scale;
  const renderEpoch = usePDFStore((s) => s.renderEpoch);
  const objectCount = usePDFStore((s) => s.objects.reduce((n, o) => n + (o.pageId === page.id ? 1 : 0), 0));

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => setVisible(e.some((x) => x.isIntersecting)), { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    const h = renderPageToCanvas(page, canvasRef.current, scale);
    h.promise.then(() => setReady(true), () => setReady(true));
    return () => h.cancel();
  }, [visible, page, scale, renderEpoch]);

  return (
    <div ref={boxRef} className="relative overflow-hidden rounded-[3px] bg-white shadow-sm ring-1 ring-black/10" style={{ width, height }}>
      <canvas ref={canvasRef} className="h-full w-full" />
      {!ready ? <div className="absolute inset-0 animate-pulse bg-slate-100" /> : null}
      {objectCount > 0 ? (
        <span className="absolute right-1 top-1 rounded bg-brand-600 px-1 text-[9px] font-semibold text-white" title={`${objectCount} edit(s) on this page`}>
          {objectCount}
        </span>
      ) : null}
    </div>
  );
});
