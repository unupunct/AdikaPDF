/**
 * Reading layers over each page: pdf.js' selectable text layer (select,
 * copy, double/triple-click) and a link layer (internal jumps with back /
 * forward history, external links after confirmation).
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { PageRef } from '@/types';
import { usePDFStore } from '@/store/usePDFStore';
import { askConfirm } from '@/store/useDialogs';
import { getAnnotations, getPdfPage, getTextContent, pdfjs, resolveDestination, type PageAnnotation } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { openExternal } from '@/lib/platform';

export const TextSelectionLayer = memo(function TextSelectionLayer({ page, zoom, active }: { page: PageRef; zoom: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const div = ref.current;
    if (!div || page.kind !== 'source' || !page.sourceId) return;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    let cancelled = false;
    // Debounce during zoom gestures, like the page raster.
    const timer = setTimeout(async () => {
      let content;
      let pdfPage;
      try {
        [content, pdfPage] = await Promise.all([getTextContent(page.sourceId!, page.sourceIndex), getPdfPage(page.sourceId!, page.sourceIndex)]);
      } catch {
        return; // document closed meanwhile
      }
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale: zoom, rotation: totalRotation(page) });
      div.replaceChildren();
      div.style.setProperty('--scale-factor', String(zoom));
      div.style.setProperty('--total-scale-factor', String(zoom));
      layer = new pdfjs.TextLayer({ textContentSource: content, container: div, viewport });
      try {
        await layer.render();
      } catch {
        return; // cancelled
      }
      // pdf.js' trick for stable selections past the last glyph.
      const end = document.createElement('div');
      end.className = 'endOfContent';
      div.append(end);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      layer?.cancel();
    };
  }, [page, zoom]);

  return (
    <div
      ref={ref}
      className="textLayer"
      data-testid="text-layer"
      onPointerDown={(e) => {
        if (e.button === 0) e.currentTarget.classList.add('selecting');
        const el = e.currentTarget;
        const done = () => {
          el.classList.remove('selecting');
          window.removeEventListener('pointerup', done);
        };
        window.addEventListener('pointerup', done);
      }}
      style={{ pointerEvents: active ? 'auto' : 'none', zIndex: active ? 12 : 1 }}
    />
  );
});

interface LinkBox {
  left: number;
  top: number;
  width: number;
  height: number;
  annot: PageAnnotation;
}

export const LinkLayer = memo(function LinkLayer({ page, zoom, active }: { page: PageRef; zoom: number; active: boolean }) {
  const [links, setLinks] = useState<LinkBox[]>([]);

  useEffect(() => {
    let alive = true;
    if (page.kind !== 'source' || !page.sourceId) return;
    void (async () => {
      const loaded = await Promise.all([getAnnotations(page.sourceId!, page.sourceIndex), getPdfPage(page.sourceId!, page.sourceIndex)]).catch(() => null);
      if (!loaded) return; // document closed meanwhile
      const [annots, pdfPage] = loaded;
      const vp = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
      const boxes = annots
        .filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest || a.action) && !(a.id && page.takenAnnots?.includes(a.id)))
        .map((a) => {
          const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
          const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
          return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), annot: a };
        });
      if (alive) setLinks(boxes);
    })();
    return () => {
      alive = false;
    };
  }, [page]);

  if (!active || links.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 14 }} data-testid="link-layer">
      {links.map((l, i) => (
        <a
          key={i}
          href="#"
          role="link"
          data-testid="pdf-link"
          title={l.annot.url ?? l.annot.unsafeUrl ?? 'Go to destination'}
          onClick={(e) => {
            e.preventDefault();
            void followLink(page, l.annot);
          }}
          className="pointer-events-auto absolute rounded-sm hover:bg-brand-500/15 hover:outline hover:outline-1 hover:outline-brand-500/60"
          style={{ left: l.left * zoom, top: l.top * zoom, width: l.width * zoom, height: l.height * zoom }}
        />
      ))}
    </div>
  );
});

/** Follows a link annotation: external URL (confirmed), destination or named action. */
export async function followLink(page: PageRef, annot: PageAnnotation): Promise<void> {
  const store = usePDFStore.getState();
  const url = annot.url ?? annot.unsafeUrl;
  if (url) {
    if (!/^(https?:|mailto:)/i.test(url)) {
      store.toast(`Blocked a link to “${url.slice(0, 80)}” (only web and e-mail links are opened).`, 'error');
      return;
    }
    const ok = await askConfirm({ title: 'Open link?', message: `This document wants to open:\n${url}`, confirmLabel: 'Open in browser' });
    if (ok) await openExternal(url).catch((e: unknown) => store.toast(String(e), 'error'));
    return;
  }
  if (annot.action) {
    const idx = store.pages.findIndex((p) => p.id === (store.currentPageId ?? page.id));
    const target =
      annot.action === 'NextPage' ? store.pages[idx + 1] : annot.action === 'PrevPage' ? store.pages[idx - 1] : annot.action === 'FirstPage' ? store.pages[0] : annot.action === 'LastPage' ? store.pages[store.pages.length - 1] : null;
    if (annot.action === 'GoBack') store.goBack();
    else if (annot.action === 'GoForward') store.goForward();
    else if (target) store.navigateTo(target.id);
    return;
  }
  if (page.sourceId) await goToDestination(page.sourceId, annot.dest);
}

/** Navigates to a PDF destination of a source, mapped onto the current page order. */
export async function goToDestination(sourceId: string, dest: string | unknown[] | null | undefined): Promise<boolean> {
  const store = usePDFStore.getState();
  const d = await resolveDestination(sourceId, dest);
  if (!d) return false;
  const target = store.pages.find((p) => p.kind === 'source' && p.sourceId === sourceId && p.sourceIndex === d.index);
  if (!target) {
    store.toast('The link points to a page that is no longer in this document.', 'info');
    return false;
  }
  let y: number | undefined;
  if (d.top !== null) {
    const pdfPage = await getPdfPage(sourceId, d.index);
    const vp = pdfPage.getViewport({ scale: 1, rotation: totalRotation(target) });
    y = vp.convertToViewportPoint(d.left ?? 0, d.top)[1];
  }
  store.navigateTo(target.id, y);
  return true;
}
