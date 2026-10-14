/**
 * Accessibility → Reading order: numbered boxes over each tagged item of the
 * page in reading order (drag one onto another to move it before / after it,
 * click to select, Ctrl+click to add), hatched areas for untagged content
 * (draw a rectangle around it to tag it), the toolbar that sets the type of
 * the selection, and the highlight of an issue picked in the PDF/UA report.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PageRef } from '@/types';
import { useA11y } from '@/store/a11y';
import { usePDFStore } from '@/store/usePDFStore';
import { Select } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { getPdfPage } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { ORDER_TYPES, type OrderItem, type OrderType } from '@/lib/pdf/readingOrder';
import type { Box } from '@/lib/pdf/textRemoval';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function toView(page: PageRef, boxes: Array<Box | null>): Promise<Array<Rect | null>> {
  if (!page.sourceId) return boxes.map(() => null);
  const p = await getPdfPage(page.sourceId, page.sourceIndex);
  const vp = p.getViewport({ scale: 1, rotation: totalRotation(page) });
  return boxes.map((b) => {
    if (!b) return null;
    const [x1, y1] = vp.convertToViewportPoint(b.x0, b.y0);
    const [x2, y2] = vp.convertToViewportPoint(b.x1, b.y1);
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.max(Math.abs(x2 - x1), 4), height: Math.max(Math.abs(y2 - y1), 4) };
  });
}

const COLORS: Record<string, string> = { H: '#7c3aed', Figure: '#059669', Formula: '#059669', Table: '#d97706', TH: '#d97706', TD: '#d97706', L: '#0891b2', LI: '#0891b2', LBody: '#0891b2', Lbl: '#0891b2', Link: '#db2777', Form: '#db2777', Annot: '#db2777' };
const colorOf = (role: string) => COLORS[/^H\d?$/.test(role) ? 'H' : role] ?? '#2563eb';
// One shared empty selection: a new [] per call would make the store selector loop.
const NONE: string[] = [];

export const ReadingOrderLayer = memo(function ReadingOrderLayer({ page, zoom }: { page: PageRef; zoom: number }) {
  const on = useA11y((s) => s.orderMode);
  const epoch = useA11y((s) => s.epoch);
  const selected = useA11y((s) => (s.selectedPage === page.id ? s.selected : NONE));
  const [items, setItems] = useState<Array<{ item: OrderItem; r: Rect }>>([]);
  const [untagged, setUntagged] = useState<Rect[]>([]);
  const [tagged, setTagged] = useState(true);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: string | null; after: boolean } | null>(null);
  const [draw, setDraw] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    void (async () => {
      const { loadPageOrder } = await import('@/actions/pdfua');
      const o = await loadPageOrder(page).catch(() => null);
      if (!o || !alive) return;
      const rs = await toView(page, [...o.items.map((i) => i.box), ...o.untagged]).catch(() => null);
      if (!rs || !alive) return;
      setTagged(o.tagged);
      setItems(o.items.flatMap((item, k) => (rs[k] ? [{ item, r: rs[k]! }] : [])));
      setUntagged(rs.slice(o.items.length).filter((r): r is Rect => !!r));
    })();
    return () => {
      alive = false;
    };
  }, [on, page, epoch]);

  if (!on || page.kind !== 'source') return null;
  const at = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - b.left) / zoom, y: (e.clientY - b.top) / zoom };
  };
  const hit = (x: number, y: number) =>
    [...items].reverse().find(({ r }) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    ref.current?.setPointerCapture(e.pointerId);
    const p = at(e);
    const h = hit(p.x, p.y);
    if (h) {
      const st = useA11y.getState();
      const same = st.selectedPage === page.id;
      const sel = e.ctrlKey || e.metaKey || e.shiftKey ? (same && st.selected.includes(h.item.id) ? st.selected.filter((x) => x !== h.item.id) : [...(same ? st.selected : []), h.item.id]) : [h.item.id];
      useA11y.setState({ selected: sel, selectedPage: page.id });
      setDrag({ id: h.item.id, x: p.x, y: p.y, over: null, after: false });
    } else if (tagged) setDraw({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    const p = at(e);
    if (drag) {
      const h = hit(p.x, p.y);
      const moved = Math.hypot(p.x - drag.x, p.y - drag.y) > 4;
      setDrag({ ...drag, over: moved && h && h.item.id !== drag.id ? h.item.id : null, after: !!h && p.y > h.r.top + h.r.height / 2 });
    } else if (draw) setDraw({ ...draw, x1: p.x, y1: p.y });
  };
  const onUp = () => {
    const act = import('@/actions/pdfua');
    if (drag?.over) {
      const ids = items.map((i) => i.item.id).filter((id) => id !== drag.id);
      const k = ids.indexOf(drag.over);
      ids.splice(drag.after ? k + 1 : k, 0, drag.id);
      void act.then((m) => m.reorderItems(page, ids));
    }
    if (draw && Math.abs(draw.x1 - draw.x0) > 4 && Math.abs(draw.y1 - draw.y0) > 4) {
      const r = { left: Math.min(draw.x0, draw.x1), top: Math.min(draw.y0, draw.y1), width: Math.abs(draw.x1 - draw.x0), height: Math.abs(draw.y1 - draw.y0) };
      void act.then(async (m) => {
        const box = await m.viewToBox(page, r);
        if (box) await m.tagRegionOn(page, box, useA11y.getState().regionType);
      });
    } else if (draw) useA11y.setState({ selected: [], selectedPage: null });
    setDrag(null);
    setDraw(null);
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 cursor-crosshair select-none"
      style={{ zIndex: 20 }}
      data-testid="reading-order-layer"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        setDrag(null);
        setDraw(null);
      }}
    >
      {untagged.map((r, k) => (
        <div
          key={`u${k}`}
          data-testid="ro-untagged"
          title="Untagged content: draw a rectangle around it to tag it"
          className="pointer-events-none absolute border border-dashed border-rose-500"
          style={{ left: r.left * zoom, top: r.top * zoom, width: r.width * zoom, height: r.height * zoom, background: 'repeating-linear-gradient(45deg, rgba(244,63,94,0.12) 0 4px, transparent 4px 8px)' }}
        />
      ))}
      {items.map(({ item, r }) => {
        const c = colorOf(item.role);
        const sel = selected.includes(item.id);
        const target = drag?.over === item.id;
        return (
          <div
            key={item.id}
            data-testid="ro-item"
            data-order={item.order}
            data-type={item.type}
            title={`${item.order}. <${item.type}> ${item.alt || item.text}`}
            className={cn('absolute rounded-sm border', drag?.id === item.id && 'opacity-60')}
            style={{
              left: r.left * zoom,
              top: r.top * zoom,
              width: r.width * zoom,
              height: r.height * zoom,
              borderColor: c,
              borderWidth: sel ? 2 : 1,
              background: sel ? `${c}33` : `${c}14`,
              boxShadow: target ? `0 ${drag?.after ? 3 : -3}px 0 0 ${c}` : undefined,
            }}
          >
            <span className="absolute -left-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white" style={{ background: c }} data-no-translate>
              {item.order}
            </span>
            <span className="absolute right-0 top-0 rounded-bl-sm px-1 font-mono text-[9px] leading-tight text-white" style={{ background: c }} data-no-translate>
              {item.type}
            </span>
          </div>
        );
      })}
      {draw ? (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-brand-600 bg-brand-500/10"
          style={{ left: Math.min(draw.x0, draw.x1) * zoom, top: Math.min(draw.y0, draw.y1) * zoom, width: Math.abs(draw.x1 - draw.x0) * zoom, height: Math.abs(draw.y1 - draw.y0) * zoom }}
        />
      ) : null}
    </div>
  );
});

/** The area of an issue picked in the PDF/UA report. */
export const IssueHighlight = memo(function IssueHighlight({ page, zoom }: { page: PageRef; zoom: number }) {
  const hl = useA11y((s) => (s.highlight?.pageId === page.id ? s.highlight : null));
  const [r, setR] = useState<Rect | null>(null);
  useEffect(() => {
    let alive = true;
    if (!hl) {
      setR(null);
      return;
    }
    void toView(page, [hl.box]).then(([v]) => alive && setR(v), () => undefined);
    return () => {
      alive = false;
    };
  }, [hl, page]);
  if (!r) return null;
  return (
    <div
      data-testid="pdfua-highlight"
      className="pointer-events-none absolute animate-pulse rounded-sm border-2 border-amber-500 bg-amber-400/20"
      style={{ left: r.left * zoom - 3, top: r.top * zoom - 3, width: r.width * zoom + 6, height: r.height * zoom + 6, zIndex: 19 }}
    />
  );
});

const TYPE_LABEL: Record<OrderType, string> = { P: 'Paragraph', H1: 'H1', H2: 'H2', H3: 'H3', H4: 'H4', H5: 'H5', H6: 'H6', Figure: 'Figure', Formula: 'Formula', Table: 'Table', List: 'List', Artifact: 'Artifact' };

/** Toolbar of the Reading order mode. */
export function ReadingOrderBar() {
  const on = useA11y((s) => s.orderMode);
  const count = useA11y((s) => s.selected.length);
  const regionType = useA11y((s) => s.regionType);
  const hasDoc = usePDFStore((s) => s.pages.length > 0);
  if (!on || !hasDoc) return null;
  const act = () => import('@/actions/pdfua');
  return (
    <div className="fixed bottom-10 left-1/2 z-40 flex max-w-[95vw] -translate-x-1/2 flex-wrap items-center gap-1 rounded-lg border border-app bg-panel px-2 py-1.5 text-[12px] shadow-lg" data-testid="reading-order-bar" role="toolbar" aria-label="Reading order">
      <span className="mr-1 font-semibold">Reading order</span>
      <span className="mr-1 text-[11px] text-muted">{count ? `${count} selected:` : 'Select boxes, then:'}</span>
      {ORDER_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          disabled={!count}
          data-testid={`ro-type-${t}`}
          onClick={() => void act().then((m) => m.retagSelection(t))}
          className="h-6 rounded border border-app px-1.5 hover-app disabled:opacity-40"
        >
          {TYPE_LABEL[t]}
        </button>
      ))}
      <span className="ml-2 text-[11px] text-muted">Draw to tag as</span>
      <Select value={regionType} ariaLabel="Type for new regions" onChange={(v) => useA11y.setState({ regionType: v })} options={ORDER_TYPES.filter((t) => t !== 'List' && t !== 'Table').map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
      <button type="button" aria-label="Close reading order" title="Close reading order" data-testid="ro-close" onClick={() => void act().then((m) => m.setReadingOrderMode(false))} className="ml-1 flex h-6 w-6 items-center justify-center rounded hover-app">
        <X size={13} />
      </button>
    </div>
  );
}
