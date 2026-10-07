import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { HIDDEN_KINDS, countRevisions, removeHiddenInfo, scanHiddenInfo, type HiddenKind } from '@/lib/pdf/hiddenInfo';
import { sanitizeBytes } from '@/lib/batch';
import { PNG_1PX, contains, everything, pdfjsText } from './helpers/redaction';

const SECRETS: Record<HiddenKind, string[]> = {
  metadata: ['INFOSECRET', 'XMPSECRET', 'IMGXMPSECRET'],
  scripts: ['JSSECRET', 'OPENJSSECRET', 'PAGEJSSECRET', 'FIELDJSSECRET'],
  attachments: ['ATTACHSECRET', 'FASECRET'],
  comments: ['COMMENTSECRET', 'REPLYSECRET'],
  formData: ['FIELDSECRET'],
  hiddenLayers: ['LAYERSECRET'],
  hiddenText: ['INVISIBLESECRET', 'OFFPAGESECRET'],
  bookmarks: ['BOOKMARKSECRET'],
  tags: ['ALTSECRET'],
  thumbnails: ['THUMBSECRET'],
  privateData: ['PIECESECRET'],
  links: ['LINKSECRET'],
  revisions: ['REVSECRET'],
};

/** A one-page PDF carrying every kind of hidden information, saved with an incremental update. */
async function loaded(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const S = (s: string) => PDFString.of(s);
  doc.setAuthor('INFOSECRET');
  doc.setTitle('REVSECRET');
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const page = doc.addPage([300, 300]);
  const img = await doc.embedPng(PNG_1PX);
  await doc.flush();
  (ctx.lookup(img.ref) as unknown as { dict: PDFDict }).dict.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>IMGXMPSECRET</x:xmpmeta>')));
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>XMPSECRET</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));

  // Layer that is switched off.
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: S('Draft notes') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font }, XObject: { Im1: img.ref }, Properties: { L1: ocg } }));
  const content = [
    'BT /F1 12 Tf 20 250 Td (VISIBLE) Tj ET',
    'q 10 0 0 10 200 200 cm /Im1 Do Q',
    '/OC /L1 BDC BT /F1 12 Tf 20 200 Td (LAYERSECRET) Tj ET EMC',
    'BT 3 Tr /F1 12 Tf 20 150 Td (INVISIBLESECRET) Tj ET',
    'BT 0 Tr /F1 12 Tf -500 100 Td (OFFPAGESECRET) Tj ET',
    'BT /F1 12 Tf 20 50 Td /P <</MCID 0>> BDC (tagged) Tj EMC ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  page.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream('THUMBSECRET', { Width: 1, Height: 1 })));
  page.node.set(PDFName.of('PieceInfo'), ctx.obj({ Illustrator: { Private: S('PIECESECRET') } }));
  page.node.set(PDFName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: S("app.alert('PAGEJSSECRET')") } }));
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));

  // Scripts, attachments, bookmarks.
  const js = ctx.obj({ S: 'JavaScript', JS: S("app.alert('JSSECRET')") });
  const fileSpec = (name: string, data: string) => ctx.obj({ Type: 'Filespec', F: S(name), UF: S(name), EF: { F: ctx.register(ctx.stream(data, { Type: 'EmbeddedFile' })) } });
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: { Names: [S('init'), js] }, EmbeddedFiles: { Names: [S('secret.txt'), fileSpec('secret.txt', 'ATTACHSECRET')] } }));
  doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: S('OPENJSSECRET') }));
  const outlines = ctx.register(ctx.obj({ Type: 'Outlines', Count: 1 }));
  const item = ctx.register(ctx.obj({ Title: S('BOOKMARKSECRET'), Parent: outlines, Dest: [page.ref, 'Fit'] }));
  (ctx.lookup(outlines) as PDFDict).set(PDFName.of('First'), item);
  (ctx.lookup(outlines) as PDFDict).set(PDFName.of('Last'), item);
  doc.catalog.set(PDFName.of('Outlines'), outlines);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

  // Tags with alternate text.
  const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Figure', Pg: page.ref, K: 0, Alt: S('ALTSECRET') }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: [elem], ParentTree: { Nums: [0, [elem]] } })));
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));

  // Form field with a value and a format script.
  const field = doc.getForm().createTextField('Name');
  field.setText('FIELDSECRET');
  field.addToPage(page, { x: 150, y: 20, width: 120, height: 20 });
  field.acroField.dict.set(PDFName.of('AA'), ctx.obj({ F: { S: 'JavaScript', JS: S('FIELDJSSECRET') } }));

  // Comments, attachment comment, links.
  const annots = page.node.Annots()!;
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: S('COMMENTSECRET'), P: page.ref }));
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [40, 10, 140, 60], Parent: note }));
  const reply = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: S('REPLYSECRET'), IRT: note }));
  const fa = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [60, 10, 80, 30], FS: fileSpec('fa.txt', 'FASECRET') }));
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 240, 80, 260], A: { S: 'URI', URI: S('https://example.com/LINKSECRET') } }));
  for (const a of [note, popup, reply, fa, link]) annots.push(a);
  const first = await doc.save({ useObjectStreams: false, updateFieldAppearances: true });

  // Incremental update: a new Info dictionary; the old one (REVSECRET) stays in the earlier revision.
  const s = Buffer.from(first).toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  const root = /\/Root (\d+ \d+ R)/.exec(s.slice(s.lastIndexOf('trailer')))![1];
  const size = Number(/\/Size (\d+)/.exec(s.slice(s.lastIndexOf('trailer')))![1]);
  const objAt = first.length + 1;
  let upd = `\n${size} 0 obj\n<< /Author (INFOSECRET) /Title (Current) >>\nendobj\n`;
  const xrefAt = first.length + upd.length;
  upd += `xref\n0 1\n0000000000 65535 f \n${size} 1\n${String(objAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array([...first, ...Buffer.from(upd, 'latin1')]);
}

describe('hidden information', () => {
  it('finds every kind with counts and previews', async () => {
    const bytes = await loaded();
    expect(countRevisions(bytes)).toBe(1);
    const all = await everything(bytes);
    for (const words of Object.values(SECRETS)) for (const w of words) expect(contains(all, w), w).toBe(true);
    const found = Object.fromEntries((await scanHiddenInfo(bytes)).map((f) => [f.kind, f]));
    for (const { kind } of HIDDEN_KINDS) expect(found[kind].count, kind).toBeGreaterThan(0);
    expect(found.attachments.preview).toEqual(expect.arrayContaining(['secret.txt', 'fa.txt']));
    expect(found.scripts.preview.join(' ')).toContain('JSSECRET');
    expect(found.hiddenLayers.preview).toEqual(['Draft notes']);
    expect(found.bookmarks.preview).toEqual(['BOOKMARKSECRET']);
    expect(found.formData.preview).toEqual(['Name: FIELDSECRET']);
    expect(found.hiddenText.count).toBe('INVISIBLESECRET'.length + 'OFFPAGESECRET'.length);
    expect(found.comments.count).toBe(2);
    expect(found.links.preview).toEqual(['https://example.com/LINKSECRET']);
  });

  for (const { kind } of HIDDEN_KINDS) {
    it(`removes ${kind} and nothing else`, async () => {
      const bytes = await loaded();
      const out = await removeHiddenInfo(bytes, [kind]);
      const found = Object.fromEntries((await scanHiddenInfo(out)).map((f) => [f.kind, f]));
      expect(found[kind].count, kind).toBe(0);
      const all = await everything(out);
      for (const w of SECRETS[kind]) expect(contains(all, w), w).toBe(false);
      // The other kinds are still there (earlier revisions go with any fresh save).
      for (const [other, words] of Object.entries(SECRETS)) {
        if (other === kind || other === 'revisions') continue;
        expect(found[other as HiddenKind].count, other).toBeGreaterThan(0);
        for (const w of words) expect(contains(all, w), `${w} after removing ${kind}`).toBe(true);
      }
      expect((await pdfjsText(out))[0]).toContain('VISIBLE');
    });
  }

  it('Sanitize removes metadata of every object, scripts, thumbnails and private data, without compress', async () => {
    const out = await sanitizeBytes(await loaded());
    const all = await everything(out);
    for (const kind of ['metadata', 'scripts', 'thumbnails', 'privateData', 'revisions'] as const) for (const w of SECRETS[kind]) expect(contains(all, w), w).toBe(false);
    for (const w of [...SECRETS.comments, ...SECRETS.bookmarks, ...SECRETS.formData]) expect(contains(all, w), w).toBe(true);
    const doc = await PDFDocument.load(out);
    expect(doc.getAuthor() ?? '').toBe('');
  });
});
