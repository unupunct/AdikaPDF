import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OCR_LANGUAGES, makeSearchable, parseOcrLangs, type OcrPageResult } from '../src/lib/pdf/ocr';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/');
const FONT = `${root}node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf`;
const STD_FONTS = `${root}node_modules/pdfjs-dist/standard_fonts/`;
const LANG_DIR = `${root}public/tesseract/lang`;
const loadFont = async () => new Uint8Array(readFileSync(FONT));

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function textItems(bytes: Uint8Array, n = 1) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: STD_FONTS,
    verbosity: 0,
  });
  tasks.push(task);
  const page = await (await task.promise).getPage(n);
  const tc = await page.getTextContent();
  return tc.items.filter((i) => 'str' in i) as { str: string; transform: number[]; width: number }[];
}

describe('OCR languages', () => {
  it('lists the bundled languages', () => {
    expect(OCR_LANGUAGES.map((l) => l.code)).toEqual(['eng', 'ron', 'deu', 'fra', 'spa', 'ita', 'hun', 'por', 'nld', 'pol']);
    expect(OCR_LANGUAGES.find((l) => l.code === 'ron')?.label).toBe('Română');
  });

  it('parses combined language specs', () => {
    expect(parseOcrLangs('ron+eng')).toEqual(['ron', 'eng']);
    expect(parseOcrLangs(' RON + eng + ron ')).toEqual(['ron', 'eng']);
    expect(parseOcrLangs(['deu', 'xyz'])).toEqual(['deu']);
    expect(parseOcrLangs(undefined)).toEqual(['eng']);
    expect(parseOcrLangs('xyz')).toEqual(['eng']);
  });
});

describe('makeSearchable (Unicode)', () => {
  it('keeps Romanian diacritics extractable', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const bytes = await doc.save();
    const words = ['Știință', 'ăâî', 'țară', 'ȘȚĂÂÎ', 'a中b'];
    const results: OcrPageResult[] = [
      {
        pageNumber: 1,
        widthPt: 400,
        heightPt: 300,
        words: words.map((text, i) => ({ text, x: 20 + i * 70, y: 40, width: 60, height: 14, confidence: 90 })),
      },
    ];
    const out = await makeSearchable(bytes, results, { loadFont });
    const items = await textItems(out);
    const text = items.map((i) => i.str).join(' ');
    for (const w of ['Știință', 'ăâî', 'țară', 'ȘȚĂÂÎ']) expect(text).toContain(w);
    // CJK is not in Noto Sans: dropped, not replaced by '?'.
    expect(text).toContain('ab');
    expect(text).not.toContain('?');
    // Position and width fitting survive the font change.
    const first = items.find((i) => i.str.startsWith('Știință'))!;
    expect(first.transform[4]).toBeCloseTo(20, 0);
    expect(first.transform[5]).toBeCloseTo(300 - 40 - 14 * 0.8, 0);
    const pdf = await PDFDocument.load(out);
    expect(pdf.getPageCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Node-level OCR: rasterise text with fontkit outlines (no canvas needed)
// ---------------------------------------------------------------------------

type Pt = [number, number];

/** Flattens absolute SVG path data (M L Q C Z, as fontkit emits) to polygons. */
function svgToPolygons(d: string): Pt[][] {
  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = [0, 0];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  let cmd = '';
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') {
      if (cur.length) polys.push(cur);
      p = [num(), num()];
      cur = [p];
    } else if (cmd === 'L') {
      p = [num(), num()];
      cur.push(p);
    } else if (cmd === 'Q') {
      const c: Pt = [num(), num()];
      const e: Pt = [num(), num()];
      for (let t = 1; t <= 8; t++) {
        const s = t / 8;
        const u = 1 - s;
        cur.push([u * u * p[0] + 2 * u * s * c[0] + s * s * e[0], u * u * p[1] + 2 * u * s * c[1] + s * s * e[1]]);
      }
      p = e;
    } else if (cmd === 'C') {
      const c1: Pt = [num(), num()];
      const c2: Pt = [num(), num()];
      const e: Pt = [num(), num()];
      for (let t = 1; t <= 12; t++) {
        const s = t / 12;
        const u = 1 - s;
        const x = u * u * u * p[0] + 3 * u * u * s * c1[0] + 3 * u * s * s * c2[0] + s * s * s * e[0];
        const y = u * u * u * p[1] + 3 * u * u * s * c1[1] + 3 * u * s * s * c2[1] + s * s * s * e[1];
        cur.push([x, y]);
      }
      p = e;
    } else if (cmd === 'Z') {
      if (cur.length) polys.push(cur);
      cur = [];
    } else {
      i++;
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

/** Renders one line of text to an 8-bit grayscale PNG (black on white). */
function renderTextPng(text: string, fontBytes: Uint8Array, px: number): Uint8Array {
  const font = fontkit.create(fontBytes);
  const run = font.layout(text);
  const scale = px / font.unitsPerEm;
  const pad = Math.round(px * 0.6);
  const polys: Pt[][] = [];
  let penX = 0;
  run.glyphs.forEach((g, k) => {
    const pos = run.positions[k];
    for (const poly of svgToPolygons(g.path.toSVG())) {
      // Font units (y up) -> pixels (y down), baseline at pad + ascent.
      polys.push(poly.map(([x, y]) => [pad + (penX + pos.xOffset + x) * scale, pad + font.ascent * scale - (pos.yOffset + y) * scale]));
    }
    penX += pos.xAdvance;
  });
  const w = Math.ceil(penX * scale + 2 * pad);
  const h = Math.ceil((font.ascent - font.descent) * scale + 2 * pad);
  const img = new Uint8Array(w * h).fill(255);
  // Nonzero-winding scanline fill sampled at pixel centres.
  for (let y = 0; y < h; y++) {
    const sy = y + 0.5;
    const xs: { x: number; dir: number }[] = [];
    for (const poly of polys) {
      for (let j = 0; j < poly.length; j++) {
        const [x0, y0] = poly[j];
        const [x1, y1] = poly[(j + 1) % poly.length];
        if (y0 === y1 || sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
        xs.push({ x: x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), dir: y1 > y0 ? 1 : -1 });
      }
    }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let j = 0; j < xs.length - 1; j++) {
      wind += xs[j].dir;
      if (!wind) continue;
      for (let x = Math.max(0, Math.round(xs[j].x)); x < Math.min(w, Math.round(xs[j + 1].x)); x++) img[y * w + x] = 0;
    }
  }
  // PNG: grayscale, 8 bit, filter 0 per row.
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(img.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** Tesseract sometimes emits cedilla forms (ş ţ) for comma-below (ș ț). */
const normRo = (s: string) => s.replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');

describe.skipIf(!existsSync(`${LANG_DIR}/ron.traineddata.gz`))('tesseract.js in node', () => {
  it('recognises Romanian diacritics with ron+eng', async () => {
    const { createWorker, OEM } = await import('tesseract.js');
    const png = renderTextPng('Știință și țară în câmpie', await loadFont(), 64);
    const worker = await createWorker(parseOcrLangs('ron+eng'), OEM.LSTM_ONLY, {
      langPath: LANG_DIR,
      gzip: true,
      cacheMethod: 'none',
    });
    try {
      const { data } = await worker.recognize(Buffer.from(png));
      const text = normRo(data.text);
      expect(text).toContain('Știință');
      expect(text).toContain('țară');
      expect(text).toContain('câmpie');
    } finally {
      await worker.terminate();
    }
  });
});
