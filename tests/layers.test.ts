import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { deleteLayers, flattenLayers, listLayers, mergeLayers, renameLayer } from '@/lib/pdf/layers';
import { buildPdf } from '@/lib/pdf/exportPdf';
import type { PageRef, ShapeObject } from '@/types';

/** A page with text in two layers (Plan, Dimensions) and outside them. */
async function layered(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage([400, 400]);
  const font = await d.embedFont(StandardFonts.Helvetica);
  page.drawText('Always', { x: 20, y: 350, size: 12, font });
  const plan = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Plan') }));
  const dims = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Dimensions') }));
  const fontName = (page.node.Resources()!.lookup(PDFName.of('Font')) as unknown as { keys(): PDFName[] }).keys()[0].decodeText();
  const extra = d.context.flateStream(`/OC /L1 BDC BT /${fontName} 12 Tf 20 300 Td (PlanText) Tj ET EMC /OC /L2 BDC BT /${fontName} 12 Tf 20 250 Td (DimText) Tj ET EMC`);
  const contents = page.node.lookup(PDFName.of('Contents'));
  if (contents instanceof PDFArray) contents.push(d.context.register(extra));
  else page.node.set(PDFName.of('Contents'), d.context.obj([page.node.get(PDFName.of('Contents')) as never, d.context.register(extra)]));
  page.node.Resources()!.set(PDFName.of('Properties'), d.context.obj({ L1: plan, L2: dims }));
  d.catalog.set(PDFName.of('OCProperties'), d.context.obj({ OCGs: [plan, dims], D: { Order: [plan, dims], ON: [plan, dims], OFF: [] } }));
  return d.save();
}

async function text(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const c = await (await doc.getPage(1)).getTextContent();
  await doc.loadingTask.destroy();
  return c.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

describe('layers', () => {
  it('lists and renames layers', async () => {
    const doc = await PDFDocument.load(await layered());
    const layers = listLayers(doc);
    expect(layers.map((l) => l.name)).toEqual(['Plan', 'Dimensions']);
    renameLayer(doc, layers[0].id, 'Floor plan');
    expect(listLayers(await PDFDocument.load(await doc.save())).map((l) => l.name)).toEqual(['Floor plan', 'Dimensions']);
  });

  it('deletes a layer with its content', async () => {
    const doc = await PDFDocument.load(await layered());
    deleteLayers(doc, [listLayers(doc)[1].id]);
    const out = await doc.save();
    expect(listLayers(await PDFDocument.load(out)).map((l) => l.name)).toEqual(['Plan']);
    const t = await text(out);
    expect(t).toContain('PlanText');
    expect(t).toContain('Always');
    expect(t).not.toContain('DimText');
  });

  it('merges layers and flattens them keeping what is visible', async () => {
    const doc = await PDFDocument.load(await layered());
    const [a, b] = listLayers(doc);
    mergeLayers(doc, [a.id, b.id], a.id);
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Plan']);
    expect(await text(await doc.save())).toContain('DimText');
    const doc2 = await PDFDocument.load(await layered());
    flattenLayers(doc2, [listLayers(doc2)[0].id]);
    const out = await doc2.save();
    expect(listLayers(await PDFDocument.load(out))).toEqual([]);
    const t = await text(out);
    expect(t).not.toContain('PlanText');
    expect(t).toContain('DimText');
  });

  it('saves objects in the layer they are given', async () => {
    const d = await PDFDocument.create();
    d.addPage([400, 400]);
    const src = { id: 's', name: 'x.pdf', bytes: await d.save(), pageCount: 1 };
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 400, height: 400 };
    const box: ShapeObject = { id: 'r', type: 'rect', pageId: 'p', x: 10, y: 10, width: 50, height: 30, rotation: 0, opacity: 1, stroke: '#000000', strokeWidth: 1, fill: null, layer: 'Notes' };
    const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [box], fieldValues: {} });
    const doc = await PDFDocument.load(out);
    expect(listLayers(doc).map((l) => l.name)).toEqual(['Notes']);
    const pdf = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const cfg = await pdf.getOptionalContentConfig();
    const groups = [...(cfg as unknown as Iterable<[string, { name: string }]>)].map(([, g]) => g.name);
    await pdf.loadingTask.destroy();
    expect(groups).toEqual(['Notes']);
  });
});
