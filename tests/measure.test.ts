import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { makeMeasure } from '@/lib/objectFactory';
import { formatNumber, measureValue, polygonArea, polylineLength, realPerPoint, scaleText, type MeasureScale } from '@/lib/measure';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const MM = 72 / 25.4;

describe('measure maths', () => {
  it('converts page points with the drawing scale', () => {
    const s: MeasureScale = { pageValue: 1, pageUnit: 'cm', realValue: 2, realUnit: 'm' };
    // 1 cm on paper = 2 m: 10 mm of page = 2 m.
    expect(realPerPoint(s) * 10 * MM).toBeCloseTo(2, 6);
    expect(scaleText(s)).toBe('1 cm = 2 m');
    expect(realPerPoint({ pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'ft' })).toBeCloseTo(1 / 72, 9);
  });

  it('lengths, perimeter and shoelace area', () => {
    expect(polylineLength([0, 0, 3, 4])).toBe(5);
    expect(polylineLength([0, 0, 3, 4, 3, 10])).toBe(11);
    expect(polylineLength([0, 0, 10, 0, 10, 10], true)).toBeCloseTo(20 + Math.SQRT2 * 10);
    expect(polygonArea([0, 0, 10, 0, 10, 5, 0, 5])).toBe(50);
    expect(polygonArea([0, 0, 0, 5, 10, 5, 10, 0])).toBe(50); // either winding
  });

  it('labels with units and sensible precision', () => {
    const mm: MeasureScale = { pageValue: 1, pageUnit: 'mm', realValue: 1, realUnit: 'mm' };
    expect(measureValue('distance', [0, 0, 100 * MM, 0], mm, 'en').label).toBe('100 mm');
    const m: MeasureScale = { pageValue: 1, pageUnit: 'cm', realValue: 2, realUnit: 'm' };
    // 5 cm × 3 cm on paper = 10 m × 6 m = 60 m².
    expect(measureValue('area', [0, 0, 50 * MM, 0, 50 * MM, 30 * MM, 0, 30 * MM], m, 'en').label).toBe('60 m²');
    expect(formatNumber(3.14159, 'en')).toBe('3.142');
    expect(formatNumber(1234.567, 'ro')).toBe('1.234,6');
  });
});

describe('measurement annotations', () => {
  it('are saved as Acrobat measurements (Line / PolyLine / Polygon + /Measure) with the value shown', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const src = { id: 's', name: 'm.pdf', bytes: await doc.save(), pageCount: 1 };
    const pages = [{ id: 'p0', kind: 'source' as const, sourceId: 's', sourceIndex: 0, baseRotation: 0 as const, userRotation: 0 as const, width: 595, height: 842 }];
    const scale: MeasureScale = { pageValue: 1, pageUnit: 'cm', realValue: 2, realUnit: 'm' };
    const objects = [
      makeMeasure('distance', 'p0', [100, 100, 100 + 50 * MM, 100], scale, 'Ana'),
      makeMeasure('perimeter', 'p0', [100, 300, 200, 300, 200, 400], scale, 'Ana'),
      makeMeasure('area', 'p0', [100, 500, 100 + 50 * MM, 500, 100 + 50 * MM, 500 + 30 * MM, 100, 500 + 30 * MM], scale, 'Ana'),
    ];
    const bytes = await buildPdf({ sources: { s: src }, pages, objects, fieldValues: {} }, { loadFont, measure });
    const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
    tasks.push(task);
    const pdf = await task.promise;
    const annots = (await (await pdf.getPage(1)).getAnnotations()) as Array<Record<string, unknown>>;
    expect(annots.map((a) => a.subtype)).toEqual(['Line', 'PolyLine', 'Polygon']);
    expect(annots.every((a) => a.hasAppearance)).toBe(true);
    const contents = annots.map((a) => (a.contentsObj as { str: string }).str);
    expect(contents[0]).toBe('10 m');
    expect(contents[2]).toBe('60 m²');
    // The dictionaries Acrobat reads: intent and /Measure with the scale.
    const back = await PDFDocument.load(bytes);
    const raw = back.getPages()[0].node.Annots()!.asArray().map((r) => back.context.lookup(r)!.toString());
    expect(raw[0]).toContain('/IT /LineDimension');
    expect(raw[1]).toContain('/IT /PolyLineDimension');
    expect(raw[2]).toContain('/IT /PolygonDimension');
    expect(raw[0]).toMatch(/\/Measure <<[\s\S]*\/Subtype \/RL/);
  });
});
