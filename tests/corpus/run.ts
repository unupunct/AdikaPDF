// Corpus worker (not part of `npm test`): runs the app's engines on every PDF named in
// CORPUS_LIST and appends one JSON line per stage and per file to CORPUS_OUT.
// Started by tests/corpus/orchestrate.mjs, which restarts it after a hang or crash.
import { it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage, ImageData as NapiImageData } from '@napi-rs/canvas';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { buildIncrementalPdf, buildPdf, incrementalBlocker, type ExportInput } from '../../src/lib/pdf/exportPdf';
import { extractStructuredText } from '../../src/lib/pdf/convert';
import { collectDocxGraphics, exportToDocx } from '../../src/lib/pdf/docx';
import { compressPdf } from '../../src/lib/pdf/compress';
import { convertToPdfADetailed } from '../../src/lib/pdf/pdfa';
import { verifyPdfSignatures } from '../../src/lib/crypto/digitalSignature';
import { checkPdfUa } from '../../src/lib/pdf/pdfua';
import { scanHiddenInfo } from '../../src/lib/pdf/hiddenInfo';
import { findTextMatches, queryFinder } from '../../src/lib/pdf/textSearch';
import { isPdfEncrypted } from '../../src/lib/crypto/encrypt';
import { decryptPdf, encryptWithSecurity, PdfPasswordError, UnsupportedEncryptionError, type Unlocked } from '../../src/lib/crypto/decrypt';
import { editableCopy } from '../../src/lib/pdf/editable';
import { looksLikePdf, repairPdf } from '../../src/lib/pdf/repair';
import { normalizeRotation } from '../../src/lib/geometry';
import type { FontVariant } from '../../src/lib/fonts';
import type { EditorObject, PageRef, SourceDoc } from '../../src/types';

const g = globalThis as Record<string, unknown>;
g.OffscreenCanvas ??= function OffscreenCanvas(w: number, h: number) {
  const c = createCanvas(Math.max(1, w), Math.max(1, h)) as unknown as Record<string, unknown>;
  c.convertToBlob = async ({ type, quality }: { type?: string; quality?: number } = {}) => {
    const png = type !== 'image/jpeg';
    const buf = await (c as unknown as { encode(f: string, q?: number): Promise<Buffer> }).encode(png ? 'png' : 'jpeg', Math.round((quality ?? 0.9) * 100));
    return new Blob([new Uint8Array(buf)], { type: png ? 'image/png' : 'image/jpeg' });
  };
  return c;
};
g.ImageData ??= NapiImageData;
// The WebView has createImageBitmap (compress, Word export): decoded through @napi-rs/canvas here.
g.createImageBitmap ??= async (src: unknown) => {
  if (src instanceof Blob) {
    const img = await loadImage(Buffer.from(await src.arrayBuffer()));
    return Object.assign(img, { close() {} });
  }
  const d = src as ImageData;
  const c = createCanvas(d.width, d.height);
  c.getContext('2d').putImageData(d as unknown as NapiImageData, 0, 0);
  return Object.assign(c, { close() {} });
};

const nm = join(process.cwd(), 'node_modules');
const PDFJS_OPTS = {
  cMapUrl: join(nm, 'pdfjs-dist', 'cmaps') + '/',
  cMapPacked: true,
  standardFontDataUrl: join(nm, 'pdfjs-dist', 'standard_fonts') + '/',
  wasmUrl: join(nm, 'pdfjs-dist', 'wasm') + '/',
  iccUrl: join(nm, 'pdfjs-dist', 'iccs') + '/',
  enableXfa: false,
  verbosity: 0,
};

const fontsDir = join(nm, '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
}
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
const JPEG_1PX = new Uint8Array(
  Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'),
);
let rasterized = 0;
const exportOpts = {
  loadFont,
  measure,
  fallbackFonts: null,
  rasterizeRedactedPage: async () => {
    rasterized++;
    return { bytes: JPEG_1PX, format: 'jpeg' as const };
  },
};

const STAGE_MS = Number(process.env.CORPUS_STAGE_MS ?? 60_000);
const out = process.env.CORPUS_OUT!;
const emit = (o: object) => appendFileSync(out, JSON.stringify(o) + '\n');

class StageTimeout extends Error {}
class Wrong extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}
class Skip extends Error {}

function within<T>(p: Promise<T>, ms = STAGE_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new StageTimeout(`timeout ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

/** The first frames of a stack inside the app's code (or the libraries'), without paths. */
function signature(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  const msg = (err.message || err.name).replace(/\d+/g, 'N').replace(/\s+/g, ' ').slice(0, 140);
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .map((l) => {
      const m = /([\w.-]+\.(?:ts|mjs|js|cjs)):(\d+)/.exec(l);
      const fn = /^at (?:async )?([\w.$<>[\] ]+?) \(/.exec(l)?.[1] ?? '';
      return m ? `${fn ? fn + '@' : ''}${m[1]}:${m[2]}` : '';
    })
    .filter((f) => f && !f.includes('run.ts'))
    .slice(0, 2);
  return `${err.constructor?.name ?? 'Error'}: ${msg}${frames.length ? ' | ' + frames.join(' < ') : ''}`;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const itemsText = (items: Array<TextItem | { str?: string }>) => items.map((i) => ('str' in i ? (i.str ?? '') : '')).join(' ');

async function open(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice(), password, ...PDFJS_OPTS }).promise as unknown as Promise<PDFDocumentProxy>;
}

async function pageText(doc: PDFDocumentProxy, n: number): Promise<TextItem[]> {
  const c = await (await doc.getPage(n)).getTextContent();
  return c.items.filter((i): i is TextItem => 'str' in i);
}

/** Characters of `a` found in `b` (multiset), as a share of `a`. */
function kept(a: string, b: string): number {
  if (!a.length) return 1;
  const counts = new Map<string, number>();
  for (const ch of b) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) (hit++, counts.set(ch, n - 1));
  }
  return hit / a.length;
}

/** A text item's box in display coordinates (top-left origin, page rotation applied). */
function displayBox(page: PDFPageProxy, it: TextItem) {
  const vp = page.getViewport({ scale: 1 });
  const [a, b, c, d, e, f] = it.transform;
  // Text turned by a multiple of 90° (also mirrored by a negative size) only.
  const flat = Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3;
  const upright = Math.abs(a) < 1e-3 && Math.abs(d) < 1e-3;
  if (!flat && !upright) return null;
  const ul = Math.hypot(a, b) || 1;
  const vl = Math.hypot(c, d) || 1;
  const [ux, uy, vx, vy] = [a / ul, b / ul, c / vl, d / vl];
  const h = it.height || vl;
  const pts = [
    [e - vx * h * 0.2, f - vy * h * 0.2],
    [e + ux * it.width + vx * h * 0.85, f + uy * it.width + vy * h * 0.85],
  ].map(([x, y]) => vp.convertToViewportPoint(x, y));
  const x0 = Math.min(pts[0][0], pts[1][0]);
  const x1 = Math.max(pts[0][0], pts[1][0]);
  const y0 = Math.min(pts[0][1], pts[1][1]);
  const y1 = Math.max(pts[0][1], pts[1][1]);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

interface FileCtx {
  file: string;
  bytes: Uint8Array;
  plain: Uint8Array;
  unlocked: Unlocked | null;
  pdf: PDFDocumentProxy | null;
  pages: PageRef[];
  source: SourceDoc | null;
  page1: TextItem[];
  index: number;
}

async function stage(ctx: FileCtx, name: string, fn: () => Promise<string | void>): Promise<boolean> {
  emit({ file: ctx.file, stage: name, at: 'start' });
  const t0 = Date.now();
  try {
    const note = await within(fn());
    emit({ file: ctx.file, stage: name, status: 'pass', ms: Date.now() - t0, ...(note ? { note } : {}) });
    return true;
  } catch (e) {
    const status = e instanceof Skip ? 'skip' : e instanceof StageTimeout ? 'timeout' : e instanceof Wrong ? 'wrong' : 'error';
    emit({ file: ctx.file, stage: name, status, ms: Date.now() - t0, sig: status === 'error' ? signature(e) : (e as Error).message, ...(status === 'error' && e instanceof Error ? { stack: e.stack?.split('\n').slice(0, 12).join('\n') } : {}), ...(e instanceof Wrong && e.detail ? { detail: e.detail } : {}) });
    return false;
  }
}

async function reopenCheck(ctx: FileCtx, bytes: Uint8Array, what: string, password?: string): Promise<PDFDocumentProxy> {
  let doc: PDFDocumentProxy;
  try {
    doc = await open(bytes, password);
  } catch (e) {
    throw new Wrong(`${what}: output does not open (${signature(e).slice(0, 100)})`);
  }
  if (doc.numPages !== ctx.pdf!.numPages) throw new Wrong(`${what}: page count ${ctx.pdf!.numPages} -> ${doc.numPages}`);
  return doc;
}

/** One file in four gets the (slow) PDF/A conversion, the same ones on every run. */
function sampled(file: string): boolean {
  let h = 0;
  for (const ch of file.split(/[\\/]/).pop()!) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4 === 0;
}

async function runFile(file: string, index: number): Promise<void> {
  let bytes: Uint8Array = new Uint8Array(readFileSync(file));
  const ctx: FileCtx = { file, bytes, plain: bytes, unlocked: null, pdf: null, pages: [], source: null, page1: [], index };
  const encrypted = isPdfEncrypted(bytes);

  const opened = await stage(ctx, 'open', async () => {
    // As the app (openPdfBytes / addSource): a file pdf.js refuses, or with a page it cannot read, is repaired first.
    let repaired = false;
    try {
      ctx.pdf = await open(bytes);
      for (let i = 1; i <= ctx.pdf.numPages; i++) await ctx.pdf.getPage(i);
    } catch (e) {
      if (e instanceof Error && e.name === 'PasswordException') throw new Skip('needs a password');
      if (!looksLikePdf(bytes)) throw e;
      try {
        bytes = (await repairPdf(bytes)).bytes;
      } catch (re) {
        throw new Error(`not opened (${signature(e).slice(0, 90)}); repair failed (${signature(re).slice(0, 90)})`);
      }
      ctx.bytes = ctx.plain = bytes;
      ctx.pdf = await open(bytes);
      repaired = true;
    }
    const pdf = ctx.pdf;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const items = (await page.getTextContent()).items.filter((x): x is TextItem => 'str' in x);
      if (i === 1) ctx.page1 = items;
      const [x0, y0, x1, y1] = page.view;
      ctx.pages.push({ id: `p${i}`, kind: 'source', sourceId: 'src', sourceIndex: i - 1, baseRotation: normalizeRotation(page.rotate), userRotation: 0, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
      if (i > 1) page.cleanup();
    }
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: Math.min(1, 2000 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1], 1)) });
    const canvas = createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    await page.render({ canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: vp, canvas: canvas as unknown as HTMLCanvasElement }).promise;
    return `${pdf.numPages} pages${encrypted ? ', encrypted' : ''}${repaired ? ', repaired' : ''}`;
  });
  if (!opened || !ctx.pdf) return;
  const pdf = ctx.pdf;

  if (encrypted) {
    const ok = await stage(ctx, 'decrypt', async () => {
      try {
        const res = await decryptPdf(bytes, '');
        ctx.plain = res.bytes;
        ctx.unlocked = res.unlocked;
      } catch (e) {
        if (e instanceof PdfPasswordError) throw new Skip('needs a password');
        if (e instanceof UnsupportedEncryptionError) throw new Skip(`unsupported: ${e.message}`);
        throw e;
      }
    });
    if (!ok) {
      // The app keeps such a file read-only: nothing else to save.
      return;
    }
  }
  // As addSource: a file pdf-lib cannot use is edited from its repaired copy.
  let original = true;
  if (process.env.CORPUS_NO_EDITABLE !== '1') {
    const fixed = await within(editableCopy(ctx.plain, pdf.numPages)).catch(() => null);
    if (fixed) {
      ctx.plain = fixed;
      original = false;
      emit({ file, stage: 'repair', status: 'pass', note: 'edited from the repaired copy' });
    }
  }
  ctx.source = { id: 'src', name: 'corpus.pdf', bytes: ctx.plain, pageCount: pdf.numPages, original, ...(ctx.unlocked ? { encryption: { file: bytes, unlocked: ctx.unlocked } } : {}) };
  const input = (objects: EditorObject[] = []): ExportInput => ({ sources: { src: ctx.source! }, pages: ctx.pages, objects, fieldValues: {}, baseSourceId: 'src' });
  const text1 = squash(itemsText(ctx.page1));

  await stage(ctx, 'save', async () => {
    rasterized = 0;
    let saved = await buildPdf(input(), exportOpts);
    if (ctx.unlocked) saved = await encryptWithSecurity(saved, ctx.unlocked);
    const doc = await reopenCheck(ctx, saved, 'save');
    const after = squash(itemsText(await pageText(doc, 1)));
    await doc.loadingTask.destroy();
    if (text1.length >= 20 && kept(text1, after) < 0.9) throw new Wrong(`save: page 1 text lost (${text1.length} -> ${after.length} chars)`);
  });

  await stage(ctx, 'incremental', async () => {
    const note: EditorObject = { id: 'n1', type: 'note', pageId: 'p1', x: 10, y: 10, width: 20, height: 20, rotation: 0, opacity: 1, text: 'corpus note', color: '#ffd400', author: 'corpus', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z' } as EditorObject;
    const why = incrementalBlocker(input([note]));
    if (why) throw new Skip(why);
    const saved = await buildIncrementalPdf(input([note]), exportOpts);
    const base = ctx.unlocked ? bytes : ctx.plain;
    if (saved.length < base.length || Buffer.compare(Buffer.from(saved.subarray(0, base.length)), Buffer.from(base)) !== 0) throw new Wrong('incremental: original bytes not kept');
    const doc = await reopenCheck(ctx, saved, 'incremental');
    const annots = await (await doc.getPage(1)).getAnnotations();
    await doc.loadingTask.destroy();
    if (!annots.some((a) => (a.contentsObj?.str ?? a.contents) === 'corpus note')) throw new Wrong('incremental: note not in the saved file');
  });

  const first = Array.from({ length: Math.min(3, pdf.numPages) }, (_, i) => i + 1);
  await stage(ctx, 'text', async () => {
    const pages = await extractStructuredText(pdf, undefined, { detectBold: true, pageNumbers: first });
    if (pages.length !== first.length) throw new Wrong(`text: ${pages.length} pages of ${first.length}`);
  });

  await stage(ctx, 'docx', async () => {
    const pages = await extractStructuredText(pdf, undefined, { detectBold: true, pageNumbers: first });
    const graphics = await collectDocxGraphics(pdf, pages);
    const blob = await exportToDocx(pages, 'corpus', { layout: ctx.index % 2 ? 'exact' : 'flow', graphics });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) throw new Wrong('docx: no word/document.xml');
  });

  await stage(ctx, 'compress', async () => {
    const res = await compressPdf(ctx.plain, { imageQuality: 0.6, maxImageDpi: 150, stripMetadata: false });
    const doc = await reopenCheck(ctx, res.bytes, 'compress');
    const after = squash(itemsText(await pageText(doc, 1)));
    await doc.loadingTask.destroy();
    if (text1.length >= 20 && kept(text1, after) < 0.9) throw new Wrong('compress: page 1 text lost');
    return `${res.before} -> ${res.after}`;
  });

  if (sampled(file)) {
    await stage(ctx, 'pdfa', async () => {
      const res = await convertToPdfADetailed(ctx.plain, { title: 'Corpus', author: 'corpus', level: '2b' });
      const doc = await reopenCheck(ctx, res.bytes, 'pdfa');
      const after = squash(itemsText(await pageText(doc, 1)));
      await doc.loadingTask.destroy();
      if (text1.length >= 20 && kept(text1, after) < 0.9) throw new Wrong('pdfa: page 1 text lost');
    });
  }

  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).includes('/ByteRange')) {
    await stage(ctx, 'signature', async () => {
      const res = await verifyPdfSignatures(bytes);
      return `${res.length} signature(s)`;
    });
  }

  await stage(ctx, 'pdfua', async () => {
    await checkPdfUa(ctx.plain);
  });

  await stage(ctx, 'hidden', async () => {
    await scanHiddenInfo(ctx.plain);
  });

  // Redaction: a box over one text item in the middle of page 1.
  const page1 = await pdf.getPage(1);
  const candidates = ctx.page1
    .map((it) => ({ it, box: displayBox(page1, it) }))
    .filter((c) => c.box && c.it.str.trim().length >= 3 && c.box.width > 5 && c.box.height > 2 && /\p{L}/u.test(c.it.str));
  const target = candidates[Math.floor(candidates.length / 2)];
  if (target) {
    await stage(ctx, 'redact', async () => {
      const box = target.box!;
      const rect = { x: box.x - 0.5, y: box.y - 0.5, width: box.width + 1, height: box.height + 1 };
      const redact: EditorObject = { id: 'rd', type: 'redact', pageId: 'p1', ...rect, rotation: 0, opacity: 1, fill: '#000000' } as EditorObject;
      rasterized = 0;
      const saved = await buildPdf(input([redact]), exportOpts);
      const doc = await reopenCheck(ctx, saved, 'redact');
      if (rasterized) {
        await doc.loadingTask.destroy();
        return 'raster';
      }
      const page = await doc.getPage(1);
      const items = await pageText(doc, 1);
      const inside = items.filter((it) => {
        if (!displayBox(page, it) || !it.str.trim()) return false;
        // Every letter's centre: what is left of a cut run sits outside the box.
        const vp = page.getViewport({ scale: 1 });
        const [a, b, c, d, e, f] = it.transform;
        const ul = Math.hypot(a, b) || 1;
        const vl = Math.hypot(c, d) || 1;
        const h = it.height || vl;
        const chars = [...it.str];
        return chars.some((ch, k) => {
          if (!ch.trim()) return false;
          const t = (it.width * (k + 0.5)) / chars.length;
          const [x, y] = vp.convertToViewportPoint(e + (a / ul) * t + (c / vl) * h * 0.33, f + (b / ul) * t + (d / vl) * h * 0.33);
          return x > rect.x + 1 && x < rect.x + rect.width - 1 && y > rect.y + 1 && y < rect.y + rect.height - 1;
        });
      });
      await doc.loadingTask.destroy();
      if (inside.some((it) => squash(it.str).length >= 2 && squash(target.it.str).includes(squash(it.str)))) throw new Wrong('redact: text under the box survived', { rect, target: target.it.str, inside: inside.map((it) => ({ str: it.str, box: displayBox(page, it) })) });
      const rest = text1.length - squash(target.it.str).length;
      const after = squash(itemsText(items));
      if (rest >= 40 && after.length < rest * 0.8) throw new Wrong(`redact: page 1 text around the box lost (${rest} -> ${after.length} chars)`);
    });
  }

  const word = ctx.page1.flatMap((i) => i.str.split(/\s+/)).find((w) => /^[A-Za-z]{5,}$/.test(w));
  if (word) {
    await stage(ctx, 'search', async () => {
      let fellBack = false;
      const hits = await findTextMatches(ctx.pages.slice(0, 1), { src: ctx.source! }, queryFinder(word), async () => ((fellBack = true), []));
      if (fellBack) return 'pdf.js fallback';
      if (!hits.length) throw new Wrong(`search: "${word}" not found by the text engine`);
    });
  }
  await pdf.loadingTask.destroy();
}

it('corpus', async () => {
  const files = readFileSync(process.env.CORPUS_LIST!, 'utf8').split(/\r?\n/).filter(Boolean);
  const offset = Number(process.env.CORPUS_INDEX0 ?? 0);
  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    const t0 = Date.now();
    emit({ file, at: 'begin' });
    try {
      await runFile(file, offset + k);
    } catch (e) {
      emit({ file, stage: 'harness', status: 'error', sig: signature(e) });
    }
    emit({ file, at: 'end', ms: Date.now() - t0, rss: Math.round(process.memoryUsage().rss / 1e6) });
  }
}, 24 * 3600_000);
