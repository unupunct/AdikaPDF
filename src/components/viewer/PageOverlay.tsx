/**
 * Interactive editing layer over a page (react-konva). Handles every tool:
 * selection (click, shift-click, marquee), move with snapping guides,
 * resize/rotate via Transformer, line endpoint handles, and creation of
 * text, shapes, lines, freehand ink, highlights, redactions, images,
 * signatures and form fields. Coordinates are page display points; the
 * Stage is scaled by the zoom factor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Layer, Line, Rect, Stage, Transformer } from 'react-konva';
import type Konva from 'konva';
import type { EditorObject, FieldKind, LineObject, NoteObject, PageRef, TextObject, ToolId } from '@/types';
import { NotePopup } from './NotePopup';
import { getAuthor } from '@/lib/author';
import { isTextTool } from '@/lib/tools';
import { usePDFStore } from '@/store/usePDFStore';
import { displaySize, normalizeAngle, normalizeRect, objectDisplayBounds, type Rect as R } from '@/lib/geometry';
import {
  defaultFieldSize,
  makeField,
  makeImage,
  makeLine,
  makeNote,
  makePen,
  makeRedaction,
  makeShape,
  makeSignature,
  makeText,
} from '@/lib/objectFactory';
import { layoutText, TEXT_PADDING } from '@/lib/textLayout';
import { pageTextRuns, runAngle, runRect } from '@/lib/pdf/textGeometry';
import { ObjectNode } from './ObjectNode';
import { TextEditor } from './TextEditor';

type Draft =
  | { kind: 'box'; tool: ToolId; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'line'; tool: 'line' | 'arrow'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'pen'; points: number[] }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number };

const BOX_TOOLS: ToolId[] = ['rect', 'ellipse', 'highlight', 'redact', 'field-text', 'field-checkbox', 'field-radio', 'field-dropdown', 'field-signature'];
const STICKY_TOOLS: ToolId[] = ['pen', 'highlight', 'redact'];
const SNAP_PX = 6;

let lastRadioGroup: string | null = null;

function fieldKindOf(tool: ToolId): FieldKind | null {
  return tool.startsWith('field-') ? (tool.slice(6) as FieldKind) : null;
}

export function PageOverlay({ page, zoom }: { page: PageRef; zoom: number }) {
  const allObjects = usePDFStore((s) => s.objects);
  const selectedIds = usePDFStore((s) => s.selectedIds);
  const tool = usePDFStore((s) => s.tool);
  const editingTextId = usePDFStore((s) => s.editingTextId);
  const hits = usePDFStore((s) => s.search.hits);
  const activeHit = usePDFStore((s) => s.search.active);
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);

  const objects = useMemo(() => allObjects.filter((o) => o.pageId === page.id), [allObjects, page.id]);
  const selectedHere = useMemo(() => objects.filter((o) => selectedIds.includes(o.id)), [objects, selectedIds]);
  const size = displaySize(page);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [guides, setGuides] = useState<Array<{ vertical: boolean; pos: number }>>([]);
  const editing = objects.find((o): o is TextObject => o.id === editingTextId && o.type === 'text');
  const editingNote = objects.find((o): o is NoteObject => o.id === editingTextId && o.type === 'note');

  const pageHits = useMemo(() => {
    const out: Array<{ rect: R; active: boolean }> = [];
    hits.forEach((h, i) => {
      if (h.pageId === page.id) for (const r of h.rects) out.push({ rect: r, active: i === activeHit });
    });
    return out;
  }, [hits, activeHit, page.id]);

  // --------------------------------------------------------------- transformer

  const singleLine = selectedHere.length === 1 && (selectedHere[0].type === 'line' || selectedHere[0].type === 'arrow') ? (selectedHere[0] as LineObject) : null;

  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = singleLine
      ? []
      : selectedHere
          .filter((o) => !o.locked && o.id !== editingTextId)
          .map((o) => stage.findOne(`#${o.id}`))
          .filter((n): n is Konva.Node => !!n);
    tr.nodes(nodes);
    const only = selectedHere.length === 1 ? selectedHere[0] : null;
    if (only?.type === 'note' || only?.type === 'markup') tr.enabledAnchors([]);
    else if (only?.type === 'text') tr.enabledAnchors(['middle-left', 'middle-right']);
    else if (only?.type === 'field' && (only.fieldKind === 'checkbox' || only.fieldKind === 'radio'))
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    else tr.enabledAnchors(['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']);
    tr.rotateEnabled(!selectedHere.some((o) => o.type === 'field' || o.type === 'note' || o.type === 'markup'));
    tr.keepRatio(only?.type === 'image' || only?.type === 'signature');
    tr.getLayer()?.batchDraw();
  }, [selectedHere, editingTextId, singleLine, objects]);

  // --------------------------------------------------------------- pointer helpers

  const pointFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = stageRef.current?.container();
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    },
    [zoom],
  );

  const clampPoint = (p: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(size.width, p.x)),
    y: Math.max(0, Math.min(size.height, p.y)),
  });

  const finishCreation = useCallback((keepTool: boolean) => {
    if (!keepTool) usePDFStore.getState().setTool('select');
  }, []);

  const createFromDraft = useCallback(
    (d: Draft) => {
      const store = usePDFStore.getState();
      const style = store.style;
      if (d.kind === 'marquee') {
        const r = normalizeRect(d.x0, d.y0, d.x1, d.y1);
        if (r.width > 2 || r.height > 2) store.selectInRect(page.id, r);
        return;
      }
      if (d.kind === 'pen') {
        if (d.points.length >= 4) store.addObject(makePen(page.id, d.points, style), false);
        return;
      }
      if (d.kind === 'line') {
        let { x1, y1 } = d;
        if (Math.hypot(x1 - d.x0, y1 - d.y0) < 3) {
          x1 = d.x0 + 80;
          y1 = d.y0;
        }
        store.addObject(makeLine(d.tool, page.id, d.x0, d.y0, x1, y1, style));
        finishCreation(false);
        return;
      }
      let rect = normalizeRect(d.x0, d.y0, d.x1, d.y1);
      const fk = fieldKindOf(d.tool);
      const tiny = rect.width < 4 && rect.height < 4;
      if (fk) {
        const def = defaultFieldSize(fk);
        if (tiny) rect = { x: d.x0 - def.width / 2, y: d.y0 - def.height / 2, ...def };
        if (fk === 'checkbox' || fk === 'radio') {
          const s = Math.max(rect.width, rect.height, 10);
          rect = { ...rect, width: s, height: s };
        }
        const names = store.objects.filter((o) => o.type === 'field').map((o) => (o as { name: string }).name);
        const group = fk === 'radio' && lastRadioGroup && names.includes(lastRadioGroup) ? lastRadioGroup : undefined;
        const field = makeField(fk, page.id, rect, names, group);
        if (fk === 'radio') lastRadioGroup = field.name;
        store.addObject(field);
        finishCreation(true);
        return;
      }
      if (tiny) {
        if (d.tool === 'highlight' || d.tool === 'redact') return;
        rect = { x: d.x0 - 50, y: d.y0 - 30, width: 100, height: 60 };
      }
      if (d.tool === 'redact') store.addObject(makeRedaction(page.id, rect), false);
      else store.addObject(makeShape(d.tool as 'rect' | 'ellipse' | 'highlight', page.id, rect, style), d.tool !== 'highlight');
      finishCreation(STICKY_TOOLS.includes(d.tool));
    },
    [page.id, finishCreation],
  );

  const editExistingText = useCallback(
    async (x: number, y: number) => {
      const runs = await pageTextRuns(page);
      const run = runs.find((r) => {
        const b = runRect(r);
        return x >= b.x - 1 && x <= b.x + b.width + 1 && y >= b.y - 1 && y <= b.y + b.height + 1;
      });
      const store = usePDFStore.getState();
      if (!run) {
        store.toast('No text found there. Click directly on a line of text.', 'info');
        return;
      }
      const family = /mono|courier|consol/i.test(`${run.fontFamily} ${run.fontName}`)
        ? 'mono'
        : /serif|times|georgia|garamond|roman/i.test(`${run.fontFamily} ${run.fontName}`) && !/sans/i.test(`${run.fontFamily}`)
          ? 'serif'
          : 'sans';
      const base = makeText(page.id, 0, 0, store.style, {
        text: run.str,
        fontSize: Math.round(run.size * 10) / 10,
        fontFamily: family,
        bold: run.bold,
        italic: run.italic,
        color: '#000000',
        background: '#ffffff',
        width: run.width + TEXT_PADDING * 2 + run.size * 0.6,
      });
      const baseline = layoutText(base).lines[0]?.baseline ?? run.size;
      const [dx, dy] = run.dir;
      const ux = dy;
      const uy = -dx;
      const obj: TextObject = {
        ...base,
        x: run.origin[0] - dx * TEXT_PADDING + ux * baseline,
        y: run.origin[1] - dy * TEXT_PADDING + uy * baseline,
        rotation: normalizeAngle(runAngle(run)),
        height: layoutText(base).contentHeight,
      };
      store.setTool('select');
      store.addObject(obj);
      store.setEditingText(obj.id);
    },
    [page],
  );

  // --------------------------------------------------------------- stage pointer

  const onStagePointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
    if (e.evt.button !== 0 || readOnly) return;
    const store = usePDFStore.getState();
    const clickedEmpty = e.target === e.target.getStage() || e.target.name() === 'hit-bg';
    const p = clampPoint(pointFromClient(e.evt.clientX, e.evt.clientY));
    store.setCurrentPage(page.id);
    if (store.editingTextId) return; // the textarea's blur commits first

    switch (tool) {
      case 'select': {
        if (!clickedEmpty) return;
        if (!e.evt.shiftKey) store.select([]);
        startDrag({ kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        return;
      }
      case 'text': {
        // Keep the click from stealing focus from the textarea we are about to open.
        e.evt.preventDefault();
        const obj = makeText(page.id, p.x, p.y - store.style.fontSize * 0.7, store.style);
        // setTool clears text editing, so switch tools first.
        store.setTool('select');
        store.addObject(obj);
        store.setEditingText(obj.id);
        return;
      }
      case 'editText':
        void editExistingText(p.x, p.y);
        return;
      case 'note': {
        e.evt.preventDefault(); // keep focus for the popup we are about to open
        const note = makeNote(page.id, p.x, p.y, getAuthor());
        store.setTool('select');
        store.addObject(note);
        store.setEditingText(note.id);
        return;
      }
      case 'typewriter': {
        // Typewriter: a FreeText comment typed straight onto the page.
        e.evt.preventDefault();
        const obj = makeText(page.id, p.x, p.y - store.style.fontSize * 0.7, store.style, { annotation: true, author: getAuthor(), width: 260 });
        store.setTool('select');
        store.addObject(obj);
        store.setEditingText(obj.id);
        return;
      }
      case 'image': {
        const img = store.pendingImage;
        if (!img) return;
        store.addObject(makeImage(page.id, p.x, p.y, img));
        store.setPendingImage(null);
        return;
      }
      case 'signature': {
        const sig = store.pendingSignature;
        if (!sig) return;
        store.addObject(makeSignature(page.id, p.x, p.y, sig));
        store.setPendingSignature(null);
        return;
      }
      case 'pen':
        startDrag({ kind: 'pen', points: [p.x, p.y] });
        return;
      case 'line':
      case 'arrow':
        startDrag({ kind: 'line', tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        return;
      default:
        if (BOX_TOOLS.includes(tool)) startDrag({ kind: 'box', tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
  };

  const draftRef = useRef<Draft | null>(null);
  const startDrag = (d: Draft) => {
    draftRef.current = d;
    setDraft(d);
    const move = (ev: PointerEvent) => {
      const cur = draftRef.current;
      if (!cur) return;
      const p = clampPoint(pointFromClient(ev.clientX, ev.clientY));
      let next: Draft;
      if (cur.kind === 'pen') {
        const [lx, ly] = cur.points.slice(-2);
        if (Math.hypot(p.x - lx, p.y - ly) < 0.8 / zoom) return;
        next = { ...cur, points: [...cur.points, p.x, p.y] };
      } else if (cur.kind === 'line' && ev.shiftKey) {
        // Shift snaps lines to 45° steps.
        const a = Math.round(Math.atan2(p.y - cur.y0, p.x - cur.x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(p.x - cur.x0, p.y - cur.y0);
        next = { ...cur, x1: cur.x0 + len * Math.cos(a), y1: cur.y0 + len * Math.sin(a) };
      } else if (cur.kind === 'box' && ev.shiftKey && !cur.tool.startsWith('field')) {
        const s = Math.max(Math.abs(p.x - cur.x0), Math.abs(p.y - cur.y0));
        next = { ...cur, x1: cur.x0 + Math.sign(p.x - cur.x0 || 1) * s, y1: cur.y0 + Math.sign(p.y - cur.y0 || 1) * s };
      } else {
        next = { ...cur, x1: p.x, y1: p.y } as Draft;
      }
      draftRef.current = next;
      setDraft(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const cur = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (cur) createFromDraft(cur);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // --------------------------------------------------------------- object events

  const onSelect = useCallback((id: string, additive: boolean) => {
    const store = usePDFStore.getState();
    if (store.tool !== 'select') return;
    if (additive) store.select([id], true);
    else if (!store.selectedIds.includes(id)) store.select([id]);
  }, []);

  const onDoubleClick = useCallback((id: string) => {
    const store = usePDFStore.getState();
    const o = store.objects.find((x) => x.id === id);
    if ((o?.type === 'text' || o?.type === 'note') && !o.locked) {
      store.select([id]);
      store.setEditingText(id);
    }
  }, []);

  /** Snapping to page edges/centre and other objects' edges/centres. */
  const onDragMove = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>) => {
      const node = e.target;
      const store = usePDFStore.getState();
      const moving = new Set(store.selectedIds.includes(node.id()) ? store.selectedIds : [node.id()]);
      const box = node.getClientRect({ relativeTo: node.getLayer() ?? undefined });
      const vTargets = [0, size.width / 2, size.width];
      const hTargets = [0, size.height / 2, size.height];
      for (const o of store.objects) {
        if (o.pageId !== page.id || moving.has(o.id)) continue;
        const b = objectDisplayBounds(o);
        vTargets.push(b.x, b.x + b.width / 2, b.x + b.width);
        hTargets.push(b.y, b.y + b.height / 2, b.y + b.height);
      }
      const threshold = SNAP_PX / zoom;
      const found: Array<{ vertical: boolean; pos: number }> = [];
      const snap = (edges: number[], targets: number[], vertical: boolean): number => {
        let best = { d: Infinity, delta: 0, pos: 0 };
        for (const edge of edges)
          for (const t of targets) {
            const d = Math.abs(t - edge);
            if (d < best.d) best = { d, delta: t - edge, pos: t };
          }
        if (best.d <= threshold) {
          found.push({ vertical, pos: best.pos });
          return best.delta;
        }
        return 0;
      };
      const dx = e.evt.altKey ? 0 : snap([box.x, box.x + box.width / 2, box.x + box.width], vTargets, true);
      const dy = e.evt.altKey ? 0 : snap([box.y, box.y + box.height / 2, box.y + box.height], hTargets, false);
      if (dx || dy) node.position({ x: node.x() + dx, y: node.y() + dy });
      // Move the rest of a multi-selection along.
      const prev = store.objects.find((o) => o.id === node.id());
      if (prev && moving.size > 1) {
        const ddx = node.x() - prev.x;
        const ddy = node.y() - prev.y;
        const stage = node.getStage();
        for (const id of moving) {
          if (id === node.id()) continue;
          const o = store.objects.find((x) => x.id === id);
          const n = stage?.findOne(`#${id}`);
          if (o && n) n.position({ x: o.x + ddx, y: o.y + ddy });
        }
      }
      setGuides(found);
    },
    [page.id, size.width, size.height, zoom],
  );

  const onDragEnd = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    setGuides([]);
    const node = e.target;
    const store = usePDFStore.getState();
    const ids = store.selectedIds.includes(node.id()) ? store.selectedIds : [node.id()];
    const stage = node.getStage();
    const patches = ids
      .map((id) => {
        const n = stage?.findOne(`#${id}`);
        return n ? { id, patch: { x: n.x(), y: n.y() } } : null;
      })
      .filter((p): p is { id: string; patch: { x: number; y: number } } => !!p);
    if (patches.length) store.updateObjects(patches);
  }, []);

  const onTransformEnd = useCallback((e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const store = usePDFStore.getState();
    const o = store.objects.find((x) => x.id === node.id());
    if (!o) return;
    const sx = Math.abs(node.scaleX());
    const sy = Math.abs(node.scaleY());
    node.scale({ x: 1, y: 1 });
    const base = { x: node.x(), y: node.y(), rotation: normalizeAngle(node.rotation()) };
    let patch: Partial<EditorObject>;
    switch (o.type) {
      case 'text': {
        const width = Math.max(20, o.width * sx);
        patch = { ...base, width, height: layoutText({ ...o, width }).contentHeight };
        break;
      }
      case 'pen':
        patch = { ...base, points: o.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy)), strokeWidth: o.strokeWidth };
        break;
      case 'line':
      case 'arrow':
        patch = { ...base, points: [o.points[0] * sx, o.points[1] * sy, o.points[2] * sx, o.points[3] * sy] };
        break;
      default:
        patch = { ...base, width: Math.max(4, o.width * sx), height: Math.max(4, o.height * sy) };
    }
    store.updateObject(o.id, patch);
  }, []);

  const moveLineEnd = (o: LineObject, end: 0 | 1, node: Konva.Node) => {
    const [x1, y1, x2, y2] = o.points;
    // Handles live in page space; convert to the line's local frame.
    const px = node.x() - o.x;
    const py = node.y() - o.y;
    const r = (-o.rotation * Math.PI) / 180;
    const lx = px * Math.cos(r) - py * Math.sin(r);
    const ly = px * Math.sin(r) + py * Math.cos(r);
    const points: [number, number, number, number] = end === 0 ? [lx, ly, x2, y2] : [x1, y1, lx, ly];
    usePDFStore.getState().updateObject(o.id, { points });
  };

  const lineHandlePos = (o: LineObject, end: 0 | 1) => {
    const lx = o.points[end * 2];
    const ly = o.points[end * 2 + 1];
    const r = (o.rotation * Math.PI) / 180;
    return { x: o.x + lx * Math.cos(r) - ly * Math.sin(r), y: o.y + lx * Math.sin(r) + ly * Math.cos(r) };
  };

  // --------------------------------------------------------------- render

  const interactive = tool === 'select' && !readOnly;
  const cursor =
    tool === 'pan'
      ? undefined
      : tool === 'select'
        ? 'default'
        : tool === 'text' || tool === 'editText' || tool === 'typewriter'
          ? 'text'
          : 'crosshair';

  return (
    <div className="absolute inset-0" style={{ cursor, pointerEvents: tool === 'pan' || isTextTool(tool) ? 'none' : 'auto', zIndex: 10 }}>
      <Stage
        ref={stageRef}
        width={size.width * zoom}
        height={size.height * zoom}
        scaleX={zoom}
        scaleY={zoom}
        onPointerDown={onStagePointerDown}
      >
        <Layer>
          <Rect name="hit-bg" width={size.width} height={size.height} fill="transparent" />
          {pageHits.map((h, i) => (
            <Rect
              key={`hit-${i}`}
              x={h.rect.x}
              y={h.rect.y}
              width={h.rect.width}
              height={h.rect.height}
              fill={h.active ? '#f97316' : '#facc15'}
              opacity={h.active ? 0.5 : 0.35}
              globalCompositeOperation="multiply"
              listening={false}
            />
          ))}
          {objects.map((o) => (
            <ObjectNode
              key={o.id}
              obj={o}
              draggable={interactive && !o.locked && o.id !== editingTextId && o.type !== 'markup'}
              listening={interactive}
              hidden={o.id === editingTextId && o.type === 'text'}
              onSelect={onSelect}
              onDoubleClick={onDoubleClick}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              onTransformEnd={onTransformEnd}
            />
          ))}
          {draft ? <DraftNode draft={draft} zoom={zoom} /> : null}
          {guides.map((g, i) => (
            <Line
              key={`g-${i}`}
              points={g.vertical ? [g.pos, 0, g.pos, size.height] : [0, g.pos, size.width, g.pos]}
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 3 / zoom]}
              listening={false}
            />
          ))}
          {selectedHere.length > 0 && !singleLine
            ? selectedHere.map((o) => {
                if (!o.locked) return null;
                const b = objectDisplayBounds(o);
                return <Rect key={`lock-${o.id}`} {...b} stroke="#94a3b8" strokeWidth={1 / zoom} dash={[3 / zoom, 3 / zoom]} listening={false} />;
              })
            : null}
          <Transformer
            ref={trRef}
            rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
            rotationSnapTolerance={4}
            borderStroke="#0284c7"
            anchorStroke="#0284c7"
            anchorFill="#ffffff"
            anchorSize={8}
            anchorCornerRadius={2}
            ignoreStroke
            flipEnabled={false}
            boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          />
          {singleLine && interactive && !singleLine.locked
            ? ([0, 1] as const).map((end) => {
                const p = lineHandlePos(singleLine, end);
                return (
                  <Circle
                    key={`h-${end}`}
                    x={p.x}
                    y={p.y}
                    radius={5 / zoom}
                    fill="#ffffff"
                    stroke="#0284c7"
                    strokeWidth={1.5 / zoom}
                    draggable
                    onMouseDown={(e) => (e.cancelBubble = true)}
                    onDragEnd={(e) => moveLineEnd(singleLine, end, e.target)}
                  />
                );
              })
            : null}
          {singleLine ? (
            <Rect
              {...objectDisplayBounds(singleLine)}
              stroke="#0284c7"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 3 / zoom]}
              listening={false}
            />
          ) : null}
        </Layer>
      </Stage>
      {editing ? <TextEditor key={editing.id} obj={editing} zoom={zoom} /> : null}
      {editingNote ? <NotePopup key={editingNote.id} note={editingNote} zoom={zoom} pageWidth={size.width} /> : null}
    </div>
  );
}

function DraftNode({ draft, zoom }: { draft: Draft; zoom: number }) {
  const style = usePDFStore((s) => s.style);
  if (draft.kind === 'pen') {
    return <Line points={draft.points} stroke={style.stroke} strokeWidth={style.strokeWidth} opacity={style.opacity} lineCap="round" lineJoin="round" listening={false} />;
  }
  if (draft.kind === 'line') {
    return <Line points={[draft.x0, draft.y0, draft.x1, draft.y1]} stroke={style.stroke} strokeWidth={style.strokeWidth} lineCap="round" listening={false} />;
  }
  const r = normalizeRect(draft.x0, draft.y0, draft.x1, draft.y1);
  if (draft.kind === 'marquee') {
    return <Rect {...r} fill="rgba(2,132,199,0.08)" stroke="#0284c7" strokeWidth={1 / zoom} dash={[4 / zoom, 3 / zoom]} listening={false} />;
  }
  const fill =
    draft.tool === 'highlight'
      ? style.highlightColor
      : draft.tool === 'redact'
        ? '#000000'
        : draft.tool.startsWith('field')
          ? 'rgba(2,132,199,0.12)'
          : (style.fill ?? undefined);
  return (
    <Rect
      {...r}
      cornerRadius={draft.tool === 'ellipse' ? Math.min(r.width, r.height) / 2 : 0}
      fill={fill}
      opacity={draft.tool === 'highlight' ? 0.45 : draft.tool === 'redact' ? 0.8 : 1}
      stroke={draft.tool === 'highlight' || draft.tool === 'redact' ? undefined : draft.tool.startsWith('field') ? '#0284c7' : style.stroke}
      strokeWidth={draft.tool.startsWith('field') ? 1 / zoom : style.strokeWidth}
      listening={false}
    />
  );
}
