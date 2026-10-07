import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildPdf } from '@/lib/pdf/exportPdf';
import type { PageRef, SourceDoc } from '@/types';
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
