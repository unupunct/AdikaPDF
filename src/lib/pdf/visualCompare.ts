/**
 * Visual compare: both versions rendered to pixels and overlaid, so every
 * change shows — pictures, lines, colours, moved text, stamps — not only the
 * words. The report has a summary page, then for each page the old version
 * faded under the new one: ink only in the new version in blue, ink only in
 * the old version in red, and a box around each changed area.
 */
import { PDFDocument, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib';

export interface Raster {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Page size in points. */
  widthPt: number;
  heightPt: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageDiff {
  /** Changed pixels. */
  changed: number;
  /** Changed areas, pixels of the comparison raster (top-left origin). */
  boxes: Box[];
  width: number;
  height: number;
  /** RGB (3 bytes per pixel) of the overlay. */
  overlay: Uint8Array;
}

const lum = (d: Uint8ClampedArray | Uint8Array, i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

/** Pixel differences of two rasters (aligned at the top-left corner). */
export function diffRasters(a: Raster | null, b: Raster | null, threshold = 40): PageDiff {
  const width = Math.max(a?.width ?? 0, b?.width ?? 0, 1);
  const height = Math.max(a?.height ?? 0, b?.height ?? 0, 1);
  const overlay = new Uint8Array(width * height * 3);
  const cell = 12;
  const cw = Math.ceil(width / cell);
  const ch = Math.ceil(height / cell);
  const cells = new Uint16Array(cw * ch);
  let changed = 0;
  const at = (r: Raster | null, x: number, y: number) => (r && x < r.width && y < r.height ? lum(r.data, (y * r.width + x) * 4) : 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const la = at(a, x, y);
      const lb = at(b, x, y);
      const o = (y * width + x) * 3;
      if (Math.abs(la - lb) <= threshold) {
        // Unchanged: the new page, faded.
        const v = 255 - (255 - lb) * 0.35;
        overlay[o] = overlay[o + 1] = overlay[o + 2] = v;
        continue;
      }
      changed++;
      cells[Math.floor(y / cell) * cw + Math.floor(x / cell)]++;
      const k = Math.min(1, Math.abs(la - lb) / 160);
      if (lb < la) {
        // Ink added in the new version: blue.
        overlay[o] = 255 - 255 * k;
        overlay[o + 1] = 255 - 155 * k;
        overlay[o + 2] = 255 - 20 * k;
      } else {
        // Ink removed (only in the old version): red.
        overlay[o] = 255 - 25 * k;
        overlay[o + 1] = 255 - 215 * k;
        overlay[o + 2] = 255 - 215 * k;
      }
    }
  }
  // Changed cells (a few pixels of anti-aliasing noise do not count) grouped into areas.
  const minPixels = 3;
  const seen = new Uint8Array(cw * ch);
  const boxes: Box[] = [];
  for (let i = 0; i < cw * ch; i++) {
    if (seen[i] || cells[i] < minPixels) continue;
    let x0 = cw;
    let y0 = ch;
    let x1 = 0;
    let y1 = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      // Neighbours up to two cells away join the same area.
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (!seen[n] && cells[n] >= minPixels) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    boxes.push({ x: x0 * cell, y: y0 * cell, width: Math.min(width, (x1 + 1) * cell) - x0 * cell, height: Math.min(height, (y1 + 1) * cell) - y0 * cell });
  }
  return { changed, boxes, width, height, overlay };
}

export interface VisualCompareResult {
  bytes: Uint8Array;
  /** 1-based page numbers with changes. */
  changedPages: number[];
  areas: number;
  pageCountOld: number;
  pageCountNew: number;
}

/** Latin-1 only (standard fonts): other characters become "?". */
const latin = (s: string) => s.replace(/[ăâ]/g, 'a').replace(/[ĂÂ]/g, 'A').replace(/î/g, 'i').replace(/Î/g, 'I').replace(/[șş]/g, 's').replace(/[ȘŞ]/g, 'S').replace(/[țţ]/g, 't').replace(/[ȚŢ]/g, 'T').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/** The report: summary page, then one overlay page per page pair. */
export async function visualCompareReport(
  oldPages: Array<() => Promise<Raster>>,
  newPages: Array<() => Promise<Raster>>,
  names: { oldName: string; newName: string },
  onProgress?: (done: number, total: number) => void,
): Promise<VisualCompareResult> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const total = Math.max(oldPages.length, newPages.length);
  const summary = doc.addPage([595, 842]);
  const changedPages: number[] = [];
  let areas = 0;
  for (let i = 0; i < total; i++) {
    onProgress?.(i, total);
    const a = oldPages[i] ? await oldPages[i]() : null;
    const b = newPages[i] ? await newPages[i]() : null;
    const d = diffRasters(a, b);
    const ref = a ?? b!;
    const widthPt = Math.max(a?.widthPt ?? 0, b?.widthPt ?? 0);
    const heightPt = Math.max(a?.heightPt ?? 0, b?.heightPt ?? 0);
    const scale = d.width / (widthPt || ref.widthPt);
    const page = doc.addPage([widthPt, heightPt + 28]);
    const img = doc.context.register(
      doc.context.flateStream(d.overlay, { Type: 'XObject', Subtype: 'Image', Width: d.width, Height: d.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
    );
    const name = page.node.newXObject('Ov', img);
    const wPt = d.width / scale;
    const hPt = d.height / scale;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(wPt, 0, 0, hPt, 0, heightPt - hPt), drawObject(name), popGraphicsState());
    for (const bx of d.boxes) {
      page.drawRectangle({
        x: bx.x / scale - 2,
        y: heightPt - (bx.y + bx.height) / scale - 2,
        width: bx.width / scale + 4,
        height: bx.height / scale + 4,
        borderColor: rgb(0.95, 0.55, 0),
        borderWidth: 1.2,
      });
    }
    const label = !a ? `Page ${i + 1}: only in the new version` : !b ? `Page ${i + 1}: only in the old version` : d.boxes.length ? `Page ${i + 1}: ${d.boxes.length} changed area${d.boxes.length === 1 ? '' : 's'}` : `Page ${i + 1}: no visible changes`;
    page.drawRectangle({ x: 0, y: heightPt, width: widthPt, height: 28, color: rgb(0.96, 0.96, 0.97) });
    page.drawText(label, { x: 12, y: heightPt + 9, size: 11, font: bold, color: d.boxes.length || !a || !b ? rgb(0.75, 0.3, 0) : rgb(0.3, 0.3, 0.3) });
    if (d.boxes.length || !a || !b) {
      changedPages.push(i + 1);
      areas += d.boxes.length;
    }
  }
  onProgress?.(total, total);
  // The summary, written now that the results are known.
  const lines: Array<{ text: string; bold?: boolean; size?: number; color?: [number, number, number] }> = [
    { text: 'Visual comparison', bold: true, size: 20 },
    { text: `Old version: ${latin(names.oldName)} (${oldPages.length} pages)` },
    { text: `New version: ${latin(names.newName)} (${newPages.length} pages)` },
    { text: '' },
    changedPages.length
      ? { text: `${areas} changed area${areas === 1 ? '' : 's'} on page${changedPages.length === 1 ? '' : 's'} ${changedPages.join(', ')}.`, bold: true }
      : { text: 'No visible differences.', bold: true },
    { text: '' },
    { text: 'Blue: only in the new version.', color: [0, 0.39, 0.92] },
    { text: 'Red: only in the old version.', color: [0.9, 0.16, 0.16] },
    { text: 'Orange boxes: changed areas. Grey: unchanged.', color: [0.75, 0.4, 0] },
  ];
  let y = 780;
  for (const l of lines) {
    const size = l.size ?? 11;
    if (l.text) summary.drawText(l.text, { x: 56, y, size, font: l.bold ? bold : font, color: l.color ? rgb(...l.color) : rgb(0.1, 0.1, 0.1) });
    y -= size * 1.6;
  }
  doc.setTitle(`Visual comparison — ${latin(names.newName)}`);
  return { bytes: await doc.save({ useObjectStreams: true }), changedPages, areas, pageCountOld: oldPages.length, pageCountNew: newPages.length };
}
