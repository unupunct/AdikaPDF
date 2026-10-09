import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRef, PDFStream, PDFString, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { signPdf, verifyPdfSignatures, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import {
  appearanceLines,
  drawSignatureAppearance,
  fillPlaceholders,
  fitLines,
  formatSigDate,
  standardProfile,
  type AppearanceAssets,
  type AppearanceProfile,
  type AppearanceValues,
} from '@/lib/crypto/sigAppearance';
import { runBatchSign, oneByOne, type BatchSignOptions } from '@/lib/batchSign';
import { identityOf, issue } from './helpers/sigPki';
import { signerFromIdentity } from '@/lib/crypto/digitalSignature';

const fonts = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const noto = (w: string) => new Uint8Array(readFileSync(join(fonts, 'noto-sans', w, `NotoSans_${w}.ttf`)));
const serif = new Uint8Array(readFileSync(join(fonts, 'noto-serif', '400Regular_Italic', 'NotoSerif_400Regular_Italic.ttf')));
// 1x1 red PNG.
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));

let identity: SigningIdentity;
beforeAll(async () => {
  const root = await issue({ cn: 'Appearance Root CA', ca: true, bits: 1024 });
  identity = identityOf(await issue({ cn: 'Ștefan Țăran', issuer: root, bits: 1024 }), [root.cert]);
});

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const values: AppearanceValues = {
  name: 'Ștefan Țăran',
  when: new Date(2026, 9, 9, 14, 5, 7),
  reason: 'Aprob conținutul',
  location: 'Brașov',
  contact: 'stefan@exemplu.ro',
  issuer: 'Appearance Root CA',
  cn: 'Ștefan Țăran',
  o: 'Firma Știință SRL',
  email: 'stefan@exemplu.ro',
};

function profile(over: Partial<AppearanceProfile> = {}): AppearanceProfile {
  return {
    ...standardProfile({ signedBy: 'Semnat digital de', date: 'Data:', reason: 'Motiv:', location: 'Locul:', contact: 'Contact:', issuer: 'Emitent:' }),
    id: 'p1',
    name: 'Firmă',
    dateFormat: 'dmy',
    details: { signedBy: true, name: true, date: true, reason: true, location: true, contact: false, issuer: true, custom: 'Pentru {o} ({cn})' },
    ...over,
  };
}
const assets = (over: Partial<AppearanceAssets> = {}): AppearanceAssets => ({ font: noto('400Regular'), bold: noto('700Bold'), graphic: { bytes: PNG, png: true }, watermark: { bytes: PNG, png: true }, ...over });

async function blank(rotate = 0): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText('Contract', { x: 60, y: 760, size: 18, font });
  if (rotate) p.setRotation(degrees(rotate));
  return d.save();
}

function widgetOf(doc: PDFDocument): PDFDict {
  const annots = doc.getPage(0).node.Annots() as PDFArray;
  return annots.asArray().map((r) => doc.context.lookup(r) as PDFDict).find((d) => (d.lookup(PDFName.of('FT')) as PDFName | undefined)?.decodeText() === 'Sig')!;
}

/** The widget's appearance drawn on a page of its own size, read back by pdf.js. */
async function appearanceText(bytes: Uint8Array): Promise<{ text: string; items: Array<{ str: string; x: number; y: number; w: number; h: number }>; bbox: number[] }> {
  const src = await PDFDocument.load(bytes);
  const n = (widgetOf(src).lookup(PDFName.of('AP')) as PDFDict).get(PDFName.of('N')) as PDFRef;
  const bbox = ((src.context.lookup(n) as PDFStream).dict.lookup(PDFName.of('BBox')) as PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
  const out = await PDFDocument.create();
  const page = out.addPage([bbox[2], bbox[3]]);
  const copy = PDFObjectCopier.for(src.context, out.context).copy(n);
  ((out.context.lookup(copy) as PDFStream).dict).set(PDFName.of('Matrix'), out.context.obj([1, 0, 0, 1, 0, 0]));
  page.node.set(PDFName.of('Contents'), out.context.register(out.context.stream('q /Ap Do Q')));
  page.node.set(PDFName.of('Resources'), out.context.obj({ XObject: { Ap: copy } }));
  const task = pdfjs.getDocument({ data: await out.save(), verbosity: 0, standardFontDataUrl: join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/' });
  tasks.push(task);
  const tc = await (await (await task.promise).getPage(1)).getTextContent();
  const items = (tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>).filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height }));
  return { text: items.map((i) => i.str).join('\n'), items, bbox };
}

describe('signature appearance designer', () => {
  it('builds the lines with labels, dates and placeholders', () => {
    const p = profile();
    expect(formatSigDate(values.when, 'dmy')).toBe('09.10.2026 14:05:07');
    expect(formatSigDate(values.when, 'dmy-date')).toBe('09.10.2026');
    expect(formatSigDate(values.when, 'iso')).toMatch(/^2026-10-09 14:05:07 [+-]\d\d:\d\d$/);
    expect(fillPlaceholders('{name}, {date}, {unknown}', values, 'dmy-date')).toBe('Ștefan Țăran, 09.10.2026, {unknown}');
    expect(appearanceLines(p, values)).toEqual([
      { text: 'Semnat digital de Ștefan Țăran', bold: true },
      { text: 'Data: 09.10.2026 14:05:07', bold: false },
      { text: 'Motiv: Aprob conținutul', bold: false },
      { text: 'Locul: Brașov', bold: false },
      { text: 'Emitent: Appearance Root CA', bold: false },
      { text: 'Pentru Firma Știință SRL (Ștefan Țăran)', bold: false },
    ]);
    expect(appearanceLines({ ...p, layout: 'graphic' }, values)).toEqual([]);
    // Empty values are left out.
    expect(appearanceLines(p, { ...values, reason: '', location: ' ' }).some((l) => l.text.startsWith('Motiv'))).toBe(false);
  });

  it('shrinks and wraps the text to fit the box', () => {
    const measure = (t: string, _b: boolean, size: number) => t.length * size * 0.5;
    const lines = appearanceLines(profile(), values);
    const fit = fitLines(lines, 100, 50, 14, measure);
    expect(fit.size).toBeLessThan(14);
    expect(fit.lines.length * fit.size * 1.22).toBeLessThanOrEqual(50.001);
    for (const l of fit.lines) expect(measure(l.text, l.bold, fit.size)).toBeLessThanOrEqual(100);
    expect(fit.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ')).toContain('Ștefan Țăran');
  });

  it('signs with a designed appearance: real text, inside the box, and the signature stays valid', async () => {
    const p = profile({ watermark: { src: 'logo', opacity: 0.15 } });
    const out = await signPdf(await blank(), {
      identity,
      pageIndex: 0,
      rect: [300, 60, 520, 130],
      appearance: (doc, w, h, rot) => drawSignatureAppearance(doc, w, h, p, values, assets(), rot),
      reason: values.reason,
    });
    const [v] = await verifyPdfSignatures(out);
    expect(v.integrity).toBe('valid');
    const { text, items, bbox } = await appearanceText(out);
    expect(bbox).toEqual([0, 0, 220, 70]);
    expect(text).toContain('Ștefan Țăran');
    expect(text).toContain('Brașov');
    expect(text).toContain('Pentru Firma Știință SRL');
    for (const i of items) {
      expect(i.x).toBeGreaterThanOrEqual(0);
      expect(i.x + i.w).toBeLessThanOrEqual(220.5);
      expect(i.y).toBeGreaterThanOrEqual(0);
      expect(i.y + i.h).toBeLessThanOrEqual(70.5);
    }
    // Text, not a picture of it: the fonts are embedded; the graphic and the watermark are images.
    const doc = await PDFDocument.load(out);
    const ap = (widgetOf(doc).lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const res = ap.dict.lookup(PDFName.of('Resources')) as PDFDict;
    expect((res.lookup(PDFName.of('Font')) as PDFDict).keys().map((k) => k.decodeText()).sort()).toEqual(['F1', 'F2']);
    expect((res.lookup(PDFName.of('XObject')) as PDFDict).keys().map((k) => k.decodeText()).sort()).toEqual(['Gr', 'Wm']);
  });

  it('a fixed small size, text only, centred; the name in a script font as text', async () => {
    const p = profile({ layout: 'graphic-top', align: 'center', fontSize: 7, graphic: { kind: 'name', font: 'Noto Serif', color: '#1d4ed8' }, border: null, background: null, watermark: null });
    const out = await signPdf(await blank(), {
      identity,
      pageIndex: 0,
      rect: [100, 100, 300, 260],
      appearance: (doc, w, h, rot) => drawSignatureAppearance(doc, w, h, p, values, assets({ graphic: { text: values.name, font: serif, color: '#1d4ed8' }, watermark: null }), rot),
    });
    expect((await verifyPdfSignatures(out))[0].integrity).toBe('valid');
    const { items } = await appearanceText(out);
    const name = items.filter((i) => i.str.includes('Ștefan Țăran'));
    // Large (the graphic, upper half), and in the details at 7 pt.
    expect(name.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...name.map((i) => i.h))).toBeGreaterThan(14);
    expect(Math.max(...name.map((i) => i.y))).toBeGreaterThan(80);
    const details = items.filter((i) => i.str.startsWith('Data:'));
    expect(details[0].h).toBeCloseTo(7, 0);
    expect(details[0].x + details[0].w / 2).toBeCloseTo(100, -1);
  });

  it('upright on a turned page, and in an existing empty field with its rectangle', async () => {
    const p = profile({ watermark: null });
    const turned = await signPdf(await blank(90), { identity, pageIndex: 0, rect: [60, 300, 130, 520], appearance: (doc, w, h, rot) => drawSignatureAppearance(doc, w, h, p, values, assets(), rot) });
    expect((await verifyPdfSignatures(turned))[0].integrity).toBe('valid');
    const doc = await PDFDocument.load(turned);
    const n = (widgetOf(doc).lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const nums = (k: string) => (n.dict.lookup(PDFName.of(k)) as PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
    // Laid out 220 × 70 as seen, turned into the 70 × 220 widget.
    expect(nums('BBox')).toEqual([0, 0, 220, 70]);
    expect(nums('Matrix')).toEqual([0, 1, -1, 0, 70, 0]);

    // Batch signing into an empty field: the field's rectangle is the box.
    const d = await PDFDocument.load(await blank());
    const page = d.getPage(0);
    const w = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Aprobare'), Rect: [300, 100, 480, 150], F: 4, P: page.ref }));
    page.node.set(PDFName.of('Annots'), d.context.obj([w]));
    d.catalog.set(PDFName.of('AcroForm'), d.context.obj({ Fields: [w] }));
    const input = await d.save({ useObjectStreams: false });
    let written: Uint8Array | null = null;
    const opts: BatchSignOptions = {
      reason: 'Aprob',
      location: '',
      contactInfo: '',
      tsaUrl: null,
      pades: true,
      certify: 0,
      ltv: false,
      archive: false,
      appearance: { visible: true, page: 'last', corner: 'bottom-right', offsetX: 20, offsetY: 20, width: 200, height: 60, fieldName: 'Aprobare' },
      output: { mode: 'replace' },
    };
    const res = await runBatchSign(['C:\\a.pdf'], oneByOne(signerFromIdentity(identity)), opts, {
      read: async () => input,
      write: async (_p, b) => void (written = b),
      exists: async () => false,
      appearance: (when) => (doc, w2, h2, rot) => drawSignatureAppearance(doc, w2, h2, p, { ...values, when }, assets(), rot),
    });
    expect(res[0].status).toBe('done');
    expect((await verifyPdfSignatures(written!))[0].integrity).toBe('valid');
    const filled = await appearanceText(written!);
    expect(filled.bbox).toEqual([0, 0, 180, 50]);
    expect(filled.text).toContain('Ștefan Țăran');
  });
});
