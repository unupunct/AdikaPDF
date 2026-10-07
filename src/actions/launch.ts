/**
 * What Explorer starts Adika for (its context menu, "Open with", a second
 * launch while Adika runs): open files, combine the selected PDFs into one
 * document, or convert a file (Office, pictures, e-mails…) to PDF.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { readFile, officeToPdf } from '@/lib/platform';
import { openPdfPath, withBusy } from './document';

export interface LaunchRequest {
  action: 'open' | 'combine' | 'convert';
  files: string[];
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

// Explorer starts one process per selected file: the launches that arrive within a moment are combined together.
let combineQueue: string[] = [];
let combineTimer: ReturnType<typeof setTimeout> | null = null;

async function combineNow(): Promise<void> {
  const files = [...new Set(combineQueue)].sort((a, b) => base(a).localeCompare(base(b), undefined, { numeric: true }));
  combineQueue = [];
  if (!files.length) return;
  if (!(await openPdfPath(files[0]))) return;
  if (files.length === 1) return;
  await withBusy('Combining PDFs…', async (progress) => {
    for (let i = 1; i < files.length; i++) {
      progress(`Adding ${base(files[i])} (${i + 1}/${files.length})…`, i / files.length);
      await usePDFStore.getState().mergeDocument(await readFile(files[i]), base(files[i]));
    }
  });
  usePDFStore.setState({ dirty: true, filePath: null, fileName: `${base(files[0]).replace(/\.pdf$/i, '')}-combined.pdf` });
  usePDFStore.getState().toast(`Combined ${files.length} PDFs. Save to keep the new document.`, 'success');
}

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

async function convertFile(path: string): Promise<void> {
  const name = base(path);
  if (/\.(pdf)$/i.test(name)) {
    await openPdfPath(path);
    return;
  }
  if (/\.(xml|zip)$/i.test(name)) {
    await openPdfPath(path);
    return;
  }
  if (OFFICE.test(name)) {
    const bytes = await withBusy(`Converting ${name}…`, () => officeToPdf(path));
    if (bytes) await (await import('./convert')).deliverPdf(bytes, name, false);
    return;
  }
  // Pictures, e-mails, e-books, XPS, web pages, DXF: always a new PDF (not added to the open document).
  const bytes = await readFile(path);
  const convert = await import('./convert');
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const pdf = await withBusy(`Converting ${name}…`, async () => {
    if (convert.IMAGE_EXTENSIONS.includes(ext)) {
      const [{ decodeTiff }, { imageFileToDataUrl }] = await Promise.all([import('@/lib/images'), import('@/lib/objectFactory')]);
      const images = /^tiff?$/.test(ext) ? decodeTiff(bytes) : [await imageFileToDataUrl(bytes, name)];
      return convert.imagesToPdf(images, { pageSize: 'a4', orientation: 'auto', marginMm: 10 });
    }
    const text = convert.textKind(name);
    if (text) return convert.textLikeToPdf(bytes, name, path, text, { pageSize: 'A4', landscape: false, marginMm: 15 });
    if (ext === 'dxf') {
      const [{ DXF_DEFAULT_OPTIONS, decodeDxf, dxfToPdf }, { loadFontBytes }] = await Promise.all([import('@/lib/pdf/dxf'), import('@/lib/fonts')]);
      return (await dxfToPdf(decodeDxf(bytes), { ...DXF_DEFAULT_OPTIONS, loadFont: () => loadFontBytes({ family: 'sans', bold: false, italic: false }) })).bytes;
    }
    return (await convert.documentToPdf(bytes, name, { pageSize: 'A4', landscape: false, marginMm: 15 })).bytes;
  });
  if (pdf) await convert.deliverPdf(pdf, name, false);
}

export async function handleLaunch(req: LaunchRequest): Promise<void> {
  if (!req.files.length) return;
  if (req.action === 'combine') {
    combineQueue.push(...req.files);
    if (combineTimer) clearTimeout(combineTimer);
    combineTimer = setTimeout(() => void combineNow(), 1200);
    return;
  }
  for (const f of req.files) {
    if (req.action === 'convert') await convertFile(f);
    else await openPdfPath(f);
  }
}
