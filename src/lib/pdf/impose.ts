/**
 * Print layouts built as vector PDFs (pages embedded, not rasterised):
 * several pages per sheet, booklets (folded, stapled in the middle) and
 * posters (one page enlarged over several sheets to tape together).
 */
import { PDFDocument, PDFPage, degrees, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, StandardFonts, type PDFEmbeddedPage } from 'pdf-lib';

export type SheetSize = 'auto' | 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';
const SIZES: Record<Exclude<SheetSize, 'auto'>, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};
const MM = 72 / 25.4;

export type PrintLayout =
  | { kind: 'normal' }
  | { kind: 'nup'; perSheet: 2 | 4 | 6 | 9 | 16; sheet: SheetSize; order: 'across' | 'down'; borders: boolean }
  | { kind: 'booklet'; sheet: SheetSize }
  | { kind: 'poster'; scale: number; sheet: SheetSize; overlapMm: number; marks: boolean };

interface Src {
  emb: PDFEmbeddedPage;
  /** Size as shown (after /Rotate). */
  w: number;
  h: number;
  rot: 0 | 90 | 180 | 270;
}

async function embedAll(out: PDFDocument, bytes: Uint8Array, pages?: number[]): Promise<Src[]> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const list = pages ?? src.getPageIndices();
  const res: Src[] = [];
  for (const i of list) {
    const p = src.getPage(i);
    const box = p.getCropBox();
    const emb = await out.embedPage(p, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
    const rot = (((p.getRotation().angle % 360) + 360) % 360) as Src['rot'];
    const turned = rot === 90 || rot === 270;
    res.push({ emb, w: turned ? box.height : box.width, h: turned ? box.width : box.height, rot });
  }
  return res;
}

/** Draws a page (as shown, rotation applied) with its lower-left at (x, y), scale s. */
function place(sheet: PDFPage, p: Src, x: number, y: number, s: number): void {
  const { emb, rot } = p;
  const w = emb.width;
  const h = emb.height;
  if (rot === 0) sheet.drawPage(emb, { x, y, xScale: s, yScale: s });
  else if (rot === 90) sheet.drawPage(emb, { x, y: y + s * w, xScale: s, yScale: s, rotate: degrees(-90) });
  else if (rot === 180) sheet.drawPage(emb, { x: x + s * w, y: y + s * h, xScale: s, yScale: s, rotate: degrees(180) });
  else sheet.drawPage(emb, { x: x + s * h, y, xScale: s, yScale: s, rotate: degrees(90) });
}

/** Fits a page into a cell, centred. */
function fit(sheet: PDFPage, p: Src, cx: number, cy: number, cw: number, ch: number): void {
  const s = Math.min(cw / p.w, ch / p.h);
  place(sheet, p, cx + (cw - p.w * s) / 2, cy + (ch - p.h * s) / 2, s);
}

function sheetSize(size: SheetSize, first: Src, landscape: boolean): [number, number] {
  let [w, h] = size === 'auto' ? [first.w, first.h] : SIZES[size];
  if (w > h) [w, h] = [h, w];
  return landscape ? [h, w] : [w, h];
}

const GRID: Record<number, [number, number]> = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };

export async function layOut(bytes: Uint8Array, layout: PrintLayout, pages?: number[]): Promise<Uint8Array> {
  if (layout.kind === 'normal' && !pages) return bytes;
  const out = await PDFDocument.create();
  const src = await embedAll(out, bytes, pages);
  if (!src.length) throw new Error('No pages to print.');

  if (layout.kind === 'normal') {
    for (const p of src) fit(out.addPage([p.w, p.h]), p, 0, 0, p.w, p.h);
  } else if (layout.kind === 'nup') {
    const [cols0, rows0] = GRID[layout.perSheet];
    const portraitPages = src[0].h >= src[0].w;
    // 2 and 6 per sheet: turn the sheet so the cells keep the page shape.
    const landscape = portraitPages ? cols0 > rows0 : cols0 < rows0;
    const [cols, rows] = portraitPages ? [cols0, rows0] : [rows0, cols0];
    const [W, H] = sheetSize(layout.sheet, src[0], landscape);
    const m = 18;
    const gap = 8;
    const cw = (W - 2 * m - (cols - 1) * gap) / cols;
    const ch = (H - 2 * m - (rows - 1) * gap) / rows;
    for (let i = 0; i < src.length; i += layout.perSheet) {
      const sheet = out.addPage([W, H]);
      for (let k = 0; k < layout.perSheet && i + k < src.length; k++) {
        const col = layout.order === 'across' ? k % cols : Math.floor(k / rows);
        const row = layout.order === 'across' ? Math.floor(k / cols) : k % rows;
        const x = m + col * (cw + gap);
        const y = H - m - (row + 1) * ch - row * gap;
        fit(sheet, src[i + k], x, y, cw, ch);
        if (layout.borders) sheet.drawRectangle({ x, y, width: cw, height: ch, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      }
    }
  } else if (layout.kind === 'booklet') {
    // Pages padded to a multiple of 4; each sheet side holds two pages, folded in the middle.
    const n = Math.ceil(src.length / 4) * 4;
    const [W, H] = sheetSize(layout.sheet, src[0], true);
    const half = W / 2;
    const m = 12;
    const at = (i: number) => (i < src.length ? src[i] : null);
    for (let s = 0; s < n / 4; s++) {
      const sides: Array<[number, number]> = [
        [n - 1 - 2 * s, 2 * s],
        [2 * s + 1, n - 2 - 2 * s],
      ];
      for (const [left, right] of sides) {
        const sheet = out.addPage([W, H]);
        const l = at(left);
        const r = at(right);
        if (l) fit(sheet, l, m, m, half - 2 * m, H - 2 * m);
        if (r) fit(sheet, r, half + m, m, half - 2 * m, H - 2 * m);
      }
    }
  } else {
    const [TW, TH] = sheetSize(layout.sheet, src[0], false);
    const margin = 10 * MM;
    const ov = Math.max(0, layout.overlapMm) * MM;
    const aw = TW - 2 * margin;
    const ah = TH - 2 * margin;
    const font = layout.marks ? await out.embedFont(StandardFonts.Helvetica) : null;
    for (let pi = 0; pi < src.length; pi++) {
      const p = src[pi];
      const s = Math.max(0.1, layout.scale);
      const PW = p.w * s;
      const PH = p.h * s;
      const cols = Math.max(1, Math.ceil((PW - ov) / (aw - ov)));
      const rows = Math.max(1, Math.ceil((PH - ov) / (ah - ov)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sheet = out.addPage([TW, TH]);
          // Top-left tile first; each tile shows [ox, ox + aw] x [oy, oy + ah] of the poster (from its top-left).
          const ox = c * (aw - ov);
          const oy = r * (ah - ov);
          sheet.pushOperators(pushGraphicsState(), rectangle(margin, margin, aw, ah), clip(), endPath());
          place(sheet, p, margin - ox, margin + ah - (PH - oy), s);
          sheet.pushOperators(popGraphicsState());
          if (font) {
            const grey = rgb(0.45, 0.45, 0.45);
            sheet.drawRectangle({ x: margin, y: margin, width: aw, height: ah, borderColor: grey, borderWidth: 0.4, borderDashArray: [3, 3] });
            sheet.drawText(`Page ${pi + 1} · row ${r + 1}/${rows} · column ${c + 1}/${cols}${ov ? ` · overlap ${layout.overlapMm} mm` : ''}`, { x: margin, y: margin / 2 - 3, size: 7, font, color: grey });
          }
        }
      }
    }
  }
  return out.save({ useObjectStreams: true });
}

/** Sheets a layout produces (for the dialog's summary). */
export function sheetCount(pages: number, layout: PrintLayout, posterTiles = 1): number {
  switch (layout.kind) {
    case 'normal':
      return pages;
    case 'nup':
      return Math.ceil(pages / layout.perSheet);
    case 'booklet':
      return Math.ceil(pages / 4) * 2;
    case 'poster':
      return pages * posterTiles;
  }
}
