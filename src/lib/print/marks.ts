/**
 * Press preparation: bleed and trim boxes, and printer marks outside the
 * trim (crop marks, registration marks, colour bars, a page label). The
 * page grows by the mark area; the trim box stays the finished size.
 * Ink coverage: estimated separations and total area coverage of a
 * rendered page with the generic CMYK model.
 */
import { PDFDocument, StandardFonts, rgb, cmyk, type PDFPage } from 'pdf-lib';
import { rgbToCmyk } from './color';

export const MM = 72 / 25.4;

export interface MarksOptions {
  /** Bleed around the trim, mm (artwork must extend into it). */
  bleedMm: number;
  crop: boolean;
  registration: boolean;
  colorBars: boolean;
  pageInfo: boolean;
  /** Label for the page info (file name). */
  label?: string;
}

/** Room for marks outside the bleed (mm). */
const MARK_ROOM_MM = 12;

export async function addPrinterMarks(bytes: Uint8Array, opts: MarksOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bleed = Math.max(0, opts.bleedMm) * MM;
  const anyMarks = opts.crop || opts.registration || opts.colorBars || opts.pageInfo;
  const room = anyMarks ? MARK_ROOM_MM * MM : 0;
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    // The trim box (pdf-lib falls back to the crop box when there is none).
    const t = page.getTrimBox();
    page.setTrimBox(t.x, t.y, t.width, t.height);
    page.setBleedBox(t.x - bleed, t.y - bleed, t.width + 2 * bleed, t.height + 2 * bleed);
    const media = { x: t.x - bleed - room, y: t.y - bleed - room, width: t.width + 2 * (bleed + room), height: t.height + 2 * (bleed + room) };
    page.setMediaBox(media.x, media.y, media.width, media.height);
    page.setCropBox(media.x, media.y, media.width, media.height);
    if (!anyMarks) return;
    drawMarks(page, t, bleed, opts, font, `${opts.label ? `${opts.label} · ` : ''}page ${i + 1} of ${pages.length}`);
  });
  return doc.save({ useObjectStreams: true });
}

type Box = { x: number; y: number; width: number; height: number };

function drawMarks(page: PDFPage, t: Box, bleed: number, opts: MarksOptions, font: Awaited<ReturnType<PDFDocument['embedFont']>>, info: string): void {
  // Registration colour: all four inks.
  const reg = cmyk(1, 1, 1, 1);
  const off = bleed + 3 * MM; // marks start beyond the bleed
  const len = 6 * MM;
  const w = 0.25;
  const x0 = t.x;
  const x1 = t.x + t.width;
  const y0 = t.y;
  const y1 = t.y + t.height;
  if (opts.crop) {
    const line = (ax: number, ay: number, bx: number, by: number) => page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: w, color: reg });
    for (const [x, sx] of [
      [x0, -1],
      [x1, 1],
    ] as const)
      for (const [y, sy] of [
        [y0, -1],
        [y1, 1],
      ] as const) {
        line(x + sx * off, y, x + sx * (off + len), y); // horizontal
        line(x, y + sy * off, x, y + sy * (off + len)); // vertical
      }
  }
  if (opts.registration) {
    const target = (cx: number, cy: number) => {
      const r = 2.5 * MM;
      page.drawCircle({ x: cx, y: cy, size: r, borderColor: reg, borderWidth: w });
      page.drawCircle({ x: cx, y: cy, size: r / 2, borderColor: reg, borderWidth: w });
      page.drawLine({ start: { x: cx - r * 1.4, y: cy }, end: { x: cx + r * 1.4, y: cy }, thickness: w, color: reg });
      page.drawLine({ start: { x: cx, y: cy - r * 1.4 }, end: { x: cx, y: cy + r * 1.4 }, thickness: w, color: reg });
    };
    const d = off + len / 2;
    target((x0 + x1) / 2, y1 + d);
    target((x0 + x1) / 2, y0 - d);
    target(x0 - d, (y0 + y1) / 2);
    target(x1 + d, (y0 + y1) / 2);
  }
  if (opts.colorBars) {
    const s = 4 * MM;
    const patches = [cmyk(1, 0, 0, 0), cmyk(0, 1, 0, 0), cmyk(0, 0, 1, 0), cmyk(0, 0, 0, 1), cmyk(1, 1, 0, 0), cmyk(0, 1, 1, 0), cmyk(1, 0, 1, 0), ...[0.25, 0.5, 0.75].map((v) => cmyk(0, 0, 0, v))];
    const y = y1 + off;
    patches.forEach((c, i) => page.drawRectangle({ x: x0 + 12 * MM + i * s, y, width: s, height: s, color: c }));
  }
  if (opts.pageInfo) {
    // Helvetica (WinAnsi): Latin-1 prints; ă ș ț become a s t, the rest "?".
    const latin = info.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
    page.drawText(latin, { x: x0 + 12 * MM, y: y0 - off - 3 * MM, size: 6, font, color: rgb(0, 0, 0) });
  }
}

// ---------------------------------------------------------------- ink coverage

export interface InkStats {
  /** Highest total ink (C+M+Y+K, 0..400 %). */
  maxTotal: number;
  /** Share of the page over the limit. */
  overLimit: number;
  /** Average coverage per plate (0..100 %). */
  average: { c: number; m: number; y: number; k: number };
}

export function inkCoverage(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, limit = 300): { stats: InkStats; plates: Uint8Array[]; total: Uint16Array } {
  const n = width * height;
  const plates = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const total = new Uint16Array(n);
  let over = 0;
  let max = 0;
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = rgbToCmyk([rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255]);
    let t = 0;
    for (let k = 0; k < 4; k++) {
      const v = Math.round(c[k] * 255);
      plates[k][i] = v;
      sum[k] += c[k];
      t += c[k];
    }
    const pct = Math.round(t * 100);
    total[i] = pct;
    if (pct > max) max = pct;
    if (pct > limit) over++;
  }
  const avg = (k: number) => Math.round((sum[k] / n) * 1000) / 10;
  return { stats: { maxTotal: max, overLimit: over / n, average: { c: avg(0), m: avg(1), y: avg(2), k: avg(3) } }, plates, total };
}

/** A plate (0..255 ink) as a picture: ink in the plate's colour on white; `null` plate = total coverage heat map. */
export function platePicture(plates: Uint8Array[], total: Uint16Array, show: { c: boolean; m: boolean; y: boolean; k: boolean }, overLimit: number | null): Uint8ClampedArray {
  const n = total.length;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = show.c ? plates[0][i] / 255 : 0;
    const m = show.m ? plates[1][i] / 255 : 0;
    const y = show.y ? plates[2][i] / 255 : 0;
    const k = show.k ? plates[3][i] / 255 : 0;
    let r = (1 - c) * (1 - k);
    let g = (1 - m) * (1 - k);
    let b = (1 - y) * (1 - k);
    if (overLimit !== null && total[i] > overLimit) {
      r = 1;
      g = 0.1;
      b = 0.9; // over the limit: magenta warning
    }
    out[i * 4] = r * 255;
    out[i * 4 + 1] = g * 255;
    out[i * 4 + 2] = b * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}
