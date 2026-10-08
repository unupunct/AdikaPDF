import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildIncrementalPdf, buildPdf, incrementalBlocker } from '@/lib/pdf/exportPdf';
import type { EditorObject, PageRef, SourceDoc } from '@/types';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const weight = v.bold ? '700Bold' : '400Regular';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', weight, `NotoSans_${weight}.ttf`))));
}
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
export const exportOpts = { loadFont, measure };

export async function makeSource(id: string, labels: string[], setup?: (doc: PDFDocument) => void | Promise<void>): Promise<SourceDoc> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of labels) doc.addPage([300, 400]).drawText(l, { x: 20, y: 360, size: 12, font });
  await setup?.(doc);
  return { id, name: `${id}.pdf`, bytes: await doc.save(), pageCount: labels.length };
}

export function pageRefs(src: SourceDoc, indexes: number[], prefix = src.id): PageRef[] {
  return indexes.map((i, k) => ({ id: `${prefix}_${k}`, kind: 'source', sourceId: src.id, sourceIndex: i, baseRotation: 0, userRotation: 0, width: 300, height: 400 }));
}

describe('base document', () => {
  it('stays the opened file when another file’s page is put first', async () => {
    const main = await makeSource('main', ['M1', 'M2'], (d) => {
      d.setTitle('Main title');
      const outline = d.context.obj({ Type: 'Outlines', Count: 0 });
      d.catalog.set(PDFName.of('Outlines'), d.context.register(outline));
      d.catalog.set(PDFName.of('PageLabels'), d.context.obj({ Nums: [0, { S: 'r' }] }));
    });
    const other = await makeSource('other', ['O1']);
    const pages = [...pageRefs(other, [0]), ...pageRefs(main, [0, 1])];
    const out = await PDFDocument.load(await buildPdf({ sources: { main, other }, pages, objects: [], fieldValues: {}, baseSourceId: 'main' }, exportOpts));
    expect(out.getPageCount()).toBe(3);
    expect(out.getTitle()).toBe('Main title');
    expect(out.catalog.get(PDFName.of('PageLabels'))).toBeDefined();
    expect(out.catalog.get(PDFName.of('Outlines'))).toBeDefined();
    // Without a base given, the first page's source is the base (as before).
    const plain = await PDFDocument.load(await buildPdf({ sources: { main, other }, pages, objects: [], fieldValues: {} }, exportOpts));
    expect(plain.getTitle()).not.toBe('Main title');
  });
});

describe('incremental save', () => {
  it('a signed document gets a comment and a field value appended; its signature stays valid', async () => {
    const plain = await makeSource('signed', ['Contract', 'Page two'], (d) => {
      d.getForm().createTextField('name').addToPage(d.getPage(1), { x: 20, y: 300, width: 150, height: 20 });
    });
    const { createSelfSignedIdentity, signPdf, verifyPdfSignatures } = await import('@/lib/crypto/digitalSignature');
    const identity = await createSelfSignedIdentity({ name: 'Test Signer', email: 't@example.com', organization: 'Adika', country: 'ro' });
    const signed = await signPdf(plain.bytes, { identity, pageIndex: 0, rect: [0, 0, 0, 0] });
    const src: SourceDoc = { ...plain, bytes: signed, original: true };
    const pages = pageRefs(src, [0, 1]);
    const comment = { id: 'n1', type: 'note', pageId: pages[0].id, x: 40, y: 40, rotation: 0, opacity: 1, width: 20, height: 20, text: 'Looks good', color: '#facc15', author: 'Ana', createdAt: '2026-10-01T10:00:00Z', modifiedAt: '2026-10-01T10:00:00Z' } as EditorObject;
    const input = { sources: { signed: src }, pages, objects: [comment], fieldValues: { 'signed::name': 'Ana Pop' }, baseSourceId: 'signed' };
    expect(incrementalBlocker(input)).toBeNull();
    const out = await buildIncrementalPdf(input, exportOpts);
    // The signed bytes are untouched; the update follows them.
    expect(Buffer.from(out.subarray(0, signed.length)).equals(Buffer.from(signed))).toBe(true);
    const [v] = await verifyPdfSignatures(out);
    expect(v.integrity).toBe('valid');
    expect((v as { modifiedAfterSigning?: boolean }).modifiedAfterSigning).toBe(false);
    expect(v.laterChanges).toMatchObject({ annotations: true, form: true, other: false });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: out.slice() }).promise;
    const a1 = (await (await doc.getPage(1)).getAnnotations()) as Array<{ subtype: string; contentsObj?: { str: string } }>;
    expect(a1.some((a) => a.subtype === 'Text' && a.contentsObj?.str === 'Looks good')).toBe(true);
    const a2 = (await (await doc.getPage(2)).getAnnotations()) as Array<{ fieldName?: string; fieldValue?: unknown }>;
    expect(a2.find((a) => a.fieldName === 'name')?.fieldValue).toBe('Ana Pop');
  });

  it('is refused for page content, page changes and rewritten files', async () => {
    const src: SourceDoc = { ...(await makeSource('s', ['A', 'B'])), original: true };
    const pages = pageRefs(src, [0, 1]);
    const base = { sources: { s: src }, pages, objects: [], fieldValues: {}, baseSourceId: 's' };
    expect(incrementalBlocker(base)).toBeNull();
    expect(incrementalBlocker({ ...base, pages: [pages[1], pages[0]] })).not.toBeNull();
    expect(incrementalBlocker({ ...base, pages: [pages[0], { ...pages[1], userRotation: 90 }] })).not.toBeNull();
    const rect = { id: 'r', type: 'rect', pageId: pages[0].id, x: 0, y: 0, rotation: 0, opacity: 1, width: 5, height: 5, stroke: '#000', fill: null, strokeWidth: 1 } as EditorObject;
    expect(incrementalBlocker({ ...base, objects: [rect] })).not.toBeNull();
    expect(incrementalBlocker({ ...base, sources: { s: { ...src, original: false } } })).not.toBeNull();
    expect(incrementalBlocker(base, { title: 'x' })).not.toBeNull();
  });
});

describe('duplicated pages', () => {
  it('keep their form fields: one field, a widget on each copy, the same value', async () => {
    const main = await makeSource('form', ['F1'], (d) => {
      const tf = d.getForm().createTextField('name');
      tf.addToPage(d.getPage(0), { x: 20, y: 300, width: 150, height: 20 });
      const cb = d.getForm().createCheckBox('agree');
      cb.addToPage(d.getPage(0), { x: 20, y: 250, width: 14, height: 14 });
    });
    const pages = pageRefs(main, [0, 0, 0]);
    const bytes = await buildPdf({ sources: { form: main }, pages, objects: [], fieldValues: { 'form::name': 'Ana', 'form::agree': true } }, exportOpts);
    const out = await PDFDocument.load(bytes);
    const form = out.getForm();
    expect(form.getFields().map((f) => f.getName()).sort()).toEqual(['agree', 'name']);
    const name = form.getTextField('name');
    expect(name.getText()).toBe('Ana');
    expect(name.acroField.getWidgets()).toHaveLength(3);
    expect(form.getCheckBox('agree').acroField.getWidgets()).toHaveLength(3);
    // Each page has its own widgets, pointing back at it.
    for (const page of out.getPages()) {
      const annots = page.node.Annots()!;
      expect(annots.size()).toBe(2);
      for (let i = 0; i < annots.size(); i++) expect(String((annots.lookup(i) as PDFDict).get(PDFName.of('P')))).toBe(String(page.ref));
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    for (let n = 1; n <= 3; n++) {
      const annots = (await (await doc.getPage(n)).getAnnotations()) as Array<{ fieldName?: string; fieldValue?: unknown }>;
      expect(annots.find((a) => a.fieldName === 'name')?.fieldValue).toBe('Ana');
    }
  });
});
