/**
 * Editable scans: the OCR text written as real, visible text in a matching
 * font, size and colour, over the scanned picture whose text lines are
 * painted over with the paper colour. The page looks the same, but its text
 * can be edited, restyled and reflowed like any other PDF text. Pictures,
 * stamps and signatures stay in the scan.
 */
import {
  PDFDocument,
  beginText,
  endText,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFFont,
  type PDFOperator,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';
import { sanitizeForFont, type OcrWord } from './ocr';

type RGB = [number, number, number];

export interface EditableLine {
  text: string;
  /** Points, unrotated page space, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Paper and ink colours, 0..255. */
  bg: RGB;
  fg: RGB;
}

export interface EditablePage {
  /** 1-based. */
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  lines: EditableLine[];
}

export interface LineBox {
  words: OcrWord[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Words into lines: same text line (vertical overlap), split at wide gaps (columns, tables). */
export function groupLines(words: OcrWord[], minConfidence = 30): LineBox[] {
  const ws = words.filter((w) => w.confidence >= minConfidence && w.width > 0 && w.height > 0).sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  const rows: OcrWord[][] = [];
  for (const w of ws) {
    const mid = w.y + w.height / 2;
    const row = rows.find((r) => {
      const top = Math.min(...r.map((x) => x.y));
      const bottom = Math.max(...r.map((x) => x.y + x.height));
      return mid > top && mid < bottom;
    });
    if (row) row.push(w);
    else rows.push([w]);
  }
  const out: LineBox[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const h = row.reduce((s, w) => s + w.height, 0) / row.length;
    let cur: OcrWord[] = [];
    const flush = () => {
      if (!cur.length) return;
      const x0 = Math.min(...cur.map((w) => w.x));
      const y0 = Math.min(...cur.map((w) => w.y));
      const x1 = Math.max(...cur.map((w) => w.x + w.width));
      const y1 = Math.max(...cur.map((w) => w.y + w.height));
      out.push({ words: cur, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      cur = [];
    };
    for (const w of row) {
      const prev = cur[cur.length - 1];
      if (prev && w.x - (prev.x + prev.width) > h * 2.5) flush();
      cur.push(w);
    }
    flush();
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Pixels per point. */
  scale: number;
}

/** Paper colour (a ring around the box) and ink colour (the dark pixels inside). */
export function lineColors(img: Pixels, box: { x: number; y: number; width: number; height: number }): { bg: RGB; fg: RGB } {
  const px = (x: number, y: number): RGB | null => {
    const X = Math.round(x * img.scale);
    const Y = Math.round(y * img.scale);
    if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) return null;
    const i = (Y * img.width + X) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const pad = Math.max(1.5, box.height * 0.25);
  const ring: RGB[] = [];
  const stepX = Math.max(0.5, box.width / 60);
  for (let x = box.x - pad; x <= box.x + box.width + pad; x += stepX) {
    for (const y of [box.y - pad, box.y + box.height + pad]) {
      const p = px(x, y);
      if (p) ring.push(p);
    }
  }
  for (let y = box.y - pad; y <= box.y + box.height + pad; y += Math.max(0.5, box.height / 8)) {
    for (const x of [box.x - pad, box.x + box.width + pad]) {
      const p = px(x, y);
      if (p) ring.push(p);
    }
  }
  const bg: RGB = ring.length ? [median(ring.map((p) => p[0])), median(ring.map((p) => p[1])), median(ring.map((p) => p[2]))] : [255, 255, 255];
  const bgL = lum(...bg);
  const ink: RGB[] = [];
  const step = Math.max(0.25, 1 / img.scale);
  for (let y = box.y; y <= box.y + box.height; y += step) {
    for (let x = box.x; x <= box.x + box.width; x += step) {
      const p = px(x, y);
      if (p && lum(...p) < bgL - 70) ink.push(p);
    }
  }
  // The darkest half: anti-aliased edges would make the ink look lighter.
  ink.sort((a, b) => lum(...a) - lum(...b));
  const core = ink.slice(0, Math.max(1, Math.ceil(ink.length / 2)));
  const fg: RGB = ink.length ? [median(core.map((p) => p[0])), median(core.map((p) => p[1])), median(core.map((p) => p[2]))] : [0, 0, 0];
  return { bg, fg };
}

/** Font size and baseline offset (from the box bottom) for a line of glyph height `h`. */
export function sizeFor(text: string, h: number): { size: number; descent: number } {
  const asc = /[A-Z0-9bdfhklĂÂÎȘȚŞŢ!?]/.test(text) ? 0.72 : 0.53;
  const hasDesc = /[gjpqyQ,;çşţșț]/.test(text);
  const size = h / (asc + (hasDesc ? 0.24 : 0));
  return { size, descent: hasDesc ? size * 0.24 : 0 };
}

export async function makeEditable(
  bytes: Uint8Array,
  pages: EditablePage[],
  opts: { loadFont: () => Promise<Uint8Array> },
): Promise<{ bytes: Uint8Array; lines: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font: PDFFont = await embedFontForText(doc, await opts.loadFont(), pages.flatMap((p) => p.lines.map((l) => l.text)));
  const supported = new Set(font.getCharacterSet());
  const all = doc.getPages();
  let count = 0;
  for (const p of pages) {
    const page = all[p.pageNumber - 1];
    if (!page || !p.lines.length) continue;
    const crop = page.getCropBox();
    const sx = p.widthPt > 0 ? crop.width / p.widthPt : 1;
    const sy = p.heightPt > 0 ? crop.height / p.heightPt : 1;
    // Isolate the scan's graphics state from the new text.
    page.node.normalize();
    const ctx = doc.context;
    page.node.wrapContentStreams(ctx.register(ctx.contentStream([pushGraphicsState()])), ctx.register(ctx.contentStream([popGraphicsState()])));
    const fontKey = page.node.newFontDictionary('FEd', font.ref);
    const paper: PDFOperator[] = [pushGraphicsState()];
    const ink: PDFOperator[] = [pushGraphicsState(), beginText()];
    for (const l of p.lines) {
      const text = sanitizeForFont(l.text, supported, '').trim();
      if (!text) continue;
      const x = crop.x + l.x * sx;
      const w = l.width * sx;
      const h = l.height * sy;
      const bottom = crop.y + crop.height - (l.y + l.height) * sy;
      // Paper over the scanned text.
      const padX = Math.max(1, h * 0.15);
      const padY = Math.max(0.8, h * 0.18);
      paper.push(setFillingRgbColor(l.bg[0] / 255, l.bg[1] / 255, l.bg[2] / 255), rectangle(x - padX, bottom - padY, w + 2 * padX, h + 2 * padY), fill());
      // The text, as wide as the scanned line.
      const { size, descent } = sizeFor(text, h);
      const natural = font.widthOfTextAtSize(text, size);
      const squeeze = natural > 0 ? Math.min(300, Math.max(30, (w / natural) * 100)) : 100;
      ink.push(
        setFillingRgbColor(l.fg[0] / 255, l.fg[1] / 255, l.fg[2] / 255),
        setFontAndSize(fontKey, +size.toFixed(2)),
        setCharacterSqueeze(+squeeze.toFixed(2)),
        setTextMatrix(1, 0, 0, 1, +x.toFixed(3), +(bottom + descent).toFixed(3)),
        showText(font.encodeText(text)),
      );
      count++;
    }
    paper.push(popGraphicsState());
    ink.push(endText(), popGraphicsState());
    page.pushOperators(...paper, ...ink);
  }
  return { bytes: await doc.save({ useObjectStreams: true }), lines: count };
}
