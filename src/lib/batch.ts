/**
 * Batch processing: one operation applied to many PDF files. Each result is
 * written next to its original with a suffix (never over an existing file).
 * The operations work on bytes; OCR is injected (it needs pdf.js + Tesseract).
 */
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontVariant } from './fonts';
import type { CompressOptions } from './pdf/compress';

export type CompressLevel = 'strong' | 'balanced' | 'light';

export type BatchOp =
  | { kind: 'compress'; level: CompressLevel }
  | { kind: 'ocr'; lang: string }
  | { kind: 'watermark'; text: string }
  | { kind: 'pdfa' }
  | { kind: 'protect'; userPassword: string; ownerPassword?: string }
  | { kind: 'sanitize' }
  | { kind: 'flatten' };

export type BatchKind = BatchOp['kind'];

export const BATCH_OPS: Array<{ kind: BatchKind; label: string; suffix: string }> = [
  { kind: 'ocr', label: 'OCR: make scanned pages searchable', suffix: '-ocr' },
  { kind: 'compress', label: 'Compress (smaller files)', suffix: '-compressed' },
  { kind: 'watermark', label: 'Add a text watermark', suffix: '-watermarked' },
  { kind: 'pdfa', label: 'Convert to PDF/A-2b (archiving)', suffix: '-pdfa2b' },
  { kind: 'protect', label: 'Protect with a password (AES-256)', suffix: '-protected' },
  { kind: 'sanitize', label: 'Remove metadata and hidden data', suffix: '-sanitized' },
  { kind: 'flatten', label: 'Flatten forms and comments', suffix: '-flattened' },
];

export const COMPRESS_PRESETS: Record<CompressLevel, Omit<CompressOptions, 'stripMetadata'>> = {
  light: { imageQuality: 0.85, maxImageDpi: 220 },
  balanced: { imageQuality: 0.72, maxImageDpi: 150 },
  strong: { imageQuality: 0.55, maxImageDpi: 100 },
};

export interface BatchContext {
  fileName: string;
  loadFont: (v: FontVariant) => Promise<Uint8Array>;
  /** OCR of a whole document (app: pdf.js + Tesseract). */
  ocr?: (bytes: Uint8Array, lang: string) => Promise<Uint8Array>;
}

export class BatchSkip extends Error {}

/** Metadata stripped, document info cleared, orphaned objects dropped. */
export async function sanitizeBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const [{ compressPdf }, { dropUnreachableObjects }] = await Promise.all([import('./pdf/compress'), import('./pdf/prune')]);
  const r = await compressPdf(bytes, { imageQuality: 1, maxImageDpi: 10000, stripMetadata: true });
  const doc = await PDFDocument.load(r.bytes);
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreator('');
  doc.setProducer('Adika PDF Editor');
  dropUnreachableObjects(doc);
  return doc.save();
}

/** Form fields and annotations burned into the page content. */
export async function flattenBytes(bytes: Uint8Array, loadFont: BatchContext['loadFont']): Promise<Uint8Array> {
  const { flattenDocument } = await import('./pdf/exportPdf');
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  // Full font: flattened field values may use any character.
  const font = await doc.embedFont(await loadFont({ family: 'sans', bold: false, italic: false }), { subset: false });
  flattenDocument(doc, font);
  return doc.save({ useObjectStreams: true });
}

export async function runBatchOp(bytes: Uint8Array, op: BatchOp, ctx: BatchContext): Promise<{ bytes: Uint8Array; note?: string }> {
  const { isPdfEncrypted, encryptPdf } = await import('./crypto/encrypt');
  if (isPdfEncrypted(bytes)) throw new BatchSkip('password-protected: skipped');
  switch (op.kind) {
    case 'compress': {
      const { compressPdf } = await import('./pdf/compress');
      const r = await compressPdf(bytes, { ...COMPRESS_PRESETS[op.level], stripMetadata: false });
      if (r.after >= r.before) throw new BatchSkip('already well optimised: no smaller version');
      return { bytes: r.bytes, note: `${Math.round((1 - r.after / r.before) * 100)}% smaller` };
    }
    case 'ocr':
      if (!ctx.ocr) throw new Error('OCR is not available here.');
      return { bytes: await ctx.ocr(bytes, op.lang) };
    case 'watermark': {
      const { addPageMarks } = await import('./pdf/pageMarks');
      const out = await addPageMarks(
        bytes,
        { fileName: ctx.fileName, watermark: { kind: 'text', text: op.text, fontSize: 60, color: '#9ca3af', opacity: 0.3, rotation: 45, position: 'center', behind: false } },
        (v) => ctx.loadFont(v),
      );
      return { bytes: out };
    }
    case 'pdfa': {
      const { convertToPdfA } = await import('./pdf/pdfa');
      return { bytes: await convertToPdfA(bytes, { title: ctx.fileName.replace(/\.pdf$/i, ''), author: '', level: '2b' }) };
    }
    case 'protect':
      if (!op.userPassword) throw new Error('A password is needed.');
      return {
        bytes: await encryptPdf(bytes, {
          userPassword: op.userPassword,
          ownerPassword: op.ownerPassword || op.userPassword,
          permissions: { print: true, printHighQuality: true, modify: false, copy: true, annotate: true, fillForms: true, extractForAccessibility: true, assemble: false },
        }),
      };
    case 'sanitize':
      return { bytes: await sanitizeBytes(bytes) };
    case 'flatten':
      return { bytes: await flattenBytes(bytes, ctx.loadFont) };
  }
}

/** "C:\\a\\b.pdf" + "-ocr" -> "C:\\a\\b-ocr.pdf", or "b-ocr (2).pdf" when taken. */
export async function outputPath(input: string, suffix: string, exists: (p: string) => Promise<boolean>): Promise<string> {
  const sep = input.includes('\\') ? '\\' : '/';
  const cut = input.lastIndexOf(sep);
  const folder = cut >= 0 ? input.slice(0, cut + 1) : '';
  const base = (cut >= 0 ? input.slice(cut + 1) : input).replace(/\.pdf$/i, '');
  for (let n = 1; n < 1000; n++) {
    const p = `${folder}${base}${suffix}${n > 1 ? ` (${n})` : ''}.pdf`;
    if (!(await exists(p))) return p;
  }
  throw new Error('Too many copies with that name.');
}
