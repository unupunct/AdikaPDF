import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cmykToRgb, genericCmykProfile, rgbToCmyk } from '@/lib/print/color';
import { convertColors } from '@/lib/print/convertColors';
import { convertToPdfX, preflightPdfX } from '@/lib/print/pdfx';
import { addPrinterMarks, inkCoverage, MM } from '@/lib/print/marks';

const WASM = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'wasm').split('\\').join('/') + '/';
const ICCS = join(process.cwd(), "node_modules", "pdfjs-dist", "iccs").split("\\").join("/") + "/";
const FONTS = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts').split('\\').join('/') + '/';
// pdf.js loads its ICC engine (qcms) with a synchronous XMLHttpRequest, which the
// WebView has and Node has not: a file-reading stand-in for the test.
class FileXhr {
  responseType = '';
  response: ArrayBuffer | null = null;
  private url = '';
  open(_method: string, url: string) {
    this.url = url;
  }
  send() {
    const b = readFileSync(this.url.replace(/^file:\/\/\/?/, ''));
    this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest ??= FileXhr;

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
/** Appends raw content operators to a page. */
function appendContent(doc: PDFDocument, page: PDFPage, ops: string) {
  page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode(ops))));
}

async function render(bytes: Uint8Array, n = 1, scale = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: Number(process.env.PDFJS_V ?? 0), wasmUrl: WASM, standardFontDataUrl: FONTS, iccUrl: ICCS, useWorkerFetch: true });
  tasks.push(task);
  const page = await (await task.promise).getPage(n);
  const vp = page.getViewport({ scale });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g as never, viewport: vp, canvas: null as never }).promise;
  return { px: (x: number, y: number) => Array.from(g.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.subarray(0, 3)), w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}

/** An RGB document: filled boxes, a stroked form, an RGB image, a gradient, text, a comment colour. */
async function rgbDoc(transparency = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawRectangle({ x: 20, y: 200, width: 80, height: 60, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 120, y: 200, width: 80, height: 60, color: rgb(0, 0.6, 0.2) });
  page.drawText('Raport tipar', { x: 20, y: 170, size: 16, font, color: rgb(0.1, 0.2, 0.8) });
  // RGB image (Flate), 2x1: blue, yellow.
  const ctx = doc.context;
  const img = ctx.register(ctx.flateStream(Uint8Array.from([0, 0, 255, 255, 255, 0]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  const imgName = page.node.newXObject('Im', img);
  // Axial RGB gradient via a shading pattern.
  const sh = ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [220, 0, 380, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }, Extend: [true, true] });
  const res = page.node.Resources()!;
  res.set(PDFName.of('Shading'), ctx.obj({ Sh0: ctx.register(sh) }));
  const ops = [`q 80 0 0 40 20 100 cm /${imgName.decodeText()} Do Q`, 'q 220 20 160 60 re W n /Sh0 sh Q', 'q 0.9 0.5 0.1 RG 4 w 220 200 m 380 260 l S Q'];
  if (transparency) {
    const gs = ctx.obj({ Type: 'ExtGState', ca: 0.5 });
    res.set(PDFName.of('ExtGState'), ctx.obj({ GS0: ctx.register(gs) }));
    ops.push('q /GS0 gs 0 1 0 rg 300 150 60 40 re f Q');
  }
  appendContent(doc, page, ops.join('\n'));
  return doc.save();
}

describe('colour model and ICC profile', () => {
  it('converts with grey component replacement', () => {
    expect(rgbToCmyk([0, 0, 0])).toEqual([0, 0, 0, 1]);
    expect(rgbToCmyk([0.5, 0.5, 0.5]).map((v) => +v.toFixed(3))).toEqual([0, 0, 0, 0.5]);
    const c = rgbToCmyk([0.2, 0.6, 0.9]);
    expect(cmykToRgb(c).map((v) => +v.toFixed(3))).toEqual([0.2, 0.6, 0.9]);
  });

  it('builds a valid CMYK output profile that pdf.js can use to render CMYK colours', async () => {
    const p = genericCmykProfile();
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(view.getUint32(0)).toBe(p.length);
    expect(String.fromCharCode(...p.subarray(12, 24))).toBe('prtrCMYKLab ');
    expect(String.fromCharCode(...p.subarray(36, 40))).toBe('acsp');
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const icc = doc.context.register(doc.context.flateStream(p, { N: 4 }));
    page.node.Resources()!.set(PDFName.of('ColorSpace'), doc.context.obj({ CS0: [PDFName.of('ICCBased'), icc] }));
    const o = '/CS0 cs 1 0 0 0 sc 0 50 50 50 re f 0 0 0 1 sc 50 50 50 50 re f';
    appendContent(doc, page, o);
    const r = await render(await doc.save());
    const cyan = r.px(25, 25);
    expect(cyan[0]).toBeLessThan(60);
    expect(cyan[1]).toBeGreaterThan(180);
    expect(cyan[2]).toBeGreaterThan(180);
    const black = r.px(75, 25);
    expect(Math.max(...black)).toBeLessThan(40);
  });
});

describe('colour conversion', () => {
  it('turns every colour grey: fills, text, strokes, images, gradients', async () => {
    const src = await rgbDoc();
    const { bytes, report } = await convertColors(src, 'gray');
    expect(report.images).toBe(1);
    expect(report.shadings).toBe(1);
    const r = await render(bytes);
    for (const [x, y] of [
      [60, 70], // red box
      [160, 70], // green box
      [40, 180], // image
      [300, 250], // gradient
    ]) {
      const [a, b, c] = r.px(x, y);
      expect(Math.max(a, b, c) - Math.min(a, b, c)).toBeLessThan(4);
    }
    // Red is darker grey than white paper, lighter than black.
    const red = r.px(60, 70)[0];
    expect(red).toBeGreaterThan(40);
    expect(red).toBeLessThan(200);
    const out = await PDFDocument.load(bytes);
    const im = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) as PDFRawStream;
    expect(im.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'));
  });

  it('converts to CMYK: the preflight for PDF/X-1a passes after conversion', async () => {
    const src = await rgbDoc();
    const before = await preflightPdfX(src, 'x1a');
    expect(before.map((i) => i.rule)).toEqual(expect.arrayContaining(['Fonts embedded', 'Trim box', 'Output intent', 'PDF/X identification', 'Trapped', 'CMYK colours only']));
    // Helvetica is not embedded: that page is rasterised for PDF/X-1a.
    const raster = async () => ({ data: new Uint8Array(20 * 15 * 4).fill(40), width: 20, height: 15 });
    const x = await convertToPdfX(src, { level: 'x1a', title: 'Raport', rasterCmyk: raster });
    expect(new TextDecoder().decode(x.bytes.subarray(0, 8))).toBe('%PDF-1.4');
    expect(x.notes.join(' ')).toMatch(/rasterised/);
    expect(await preflightPdfX(x.bytes, 'x1a')).toEqual([]);
    const doc = await PDFDocument.load(x.bytes);
    expect(doc.catalog.lookup(PDFName.of('OutputIntents'))?.toString()).toMatch(/GTS_PDFX/);
    expect(new TextDecoder().decode((doc.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).contents)).toMatch(/PDF\/X-1a:2003/);
  });

  it('PDF/X-4 keeps transparency and RGB, adds trim box, output intent with profile and metadata', async () => {
    const src = await rgbDoc(true);
    const x4 = await convertToPdfX(src, { level: 'x4', title: 'Raport' });
    const issues = await preflightPdfX(x4.bytes, 'x4');
    // Only the fonts remain (standard fonts cannot be embedded here): reported, not fixed.
    expect(issues.map((i) => i.rule)).toEqual(['Fonts embedded']);
    const x1a = await preflightPdfX(src, 'x1a');
    expect(x1a.some((i) => i.rule === 'No transparency')).toBe(true);
  });

  it('keeps the creation date, uses one timestamp for Info and XMP and writes a file ID', async () => {
    const d = await PDFDocument.load(await rgbDoc(false));
    d.setCreationDate(new Date('2020-05-04T03:02:01Z'));
    const x4 = await convertToPdfX(await d.save(), { level: 'x4', title: 'Raport' });
    const doc = await PDFDocument.load(x4.bytes, { updateMetadata: false });
    expect(doc.getCreationDate()?.toISOString()).toBe('2020-05-04T03:02:01.000Z');
    const xmp = new TextDecoder().decode((doc.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).contents);
    expect(xmp).toContain('<xmp:CreateDate>2020-05-04T03:02:01Z</xmp:CreateDate>');
    const mod = doc.getModificationDate()!.toISOString().replace('.000Z', 'Z');
    expect(xmp).toContain(`<xmp:ModifyDate>${mod}</xmp:ModifyDate>`);
    expect(xmp).toContain(`<xmp:MetadataDate>${mod}</xmp:MetadataDate>`);
    const id = doc.context.trailerInfo.ID as PDFArray;
    expect(id).toBeInstanceOf(PDFArray);
    expect(id.size()).toBe(2);
  });
});

describe('printer marks and ink coverage', () => {
  it('adds bleed, trim and a mark area; the trim box stays the finished size', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]).drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.9, 0.9, 1) });
    const out = await addPrinterMarks(await doc.save(), { bleedMm: 3, crop: true, registration: true, colorBars: true, pageInfo: true, label: 'flyer.pdf' });
    const p = (await PDFDocument.load(out)).getPage(0);
    const trim = p.getTrimBox();
    expect([trim.width, trim.height].map((v) => Math.round(v))).toEqual([595, 842]);
    const bleed = p.getBleedBox();
    expect(bleed.width - trim.width).toBeCloseTo(6 * MM, 1);
    const media = p.getMediaBox();
    expect(media.width - trim.width).toBeCloseTo(2 * (3 + 12) * MM, 1);
    const r = await render(out);
    expect(r.w).toBeGreaterThan(640);
  });

  it('estimates plates and total ink', () => {
    const px = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 255, 255, 255, 30, 10, 60, 255]);
    const { stats, plates } = inkCoverage(px, 4, 1, 200);
    expect(plates[3][0]).toBe(255); // black: K only (grey component replacement)
    expect(plates[0][2]).toBe(255); // cyan
    expect(stats.maxTotal).toBeGreaterThanOrEqual(100);
    expect(stats.overLimit).toBeGreaterThan(0); // the dark blue
  });
});
