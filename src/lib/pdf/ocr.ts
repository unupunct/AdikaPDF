// Offline OCR (tesseract.js v7) and invisible-text layer ("searchable PDF").
//
// All tesseract assets are served locally from <BASE_URL>tesseract/ – see
// scripts/copy-ocr-assets.mjs. Nothing is fetched from a CDN.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { embedFontForText } from './fontEmbed';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  TextRenderingMode,
  beginText,
  degrees,
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
import { loadFontBytes } from '../fonts';

/** Languages whose traineddata is bundled under public/tesseract/lang. */
export const OCR_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'eng', label: 'English' },
  { code: 'ron', label: 'Română' },
  { code: 'deu', label: 'Deutsch' },
  { code: 'fra', label: 'Français' },
  { code: 'spa', label: 'Español' },
  { code: 'ita', label: 'Italiano' },
  { code: 'hun', label: 'Magyar' },
  { code: 'por', label: 'Português' },
  { code: 'nld', label: 'Nederlands' },
  { code: 'pol', label: 'Polski' },
];

const KNOWN_LANGS = new Set(OCR_LANGUAGES.map((l) => l.code));

/**
 * Normalises a language spec ('ron+eng', ['ron', 'eng'], ' RON + eng ') to a
 * de-duplicated list of bundled codes. Unknown codes are dropped; falls back
 * to English when nothing usable remains.
 */
export function parseOcrLangs(lang: string | string[] | undefined): string[] {
  const raw = Array.isArray(lang) ? lang : (lang ?? 'eng').split('+');
  const out: string[] = [];
  for (const r of raw) {
    const c = r.trim().toLowerCase();
    if (KNOWN_LANGS.has(c) && !out.includes(c)) out.push(c);
  }
  return out.length ? out : ['eng'];
}

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
  /** Word boxes in unrotated page space; the text reads along the page turned clockwise by `rotation`. */
  words: OcrWord[];
  /** Clockwise turn (0/90/180/270) at which the words were read: the page's /Rotate, or the corrected one. Default 0. */
  rotation?: number;
  /** New /Rotate for a page that was scanned sideways or upside down (set by makeSearchable). */
  straighten?: number;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * A box on the page as shown turned clockwise by `rotation` -> the same box
 * in unrotated page space (W x H, top-left origin). Pure.
 */
export function displayToPage(b: Box, rotation: number, W: number, H: number): Box {
  const r = ((rotation % 360) + 360) % 360;
  const map = (X: number, Y: number): [number, number] => (r === 90 ? [Y, H - X] : r === 180 ? [W - X, H - Y] : r === 270 ? [W - Y, X] : [X, Y]);
  const [u0, v0] = map(b.x, b.y);
  const [u1, v1] = map(b.x + b.width, b.y + b.height);
  return { x: Math.min(u0, u1), y: Math.min(v0, v1), width: Math.abs(u1 - u0), height: Math.abs(v1 - v0) };
}

/** The inverse of displayToPage. Pure. */
export function pageToDisplay(b: Box, rotation: number, W: number, H: number): Box {
  const r = ((rotation % 360) + 360) % 360;
  // Displayed size: W x H, or H x W when turned a quarter.
  const [dw, dh] = r === 90 || r === 270 ? [H, W] : [W, H];
  return displayToPage(b, (360 - r) % 360, dw, dh);
}

/** How much a reading looks like real text: confident words of two letters or more. Pure. */
export function orientationScore(words: Array<{ text: string; confidence: number }>): number {
  let s = 0;
  for (const w of words) if (w.confidence >= 60 && /\p{L}{2,}/u.test(w.text)) s += w.text.length;
  return s;
}

/** Below this score at the page's own rotation, the other three are tried. */
const ORIENTATION_DOUBT = 40;

/**
 * Picks the clockwise turn that reads best. `read` recognises the page turned
 * by a given angle (on a small render) and returns its words. The page's own
 * rotation wins unless another reads clearly better. Pure apart from `read`.
 */
export async function bestOrientation(base: number, baseScore: number, read: (rotation: number) => Promise<Array<{ text: string; confidence: number }>>): Promise<number> {
  if (baseScore >= ORIENTATION_DOUBT) return base;
  let best = base;
  let bestScore = orientationScore(await read(base));
  const own = bestScore;
  for (const turn of [90, 180, 270]) {
    const r = (base + turn) % 360;
    const s = orientationScore(await read(r));
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best !== base && bestScore >= 12 && bestScore >= own * 2 ? best : base;
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
  opts: {
    pageNumbers: number[];
    dpi?: number;
    lang?: string | string[];
    /** Called with each recognised page and its pixels (e.g. to read paper and ink colours). */
    sample?: (result: OcrPageResult, pixels: { data: Uint8ClampedArray; width: number; height: number; scale: number }) => void;
    /** Paint table lines white before recognising: letters touching ruling lines read much better. */
    eraseLines?: boolean;
    /** Detect pages scanned sideways or upside down and read them upright (see makeSearchable for /Rotate). */
    straighten?: boolean;
    /** Stops between pages when aborted. */
    signal?: AbortSignal;
  },
  onProgress?: (msg: string, fraction: number) => void,
): Promise<OcrPageResult[]> {
  const { createWorker, OEM } = await import('tesseract.js');
  const dpi = opts.dpi ?? 300;
  // tesseract.js v7 accepts an array (or a '+'-joined string) of languages.
  const langs = parseOcrLangs(opts.lang);
  const pages = opts.pageNumbers.filter((n) => n >= 1 && n <= pdf.numPages);
  const total = Math.max(1, pages.length);
  let current = 0;
  const report = (msg: string, within: number) =>
    onProgress?.(msg, Math.min(1, (current + Math.min(1, Math.max(0, within))) / total));

  const base = assetBase();
  onProgress?.('Loading OCR engine', 0);
  const worker = await createWorker(langs, OEM.LSTM_ONLY, {
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

  // Renders the page turned clockwise by `rotation` and reads it; word boxes in that turned space.
  const read = async (n: number, rotation: number, atDpi: number, keepPixels: boolean) => {
    const { canvas, scale } = await renderPageToCanvas(pdf, n, atDpi, rotation);
    if (opts.eraseLines) {
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { rasterRules } = await import('@/lib/scan/rasterRules');
      ctx.fillStyle = '#ffffff';
      for (const r of rasterRules(img.data, img.width, img.height, scale)) ctx.fillRect(r.x0 * scale - 2, r.y0 * scale - 2, (r.x1 - r.x0) * scale + 4, (r.y1 - r.y0) * scale + 4);
    }
    const png = await canvasToBlob(canvas, 'image/png');
    const pixels = keepPixels ? (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = canvas.height = 0;
    const { data } = await worker.recognize(png, {}, { blocks: true, text: false });
    return { words: blocksToWords(data.blocks as unknown as TessBlock[], scale), pixels, scale };
  };

  const results: OcrPageResult[] = [];
  try {
    for (current = 0; current < pages.length; current++) {
      opts.signal?.throwIfAborted();
      const n = pages[current];
      report(`Rendering page ${n}`, 0);
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const own = ((page.rotate % 360) + 360) % 360;
      // The page as it is shown (its /Rotate), so text stored sideways under a rotation reads upright.
      // Editable text (sample) is laid out in unrotated space: it reads the page unturned, as before.
      let rotation = opts.sample ? 0 : own;
      let r = await read(n, rotation, dpi, !!opts.sample);
      if (opts.straighten && !opts.sample) {
        const score = orientationScore(r.words);
        // Other turns are tried on a small render, only when the page reads poorly.
        const best = await bestOrientation(own, score, async (rot) => (await read(n, rot, Math.min(dpi, 150), false)).words);
        if (best !== own) {
          report(`Straightening page ${n}`, 0.5);
          rotation = best;
          r = await read(n, rotation, dpi, !!opts.sample);
        }
      }
      const result: OcrPageResult = {
        pageNumber: n,
        widthPt: vp.width,
        heightPt: vp.height,
        words: r.words.map((w) => ({ ...w, ...displayToPage(w, rotation, vp.width, vp.height) })),
        rotation,
        straighten: !opts.sample && rotation !== own ? rotation : undefined,
      };
      results.push(result);
      if (r.pixels && opts.sample) opts.sample(result, { data: r.pixels.data, width: r.pixels.width, height: r.pixels.height, scale: r.scale });
      // Frees the page's decoded images and fonts: long documents stay within memory.
      page.cleanup();
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

/** Replaces characters the font cannot encode with `replacement` (default '?'). */
export function sanitizeForFont(text: string, supported: Set<number>, replacement = '?'): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += supported.has(cp) ? ch : replacement;
  }
  return out;
}

export interface MakeSearchableOptions {
  /** TTF/OTF bytes for the invisible text. Default: bundled Noto Sans Regular. */
  loadFont?: () => Promise<Uint8Array>;
}

export async function makeSearchable(
  bytes: Uint8Array,
  results: OcrPageResult[],
  opts?: MakeSearchableOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fontBytes = await (opts?.loadFont ?? (() => loadFontBytes({ family: 'sans', bold: false, italic: false })))();
  // Noto Sans covers Latin Extended, so ă â î ș ț survive extraction. Only the
  // recognised words' glyphs are kept (see fontEmbed.ts for why not subset: true).
  const font: PDFFont = await embedFontForText(doc, fontBytes, results.flatMap((r) => r.words.map((w) => w.text)));
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
    // Text runs along the page as it was read (turned clockwise by `rot`): counter-clockwise in PDF space.
    const rot = ((r.rotation ?? 0) % 360 + 360) % 360;
    const quarter = rot === 90 || rot === 270;
    const [cos, sin] = rot === 90 ? [0, 1] : rot === 180 ? [-1, 0] : rot === 270 ? [0, -1] : [1, 0];
    for (const w of r.words) {
      // Characters missing from the font are dropped rather than faked.
      const text = sanitizeForFont(w.text, supported, '').trim();
      if (!text) continue;
      const d = pageToDisplay(w, rot, r.widthPt, r.heightPt);
      const width = d.width * (quarter ? sy : sx);
      const height = d.height * (quarter ? sx : sy);
      if (!(width > 0 && height > 0)) continue;
      const size = Math.max(1, height);
      const natural = font.widthOfTextAtSize(text, size);
      const squeeze = natural > 0 ? Math.min(1000, Math.max(1, (width / natural) * 100)) : 100;
      // Baseline start, 80% down the word as read.
      const p = displayToPage({ x: d.x, y: d.y + d.height * 0.8, width: 0, height: 0 }, rot, r.widthPt, r.heightPt);
      const x = crop.x + p.x * sx;
      const y = crop.y + crop.height - p.y * sy;
      ops.push(
        setFontAndSize(fontKey, size),
        setCharacterSqueeze(+squeeze.toFixed(2)),
        setTextMatrix(cos, sin, -sin, cos, +x.toFixed(3), +y.toFixed(3)),
        showText(font.encodeText(text + ' ')),
      );
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
    if (r.straighten !== undefined) page.setRotation(degrees(r.straighten));
  }
  return doc.save({ useObjectStreams: true });
}
