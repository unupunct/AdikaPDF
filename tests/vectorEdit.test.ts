import { describe, expect, it } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { parseSvgPath, removePath, svgPath, vectorPaths } from '@/lib/pdf/vectorEdit';
import { buildPdf } from '@/lib/pdf/exportPdf';
import type { PageRef, VectorObject } from '@/types';

async function drawing() {
  const d = await PDFDocument.create();
  const p = d.addPage([400, 400]);
  p.drawRectangle({ x: 50, y: 300, width: 100, height: 50, color: rgb(1, 0, 0) });
  p.drawLine({ start: { x: 50, y: 200 }, end: { x: 350, y: 200 }, thickness: 3, color: rgb(0, 0, 1) });
  p.drawCircle({ x: 300, y: 320, size: 30, color: rgb(0, 0.5, 0), borderColor: rgb(0, 0, 0), borderWidth: 2, opacity: 0.5 });
  return PDFDocument.load(await d.save());
}

describe('drawings on the page', () => {
  it('reads each painted path with its colours, width, opacity and bounds', async () => {
    const doc = await drawing();
    const paths = vectorPaths(doc, doc.getPage(0));
    expect(paths).toHaveLength(3);
    const [rect, line, circle] = paths;
    expect(rect).toMatchObject({ fill: '#ff0000', stroke: null });
    expect(rect.box).toEqual({ x0: 50, y0: 300, x1: 150, y1: 350 });
    expect(line).toMatchObject({ fill: null, stroke: '#0000ff', lineWidth: 3 });
    expect(circle).toMatchObject({ fill: '#008000', stroke: '#000000', lineWidth: 2, opacity: 0.5 });
    expect(circle.cmds.some((c) => c.c === 'C')).toBe(true);
    expect(circle.box.x0).toBeCloseTo(270, 0);
    expect(circle.box.y1).toBeCloseTo(350, 0);
  });

  it('removes one path from the page and keeps the others', async () => {
    const doc = await drawing();
    const page = doc.getPage(0);
    removePath(doc, page, vectorPaths(doc, page)[1]);
    const again = await PDFDocument.load(await doc.save());
    const left = vectorPaths(again, again.getPage(0));
    expect(left.map((p) => p.fill ?? p.stroke)).toEqual(['#ff0000', '#008000']);
  });

  it('writes a lifted drawing back with its new colour, size and place', async () => {
    const d = await PDFDocument.create();
    d.addPage([400, 400]);
    const src = { id: 's', name: 'd.pdf', bytes: await d.save(), pageCount: 1 };
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 400, height: 400 };
    const path = svgPath(
      [{ c: 'M', p: [0, 0] }, { c: 'L', p: [100, 0] }, { c: 'L', p: [100, 50] }, { c: 'L', p: [0, 50] }, { c: 'Z' }],
      (x, y) => [x, y],
    );
    expect(parseSvgPath(path)).toHaveLength(5);
    const v: VectorObject = { id: 'v', type: 'vector', pageId: 'p', x: 20, y: 30, width: 200, height: 50, rotation: 0, opacity: 1, path, naturalWidth: 100, naturalHeight: 50, fill: '#00ff00', stroke: '#112233', strokeWidth: 2, evenOdd: false };
    const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [v], fieldValues: {} });
    const doc = await PDFDocument.load(out);
    const [p] = vectorPaths(doc, doc.getPage(0));
    expect(p).toMatchObject({ fill: '#00ff00', stroke: '#112233', lineWidth: 2 });
    // Display (20, 30)-(220, 80), y down -> PDF y = 400 - y.
    expect(p.box.x0).toBeCloseTo(20);
    expect(p.box.x1).toBeCloseTo(220);
    expect(p.box.y0).toBeCloseTo(320);
    expect(p.box.y1).toBeCloseTo(370);
  });
});
