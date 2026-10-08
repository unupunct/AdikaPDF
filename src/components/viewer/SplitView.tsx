/**
 * View → Split: a second, read-only pane beside the main viewer, with its own
 * zoom and scrolling. It shows this document (another part of it) or any
 * other open tab; edits are drawn on top. Optionally it follows the page of
 * the main view.
 */
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { Layer, Stage } from 'react-konva';
import { X, ZoomIn, ZoomOut, MoveHorizontal } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { tabInfo, useTabs } from '@/store/tabs';
import { renderPageToCanvas } from '@/lib/pdf/pdfService';
import { displaySize } from '@/lib/geometry';
import { ObjectNode } from './ObjectNode';
import { Checkbox, Select } from '@/components/ui/primitives';
import type { EditorObject, PageRef } from '@/types';

export const useSplit = create<{ open: boolean; tabId: string | null; zoom: number | null; follow: boolean }>()(() => ({ open: false, tabId: null, zoom: null, follow: false }));

export function toggleSplit(): void {
  const s = useSplit.getState();
  useSplit.setState({ open: !s.open, tabId: s.open ? s.tabId : null });
}

const noop = () => undefined;

const SplitPage = memo(function SplitPage({ page, index, zoom, objects, root }: { page: PageRef; index: number; zoom: number; objects: EditorObject[]; root: RefObject<HTMLDivElement | null> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const size = displaySize(page);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => setNear(e.some((x) => x.isIntersecting)), { root: root.current, rootMargin: '120% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!near || !canvas.current) return;
    const h = renderPageToCanvas(page, canvas.current, zoom);
    h.promise.catch(() => undefined);
    return () => h.cancel();
  }, [near, page, zoom]);
  // Free bitmap memory for pages scrolled far away (as the main view does).
  useEffect(() => {
    const c = canvas.current;
    if (near || !c) return;
    c.width = 0;
    c.height = 0;
  }, [near]);
  return (
    <div ref={wrap} className="relative mx-auto mb-3 bg-white shadow" style={{ width: size.width * zoom, height: size.height * zoom }} data-testid={`split-page-${index + 1}`}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {near && objects.length ? (
        <Stage width={size.width * zoom} height={size.height * zoom} scaleX={zoom} scaleY={zoom} listening={false} className="pointer-events-none absolute inset-0">
          <Layer listening={false}>
            {objects.map((o) => (
              <ObjectNode key={o.id} obj={o} draggable={false} listening={false} hidden={false} onSelect={noop} onDoubleClick={noop} onDragMove={noop} onDragEnd={noop} onTransformEnd={noop} />
            ))}
          </Layer>
        </Stage>
      ) : null}
    </div>
  );
});

export function SplitView() {
  const { tabId, zoom: zoomSet, follow } = useSplit();
  const tabs = useTabs();
  const activePages = usePDFStore((s) => s.pages);
  const activeObjects = usePDFStore((s) => s.objects);
  const current = usePDFStore((s) => s.currentPageId);
  const self = !tabId || tabId === tabs.activeId || !tabs.tabs.some((t) => t.id === tabId);
  const other = self ? null : tabs.tabs.find((t) => t.id === tabId)?.slice ?? null;
  const pages = self ? activePages : (other?.pages ?? []);
  const objects = self ? activeObjects : (other?.objects ?? []);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = pages.length ? Math.max(0.1, (width - 32) / displaySize(pages[0]).width) : 1;
  const zoom = zoomSet ?? fit;
  const byPage = useMemo(() => {
    const m = new Map<string, EditorObject[]>();
    for (const o of objects) m.set(o.pageId, [...(m.get(o.pageId) ?? []), o]);
    return m;
  }, [objects]);

  // Follow the main view: show the same page number.
  useEffect(() => {
    if (!follow || !self || !current) return;
    const i = pages.findIndex((p) => p.id === current);
    const el = root.current?.querySelector(`[data-testid="split-page-${i + 1}"]`) as HTMLElement | null;
    if (el && root.current) root.current.scrollTop = el.offsetTop - 12;
  }, [follow, self, current, pages]);

  const options = [{ value: '__self', label: 'This document' }, ...tabs.tabs.filter((t) => t.id !== tabs.activeId && t.slice?.pages.length).map((t) => ({ value: t.id, label: tabInfo(t, tabs.activeId).name ?? 'Untitled' }))];

  return (
    <aside className="flex min-w-0 flex-1 flex-col border-l border-app bg-app" data-testid="split-view">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app bg-panel px-2 text-[12px]">
        <div className="w-48">
          <Select value={self ? '__self' : tabId!} onChange={(v: string) => useSplit.setState({ tabId: v === '__self' ? null : v })} options={options} ariaLabel="Document in the split pane" />
        </div>
        <button type="button" className="rounded p-1 hover-app" aria-label="Zoom out" onClick={() => useSplit.setState({ zoom: Math.max(0.2, zoom / 1.2) })}>
          <ZoomOut size={15} />
        </button>
        <span className="w-10 text-center tabular-nums" data-no-translate>
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className="rounded p-1 hover-app" aria-label="Zoom in" onClick={() => useSplit.setState({ zoom: Math.min(6, zoom * 1.2) })}>
          <ZoomIn size={15} />
        </button>
        <button type="button" className="rounded p-1 hover-app" aria-label="Fit width" title="Fit width" onClick={() => useSplit.setState({ zoom: null })}>
          <MoveHorizontal size={15} />
        </button>
        {self ? <Checkbox checked={follow} onChange={(v) => useSplit.setState({ follow: v })} label="Follow the main view" /> : null}
        <span className="flex-1" />
        <button type="button" className="rounded p-1 hover-app" aria-label="Close split view" onClick={() => useSplit.setState({ open: false })} data-testid="split-close">
          <X size={15} />
        </button>
      </div>
      <div ref={root} className="relative min-h-0 flex-1 overflow-auto p-4" data-testid="split-scroll">
        {pages.map((p, i) => (
          <SplitPage key={p.id} page={p} index={i} zoom={zoom} objects={byPage.get(p.id) ?? []} root={root} />
        ))}
      </div>
    </aside>
  );
}
