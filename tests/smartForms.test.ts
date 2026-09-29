import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { readFieldLogic } from '@/lib/pdf/formScripts';
import { makeField } from '@/lib/objectFactory';
import type { FontVariant } from '@/lib/fonts';
import type { FieldObject, PageRef } from '@/types';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;

describe('smart form fields in the saved PDF', () => {
  it('formats, ranges and formulas become Acrobat actions with a calculation order', async () => {
    const d = await PDFDocument.create();
    d.addPage([595, 842]);
    const src = { id: 's', name: 'order.pdf', bytes: await d.save(), pageCount: 1 };
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 };
    const f = (name: string, y: number, patch: Partial<FieldObject>): FieldObject => ({ ...makeField('text', 'p', { x: 100, y, width: 160, height: 22 }, []), name, ...patch });
    const money = { kind: 'number' as const, decimals: 2, sep: 2 as const, currency: ' lei', currencyBefore: false };
    const objects = [
      f('Qty', 100, { value: '3', logic: { format: { kind: 'number', decimals: 0, sep: 2, currency: '', currencyBefore: false }, range: { min: 1, max: 99 } } }),
      f('Price', 140, { value: '1234.5', logic: { format: money } }),
      f('Total', 180, { logic: { format: money, calc: { op: 'formula', formula: 'Qty * Price' } } }),
      f('Date', 220, { logic: { format: { kind: 'date', pattern: 'dd.mm.yyyy' } } }),
    ];
    const bytes = await buildPdf({ sources: { s: src }, pages: [ref], objects, fieldValues: {} }, { loadFont, measure });
    const doc = await PDFDocument.load(bytes);
    const logic = readFieldLogic(doc);
    expect(logic.Qty).toEqual({ format: { kind: 'number', decimals: 0, sep: 2, currency: '', currencyBefore: false }, range: { min: 1, max: 99 } });
    expect(logic.Total).toEqual({ format: money, calc: { op: 'formula', formula: 'Qty * Price' } });
    expect(logic.Date.format).toEqual({ kind: 'date', pattern: 'dd.mm.yyyy' });
    // Calculation order lists Total.
    const acro = doc.catalog.lookup(PDFName.of('AcroForm')) as PDFDict;
    const co = acro.lookup(PDFName.of('CO'));
    expect(co?.toString()).toContain(doc.getForm().getField('Total').acroField.ref.toString());
    // Price: plain value stored, formatted text on the page.
    const price = doc.getForm().getTextField('Price');
    expect(price.getText()).toBe('1234.5');
    // Total calculated when saving: 3 x 1234.5.
    expect(doc.getForm().getTextField('Total').getText()).toBe('3703.5');
    const ap = (price.acroField.getWidgets()[0].dict.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const content = Buffer.from(decodePDFRawStream(ap).decode()).toString('latin1');
    // The appearance draws "1.234,50 lei" (hex-encoded glyphs), not "1234.5".
    expect(content).not.toContain('1234.5');
    expect(content).toMatch(/Tj|TJ/);
  });
});
