import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { readXfaPackets, xfaDataXml } from '@/lib/pdf/xfa';
import { staticXfaPdf } from './helpers/xfaForms';
import { PNG_1PX, contains, everything, loadFont, measure, pageRefs, pdfjsText, rasterize, sourceOf } from './helpers/redaction';

const SECRETS = ['ALPHASECRET', 'BETASECRET', 'GAMMASECRET', 'PIECESECRET', 'THUMBSECRET', 'FIELDSECRET', 'LINKSECRET'];

/**
 * Three tagged pages: page 1 "ALPHASECRET" in a span with /ActualText (vector redaction),
 * page 2 "BETASECRET" over a picture (raster redaction), page 3 "GAMMASECRET" (deleted).
 * Bookmarks, named destinations, links, the open action, a form widget and the
 * structure tree all point at the pages.
 */
async function taggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const img = await doc.embedPng(PNG_1PX);
  const contents = [
    'BT /F1 12 Tf 20 250 Td /Span <</MCID 0 /ActualText (ALPHASECRET)>> BDC (ALPHASECRET) Tj EMC ET BT /F1 12 Tf 20 100 Td /P <</MCID 1>> BDC (keep me) Tj EMC ET',
    'q 100 0 0 30 15 240 cm /Im1 Do Q BT /F1 12 Tf 20 250 Td /Figure <</MCID 0>> BDC (BETASECRET) Tj EMC ET',
    'BT /F1 12 Tf 20 250 Td /P <</MCID 0>> BDC (GAMMASECRET) Tj EMC ET',
  ];
  const pages = contents.map((c, i) => {
    const p = doc.addPage([300, 300]);
    p.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(c)));
    p.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font }, XObject: { Im1: img.ref } }));
    p.node.set(PDFName.of('StructParents'), ctx.obj(i));
    return p;
  });
  const [p1, p2, p3] = pages;
  p1.node.set(PDFName.of('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('PIECESECRET') } }));
  p1.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream('THUMBSECRET', { Width: 1, Height: 1 })));

  // Structure tree.
  const se = (type: string, pg: PDFRef, k: number, extra: Record<string, unknown> = {}) => ctx.register(ctx.obj({ Type: 'StructElem', S: type, Pg: pg, K: k, ...extra }));
  const span = se('Span', p1.ref, 0, { ActualText: PDFString.of('ALPHASECRET') });
  const para = se('P', p1.ref, 1);
  const fig = se('Figure', p2.ref, 0, { Alt: PDFString.of('BETASECRET picture') });
  const gone = se('P', p3.ref, 0, { ActualText: PDFString.of('GAMMASECRET') });
  const docElem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Document', K: [span, para, fig, gone] }));
  const parentTree = ctx.obj({ Nums: [0, [span, para], 1, [fig], 2, [gone]] });
  const root = ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: docElem, ParentTree: parentTree, ParentTreeNextKey: 3 }));
  for (const r of [span, para, fig, gone]) (ctx.lookup(r) as PDFDict).set(PDFName.of('P'), docElem);
  (ctx.lookup(docElem) as PDFDict).set(PDFName.of('P'), root);
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));

  // Bookmarks to pages 2 and 3, named destinations, open action.
  const outlines = ctx.register(ctx.obj({ Type: 'Outlines', Count: 2 }));
  const o1 = ctx.register(ctx.obj({ Title: PDFString.of('Two'), Parent: outlines, Dest: [p2.ref, 'Fit'] }));
  const o2 = ctx.register(ctx.obj({ Title: PDFString.of('Three'), Parent: outlines, A: { S: 'GoTo', D: [p3.ref, 'Fit'] }, Prev: o1 }));
  (ctx.lookup(o1) as PDFDict).set(PDFName.of('Next'), o2);
  const od = ctx.lookup(outlines) as PDFDict;
  od.set(PDFName.of('First'), o1);
  od.set(PDFName.of('Last'), o2);
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: { Names: [PDFString.of('three'), [p3.ref, 'Fit'], PDFString.of('two'), [p2.ref, 'Fit']] } }));
  doc.catalog.set(PDFName.of('OpenAction'), ctx.obj([p3.ref, 'Fit']));

  // A link on page 1 to page 3, a comment on page 3 and a form field on page 3.
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 80, 40], Dest: [p3.ref, 'Fit'], Contents: PDFString.of('to three'), P: p1.ref }));
  p1.node.set(PDFName.of('Annots'), ctx.obj([link]));
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [200, 200, 220, 220], Contents: PDFString.of('LINKSECRET'), P: p3.ref }));
  const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('Name'), V: PDFString.of('FIELDSECRET'), Rect: [20, 20, 120, 40], P: p3.ref }));
  p3.node.set(PDFName.of('Annots'), ctx.obj([note, widget]));
  // The comment is also reachable from the tags (an OBJR), like in tagged files.
  (ctx.lookup(gone) as PDFDict).set(PDFName.of('K'), ctx.obj([0, { Type: 'OBJR', Obj: note, Pg: p3.ref }]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widget], CO: [widget] }));
  return doc.save({ useObjectStreams: false });
}

describe('nothing keeps a redacted, rasterised or deleted page alive', () => {
  it('tags, bookmarks, named destinations, links, open action and widgets are retargeted or dropped', async () => {
    const bytes = await taggedPdf();
    const before = await everything(bytes);
    for (const w of SECRETS) expect(contains(before, w), w).toBe(true);

    const src = sourceOf(bytes);
    const [r1, r2] = pageRefs(src, 3);
    const out = await buildPdf(
      {
        sources: { [src.id]: src },
        pages: [r1, r2], // page 3 deleted
        objects: [
          { id: 'a', type: 'redact', pageId: r1.id, x: 15, y: 35, width: 110, height: 25, rotation: 0, opacity: 1, fill: '#000000' },
          { id: 'b', type: 'redact', pageId: r2.id, x: 15, y: 35, width: 110, height: 25, rotation: 0, opacity: 1, fill: '#000000' },
        ],
        fieldValues: {},
      },
      { loadFont, measure, rasterizeRedactedPage: rasterize },
    );
    const texts = await pdfjsText(out);
    expect(texts[0]).toContain('keep me');
    const all = await everything(out);
    for (const w of SECRETS) expect(contains(all, w), w).toBe(false);

    const doc = await PDFDocument.load(out);
    const live = new Set(doc.getPages().map((p) => p.ref.toString()));
    // The bookmark to page 2 now points at its raster replacement.
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    const first = outlines.lookup(PDFName.of('First'), PDFDict);
    const dest = first.lookup(PDFName.of('Dest'), PDFArray);
    expect(live.has(String(dest.get(0)))).toBe(true);
    expect(doc.catalog.get(PDFName.of('OpenAction'))).toBeUndefined();
    // The tagged span kept its MCID but lost the redacted text; page 1's thumbnail and private data are gone.
    expect(doc.getPage(0).node.get(PDFName.of('Thumb'))).toBeUndefined();
    expect(doc.getPage(0).node.get(PDFName.of('PieceInfo'))).toBeUndefined();
  });

  it('a static XFA field under a box is emptied in the XFA data too', async () => {
    const src = { ...sourceOf(await staticXfaPdf()), pageCount: 1 };
    const [ref] = pageRefs(src, 1, 612, 792);
    const out = await buildPdf(
      { sources: { [src.id]: src }, pages: [ref], objects: [{ id: 'r', type: 'redact', pageId: ref.id, x: 140, y: 60, width: 280, height: 40, rotation: 0, opacity: 1, fill: '#000000' }], fieldValues: {} },
      { loadFont, measure, rasterizeRedactedPage: rasterize },
    );
    const doc = await PDFDocument.load(out);
    const packets = readXfaPackets(doc);
    expect(packets).not.toBeNull();
    {
      const data = xfaDataXml(packets)!;
      expect(data).not.toContain('Ana Pop');
      expect(data).toContain('<Country>Germany</Country>');
    }
    expect(contains(await everything(out), 'Ana Pop')).toBe(false);
  });
});
