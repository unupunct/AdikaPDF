/**
 * Import ("Create PDF from …") and export ("Convert PDF to …") workflows,
 * plus OCR, compression, PDF/A and flattening. Every export runs on the
 * current document *with edits applied*.
 */
import { PDFDocument } from 'pdf-lib';
import { marked } from 'marked';
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, openPdfBytes, saveDerived, suggestedName, withBusy, PDF_FILTER } from './document';
import { openPdf, type PDFDocumentProxy } from '@/lib/pdf/pdfService';
import { htmlToPdf, officeToPdf, pickFiles, pickPaths, readFile, saveBytes, scanPage, isDesktop } from '@/lib/platform';
import { imageFileToDataUrl } from '@/lib/objectFactory';
import { decodeTiff } from '@/lib/images';
import {
  exportAllSvgZip,
  exportPagesAsImages,
  exportPlainText,
  exportToHtml,
  exportToPptx,
  exportToXlsx,
  extractStructuredText,
  renderPageToCanvas,
} from '@/lib/pdf/convert';
import { makeSearchable, ocrPages } from '@/lib/pdf/ocr';
import { compressPdf, type CompressOptions } from '@/lib/pdf/compress';
import { convertToPdfADetailed, pdfaWarnings, type PdfAMeta } from '@/lib/pdf/pdfa';
import type { DxfToPdfOptions } from '@/lib/pdf/dxf';
export type { DxfToPdfOptions };
import { buildPdf } from '@/lib/pdf/exportPdf';
import { loadFontBytes } from '@/lib/fonts';

// ================================================================ helpers

/** Sheet rows per page from the page layout (a table row with wrapped cells stays one row). */
async function xlsxRows(pdf: PDFDocumentProxy, text: Awaited<ReturnType<typeof extractStructuredText>>, onProgress?: (done: number, total: number) => void, scanned?: Set<number>): Promise<string[][][]> {
  const graphics = await (await import('@/lib/pdf/docx')).collectDocxGraphics(pdf, text, onProgress, { scanned });
  const rows = (await import('@/lib/pdf/exportFormats')).layoutRows(text, graphics);
  return text.map((p) => rows.filter((r) => r.pageNumber === p.pageNumber).map((r) => r.cells));
}

async function withEditedDoc<T>(fn: (pdf: PDFDocumentProxy, bytes: Uint8Array) => Promise<T>, progress?: (m: string, f: number | null) => void): Promise<T> {
  const bytes = await exportCurrentPdf({}, progress);
  const pdf = await openPdf(bytes);
  try {
    return await fn(pdf, bytes);
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

function baseName(): string {
  return suggestedName().replace(/\.pdf$/i, '');
}

/** Opens freshly created PDF bytes, or appends them when a document is open and `append` is set. */
export async function deliverPdf(bytes: Uint8Array, name: string, append: boolean): Promise<void> {
  const store = usePDFStore.getState();
  if (append && store.pages.length > 0) {
    await store.mergeDocument(bytes, name);
    store.toast(`Added ${name} to the document.`, 'success');
    return;
  }
  if (await openPdfBytes(bytes, name.replace(/\.[^.]+$/, '') + '.pdf', null)) {
    usePDFStore.setState({ dirty: true });
    usePDFStore.getState().toast('Created. Use Save to store the PDF.', 'success');
  }
}

// ================================================================ import: images

export type PageSizeOption = 'fit' | 'a4' | 'letter';

export interface ImagesToPdfOptions {
  pageSize: PageSizeOption;
  orientation: 'auto' | 'portrait' | 'landscape';
  marginMm: number;
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

export async function imagesToPdf(images: Array<{ src: string; width: number; height: number }>, opts: ImagesToPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer('Adika PDF Editor');
  doc.setCreator('Adika PDF Editor');
  const margin = (opts.marginMm / 25.4) * 72;
  for (const img of images) {
    const bytes = dataUrlToBytes(img.src);
    const embedded = img.src.startsWith('data:image/jpeg') ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    // Pixels → points at 96 DPI for "fit to image".
    const iw = (img.width * 72) / 96;
    const ih = (img.height * 72) / 96;
    let pw: number;
    let ph: number;
    if (opts.pageSize === 'fit') {
      pw = iw + margin * 2;
      ph = ih + margin * 2;
    } else {
      const [w, h] = PAGE_SIZES[opts.pageSize];
      const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && img.width > img.height);
      [pw, ph] = landscape ? [h, w] : [w, h];
    }
    const page = doc.addPage([pw, ph]);
    const k = Math.min((pw - margin * 2) / iw, (ph - margin * 2) / ih, opts.pageSize === 'fit' ? 1 : Infinity);
    const w = iw * k;
    const h = ih * k;
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}

function dataUrlToBytes(src: string): Uint8Array {
  const b64 = src.slice(src.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif'];
export const DOCUMENT_EXTENSIONS = ['epub', 'eml', 'mht', 'mhtml', 'msg', 'xps', 'oxps'];
export const CAD_EXTENSIONS = ['dxf'];

export async function pickImagesAsDataUrls(): Promise<Array<{ src: string; width: number; height: number; name: string }>> {
  const files = await pickFiles([{ name: 'Images', extensions: IMAGE_EXTENSIONS }], true);
  const out: Array<{ src: string; width: number; height: number; name: string }> = [];
  for (const f of files) {
    if (/\.tiff?$/i.test(f.name)) {
      for (const p of decodeTiff(f.bytes)) out.push({ ...p, name: f.name });
    } else if (/\.hei[cf]$/i.test(f.name)) {
      const { decodeHeic } = await import('@/lib/images/heic');
      for (const p of await decodeHeic(f.bytes)) out.push({ ...p, name: f.name });
    } else {
      out.push({ ...(await imageFileToDataUrl(f.bytes, f.name)), name: f.name });
    }
  }
  return out;
}

// ================================================================ import: office / html / text

export const OFFICE_EXTENSIONS = ['doc', 'docx', 'docm', 'dotx', 'rtf', 'odt', 'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods', 'ppt', 'pptx', 'pptm', 'ppsx', 'odp'];

export async function importOfficeDocuments(append: boolean): Promise<void> {
  const paths = await pickPaths([{ name: 'Office documents', extensions: OFFICE_EXTENSIONS }], true);
  if (paths.length === 0) return;
  await withBusy('Converting with Microsoft Office…', async (progress) => {
    const results: Uint8Array[] = [];
    for (let i = 0; i < paths.length; i++) {
      const name = paths[i].split(/[\\/]/).pop() ?? paths[i];
      progress(`Converting ${name} (${i + 1}/${paths.length})…`, i / paths.length);
      results.push(await officeToPdf(paths[i]));
    }
    const first = paths[0].split(/[\\/]/).pop() ?? 'Document';
    const bytes = results.length === 1 ? results[0] : await concatPdfs(results);
    await deliverPdf(bytes, first, append);
  });
}

export async function concatPdfs(list: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export interface HtmlPageOptions {
  pageSize: 'A4' | 'Letter';
  landscape: boolean;
  marginMm: number;
}

function pageCss(o: HtmlPageOptions): string {
  return `@page { size: ${o.pageSize} ${o.landscape ? 'landscape' : 'portrait'}; margin: ${o.marginMm}mm; }`;
}

const DOC_CSS = `
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }
h1, h2, h3 { line-height: 1.25; margin: 1.1em 0 0.4em; } h1 { font-size: 22pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
pre, code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; }
pre { background: #f5f7fa; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
table { border-collapse: collapse; margin: 0.8em 0; } th, td { border: 1px solid #c8d0da; padding: 4px 8px; } th { background: #eef2f6; }
blockquote { border-left: 3px solid #0284c7; margin: 0.8em 0; padding: 0.2em 0 0.2em 12px; color: #333; }
img { max-width: 100%; } a { color: #0369a1; }`;

export function wrapHtml(body: string, title: string, o: HtmlPageOptions): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${pageCss(o)}${DOC_CSS}</style></head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Injects page CSS and a <base> so relative images/styles of a local HTML file resolve. */
export function prepareHtmlFile(html: string, dirPath: string | null, o: HtmlPageOptions): string {
  const base = dirPath ? `<base href="file:///${dirPath.replace(/\\/g, '/').replace(/\/?$/, '/')}">` : '';
  const style = `<style>${pageCss(o)}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${base}${style}`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}${style}</head><body>${html}</body></html>`;
}

export async function importTextLike(kind: 'html' | 'markdown' | 'text', o: HtmlPageOptions, append: boolean): Promise<void> {
  const ext = kind === 'html' ? ['html', 'htm', 'xhtml'] : kind === 'markdown' ? ['md', 'markdown'] : ['txt', 'log', 'csv', 'json', 'xml'];
  const files = await pickFiles([{ name: kind === 'html' ? 'Web pages' : kind === 'markdown' ? 'Markdown' : 'Text files', extensions: ext }], false);
  const f = files[0];
  if (!f) return;
  await withBusy('Rendering to PDF…', async () => {
    const text = new TextDecoder('utf-8').decode(f.bytes);
    let html: string;
    if (kind === 'html') html = prepareHtmlFile(text, f.path ? f.path.replace(/[\\/][^\\/]*$/, '') : null, o);
    else if (kind === 'markdown') html = wrapHtml(await marked.parse(text, { gfm: true }), f.name, o);
    else html = wrapHtml(`<pre style="background:none;padding:0">${escapeHtml(text)}</pre>`, f.name, o);
    await deliverPdf(await htmlToPdf({ html }), f.name, append);
  });
}

export async function importUrl(url: string, append: boolean): Promise<void> {
  await withBusy(`Loading ${url}…`, async () => {
    const bytes = await htmlToPdf({ url });
    const name = new URL(url).hostname.replace(/^www\./, '') || 'web-page';
    await deliverPdf(bytes, `${name}.pdf`, append);
  });
}

export async function scanToPdf(opts: ImagesToPdfOptions, append: boolean): Promise<void> {
  const images: Array<{ src: string; width: number; height: number }> = [];
  for (;;) {
    const bytes = await withBusy(images.length ? `Scanning page ${images.length + 1}…` : 'Waiting for the scanner…', () => scanPage());
    if (!bytes || bytes.length === 0) break;
    images.push(await imageFileToDataUrl(bytes, 'scan.png'));
    const more = window.confirm(`Scanned ${images.length} page(s). Scan another page?`);
    if (!more) break;
  }
  if (images.length === 0) return;
  await withBusy('Building PDF…', async () => deliverPdf(await imagesToPdf(images, opts), 'Scan.pdf', append));
}

// ================================================================ import: EPUB, email, XPS, DXF

/** Converts an EPUB, e-mail (.eml/.msg/.mht) or XPS/OXPS file to PDF bytes. */
export async function documentToPdf(bytes: Uint8Array, fileName: string, o: HtmlPageOptions): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'xps' || ext === 'oxps') {
    const { xpsToPdf } = await import('@/lib/pdf/xps');
    const r = await xpsToPdf(bytes);
    return { bytes: r.bytes, notes: r.warnings };
  }
  if (ext === 'epub') {
    const { epubToHtml } = await import('@/lib/pdf/epub');
    const book = await epubToHtml(bytes);
    const pdf = await htmlToPdf({ html: prepareHtmlFile(book.html, null, o) });
    const doc = await PDFDocument.load(pdf);
    doc.setTitle(book.title);
    if (book.author) doc.setAuthor(book.author);
    doc.setProducer('Adika PDF Editor');
    return { bytes: await doc.save(), notes: [] };
  }
  if (['eml', 'msg', 'mht', 'mhtml'].includes(ext)) {
    const { emailToHtml } = await import('@/lib/pdf/email');
    const mail = await emailToHtml(bytes, fileName);
    const pdf = await htmlToPdf({ html: prepareHtmlFile(mail.html, null, o) });
    const doc = await PDFDocument.load(pdf);
    doc.setTitle(mail.subject || fileName);
    doc.setProducer('Adika PDF Editor');
    // Keep the original attachments inside the PDF (paperclip panel in readers).
    for (const a of mail.attachments.filter((x) => !x.inline)) {
      await doc.attach(a.bytes, a.name, { mimeType: a.mime || 'application/octet-stream', description: `Attachment of "${mail.subject}"` });
    }
    return { bytes: await doc.save(), notes: [] };
  }
  throw new Error(`Unsupported document type: .${ext}`);
}

export async function importDocuments(o: HtmlPageOptions, append: boolean): Promise<void> {
  const files = await pickFiles([{ name: 'E-books, e-mails and XPS', extensions: DOCUMENT_EXTENSIONS }], true);
  if (files.length === 0) return;
  await withBusy('Converting…', async (progress) => {
    const parts: Uint8Array[] = [];
    const notes: string[] = [];
    for (let i = 0; i < files.length; i++) {
      progress(`Converting ${files[i].name} (${i + 1}/${files.length})…`, i / files.length);
      const r = await documentToPdf(files[i].bytes, files[i].name, o);
      parts.push(r.bytes);
      notes.push(...r.notes);
    }
    await deliverPdf(parts.length === 1 ? parts[0] : await concatPdfs(parts), files[0].name, append);
    if (notes.length) usePDFStore.getState().toast(`Converted with ${notes.length} note(s): ${notes.slice(0, 3).join('; ')}`, 'info');
  });
}

export async function importDxf(opts: DxfToPdfOptions, append: boolean): Promise<void> {
  const files = await pickFiles([{ name: 'DXF drawings', extensions: CAD_EXTENSIONS }], true);
  if (files.length === 0) return;
  await withBusy('Converting drawing…', async (progress) => {
    const { dxfToPdf, decodeDxf } = await import('@/lib/pdf/dxf');
    const parts: Uint8Array[] = [];
    const notes: string[] = [];
    for (let i = 0; i < files.length; i++) {
      progress(`Drawing ${files[i].name} (${i + 1}/${files.length})…`, i / files.length);
      const r = await dxfToPdf(decodeDxf(files[i].bytes), { ...opts, loadFont: () => loadFontBytes({ family: 'sans', bold: false, italic: false }) });
      parts.push(r.bytes);
      notes.push(...r.warnings);
    }
    await deliverPdf(parts.length === 1 ? parts[0] : await concatPdfs(parts), files[0].name, append);
    if (notes.length) usePDFStore.getState().toast(notes.slice(0, 3).join(' · '), 'info');
  });
}

// ================================================================ export

export type ExportFormat = 'docx' | 'odt' | 'rtf' | 'xlsx' | 'csv' | 'pptx' | 'png' | 'jpeg' | 'tiff' | 'svg' | 'html' | 'epub' | 'md' | 'txt' | 'json';

export interface ExportRequest {
  format: ExportFormat;
  dpi: number;
  pageNumbers?: number[];
  quality?: number;
  /** Word only: editable flowing text (default) or paragraphs pinned to their PDF position. */
  docxLayout?: 'flow' | 'exact';
}

const FORMAT_INFO: Record<ExportFormat, { ext: string; label: string }> = {
  docx: { ext: 'docx', label: 'Word document' },
  odt: { ext: 'odt', label: 'OpenDocument text' },
  rtf: { ext: 'rtf', label: 'Rich Text' },
  csv: { ext: 'csv', label: 'CSV table' },
  epub: { ext: 'epub', label: 'EPUB e-book' },
  json: { ext: 'json', label: 'JSON data' },
  xlsx: { ext: 'xlsx', label: 'Excel workbook' },
  pptx: { ext: 'pptx', label: 'PowerPoint presentation' },
  png: { ext: 'zip', label: 'PNG images (ZIP)' },
  jpeg: { ext: 'zip', label: 'JPEG images (ZIP)' },
  tiff: { ext: 'tif', label: 'Multi-page TIFF' },
  svg: { ext: 'zip', label: 'SVG pages (ZIP)' },
  html: { ext: 'html', label: 'HTML5 page' },
  md: { ext: 'md', label: 'Markdown' },
  txt: { ext: 'txt', label: 'Plain text' },
};

export async function exportAs(req: ExportRequest): Promise<void> {
  const info = FORMAT_INFO[req.format];
  const result = await withBusy(`Converting to ${info.label}…`, (progress) =>
    withEditedDoc(async (pdf0, bytes0) => {
      const tick = (label: string) => (done: number, total: number) => progress(`${label} (${done}/${total})`, total ? done / total : null);
      const needsText = ['docx', 'odt', 'rtf', 'xlsx', 'csv', 'pptx', 'html', 'epub', 'md', 'txt', 'json'].includes(req.format);
      let pdf = pdf0;
      let bytes = bytes0;
      let text = needsText ? await extractStructuredText(pdf, tick('Reading text'), { detectBold: true, pageNumbers: req.pageNumbers }) : [];
      // Scanned pages (no text) are recognised first; their tables are found from the lines in the scan.
      const scanned = new Set<number>();
      const textFormats = ['docx', 'odt', 'rtf', 'xlsx', 'csv', 'epub', 'md', 'txt', 'json'];
      const empty = textFormats.includes(req.format) ? text.filter((p) => !p.lines.length).map((p) => p.pageNumber) : [];
      let ocrDoc: PDFDocumentProxy | null = null;
      if (empty.length) {
        let lang = ['ron', 'eng'];
        try {
          const v = JSON.parse(localStorage.getItem('adika.ocrLangs') ?? 'null') as unknown;
          if (Array.isArray(v) && v.length) lang = v as string[];
        } catch {
          /* default languages */
        }
        const results = await ocrPages(pdf0, { pageNumbers: empty, dpi: 300, lang, eraseLines: true }, (m, f) => progress(m, f));
        const found = results.filter((r) => r.words.length);
        if (found.length) {
          for (const r of found) scanned.add(r.pageNumber);
          bytes = await makeSearchable(bytes0, found);
          ocrDoc = await openPdf(bytes);
          pdf = ocrDoc;
          text = await extractStructuredText(pdf, tick('Reading text'), { detectBold: true, pageNumbers: req.pageNumbers });
        }
      }
      try {
      switch (req.format) {
        case 'docx': {
          const { collectDocxGraphics, exportToDocx } = await import('@/lib/pdf/docx');
          const graphics = await collectDocxGraphics(pdf, text, tick('Reading images and colours'), { scanned });
          return exportToDocx(text, baseName(), { layout: req.docxLayout, graphics });
        }
        case 'odt':
        case 'rtf': {
          // Same layout as the Word export: pictures, colours and rules come from the rendered pages.
          const { collectDocxGraphics } = await import('@/lib/pdf/docx');
          const graphics = await collectDocxGraphics(pdf, text, tick('Reading images and colours'), { scanned });
          const formats = await import('@/lib/pdf/exportFormats');
          if (req.format === 'odt') return formats.exportToOdt(text, baseName(), graphics);
          return new Blob([formats.exportToRtf(text, baseName(), graphics)], { type: 'application/rtf' });
        }
        case 'csv': {
          const graphics = await (await import('@/lib/pdf/docx')).collectDocxGraphics(pdf, text, tick('Reading tables'), { scanned });
          return new Blob([(await import('@/lib/pdf/exportFormats')).exportToCsv(text, { delimiter: ',' }, graphics)], { type: 'text/csv' });
        }
        case 'json': {
          const fields = await (await import('./security')).readFormFields(bytes);
          const json = await (await import('@/lib/pdf/exportFormats')).exportToJson(pdf, text, { formFields: fields.map((f) => ({ name: f.name, kind: f.kind, value: f.value })) });
          return new Blob([json], { type: 'application/json' });
        }
        case 'epub': {
          const graphics = await (await import('@/lib/pdf/docx')).collectDocxGraphics(pdf, text, tick('Reading tables and lists'), { scanned });
          return (await import('@/lib/pdf/epub')).pdfToEpub(text, { title: baseName(), author: '' }, graphics);
        }
        case 'xlsx':
          return exportToXlsx(text, await xlsxRows(pdf, text, tick('Reading tables'), scanned));
        case 'pptx':
          return exportToPptx(pdf, text, { dpi: req.dpi, title: baseName() }, tick('Rendering slides'));
        case 'png':
        case 'jpeg':
        case 'tiff':
          return exportPagesAsImages(pdf, { format: req.format, dpi: req.dpi, pageNumbers: req.pageNumbers, quality: req.quality }, tick('Rendering pages'));
        case 'svg':
          return exportAllSvgZip(pdf, { dpi: req.dpi, pageNumbers: req.pageNumbers }, tick('Rendering pages'));
        case 'html':
          return exportToHtml(pdf, text, { dpi: req.dpi, title: baseName() }, tick('Rendering pages'));
        case 'md': {
          const { collectDocxGraphics } = await import('@/lib/pdf/docx');
          const graphics = await collectDocxGraphics(pdf, text, tick('Reading tables and lists'), { scanned });
          return new Blob([(await import('@/lib/pdf/exportFormats')).exportToMarkdown(text, graphics)], { type: 'text/markdown' });
        }
        case 'txt':
          return new Blob([exportPlainText(text)], { type: 'text/plain' });
      }
      } finally {
        await ocrDoc?.loadingTask.destroy().catch(() => undefined);
      }
    }, progress),
  );
  if (!result) return;
  const path = await saveBytes(result, `${baseName()}.${info.ext}`, [{ name: info.label, extensions: [info.ext] }]);
  if (path) usePDFStore.getState().toast(path === 'downloaded' ? 'Downloaded.' : `Saved to ${path}`, 'success');
}

// ================================================================ OCR / compress / PDF-A / flatten

export async function runOcr(opts: { pageNumbers: number[]; dpi: number; lang: string; editable?: { family: 'sans' | 'serif' } }): Promise<void> {
  const editable = opts.editable;
  const out = await withBusy('Recognising text (OCR)…', (progress) =>
    withEditedDoc(async (pdf, bytes) => {
      const { groupLines, lineColors, makeEditable } = await import('@/lib/pdf/editableScan');
      const pages: import('@/lib/pdf/editableScan').EditablePage[] = [];
      const results = await ocrPages(
        pdf,
        {
          ...opts,
          // Editable text: the paper and ink colour of every line, read while the page is rendered.
          sample: editable
            ? (r, pixels) =>
                pages.push({
                  pageNumber: r.pageNumber,
                  widthPt: r.widthPt,
                  heightPt: r.heightPt,
                  lines: groupLines(r.words).map((l) => ({ text: l.words.map((w) => w.text).join(' '), x: l.x, y: l.y, width: l.width, height: l.height, ...lineColors(pixels, l) })),
                })
            : undefined,
        },
        (m, f) => progress(m, f),
      );
      const words = results.reduce((n, r) => n + r.words.length, 0);
      if (editable) {
        progress('Writing editable text…', null);
        const r = await makeEditable(bytes, pages, { loadFont: () => loadFontBytes({ family: editable.family, bold: false, italic: false }) });
        return { bytes: r.bytes, words };
      }
      progress('Embedding searchable text…', null);
      return { bytes: await makeSearchable(bytes, results), words };
    }, progress),
  );
  if (!out) return;
  usePDFStore
    .getState()
    .toast(editable ? `OCR found ${out.words} words. The text is now real, editable text (Edit → Edit text).` : `OCR found ${out.words} words. The text layer is now searchable and selectable.`, 'success');
  await saveDerived(out.bytes, editable ? '-editable' : '-ocr', true);
}

export async function runCompress(opts: CompressOptions): Promise<{ before: number; after: number } | undefined> {
  const out = await withBusy('Compressing…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    return compressPdf(bytes, opts, (d, t) => progress(`Optimising images (${d}/${t})`, t ? d / t : null));
  });
  if (!out) return undefined;
  if (out.after >= out.before) {
    usePDFStore.getState().toast('This PDF is already well optimised — no smaller version could be made.', 'info');
    return { before: out.before, after: out.after };
  }
  await saveDerived(out.bytes, '-compressed', true);
  return { before: out.before, after: out.after };
}

export async function runPdfA(meta: PdfAMeta): Promise<string[] | undefined> {
  const level = meta.level ?? '2b';
  const out = await withBusy(`Converting to PDF/A-${level}…`, async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const r = await convertToPdfADetailed(bytes, meta);
    return { pdfa: r.bytes, warnings: [...r.notes, ...(await pdfaWarnings(r.bytes, level))] };
  });
  if (!out) return undefined;
  await saveDerived(out.pdfa, `-pdfa${level}`, true);
  return out.warnings;
}

export async function flattenCurrent(): Promise<void> {
  const out = await withBusy('Flattening…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const { flattenBytes } = await import('@/lib/batch');
    return flattenBytes(bytes, loadFontBytes);
  });
  if (out) await saveDerived(out, '-flattened', true);
}

/** Extracts page numbers (1-based) into a new PDF. */
export async function extractPages(pageNumbers: number[], suffix = '-extract'): Promise<void> {
  const s = usePDFStore.getState();
  const pages = pageNumbers.map((n) => s.pages[n - 1]).filter((p) => !!p);
  if (pages.length === 0) return;
  const ids = new Set(pages.map((p) => p.id));
  const bytes = await withBusy('Extracting pages…', () =>
    buildPdf(
      { sources: s.sources, pages, objects: s.objects.filter((o) => ids.has(o.pageId)), fieldValues: s.fieldValues },
      { rasterizeRedactedPage: (p, r) => import('./document').then((m) => m.rasterizeWithRedactions(p, r)) },
    ),
  );
  if (bytes) await saveDerived(bytes, suffix, false);
}

/** Splits into chunks of `every` pages, or at explicit ranges like "1-3,4-10". */
/**
 * Split at blank pages and / or Adika separator sheets (their barcode may
 * name the next part). The blank pages and sheets themselves are left out.
 */
export async function splitAtSeparators(opts: { atBlank: boolean }): Promise<void> {
  const groups = await withBusy('Looking for separator pages…', async (progress) => {
    const [{ pageRole, splitPages }, { cleanupPage, binarize, toGray }, { readCode128 }] = await Promise.all([
      import('@/lib/scan/scanPdf'),
      import('@/lib/scan/cleanup'),
      import('@/lib/barcode/code128'),
    ]);
    const pdf = await openPdf(await exportCurrentPdf({}, progress));
    try {
      const roles = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        progress(`Checking page ${n} of ${pdf.numPages}`, n / pdf.numPages);
        const { canvas } = await renderPageToCanvas(pdf, n, 100);
        const d = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = canvas.height = 0;
        const img = { data: d.data, width: d.width, height: d.height };
        const r = cleanupPage(img, { edges: true });
        roles.push(pageRole(readCode128(binarize(toGray(r.img)), r.img.width, r.img.height), r.blank));
      }
      return splitPages(roles, { atBlank: opts.atBlank, dropBlank: opts.atBlank });
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
  if (!groups) return;
  if (groups.length <= 1) {
    usePDFStore.getState().toast(opts.atBlank ? 'No blank pages or separator sheets were found.' : 'No separator sheets were found.', 'info');
    return;
  }
  await splitDocument(
    groups.map((g) => g.pages.map((i) => i + 1)),
    groups.map((g) => g.name),
  );
}

/** Split at the top-level bookmarks: each part starts at a bookmark and takes its title as name. */
export async function splitByBookmarks(): Promise<void> {
  const s = usePDFStore.getState();
  const tree = s.outline ?? (await (await import('@/lib/pdf/outlineTree')).toEditable(Object.values(s.sources), s.pages));
  const starts: Array<{ title: string; index: number }> = [];
  for (const b of tree) {
    const index = s.pages.findIndex((p) => p.id === b.pageId);
    if (index >= 0 && !starts.some((x) => x.index === index)) starts.push({ title: b.title, index });
  }
  starts.sort((a, b) => a.index - b.index);
  if (starts.length < 2 && !(starts.length === 1 && starts[0].index > 0)) {
    s.toast('The document needs at least two top-level bookmarks on different pages.', 'info');
    return;
  }
  const ranges: number[][] = [];
  const names: Array<string | null> = [];
  if (starts[0].index > 0) {
    ranges.push(Array.from({ length: starts[0].index }, (_, i) => i + 1));
    names.push(null);
  }
  starts.forEach((st, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : s.pages.length;
    ranges.push(Array.from({ length: end - st.index }, (_, i) => st.index + i + 1));
    names.push(st.title);
  });
  await splitDocument(ranges, names);
}

/** Split into parts of at most `maxMb` (a page larger than that is a part on its own). */
export async function splitBySize(maxMb: number): Promise<void> {
  const s = usePDFStore.getState();
  const limit = Math.max(0.1, maxMb) * 1024 * 1024;
  const sizes = await withBusy('Measuring the pages…', async (progress) => {
    const out: number[] = [];
    for (let i = 0; i < s.pages.length; i++) {
      progress(`Page ${i + 1} of ${s.pages.length}`, (i + 1) / s.pages.length);
      const page = s.pages[i];
      const bytes = await buildPdf(
        { sources: s.sources, pages: [page], objects: s.objects.filter((o) => o.pageId === page.id), fieldValues: s.fieldValues },
        { rasterizeRedactedPage: (p, r) => import('./document').then((m) => m.rasterizeWithRedactions(p, r)) },
      );
      out.push(bytes.length);
    }
    return out;
  });
  if (!sizes) return;
  // Shared fonts and images are counted once per page here, so the parts come out a little smaller than the limit.
  const ranges: number[][] = [];
  let cur: number[] = [];
  let total = 0;
  sizes.forEach((sz, i) => {
    if (cur.length && total + sz > limit) {
      ranges.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(i + 1);
    total += sz;
  });
  if (cur.length) ranges.push(cur);
  if (ranges.length === 1) {
    s.toast(`The whole document fits in ${maxMb} MB: nothing to split.`, 'info');
    return;
  }
  await splitDocument(ranges);
}

export async function splitDocument(ranges: number[][], names: Array<string | null> = []): Promise<void> {
  const s = usePDFStore.getState();
  const base = baseName();
  const outputs = await withBusy('Splitting…', async (progress) => {
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (let i = 0; i < ranges.length; i++) {
      progress(`Part ${i + 1} of ${ranges.length}`, i / ranges.length);
      const pages = ranges[i].map((n) => s.pages[n - 1]).filter((p) => !!p);
      const ids = new Set(pages.map((p) => p.id));
      const bytes = await buildPdf(
        { sources: s.sources, pages, objects: s.objects.filter((o) => ids.has(o.pageId)), fieldValues: s.fieldValues },
        { rasterizeRedactedPage: (p, r) => import('./document').then((m) => m.rasterizeWithRedactions(p, r)) },
      );
      const named = names[i]?.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
      files.push({ name: named ? `${named}.pdf` : `${base}-part${i + 1}.pdf`, bytes });
    }
    return files;
  });
  if (!outputs) return;
  if (outputs.length === 1) {
    await saveBytes(outputs[0].bytes, outputs[0].name, PDF_FILTER);
    return;
  }
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const f of outputs) zip.file(f.name, f.bytes);
  const blob = await zip.generateAsync({ type: 'blob' });
  const path = await saveBytes(blob, `${base}-split.zip`, [{ name: 'ZIP archive', extensions: ['zip'] }]);
  if (path) usePDFStore.getState().toast(`Split into ${outputs.length} files.`, 'success');
}

/** Parses "1-3, 5, 8-" style ranges (1-based, inclusive). */
export function parseRanges(input: string, pageCount: number): number[][] {
  const out: number[][] = [];
  for (const part of input.split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(t);
    let a: number;
    let b: number;
    if (m) {
      a = m[1] ? parseInt(m[1], 10) : 1;
      b = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(t)) {
      a = b = parseInt(t, 10);
    } else throw new Error(`“${t}” is not a page range.`);
    if (a < 1 || b > pageCount || a > b) throw new Error(`Range “${t}” is outside 1–${pageCount}.`);
    out.push(Array.from({ length: b - a + 1 }, (_, i) => a + i));
  }
  return out;
}

export { isDesktop, readFile };
