/**
 * One-click file tools (like iLovePDF / Foxit's tool hub): pick files →
 * convert → save. They work without opening a document; several files at
 * once are saved together as a ZIP.
 */
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { askPassword } from '@/store/useDialogs';
import { openPdfBytes, withBusy, PDF_FILTER } from './document';
import { IMAGE_EXTENSIONS, imagesToPdf, pickImagesAsDataUrls } from './convert';
import { openPdf, PasswordRequiredError, type PDFDocumentProxy } from '@/lib/pdf/pdfService';
import { officeToPdf, pickFiles, pickPaths, type PickedFile } from '@/lib/platform';
import { saveFileQuiet } from '@/actions/saveGuard';
import { exportPagesAsImages, exportToPptx, exportToXlsx, extractStructuredText } from '@/lib/pdf/convert';
import { collectDocxGraphics, exportToDocx } from '@/lib/pdf/docx';
import { layoutRows } from '@/lib/pdf/exportFormats';
import { compressPdf } from '@/lib/pdf/compress';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import { log } from '@/lib/log';

export type QuickToolId = 'pdf-word' | 'pdf-jpg' | 'word-pdf' | 'jpg-pdf' | 'merge' | 'pdf-ppt' | 'compress' | 'ppt-pdf' | 'pdf-excel' | 'excel-pdf';

export const QUICK_TOOLS: Array<{ id: QuickToolId; title: string; hint: string }> = [
  { id: 'pdf-word', title: 'PDF to Word', hint: 'Editable .docx that keeps fonts, layout, tables and images' },
  { id: 'pdf-jpg', title: 'PDF to JPG', hint: 'Every page as a JPG image' },
  { id: 'word-pdf', title: 'Word to PDF', hint: '.docx, .doc, .rtf, .odt via Microsoft Word' },
  { id: 'jpg-pdf', title: 'JPG to PDF', hint: 'Photos and scans (JPG, PNG, HEIC, TIFF…)' },
  { id: 'merge', title: 'Merge PDF', hint: 'Combine several PDFs in the order you choose' },
  { id: 'pdf-ppt', title: 'PDF to PPT', hint: 'One slide per page' },
  { id: 'compress', title: 'Compress PDF', hint: 'Smaller files, same text quality' },
  { id: 'ppt-pdf', title: 'PPT to PDF', hint: '.pptx, .ppt via Microsoft PowerPoint' },
  { id: 'pdf-excel', title: 'PDF to Excel', hint: 'Tables into spreadsheet cells' },
  { id: 'excel-pdf', title: 'Excel to PDF', hint: '.xlsx, .xls, .csv via Microsoft Excel' },
];

const baseOf = (name: string) => name.replace(/\.[^.]+$/, '');

/** Opens a picked PDF with pdf.js, asking for its password when needed. */
async function openForConversion(f: PickedFile): Promise<PDFDocumentProxy | null> {
  let password: string | undefined;
  for (;;) {
    try {
      return await openPdf(f.bytes, password);
    } catch (e) {
      if (e instanceof PasswordRequiredError) {
        const pw = await askPassword(f.name, e.incorrect);
        if (pw === null) return null;
        password = pw;
        continue;
      }
      throw e;
    }
  }
}

interface Output {
  name: string;
  data: Blob | Uint8Array;
}

/** Saves one output directly, or several as a ZIP. Returns the saved path. */
async function saveOutputs(outputs: Output[], zipName: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (outputs.length === 0) return null;
  if (outputs.length === 1) return saveFileQuiet(outputs[0].data, outputs[0].name, [filter]);
  const zip = new JSZip();
  for (const o of outputs) zip.file(o.name, o.data);
  return saveFileQuiet(await zip.generateAsync({ type: 'blob' }), zipName, [{ name: 'ZIP archive', extensions: ['zip'] }]);
}

function done(path: string | null, summary: string): void {
  if (!path) return;
  const s = usePDFStore.getState();
  s.toast(path === 'downloaded' ? `${summary} Downloaded.` : `${summary} Saved to ${path}`, 'success');
  log('info', `Quick tool: ${summary} → ${path}`);
}

// ------------------------------------------------------------------ from PDF

async function fromPdf(kind: 'docx' | 'jpg' | 'pptx' | 'xlsx'): Promise<void> {
  const files = await pickFiles(PDF_FILTER, true);
  if (files.length === 0) return;
  const label = { docx: 'Word', jpg: 'JPG', pptx: 'PowerPoint', xlsx: 'Excel' }[kind];
  const outputs = await withBusy(`Converting to ${label}…`, async (progress) => {
    const out: Output[] = [];
    for (let n = 0; n < files.length; n++) {
      const f = files[n];
      const tick = (done: number, total: number) => progress(`${f.name}: ${done}/${total}`, (n + (total ? done / total : 0)) / files.length);
      const pdf = await openForConversion(f);
      if (!pdf) continue;
      try {
        const base = baseOf(f.name);
        if (kind === 'jpg') {
          out.push({ name: `${base}-jpg.zip`, data: await exportPagesAsImages(pdf, { format: 'jpeg', dpi: 150, quality: 0.9 }, tick) });
        } else {
          const text = await extractStructuredText(pdf, tick, { detectBold: true });
          if (kind === 'docx') out.push({ name: `${base}.docx`, data: await exportToDocx(text, base, { graphics: await collectDocxGraphics(pdf, text, tick) }) });
          if (kind === 'xlsx') {
            const rows = layoutRows(text, await collectDocxGraphics(pdf, text, tick));
            out.push({ name: `${base}.xlsx`, data: await exportToXlsx(text, text.map((p) => rows.filter((r) => r.pageNumber === p.pageNumber).map((r) => r.cells))) });
          }
          if (kind === 'pptx') out.push({ name: `${base}.pptx`, data: await exportToPptx(pdf, text, { dpi: 150, title: base }, tick) });
        }
      } finally {
        await pdf.loadingTask.destroy().catch(() => undefined);
      }
    }
    return out;
  });
  if (!outputs?.length) return;
  const ext = kind === 'jpg' ? 'zip' : kind;
  const path = await saveOutputs(outputs, `converted-${kind}.zip`, { name: label, extensions: [ext] });
  done(path, `Converted ${outputs.length} file${outputs.length > 1 ? 's' : ''} to ${label}.`);
}

// ------------------------------------------------------------------ to PDF

const OFFICE_KINDS = {
  word: { label: 'Word', extensions: ['docx', 'doc', 'docm', 'dotx', 'rtf', 'odt'] },
  ppt: { label: 'PowerPoint', extensions: ['pptx', 'ppt', 'pptm', 'ppsx', 'pps', 'odp'] },
  excel: { label: 'Excel', extensions: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'ods'] },
} as const;

async function officeToPdfTool(kind: keyof typeof OFFICE_KINDS): Promise<void> {
  const info = OFFICE_KINDS[kind];
  const paths = await pickPaths([{ name: `${info.label} documents`, extensions: [...info.extensions] }], true);
  if (paths.length === 0) return;
  const outputs = await withBusy(`Converting with Microsoft ${info.label}…`, async (progress) => {
    const out: Output[] = [];
    for (let n = 0; n < paths.length; n++) {
      const name = paths[n].split(/[\\/]/).pop() ?? paths[n];
      progress(`${name} (${n + 1}/${paths.length})`, n / paths.length);
      out.push({ name: `${baseOf(name)}.pdf`, data: await officeToPdf(paths[n]) });
    }
    return out;
  });
  await saveAndOpen(outputs, `converted-${kind}.zip`, `${info.label} to PDF`);
}

async function saveAndOpen(outputs: Output[] | undefined, zipName: string, what: string): Promise<void> {
  if (!outputs?.length) return;
  const path = await saveOutputs(outputs, zipName, { name: 'PDF documents', extensions: ['pdf'] });
  done(path, `${what}: ${outputs.length} file${outputs.length > 1 ? 's' : ''}.`);
  // A single result opens in a new tab, ready to review.
  if (path && path !== 'downloaded' && outputs.length === 1) {
    const data = outputs[0].data;
    await openPdfBytes(data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()), path.split(/[\\/]/).pop() ?? outputs[0].name, path);
  }
}

async function imagesToPdfTool(): Promise<void> {
  const images = await pickImagesAsDataUrls();
  if (images.length === 0) return;
  const outputs = await withBusy('Creating PDF from images…', async () => [
    { name: `${baseOf(images[0].name)}.pdf`, data: await imagesToPdf(images, { pageSize: 'a4', orientation: 'auto', marginMm: 10 }) },
  ]);
  await saveAndOpen(outputs, 'images.zip', 'Images to PDF');
}

/** Merges PDFs in the given order (ToolsModal lets the user reorder first). */
export async function mergeFiles(files: PickedFile[]): Promise<void> {
  if (files.length < 2) {
    usePDFStore.getState().toast('Choose at least two PDFs to merge.', 'info');
    return;
  }
  const locked = files.filter((f) => isPdfEncrypted(f.bytes));
  if (locked.length) {
    usePDFStore.getState().toast(`Password-protected files cannot be merged: ${locked.map((f) => f.name).join(', ')}.`, 'error');
    return;
  }
  const outputs = await withBusy('Merging…', async (progress) => {
    const out = await PDFDocument.create();
    for (let n = 0; n < files.length; n++) {
      progress(`Adding ${files[n].name}`, n / files.length);
      const src = await PDFDocument.load(files[n].bytes);
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    }
    out.setProducer('Adika PDF Editor');
    return [{ name: `${baseOf(files[0].name)}-merged.pdf`, data: await out.save() }];
  });
  await saveAndOpen(outputs, 'merged.zip', `Merged ${files.length} PDFs`);
}

export async function pickPdfsForMerge(): Promise<PickedFile[]> {
  return pickFiles(PDF_FILTER, true);
}

async function compressTool(): Promise<void> {
  const files = await pickFiles(PDF_FILTER, true);
  if (files.length === 0) return;
  let before = 0;
  let after = 0;
  const outputs = await withBusy('Compressing…', async (progress) => {
    const out: Output[] = [];
    for (let n = 0; n < files.length; n++) {
      progress(`${files[n].name} (${n + 1}/${files.length})`, n / files.length);
      if (isPdfEncrypted(files[n].bytes)) throw new Error(`${files[n].name} is password-protected; remove the password first.`);
      const r = await compressPdf(files[n].bytes, { imageQuality: 0.72, maxImageDpi: 150, stripMetadata: true });
      before += r.before;
      after += r.after;
      out.push({ name: `${baseOf(files[n].name)}-compressed.pdf`, data: r.bytes });
    }
    return out;
  });
  if (!outputs?.length) return;
  const saved = before ? Math.round((1 - after / before) * 100) : 0;
  const path = await saveOutputs(outputs, 'compressed.zip', { name: 'PDF documents', extensions: ['pdf'] });
  done(path, saved > 0 ? `Compressed ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB (−${saved}%).` : 'These PDFs were already well optimised.');
}

/** Runs a tool (merge needs its own ordering step in the modal). */
export async function runQuickTool(id: Exclude<QuickToolId, 'merge'>): Promise<void> {
  switch (id) {
    case 'pdf-word':
      return fromPdf('docx');
    case 'pdf-jpg':
      return fromPdf('jpg');
    case 'pdf-ppt':
      return fromPdf('pptx');
    case 'pdf-excel':
      return fromPdf('xlsx');
    case 'word-pdf':
      return officeToPdfTool('word');
    case 'ppt-pdf':
      return officeToPdfTool('ppt');
    case 'excel-pdf':
      return officeToPdfTool('excel');
    case 'jpg-pdf':
      return imagesToPdfTool();
    case 'compress':
      return compressTool();
  }
}

export { IMAGE_EXTENSIONS };
