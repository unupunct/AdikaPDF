/**
 * Edit → Edit drawing: click a line, box, curve or filled shape that is
 * already in the PDF. It is taken out of the page content (the document is
 * rewritten, undoable) and becomes a drawing object that can be moved,
 * resized, recoloured, given another line width, or deleted.
 */
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { uid } from '@/lib/uid';
import { displayToPdfMatrix, totalRotation, type Matrix } from '@/lib/geometry';
import type { PageRef, VectorObject } from '@/types';

function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Lifts the drawing under (x, y) (display space): the smallest one there, so a box inside a box can be picked. */
export async function liftVector(page: PageRef, x: number, y: number): Promise<boolean> {
  const s0 = usePDFStore.getState();
  const why = blockedReason(s0, 'content');
  if (why) {
    s0.toast(why, 'info');
    return false;
  }
  if (page.kind !== 'source' || !page.sourceId || !s0.sources[page.sourceId]) {
    s0.toast('Drawings can be edited on pages of the opened PDF.', 'info');
    return false;
  }
  const src = s0.sources[page.sourceId];
  const [{ PDFDocument }, { vectorPaths, removePath, svgPath }, { dropUnreachableObjects }] = await Promise.all([import('pdf-lib'), import('@/lib/pdf/vectorEdit'), import('@/lib/pdf/prune')]);
  const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
  const pdfPage = doc.getPage(page.sourceIndex);
  const box = pdfPage.getCropBox();
  const inv = invert(displayToPdfMatrix(totalRotation(page), { x: box.x, y: box.y, width: box.width, height: box.height }));
  const toDisplay = (px: number, py: number): [number, number] => [px * inv[0] + py * inv[2] + inv[4], px * inv[1] + py * inv[3] + inv[5]];
  let paths;
  try {
    paths = vectorPaths(doc, pdfPage);
  } catch {
    s0.toast('The drawings of this page cannot be read.', 'error');
    return false;
  }
  // Display-space bounds of each path.
  const boxes = paths.map((p) => {
    const cs = [toDisplay(p.box.x0, p.box.y0), toDisplay(p.box.x1, p.box.y1), toDisplay(p.box.x0, p.box.y1), toDisplay(p.box.x1, p.box.y0)];
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
  const tol = 3;
  let best = -1;
  let bestArea = Infinity;
  boxes.forEach((b, i) => {
    if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return;
    const area = Math.max(1, b.x1 - b.x0) * Math.max(1, b.y1 - b.y0);
    // The smallest drawing wins; among equal ones the topmost (later) one.
    if (area <= bestArea) {
      best = i;
      bestArea = area;
    }
  });
  if (best < 0) {
    s0.toast('No drawing found there. Click directly on a line or shape in the page.', 'info');
    return false;
  }
  const p = paths[best];
  const b = boxes[best];
  const pad = p.stroke ? p.lineWidth / 2 : 0;
  const ox = b.x0 - pad;
  const oy = b.y0 - pad;
  const w = Math.max(1, b.x1 - b.x0 + 2 * pad);
  const h = Math.max(1, b.y1 - b.y0 + 2 * pad);
  const path = svgPath(p.cmds, (px, py) => {
    const [dx, dy] = toDisplay(px, py);
    return [dx - ox, dy - oy];
  });
  removePath(doc, pdfPage, p);
  dropUnreachableObjects(doc);
  const bytes = await doc.save({ useObjectStreams: true });
  const { source } = await usePDFStore.getState().addSource(bytes, src.name);
  const obj: VectorObject = {
    id: uid('obj'),
    type: 'vector',
    pageId: page.id,
    x: ox,
    y: oy,
    width: w,
    height: h,
    rotation: 0,
    opacity: p.opacity,
    path,
    naturalWidth: w,
    naturalHeight: h,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: Math.max(0.1, Math.round(p.lineWidth * 100) / 100),
    evenOdd: p.evenOdd,
  };
  const oldId = page.sourceId;
  const prefix = `${oldId}::`;
  const s = usePDFStore.getState();
  s.commit((st) => ({
    pages: st.pages.map((pg) => (pg.sourceId === oldId ? { ...pg, sourceId: source.id } : pg)),
    fieldValues: Object.fromEntries(Object.entries(st.fieldValues).map(([k, v]) => [k.startsWith(prefix) ? `${source.id}::${k.slice(prefix.length)}` : k, v])),
    objects: [...st.objects, obj],
  }));
  usePDFStore.setState({ selectedIds: [obj.id], tool: 'select' });
  s.toast('The drawing can now be moved, resized and recoloured in Properties, or deleted with Delete.', 'success');
  return true;
}
