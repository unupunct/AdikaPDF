import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { decodeDxf, dxfToPdf, mtextToPlain, pruneTrueType, type DxfToPdfOptions } from '../src/lib/pdf/dxf';

const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/';
const fontBytes = new Uint8Array(readFileSync(resolve('node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf')));
const loadFont = async () => fontBytes;

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, standardFontDataUrl, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

type Pair = [number, string | number];
const lines = (pairs: Pair[]) => pairs.map(([c, v]) => `${String(c).padStart(3, ' ')}\n${v}`).join('\n');
const section = (name: string, body: Pair[]): Pair[] => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
const dxfDoc = (...sections: Pair[][]) => lines([...sections.flat(), [0, 'EOF']]) + '\n';
const layer = (name: string, color: number, flags = 0): Pair[] => [[0, 'LAYER'], [2, name], [70, flags], [62, color], [6, 'CONTINUOUS']];

const opts = (o: Partial<DxfToPdfOptions> = {}): DxfToPdfOptions => ({
  paper: 'A4',
  orientation: 'landscape',
  marginMm: 10,
  blackOnWhite: true,
  lineWeightMm: 0.25,
  layers: true,
  loadFont,
  ...o,
});

// ---------------------------------------------------------------------------
// R2000-style drawing: every supported entity type
// ---------------------------------------------------------------------------
const R2000 = dxfDoc(
  section('HEADER', [[9, '$ACADVER'], [1, 'AC1015'], [9, '$INSUNITS'], [70, 4], [9, '$EXTMIN'], [10, -9999], [20, -9999], [30, 0], [9, '$EXTMAX'], [10, 9999], [20, 9999], [30, 0]]),
  section('TABLES', [
    [0, 'TABLE'], [2, 'LTYPE'], [70, 2],
    [0, 'LTYPE'], [2, 'CONTINUOUS'], [70, 0], [3, 'Solid line'], [72, 65], [73, 0], [40, 0],
    [0, 'LTYPE'], [2, 'DASHED'], [70, 0], [3, '__ __'], [72, 65], [73, 2], [40, 7.5], [49, 5], [49, -2.5],
    [0, 'ENDTAB'],
    [0, 'TABLE'], [2, 'LAYER'], [70, 4],
    ...layer('0', 7),
    ...layer('Walls', 1),
    ...layer('Text', 5),
    ...layer('Hidden', -3),
    ...layer('Frozen', 2, 1),
    [0, 'ENDTAB'],
  ]),
  section('BLOCKS', [
    [0, 'BLOCK'], [8, '0'], [2, 'CHAIR'], [70, 0], [10, 0], [20, 0], [30, 0], [3, 'CHAIR'],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 4], [21, 0], [31, 0],
    [0, 'CIRCLE'], [8, '0'], [62, 0], [10, 2], [20, 2], [30, 0], [40, 1],
    [0, 'INSERT'], [8, '0'], [2, 'LEG'], [10, 0], [20, 0], [30, 0],
    [0, 'ENDBLK'], [8, '0'],
    [0, 'BLOCK'], [8, '0'], [2, 'LEG'], [70, 0], [10, 0], [20, 0], [30, 0],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 0], [21, -1], [31, 0],
    [0, 'ENDBLK'], [8, '0'],
    [0, 'BLOCK'], [8, '0'], [2, '*D1'], [70, 1], [10, 0], [20, 0], [30, 0],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 60], [30, 0], [11, 100], [21, 60], [31, 0],
    [0, 'MTEXT'], [8, '0'], [10, 50], [20, 62], [30, 0], [40, 2.5], [71, 8], [1, '100'],
    [0, 'ENDBLK'], [8, '0'],
  ]),
  section('ENTITIES', [
    [0, 'LINE'], [5, '1A'], [100, 'AcDbEntity'], [8, 'Walls'], [100, 'AcDbLine'], [10, 0], [20, 0], [30, 0], [11, 100], [21, 0], [31, 0],
    [0, 'LWPOLYLINE'], [100, 'AcDbEntity'], [8, 'Walls'], [100, 'AcDbPolyline'], [90, 4], [70, 1], [43, 0.5],
    [10, 0], [20, 10], [10, 20], [20, 10], [42, 1], [10, 20], [20, 30], [10, 0], [20, 30],
    [0, 'CIRCLE'], [8, 'Walls'], [10, 50], [20, 20], [30, 0], [40, 5],
    [0, 'ARC'], [8, 'Walls'], [62, 3], [10, 70], [20, 20], [30, 0], [40, 5], [50, 0], [51, 180],
    [0, 'ELLIPSE'], [8, 'Walls'], [10, 90], [20, 20], [30, 0], [11, 8], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, Math.PI],
    [0, 'SPLINE'], [8, 'Walls'], [70, 8], [71, 3], [72, 8], [73, 4], [74, 0],
    [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1],
    [10, 0], [20, 40], [30, 0], [10, 10], [20, 50], [30, 0], [10, 20], [20, 40], [30, 0], [10, 30], [20, 50], [30, 0],
    [0, 'SPLINE'], [8, 'Walls'], [70, 8], [71, 3], [74, 3], [11, 40], [21, 40], [31, 0], [11, 45], [21, 48], [31, 0], [11, 50], [21, 40], [31, 0],
    [0, 'POINT'], [8, 'Walls'], [10, 60], [20, 45], [30, 0],
    [0, 'TEXT'], [8, 'Text'], [10, 10], [20, 70], [30, 0], [40, 5], [1, 'Plan etaj — ăîșț'], [50, 0], [72, 1], [11, 50], [21, 70], [31, 0],
    [0, 'TEXT'], [8, 'Text'], [10, 95], [20, 40], [30, 0], [40, 2], [1, 'Rotated %%d'], [50, 90],
    [0, 'MTEXT'], [8, 'Text'], [10, 60], [20, 90], [30, 0], [40, 3], [71, 5], [3, '{\\fArial|b1|i0;Line one}\\P'], [1, 'Second \\H2.5;line'],
    [0, 'SOLID'], [8, 'Walls'], [10, 0], [20, -20], [30, 0], [11, 10], [21, -20], [31, 0], [12, 0], [22, -10], [32, 0], [13, 10], [23, -10], [33, 0],
    [0, '3DFACE'], [8, 'Walls'], [10, 20], [20, -20], [30, 0], [11, 30], [21, -20], [31, 0], [12, 30], [22, -10], [32, 0], [13, 20], [23, -10], [33, 0],
    [0, 'HATCH'], [100, 'AcDbEntity'], [8, 'Walls'], [62, 4], [100, 'AcDbHatch'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
    [2, 'SOLID'], [70, 1], [71, 0], [91, 1],
    [92, 3], [72, 0], [73, 1], [93, 4], [10, 40], [20, -20], [10, 50], [20, -20], [10, 50], [20, -10], [10, 40], [20, -10], [97, 0],
    [75, 0], [76, 1], [98, 1], [10, 45], [20, -15],
    [0, 'HATCH'], [8, 'Walls'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'ANSI31'], [70, 0], [71, 0], [91, 1],
    [92, 1], [93, 2], [72, 1], [10, 60], [20, -20], [11, 80], [21, -20], [72, 2], [10, 70], [20, -20], [40, 10], [50, 0], [51, 180], [73, 1], [97, 0],
    [75, 0], [76, 1], [52, 0], [41, 1], [77, 0], [78, 1], [53, 45], [43, 0], [44, 0], [45, -2], [46, 2], [79, 0], [98, 0],
    [0, 'INSERT'], [8, 'Furniture'], [62, 3], [2, 'CHAIR'], [10, 120], [20, 0], [30, 0], [41, 1], [42, 1], [50, 30], [70, 3], [71, 2], [44, 6], [45, 6],
    [0, 'DIMENSION'], [8, 'Dims'], [2, '*D1'], [10, 100], [20, 60], [30, 0], [70, 32], [1, ''],
    [0, 'LINE'], [8, 'Walls'], [6, 'DASHED'], [10, 0], [20, 100], [30, 0], [11, 100], [21, 100], [31, 0],
    [0, 'LINE'], [8, 'Hidden'], [10, 0], [20, 0], [30, 0], [11, 500], [21, 500], [31, 0],
    [0, 'TEXT'], [8, 'Hidden'], [10, 0], [20, 0], [30, 0], [40, 5], [1, 'SECRET'],
    [0, 'TEXT'], [8, 'Frozen'], [10, 0], [20, 0], [30, 0], [40, 5], [1, 'ICECOLD'],
    [0, 'LINE'], [8, 'Walls'], [67, 1], [10, -1000], [20, -1000], [30, 0], [11, 1000], [21, 1000], [31, 0],
    [0, 'RAY'], [8, 'Walls'], [10, 0], [20, 0], [30, 0], [11, 1], [21, 0], [31, 0],
    [0, 'IMAGE'], [8, 'Walls'], [10, 0], [20, 0], [30, 0],
  ]),
);

// ---------------------------------------------------------------------------
// R12-style drawing: POLYLINE/VERTEX, no subclass markers
// ---------------------------------------------------------------------------
const R12 = dxfDoc(
  section('HEADER', [[9, '$ACADVER'], [1, 'AC1009']]),
  section('TABLES', [[0, 'TABLE'], [2, 'LAYER'], [70, 1], ...layer('0', 7), [0, 'ENDTAB']]),
  section('ENTITIES', [
    [0, 'POLYLINE'], [8, '0'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 1],
    [0, 'VERTEX'], [8, '0'], [10, 0], [20, 0], [30, 0],
    [0, 'VERTEX'], [8, '0'], [10, 40], [20, 0], [30, 0], [42, 0.5],
    [0, 'VERTEX'], [8, '0'], [10, 40], [20, 10], [30, 0],
    [0, 'SEQEND'], [8, '0'],
    [0, 'TEXT'], [8, '0'], [10, 2], [20, 2], [30, 0], [40, 3], [1, 'R12 text'],
    [0, 'LINE'], [8, '0'], [10, 0], [20, -5], [30, 0], [11, 40], [21, -5], [31, 0],
  ]),
);

async function pageStrings(bytes: Uint8Array): Promise<string> {
  const pdf = await openPdf(bytes);
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str : '')).join('|');
}

describe('mtextToPlain', () => {
  it('strips formatting codes', () => {
    expect(mtextToPlain('{\\fArial|b1|i0;Bold}\\Pnext \\H2.5x;line\\~end')).toEqual(['Bold', 'next line end']);
    expect(mtextToPlain('\\S1^2; \\U+0103 \\\\ \\{x\\} %%d %%p %%c')).toEqual(['1/2 ă \\ {x} ° ± Ø']);
    expect(mtextToPlain('\\A1;\\C1;red\\Lunder\\l')).toEqual(['redunder']);
  });
});

describe('dxfToPdf (R2000)', () => {
  it('renders every entity type with text, layers and paper', async () => {
    const res = await dxfToPdf(R2000, opts());
    expect(res.skipped).toEqual({ RAY: 1, IMAGE: 1 });
    // 1 line, 1 lwpoly, circle, arc, ellipse, 2 splines, point, 2 text, 2 mtext lines (1 entity),
    // solid, 3dface, 2 hatches, 6 chairs × (line + circle + leg line), dimension line + mtext, dashed line
    expect(res.entities).toBe(1 + 1 + 1 + 1 + 1 + 2 + 1 + 2 + 1 + 1 + 1 + 2 + 6 * 3 + 2 + 1);
    expect(res.layers).toEqual(expect.arrayContaining(['Walls', 'Text', 'Furniture', 'Dims']));
    expect(res.layers).not.toContain('Hidden');
    expect(res.layers).not.toContain('Frozen');
    const w = res.warnings.join('\n');
    expect(w).toMatch(/millimetres/);
    expect(w).toMatch(/3 entities are on hidden/);
    expect(w).toMatch(/1 paper-space entity/);
    expect(w).toMatch(/1 pattern hatch/);

    const pdf = await openPdf(res.bytes);
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo(841.89, 1);
    expect(vp.height).toBeCloseTo(595.28, 1);

    const text = await pageStrings(res.bytes);
    expect(text).toContain('Plan etaj — ăîșț');
    expect(text).toContain('Line one');
    expect(text).toContain('Second line');
    expect(text).toContain('Rotated °');
    expect(text).toContain('100');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('ICECOLD');

    const occ = await pdf.getOptionalContentConfig();
    const names: string[] = [];
    for (const [, group] of occ) names.push((group as { name: string }).name);
    expect(names.sort()).toEqual([...res.layers].sort());
    expect(names).not.toContain('Hidden');

    const ops = await page.getOperatorList();
    const paints = new Set<number>();
    ops.fnArray.forEach((fn, i) => {
      if (fn === pdfjs.OPS.constructPath) paints.add((ops.argsArray[i] as number[])[0]);
    });
    expect(paints.has(pdfjs.OPS.stroke)).toBe(true);
    expect(paints.has(pdfjs.OPS.fill) || paints.has(pdfjs.OPS.eoFill)).toBe(true);
    expect(ops.fnArray).toContain(pdfjs.OPS.beginMarkedContentProps);
    expect(ops.fnArray).toContain(pdfjs.OPS.setDash);

    // Structural: /Properties in resources and an OCProperties /D config.
    const doc = await PDFDocument.load(res.bytes);
    const ocp = doc.catalog.lookup(PDFName.of('OCProperties'));
    expect(ocp).toBeDefined();
  });

  it('honours paper, orientation and the layers switch', async () => {
    const res = await dxfToPdf(R2000, opts({ paper: 'A3', orientation: 'portrait', layers: false, blackOnWhite: false }));
    const pdf = await openPdf(res.bytes);
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo((297 * 72) / 25.4, 1);
    expect(vp.height).toBeCloseTo((420 * 72) / 25.4, 1);
    const occ = await pdf.getOptionalContentConfig();
    expect([...occ].length).toBe(0);
    expect(await pageStrings(res.bytes)).toContain('Plan etaj');
  });

  it('auto paper follows the drawing aspect ratio', async () => {
    const res = await dxfToPdf(R12, opts({ paper: 'auto', orientation: 'auto', marginMm: 0 }));
    const pdf = await openPdf(res.bytes);
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo((420 * 72) / 25.4, 1);
    expect(vp.width / vp.height).toBeGreaterThan(1.5);
  });
});

describe('dxfToPdf (R12)', () => {
  it('draws POLYLINE with bulges, TEXT and LINE', async () => {
    const res = await dxfToPdf(R12, opts());
    expect(res.entities).toBe(3);
    expect(res.skipped).toEqual({});
    expect(res.layers).toEqual(['0']);
    expect(await pageStrings(res.bytes)).toContain('R12 text');
    expect(res.warnings.join('\n')).toMatch(/not set/);
  });

  it('works without a font loader (Helvetica fallback)', async () => {
    const res = await dxfToPdf(R12, opts({ loadFont: undefined }));
    expect(res.warnings.join('\n')).toMatch(/Helvetica/);
    expect(await pageStrings(res.bytes)).toContain('R12 text');
  });
});

describe('dxfToPdf errors', () => {
  it('rejects binary DXF', async () => {
    await expect(dxfToPdf('AutoCAD Binary DXF\r\n\u001a\u0000rest', opts())).rejects.toThrow(/Binary DXF/);
    const bin = new TextEncoder().encode('AutoCAD Binary DXF\r\n\u001a\u0000');
    expect(() => decodeDxf(bin)).toThrow(/Binary DXF/);
  });

  it('rejects non-DXF input', async () => {
    await expect(dxfToPdf('hello world\nthis is not a drawing', opts())).rejects.toThrow(/not a readable DXF/);
    await expect(dxfToPdf('  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\n', opts())).rejects.toThrow(/could not be read/);
  });

  it('never throws for one broken entity', async () => {
    const broken = dxfDoc(
      section('ENTITIES', [
        [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [30, 0],
        [0, 'CIRCLE'], [8, '0'], [10, 5], [20, 5], [30, 0], [40, 2],
        [0, 'INSERT'], [8, '0'], [2, 'NOPE'], [10, 0], [20, 0], [30, 0],
      ]),
    );
    const res = await dxfToPdf(broken, opts());
    expect(res.entities).toBe(1);
    expect(res.skipped).toEqual({ LINE: 1, 'INSERT (missing block)': 1 });
  });
});

describe('decodeDxf', () => {
  it('decodes UTF-8 and ANSI code pages', () => {
    const utf = new TextEncoder().encode('  9\n$ACADVER\n  1\nAC1027\n ăîșț');
    expect(decodeDxf(utf)).toContain('ăîșț');
    const head = '  9\n$ACADVER\n  1\nAC1015\n  9\n$DWGCODEPAGE\n  3\nANSI_1250\n';
    const bytes = new Uint8Array([...new TextEncoder().encode(head), 0xe3, 0xee, 0xba, 0xfe]);
    expect(decodeDxf(bytes).endsWith('ăîşţ')).toBe(true);
  });
});

describe('pruneTrueType', () => {
  it('keeps used glyph outlines and ids, drops the rest', async () => {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const full = fontkit.create(fontBytes);
    const gidA = full.glyphForCodePoint(0x0103).id; // ă (composite in many fonts)
    const gidL = full.glyphForCodePoint(0x4c).id;
    const pruned = pruneTrueType(fontBytes, new Set([gidA, gidL]));
    expect(pruned.length).toBeLessThan(fontBytes.length / 4);
    const f = fontkit.create(pruned);
    expect(f.numGlyphs).toBe(full.numGlyphs);
    expect((f.getGlyph(gidL).path as unknown as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
    expect((f.getGlyph(gidA).path as unknown as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
    expect((f.getGlyph(full.glyphForCodePoint(0x5a).id).path as unknown as { commands: unknown[] }).commands.length).toBe(0);
  });
});
