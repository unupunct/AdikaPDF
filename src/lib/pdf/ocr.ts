// Offline OCR (tesseract.js v7) and invisible-text layer ("searchable PDF").
//
// All tesseract assets are served locally from <BASE_URL>tesseract/ – see
// scripts/copy-ocr-assets.mjs. Nothing is fetched from a CDN.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
} from 'pdf-lib';
import { canvasToBlob, renderPageToCanvas } from './convert';

export interface OcrWord {
  text: string;
  /** Top-left corner, points, unrotated page space, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..100 */
  confidence: number;
}

export interface OcrPageResult {
  /** 1-based page number. */
  pageNumber: number;
  /** Unrotated (CropBox) page size in points. */
  widthPt: number;
  heightPt: number;
  words: OcrWord[];
}

interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text: string;
  confidence: number;
  bbox: TessBbox;
}
interface TessBlock {
  paragraphs: { lines: { words: TessWord[] }[] }[];
}

/** Flattens tesseract blocks into point-space words. Pure. */
export function blocksToWords(blocks: TessBlock[] | null | undefined, pxPerPt: number): OcrWord[] {
  const out: OcrWord[] = [];
  for (const b of blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const text = (w.text ?? '').trim();
          if (!text) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          out.push({
            text,
            x: x0 / pxPerPt,
            y: y0 / pxPerPt,
            width: Math.max(0, x1 - x0) / pxPerPt,
            height: Math.max(0, y1 - y0) / pxPerPt,
            confidence: w.confidence,
          });
        }
      }
    }
  }
  return out;
}

function assetBase(): URL {
  return new URL(import.meta.env.BASE_URL, document.baseURI);
}

export async function ocrPages(
  pdf: PDFDocumentProxy,
  opts: { pageNumbers: number[]; dpi?: number; lang?: string },
  onProgress?: (msg: string, fraction: number) => void,
): Promise<OcrPageResult[]> {
  const { createWorker, OEM } = await import('tesseract.js');
  const dpi = opts.dpi ?? 300;
  const lang = opts.lang ?? 'eng';
  const pages = opts.pageNumbers.filter((n) => n >= 1 && n <= pdf.numPages);
  const total = Math.max(1, pages.length);
  let current = 0;
  const report = (msg: string, within: number) =>
    onProgress?.(msg, Math.min(1, (current + Math.min(1, Math.max(0, within))) / total));

  const base = assetBase();
  onProgress?.('Loading OCR engine', 0);
  const worker = await createWorker(lang, OEM.LSTM_ONLY, {
    workerPath: new URL('tesseract/worker.min.js', base).href,
    corePath: new URL('tesseract/', base).href,
    langPath: new URL('tesseract/lang', base).href,
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') report(`Recognizing page ${pages[current] ?? ''}`, m.progress);
    },
  });

  const results: OcrPageResult[] = [];
  try {
    for (current = 0; current < pages.length; current++) {
      const n = pages[current];
      report(`Rendering page ${n}`, 0);
      // Rotation 0: boxes come out in unrotated page space.
      const { canvas, scale } = await renderPageToCanvas(pdf, n, dpi, 0);
      const png = await canvasToBlob(canvas, 'image/png');
      const widthPt = canvas.width / scale;
      const heightPt = canvas.height / scale;
      canvas.width = canvas.height = 0;
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const { data } = await worker.recognize(png, {}, { blocks: true, text: false });
      results.push({
        pageNumber: n,
        widthPt: vp.width || widthPt,
        heightPt: vp.height || heightPt,
        words: blocksToWords(data.blocks as unknown as TessBlock[], scale),
      });
    }
    onProgress?.('OCR complete', 1);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Invisible text layer
// ---------------------------------------------------------------------------

/** Replaces characters the font cannot encode (WinAnsi for Helvetica) with '?'. */
export function sanitizeForFont(text: string, supported: Set<number>): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += supported.has(cp) ? ch : '?';
  }
  return out;
}

export async function makeSearchable(bytes: Uint8Array, results: OcrPageResult[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const supported = new Set(font.getCharacterSet());
  const pages = doc.getPages();
  const ctx = doc.context;

  for (const r of results) {
    const page = pages[r.pageNumber - 1];
    if (!page || !r.words.length) continue;
    const crop = page.getCropBox();
    // OCR coordinates may come from a slightly different page size; scale.
    const sx = r.widthPt > 0 ? crop.width / r.widthPt : 1;
    const sy = r.heightPt > 0 ? crop.height / r.heightPt : 1;

    // Isolate the existing content so its graphics state cannot leak into ours.
    // normalize() turns /Contents into an array (and resolves /Resources).
    page.node.normalize();
    const start = ctx.register(ctx.contentStream([pushGraphicsState()]));
    const end = ctx.register(ctx.contentStream([popGraphicsState()]));
    page.node.wrapContentStreams(start, end);
    const fontKey = page.node.newFontDictionary('FOCR', font.ref);

    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of r.words) {
      const text = sanitizeForFont(w.text, supported).trim();
      if (!text) continue;
      const width = w.width * sx;
      const height = w.height * sy;
      if (!(width > 0 && height > 0)) continue;
      const size = Math.max(1, height);
      const natural = font.widthOfTextAtSize(text, size);
      const squeeze = natural > 0 ? Math.min(1000, Math.max(1, (width / natural) * 100)) : 100;
      const x = crop.x + w.x * sx;
      const y = crop.y + crop.height - w.y * sy - height * 0.8;
      ops.push(
        setFontAndSize(fontKey, size),
        setCharacterSqueeze(+squeeze.toFixed(2)),
        setTextMatrix(1, 0, 0, 1, +x.toFixed(3), +y.toFixed(3)),
        showText(font.encodeText(text + ' ')),
      );
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  return doc.save({ useObjectStreams: true });
}
