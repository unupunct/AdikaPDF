import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { fillDatasets, fillXfaData, readXfaPackets, restoreStaticXfa, xfaBindings, xfaDataXml, xfaFieldNames, xfaInputs, xfaKind, xfaKindOf, type XfaHtmlNode, type XfaInput } from '@/lib/pdf/xfa';
import { parseXml, serializeXml, textOf, path } from '@/lib/xml';
import { dynamicXfaPdf, staticXfaPdf, XFA_DATASETS, XFA_TEMPLATE } from './helpers/xfaForms';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { buildXfaPdf } from '@/lib/pdf/xfaPdf';
import { fieldLabel } from '@/lib/pdf/formScripts';
import type { FontVariant } from '@/lib/fonts';
import type { PageRef } from '@/types';

const dataOf = (xml: string) => parseXml(xml);

describe('XML', () => {
  it('round-trips text, attributes, CDATA and entities', () => {
    const src = '<a x="1 &amp; 2"><b>t &lt; u</b><c><![CDATA[<raw>]]></c><d/></a>';
    const el = parseXml(src);
    expect(textOf(path(el, 'b'))).toBe('t < u');
    expect(textOf(path(el, 'c'))).toBe('<raw>');
    expect(serializeXml(el)).toBe('<a x="1 &amp; 2"><b>t &lt; u</b><c>&lt;raw&gt;</c><d/></a>');
  });
});

describe('XFA forms', () => {
  it('tells dynamic from static forms', async () => {
    expect(await xfaKind(await dynamicXfaPdf())).toBe('dynamic');
    expect(await xfaKind(await staticXfaPdf())).toBe('static');
    const plain = await PDFDocument.create();
    plain.addPage();
    expect(await xfaKind(await plain.save())).toBeNull();
  });

  it('maps XFA field names to their data and fills the datasets', () => {
    const b = xfaBindings(XFA_TEMPLATE);
    expect(b.get('form1[0].Main[0].Name[0]')?.data).toEqual([
      { name: 'form1', index: 0 },
      { name: 'Main', index: 0 },
      { name: 'Name', index: 0 },
    ]);
    expect(b.get('form1[0].Main[0].Express[0]')).toMatchObject({ kind: 'checkbox', items: ['1', '0'] });
    const r = fillDatasets(XFA_TEMPLATE, XFA_DATASETS, { 'form1[0].Main[0].Name[0]': 'Ion Ionescu', 'form1[0].Main[0].Express[0]': false, 'form1[0].Main[0].Notes[0]': 'Ring twice' });
    expect(r.unmapped).toEqual([]);
    const main = path(dataOf(r.xml), 'data', 'form1', 'Main');
    expect(textOf(path(main, 'Name'))).toBe('Ion Ionescu');
    expect(textOf(path(main, 'Express'))).toBe('0');
    expect(textOf(path(main, 'Notes'))).toBe('Ring twice');
    expect(textOf(path(main, 'Country'))).toBe('Germany');
  });

  it('keeps a static form’s XFA data in step with its filled fields', async () => {
    const doc = await PDFDocument.load(await staticXfaPdf());
    const packets = readXfaPackets(doc)!;
    doc.getForm().getTextField('form1[0].Main[0].Name[0]').setText('Maria');
    expect(readXfaPackets(doc)).toBeNull(); // pdf-lib dropped it
    expect(restoreStaticXfa(doc, packets, { 'form1[0].Main[0].Name[0]': 'Maria' })).toBe('synced');
    const again = await PDFDocument.load(await doc.save({ updateFieldAppearances: false }));
    const data = xfaDataXml(readXfaPackets(again)!)!;
    expect(data).toContain('<Name>Maria</Name>');
    expect(data).toContain('<Country>Germany</Country>');
    // A field the XFA form does not know: XFA is dropped rather than left stale.
    expect(restoreStaticXfa(again, packets, { 'Stray[0]': 'x' })).toBe('removed');
    expect(readXfaPackets(again)).toBeNull();
  });

  it('names the fields of pdf.js’ layout like XFA and writes values back into the original', async () => {
    const original = await dynamicXfaPdf();
    const doc = await pdfjs.getDocument({ data: original.slice(), enableXfa: true, verbosity: 0 }).promise;
    const html = doc.allXfaHtml as unknown as XfaHtmlNode;
    const names = xfaFieldNames(html.children ?? []);
    expect([...names.values()]).toEqual(['form1[0].Main[0].Name[0]', 'form1[0].Main[0].Qty[0]', 'form1[0].Main[0].Express[0]', 'form1[0].Main[0].Country[0]', 'form1[0].Main[0].Notes[0]']);
    const inputs = xfaInputs(html.children ?? []);
    expect(inputs.map((i) => [i.name, i.type, i.value])).toEqual([
      ['form1[0].Main[0].Name[0]', 'text', 'Ana Pop'],
      ['form1[0].Main[0].Qty[0]', 'text', '2'],
      ['form1[0].Main[0].Express[0]', 'checkbox', '1'],
      ['form1[0].Main[0].Country[0]', 'select', 'Germany'],
      ['form1[0].Main[0].Notes[0]', 'textarea', ''],
    ]);
    expect(inputs[3].options).toEqual([
      { value: 'Romania', label: 'Romania' },
      { value: 'Germany', label: 'Germany' },
    ]);
    await doc.loadingTask.destroy();
    const filled = await fillXfaData(pdfjs as never, original, { 'form1[0].Main[0].Name[0]': 'Elena Dumitru', 'form1[0].Main[0].Country[0]': 'Romania', 'form1[0].Main[0].Express[0]': false });
    const back = readXfaPackets(await PDFDocument.load(filled))!;
    const data = xfaDataXml(back)!;
    expect(data).toContain('Elena Dumitru');
    expect(data).toContain('<Country>Romania</Country>');
    expect(data).toContain('<Express>0</Express>');
    expect(await xfaKind(filled)).toBe('dynamic');
  });
});

describe('XFA forms saved by Adika', () => {
  const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
  const loadFont = (v: FontVariant) => {
    const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
    const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
    const weight = v.bold ? '700Bold' : '400Regular';
    const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
    return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
  };

  it('a filled static form keeps its XFA, with the values in the XFA data', async () => {
    const bytes = await staticXfaPdf();
    const src = { id: 's', name: 'x.pdf', bytes, pageCount: 1 };
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 612, height: 792 };
    const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [], fieldValues: { 's::form1[0].Main[0].Name[0]': 'Ioana Marin', 's::form1[0].Main[0].Express[0]': false } }, { loadFont, measure: () => (s: string) => s.length * 5 });
    const doc = await PDFDocument.load(out);
    expect(xfaKindOf(doc)).toBe('static');
    const data = xfaDataXml(readXfaPackets(doc)!)!;
    expect(data).toContain('<Name>Ioana Marin</Name>');
    expect(data).toContain('<Express>0</Express>');
    expect(doc.getForm().getTextField('form1[0].Main[0].Name[0]').getText()).toBe('Ioana Marin');
  });

  it('builds a fillable PDF from a measured XFA layout', async () => {
    const input = (name: string, type: XfaInput['type'], value: string, extra: Partial<XfaInput> = {}): XfaInput => ({ name, fieldId: name, dataId: name, type, value, ...extra });
    const { bytes, fields } = await buildXfaPdf(
      [
        {
          width: 612,
          height: 792,
          items: [
            { type: 'rect', x: 36, y: 36, w: 540, h: 30, fill: 'rgb(230, 230, 250)' },
            { type: 'text', x: 40, baseline: 56, text: 'Order form – ș ț', size: 16, bold: true, italic: false, family: 'sans', color: 'rgb(0, 0, 0)' },
            { type: 'line', x1: 36, y1: 100, x2: 576, y2: 100, width: 0.5, color: 'rgb(0, 0, 0)' },
            { type: 'field', x: 150, y: 80, w: 200, h: 18, input: input('form1[0].Main[0].Name[0]', 'text', 'Ana Pop'), size: 10, tooltip: 'Customer name', required: true },
            { type: 'field', x: 150, y: 110, w: 10, h: 10, input: input('form1[0].Main[0].Express[0]', 'checkbox', '1', { on: '1', off: '0' }), size: 10 },
            { type: 'field', x: 150, y: 130, w: 200, h: 18, input: input('form1[0].Main[0].Country[0]', 'select', 'Germany', { options: [{ value: 'Romania', label: 'Romania' }, { value: 'Germany', label: 'Germany' }] }), size: 10 },
            { type: 'field', x: 150, y: 160, w: 10, h: 10, input: input('form1[0].Main[0].Pay[0]', 'radio', 'card', { on: 'card', off: '' }), size: 10 },
            { type: 'field', x: 200, y: 160, w: 10, h: 10, input: input('form1[0].Main[0].Pay[0]', 'radio', '', { on: 'cash', off: '' }), size: 10 },
          ],
        },
      ],
      loadFont,
      'Order',
    );
    expect(fields).toEqual(['form1[0].Main[0].Name[0]', 'form1[0].Main[0].Express[0]', 'form1[0].Main[0].Country[0]', 'form1[0].Main[0].Pay[0]']);
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    expect(form.getTextField('form1[0].Main[0].Name[0]').getText()).toBe('Ana Pop');
    expect(form.getTextField('form1[0].Main[0].Name[0]').isRequired()).toBe(true);
    expect(form.getCheckBox('form1[0].Main[0].Express[0]').isChecked()).toBe(true);
    expect(form.getDropdown('form1[0].Main[0].Country[0]').getSelected()).toEqual(['Germany']);
    expect(form.getRadioGroup('form1[0].Main[0].Pay[0]').getSelected()).toBe('card');
    const tu = (n: string) => doc.getForm().getField(n).acroField.dict.lookup(PDFName.of('TU'));
    expect(fieldLabel('form1[0].Main[0].Name[0]', tu('form1[0].Main[0].Name[0]'))).toBe('Customer name');
    expect(fieldLabel('form1[0].Main[0].Express[0]', tu('form1[0].Main[0].Express[0]'))).toBe('Express');
    expect(fieldLabel('Plain', undefined)).toBeUndefined();
    const text = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise.then((d) => d.getPage(1)).then((p) => p.getTextContent());
    expect(text.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain('Order form – ș ț');
  });
});

describe('single-stream XFA', () => {
  async function singleStream(withDatasets: boolean) {
    const doc = await PDFDocument.create();
    doc.addPage();
    const xdp = `<?xml version="1.0" encoding="UTF-8"?>\n<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/" timeStamp="2024-01-01T00:00:00Z">${XFA_TEMPLATE}${withDatasets ? XFA_DATASETS : ''}<config xmlns="http://www.xfa.org/schema/xci/3.1/"/></xdp:xdp>`;
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: doc.context.register(doc.context.stream(xdp)) }));
    return doc;
  }

  for (const withDatasets of [true, false]) {
    it(`round-trips with${withDatasets ? '' : 'out'} a datasets packet`, async () => {
      const doc = await singleStream(withDatasets);
      const packets = readXfaPackets(doc)!;
      expect(packets[0][0]).toBe('preamble');
      expect(packets[0][1]).toContain('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/" timeStamp=');
      expect(packets.at(-1)).toEqual(['postamble', '</xdp:xdp>']);
      expect(restoreStaticXfa(doc, packets, { 'form1[0].Main[0].Name[0]': 'Maria' })).toBe('synced');
      const again = readXfaPackets(await PDFDocument.load(await doc.save()))!;
      expect(again.map(([n]) => n)).toEqual(['preamble', 'template', 'datasets', 'config', 'postamble']);
      const whole = parseXml(again.map(([, x]) => x).join('').replace(/^<\?xml[^>]*\?>\s*/, ''));
      expect(whole.name).toBe('xdp:xdp');
      expect(textOf(path(whole, 'datasets', 'data', 'form1', 'Main', 'Name'))).toBe('Maria');
    });
  }
});
