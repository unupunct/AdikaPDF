import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { buildPdf, flattenDocument, type ExportInput } from '@/lib/pdf/exportPdf';
import type { EditorObject, FieldObject, PageRef, Rotation, SourceDoc, TextObject } from '@/types';
import type { FontVariant } from '@/lib/fonts';
import { displayToPdfMatrix, applyMatrix, rotateDisplayPoint } from '@/lib/geometry';
import { wrapText } from '@/lib/textLayout';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
}
// Deterministic width model for node (no canvas): 0.5 em per character.
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
const opts = { loadFont, measure };

async function makeSource(pages: Array<{ w: number; h: number; rotate?: number; label: string }>): Promise<SourceDoc> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([p.w, p.h]);
    page.drawText(p.label, { x: 20, y: p.h - 40, size: 12, font });
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  const bytes = await doc.save();
  return { id: `src_${pages[0].label}`, name: 'test.pdf', bytes, pageCount: pages.length };
}

function refs(src: SourceDoc, sizes: Array<{ w: number; h: number; rotate?: number }>): PageRef[] {
  return sizes.map((s, i) => ({
    id: `${src.id}_p${i}`,
    kind: 'source',
    sourceId: src.id,
    sourceIndex: i,
    baseRotation: ((s.rotate ?? 0) % 360) as Rotation,
    userRotation: 0,
    width: s.w,
    height: s.h,
  }));
}

function text(pageId: string, x: number, y: number, str: string, extra: Partial<TextObject> = {}): TextObject {
  return {
    id: `t_${str}`,
    type: 'text',
    pageId,
    x,
    y,
    rotation: 0,
    opacity: 1,
    width: 300,
    height: 20,
    text: str,
    fontFamily: 'sans',
    bold: false,
    italic: false,
    fontSize: 12,
    color: '#000000',
    align: 'left',
    lineHeight: 1.25,
    background: null,
    ...extra,
  };
}

async function openWithPdfjs(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false }).promise;
}

async function pageTexts(bytes: Uint8Array) {
  const doc = await openWithPdfjs(bytes);
  const out: Array<{ items: TextItem[]; rotate: number; view: number[]; vp: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof openWithPdfjs>>['getPage']>>['getViewport']> }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push({ items: content.items.filter((it): it is TextItem => 'str' in it), rotate: page.rotate, view: page.view, vp: page.getViewport({ scale: 1 }) });
  }
  return out;
}

/** Converts a pdf.js text item origin to display space for its page. */
function displayPos(item: TextItem, page: { vp: { convertToViewportPoint(x: number, y: number): number[] } }): [number, number] {
  const [x, y] = page.vp.convertToViewportPoint(item.transform[4], item.transform[5]);
  return [x, y];
}

/** Real pdf.js viewports for a page with a CropBox offset, at each rotation. */
async function viewports(view: [number, number, number, number]) {
  const d = await PDFDocument.create();
  const pg = d.addPage([view[2], view[3]]);
  pg.setMediaBox(view[0], view[1], view[2] - view[0], view[3] - view[1]);
  const doc = await openWithPdfjs(await d.save());
  const page = await doc.getPage(1);
  return (rotation: number) => page.getViewport({ scale: 1, rotation });
}

describe('geometry', () => {
  it('display→PDF matrix agrees with pdf.js viewport for every rotation', async () => {
    const box = { x: 10, y: 20, width: 300, height: 500 };
    const vpAt = await viewports([10, 20, 310, 520]);
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const vp = vpAt(rotation);
      const m = displayToPdfMatrix(rotation, box);
      for (const [dx, dy] of [[0, 0], [50, 80], [vp.width, vp.height], [12.5, 200]]) {
        const [px, py] = applyMatrix(m, dx, dy);
        const [bx, by] = vp.convertToViewportPoint(px, py);
        expect(bx).toBeCloseTo(dx, 6);
        expect(by).toBeCloseTo(dy, 6);
      }
    }
  });

  it('rotating display points is consistent with pdf.js', async () => {
    // A point fixed on paper keeps its PDF position when the page rotates.
    const vpAt = await viewports([0, 0, 300, 500]);
    const vp0 = vpAt(0);
    const vp90 = vpAt(90);
    const [px, py] = vp0.convertToPdfPoint(40, 70);
    const expected = vp90.convertToViewportPoint(px, py);
    const got = rotateDisplayPoint(40, 70, 90, vp0.width, vp0.height);
    expect(got[0]).toBeCloseTo(expected[0], 6);
    expect(got[1]).toBeCloseTo(expected[1], 6);
  });

  it('wraps words and hard-breaks long words', () => {
    const m = (s: string) => s.length * 6;
    expect(wrapText('hello world foo', 60, m)).toEqual(['hello', 'world foo']);
    expect(wrapText('abcdefghijklmnop', 60, m)).toEqual(['abcdefghij', 'klmnop']);
    expect(wrapText('a\n\nb', 60, m)).toEqual(['a', '', 'b']);
  });
});

describe('buildPdf', () => {
  it('places text where it was shown, on normal and rotated pages', async () => {
    const sizes = [
      { w: 300, h: 500 },
      { w: 300, h: 500, rotate: 90 },
    ];
    const src = await makeSource(sizes.map((s, i) => ({ ...s, label: `P${i}` })));
    const pages = refs(src, sizes);
    const objects: EditorObject[] = [text(pages[0].id, 50, 100, 'AlphaText'), text(pages[1].id, 60, 40, 'BetaText ăîșț')];
    const out = await buildPdf({ sources: { [src.id]: src }, pages, objects, fieldValues: {} }, opts);
    const result = await pageTexts(out);
    for (const [i, needle, x] of [[0, 'AlphaText', 50], [1, 'BetaText', 60]] as const) {
      const item = result[i].items.find((it) => it.str.includes(needle));
      expect(item, `${needle} present`).toBeTruthy();
      const [dx, dy] = displayPos(item!, result[i]);
      expect(dx).toBeCloseTo(x + 2, 0); // + TEXT_PADDING
      expect(dy).toBeGreaterThan(objects[i].y);
      expect(dy).toBeLessThan(objects[i].y + 20);
    }
    expect(result[1].items.some((it) => it.str.includes('ăîșț'))).toBe(true);
  });

  it('reorders, rotates, inserts blank pages and merges another PDF', async () => {
    const a = await makeSource([
      { w: 200, h: 300, label: 'A1' },
      { w: 200, h: 300, label: 'A2' },
    ]);
    const b = await makeSource([{ w: 400, h: 250, label: 'B1' }]);
    const pa = refs(a, [{ w: 200, h: 300 }, { w: 200, h: 300 }]);
    const pb = refs(b, [{ w: 400, h: 250 }]);
    const blank: PageRef = { id: 'blank', kind: 'blank', sourceId: null, sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 100, height: 100 };
    const pages = [{ ...pa[1], userRotation: 90 as Rotation }, pb[0], blank, pa[0]];
    const out = await buildPdf({ sources: { [a.id]: a, [b.id]: b }, pages, objects: [], fieldValues: {} }, opts);
    const result = await pageTexts(out);
    expect(result.map((r) => r.items.map((i) => i.str).join(''))).toEqual(['A2', 'B1', '', 'A1']);
    expect(result[0].rotate).toBe(90);
    expect(result[2].view).toEqual([0, 0, 100, 100]);
  });

  it('keeps the same page twice (duplicate) without corrupting the tree', async () => {
    const a = await makeSource([{ w: 200, h: 300, label: 'Dup' }]);
    const [p] = refs(a, [{ w: 200, h: 300 }]);
    const out = await buildPdf({ sources: { [a.id]: a }, pages: [p, { ...p, id: 'copy' }], objects: [], fieldValues: {} }, opts);
    const result = await pageTexts(out);
    expect(result.length).toBe(2);
    expect(result.every((r) => r.items.some((i) => i.str === 'Dup'))).toBe(true);
  });

  it('creates fillable form fields and fills existing ones', async () => {
    const a = await makeSource([{ w: 300, h: 400, label: 'Form' }]);
    const [p] = refs(a, [{ w: 300, h: 400 }]);
    const field = (kind: FieldObject['fieldKind'], name: string, y: number, extra: Partial<FieldObject> = {}): FieldObject => ({
      id: `f_${name}_${y}`,
      type: 'field',
      pageId: p.id,
      fieldKind: kind,
      x: 20,
      y,
      rotation: 0,
      opacity: 1,
      width: 120,
      height: 20,
      name,
      value: '',
      options: [],
      required: false,
      fontSize: 11,
      multiline: false,
      ...extra,
    });
    const objects: EditorObject[] = [
      field('text', 'FullName', 50, { value: 'Ana Pop' }),
      field('checkbox', 'Agree', 80, { width: 14, height: 14, value: 'checked' }),
      field('radio', 'Choice', 110, { width: 14, height: 14, value: 'Yes' }),
      field('radio', 'Choice', 130, { width: 14, height: 14, value: 'No' }),
      field('dropdown', 'City', 160, { options: ['Cluj', 'Iași'], value: 'Iași' }),
      field('signature', 'SignHere', 200, { height: 40 }),
    ];
    const out = await buildPdf({ sources: { [a.id]: a }, pages: [p], objects, fieldValues: {} }, opts);
    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    const names = form.getFields().map((f) => f.getName()).sort();
    expect(names).toEqual(['Agree', 'Choice', 'City', 'FullName', 'SignHere']);
    expect(form.getTextField('FullName').getText()).toBe('Ana Pop');
    expect(form.getCheckBox('Agree').isChecked()).toBe(true);
    expect(form.getRadioGroup('Choice').getOptions()).toEqual(['Yes', 'No']);
    expect(form.getDropdown('City').getSelected()).toEqual(['Iași']);

    // Round-trip: fill the existing fields through fieldValues.
    const src2: SourceDoc = { id: 'src2', name: 'f.pdf', bytes: out, pageCount: 1 };
    const p2: PageRef = { ...p, id: 'p2', sourceId: 'src2' };
    const out2 = await buildPdf(
      {
        sources: { src2 },
        pages: [p2],
        objects: [],
        fieldValues: { 'src2::FullName': 'Ion Ionescu', 'src2::Agree': false, 'src2::Choice': 'No', 'src2::City': 'Cluj' },
      },
      opts,
    );
    const f2 = (await PDFDocument.load(out2)).getForm();
    expect(f2.getTextField('FullName').getText()).toBe('Ion Ionescu');
    expect(f2.getCheckBox('Agree').isChecked()).toBe(false);
    expect(f2.getRadioGroup('Choice').getSelected()).toBe('No');
    expect(f2.getDropdown('City').getSelected()).toEqual(['Cluj']);
  });

  it('drops form fields of deleted pages', async () => {
    const base = await PDFDocument.create();
    const pg1 = base.addPage([200, 200]);
    const pg2 = base.addPage([200, 200]);
    base.getForm().createTextField('OnPage1').addToPage(pg1, { x: 10, y: 10, width: 50, height: 20 });
    base.getForm().createTextField('OnPage2').addToPage(pg2, { x: 10, y: 10, width: 50, height: 20 });
    const src: SourceDoc = { id: 'sf', name: 'x.pdf', bytes: await base.save(), pageCount: 2 };
    const [a] = refs(src, [{ w: 200, h: 200 }, { w: 200, h: 200 }]);
    const out = await buildPdf({ sources: { sf: src }, pages: [a], objects: [], fieldValues: {} }, opts);
    expect((await PDFDocument.load(out)).getForm().getFields().map((f) => f.getName())).toEqual(['OnPage1']);
  });

  it('draws shapes, lines, pen strokes and images without errors', async () => {
    const a = await makeSource([{ w: 300, h: 300, label: 'Shapes' }]);
    const [p] = refs(a, [{ w: 300, h: 300 }]);
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const base = { pageId: p.id, rotation: 0, opacity: 0.8 };
    const objects: EditorObject[] = [
      { ...base, id: 'r', type: 'rect', x: 10, y: 10, width: 50, height: 30, stroke: '#ff0000', strokeWidth: 2, fill: '#00ff00' },
      { ...base, id: 'e', type: 'ellipse', x: 70, y: 10, width: 50, height: 30, stroke: '#0000ff', strokeWidth: 1, fill: null },
      { ...base, id: 'h', type: 'highlight', x: 10, y: 50, width: 80, height: 12, stroke: null, strokeWidth: 0, fill: '#facc15' },
      { ...base, id: 'l', type: 'arrow', x: 10, y: 80, points: [0, 0, 100, 20], stroke: '#111111', strokeWidth: 2 },
      { ...base, id: 'pen', type: 'pen', x: 10, y: 120, points: [0, 0, 10, 5, 20, 0, 30, 10], stroke: '#222222', strokeWidth: 3 },
      { ...base, id: 'img', type: 'image', x: 150, y: 150, rotation: 30, width: 40, height: 40, src: png, crop: null, naturalWidth: 1, naturalHeight: 1 },
      {
        ...base,
        id: 'sig',
        type: 'signature',
        x: 150,
        y: 220,
        width: 120,
        height: 50,
        src: png,
        naturalWidth: 1,
        naturalHeight: 1,
        signerName: 'Maria Ștefănescu',
        signedAt: new Date('2026-09-25T10:00:00Z').toISOString(),
        showCaption: true,
        kind: 'signature',
      },
    ];
    const out = await buildPdf({ sources: { [a.id]: a }, pages: [p], objects, fieldValues: {} }, opts);
    const result = await pageTexts(out);
    expect(result[0].items.some((i) => i.str.includes('Maria Ștefănescu'))).toBe(true);
    const doc = await openWithPdfjs(out);
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray.length).toBeGreaterThan(20);
  });

  it('redacted pages are rebuilt from the raster only (no text left)', async () => {
    const a = await makeSource([{ w: 200, h: 200, label: 'SECRET' }]);
    const [p] = refs(a, [{ w: 200, h: 200 }]);
    const jpeg = new Uint8Array(
      Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
        'base64',
      ),
    );
    const input: ExportInput = {
      sources: { [a.id]: a },
      pages: [p],
      objects: [{ id: 'rd', type: 'redact', pageId: p.id, x: 10, y: 10, width: 100, height: 30, rotation: 0, opacity: 1, fill: '#000000' }],
      fieldValues: {},
    };
    let asked = 0;
    const out = await buildPdf(input, { ...opts, rasterizeRedactedPage: async () => ((asked++, { bytes: jpeg, format: 'jpeg' })) });
    expect(asked).toBe(1);
    const result = await pageTexts(out);
    expect(result[0].items.map((i) => i.str).join('')).toBe('');
    expect(Buffer.from(out).includes(Buffer.from('SECRET'))).toBe(false);
  });

  it('flattens form fields into page content', async () => {
    const base = await PDFDocument.create();
    const pg = base.addPage([200, 200]);
    const tf = base.getForm().createTextField('Name');
    tf.setText('FlatValue');
    tf.addToPage(pg, { x: 10, y: 10, width: 120, height: 20 });
    flattenDocument(base);
    const bytes = await base.save();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFields().length).toBe(0);
    const texts = await pageTexts(bytes);
    expect(texts[0].items.map((i) => i.str).join('')).toContain('FlatValue');
  });
});

describe('embedded fonts render (regression: pdf-lib subsetting corrupted glyphs)', () => {
  it('every drawn character has a real glyph outline in the embedded font', async () => {
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const { PDFRawStream, PDFName, PDFDict, decodePDFRawStream } = await import('pdf-lib');
    const a = await makeSource([{ w: 400, h: 300, label: 'Fonts' }]);
    const [p] = refs(a, [{ w: 400, h: 300 }]);
    const strings = {
      sans: 'Semnat în Cluj-Napoca ăâîșț ĂÂÎȘȚ 0123',
      serif: 'Contract nr. 58213 — țară',
      mono: 'const x = "șț";',
    } as const;
    const objects: EditorObject[] = (Object.keys(strings) as Array<keyof typeof strings>).map((family, i) =>
      text(p.id, 20, 20 + i * 40, strings[family], { id: `t-${family}`, fontFamily: family, bold: family === 'serif', italic: family === 'mono' }),
    );
    const out = await buildPdf({ sources: { [a.id]: a }, pages: [p], objects, fieldValues: {} }, opts);
    const doc = await PDFDocument.load(out);
    const fonts: Array<ReturnType<typeof fontkit.create>> = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      // Font programs are only reachable from their FontDescriptor.
      if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
      for (const key of ['FontFile2', 'FontFile3']) {
        const file = obj.lookup(PDFName.of(key));
        if (file instanceof PDFRawStream) fonts.push(fontkit.create(decodePDFRawStream(file).decode()));
      }
    }
    expect(fonts.length).toBe(3);
    const allChars = [...new Set([...Object.values(strings).join('')])].filter((c) => c.trim());
    for (const font of fonts) {
      // Glyphs this font was asked to draw must have outlines (not emptied/corrupt).
      const covered = allChars.filter((c) => font.hasGlyphForCodePoint(c.codePointAt(0)!));
      const drawn = covered.filter((c) => Object.values(strings).some((s) => s.includes(c)));
      let inked = 0;
      for (const c of drawn) {
        const g = font.glyphForCodePoint(c.codePointAt(0)!);
        if ((g.path as unknown as { commands: unknown[] }).commands.length > 0) inked++;
      }
      expect(inked).toBeGreaterThan(8);
    }
    // And pruning actually shrank the files (not the ~500 KB full fonts).
    expect(out.length).toBeLessThan(400_000);
  });
});
