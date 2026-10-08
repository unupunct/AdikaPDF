/**
 * Scan to PDF: pages from the scanner (or pictures from files / a phone),
 * cleaned up (straightened, specks and dark edges removed, turned upright),
 * blank pages and separator sheets recognised, then one PDF or one PDF per
 * document — black and white pages as compact Group 4 images, optional OCR.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { deliverPdf } from './convert';
import { withBusy } from './document';
import { fileStamp, isDesktop, pickFiles, pickFolder, wiaScan, writeFile } from '@/lib/platform';
import { saveFileQuiet } from '@/actions/saveGuard';
import { imageFileToDataUrl } from '@/lib/objectFactory';
import { binarize, cleanupPage, toGray, type CleanupOptions, type Img } from '@/lib/scan/cleanup';
import { readCode128 } from '@/lib/barcode/code128';
import { buildScanPdf, pageRole, separatorSheet, splitPages, type PageRole, type ScanMode, type ScanOutPage } from '@/lib/scan/scanPdf';

export type ScanSource = 'flatbed' | 'feeder' | 'duplex';
export type PaperSize = 'auto' | 'a4' | 'a5' | 'letter' | 'legal';
export const PAPER_MM: Record<Exclude<PaperSize, 'auto'>, [number, number]> = { a4: [210, 297], a5: [148, 210], letter: [215.9, 279.4], legal: [215.9, 355.6] };

export interface ScanSettings {
  device: string;
  source: ScanSource;
  mode: ScanMode;
  dpi: number;
  paper: PaperSize;
}

export interface PageCleanup extends CleanupOptions {
  mode: ScanMode;
}

export interface ScanPageItem {
  id: string;
  /** The picture as scanned (kept so the cleanup can be changed). */
  original: Blob;
  /** Cleaned-up picture: JPEG (colour / grey) or PNG (black and white). */
  processed: Blob;
  thumb: string;
  width: number;
  height: number;
  dpi: number;
  mode: ScanMode;
  role: PageRole;
  rotated: number;
  skew: number;
  /** Extra quarter turns asked for by the user. */
  turns: number;
}

let seq = 0;

function canvasOf(img: Img): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

async function pixelsOf(blob: Blob): Promise<Img> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page.'))), type, q));

/** Cleans one page up and recognises blank pages and separator sheets. */
export async function processPage(original: Blob, dpi: number, cleanup: PageCleanup, turns = 0): Promise<Omit<ScanPageItem, 'id' | 'original'>> {
  let img = await pixelsOf(original);
  if (turns % 4) {
    const { rotateQuarter } = await import('@/lib/scan/cleanup');
    img = rotateQuarter(img, turns);
  }
  const r = cleanupPage(img, cleanup);
  let out = r.img;
  const gray = toGray(out);
  const bin = binarize(gray);
  const role = pageRole(readCode128(bin, out.width, out.height), r.blank);
  if (cleanup.mode !== 'color') {
    // Grey (or black and white, kept sharp) pictures.
    const d = new Uint8ClampedArray(out.data.length);
    for (let i = 0; i < gray.length; i++) {
      const v = cleanup.mode === 'bw' ? (bin[i] ? 0 : 255) : gray[i];
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    out = { data: d, width: out.width, height: out.height };
  }
  const c = canvasOf(out);
  const processed = cleanup.mode === 'bw' ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.82);
  const t = document.createElement('canvas');
  const k = 150 / Math.max(out.width, out.height);
  t.width = Math.max(1, Math.round(out.width * k));
  t.height = Math.max(1, Math.round(out.height * k));
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return { processed, thumb: t.toDataURL('image/jpeg', 0.7), width: out.width, height: out.height, dpi, mode: cleanup.mode, role, rotated: r.rotated, skew: r.skew, turns };
}

async function makeItem(original: Blob, dpi: number, cleanup: PageCleanup): Promise<ScanPageItem> {
  return { id: `scan-${++seq}`, original, ...(await processPage(original, dpi, cleanup)) };
}

/** Scans with the chosen scanner; returns the new pages. */
export async function scanPages(settings: ScanSettings, cleanup: PageCleanup): Promise<ScanPageItem[] | undefined> {
  const [wMm, hMm] = settings.paper === 'auto' ? [0, 0] : PAPER_MM[settings.paper];
  return withBusy(settings.source === 'flatbed' ? 'Scanning…' : 'Scanning the pages in the feeder…', async (progress) => {
    const raw = await wiaScan({ device: settings.device, dpi: settings.dpi, mode: settings.mode, source: settings.source, widthMm: wMm, heightMm: hMm });
    const out: ScanPageItem[] = [];
    for (let i = 0; i < raw.length; i++) {
      progress(`Cleaning up page ${i + 1} of ${raw.length}…`, (i + 1) / raw.length);
      out.push(await makeItem(new Blob([raw[i].slice().buffer as ArrayBuffer], { type: 'image/png' }), settings.dpi, cleanup));
    }
    return out;
  });
}

/** Pictures from files (phone photos, earlier scans) as pages. The resolution is guessed from an A4 width. */
export async function addPictures(cleanup: PageCleanup): Promise<ScanPageItem[] | undefined> {
  const files = await pickFiles([{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'heic', 'heif'] }], true);
  if (!files.length) return [];
  return withBusy('Adding the pictures…', async (progress) => {
    // Multi-page TIFF (a common scanner output) gives several pages.
    const blobs: Blob[] = [];
    for (const f of files) {
      if (/\.tiff?$/i.test(f.name)) {
        const { decodeTiff } = await import('@/lib/images');
        for (const p of decodeTiff(f.bytes)) blobs.push(await (await fetch(p.src)).blob());
      } else if (/\.(heic|heif)$/i.test(f.name)) {
        const { src } = await imageFileToDataUrl(f.bytes, f.name);
        blobs.push(await (await fetch(src)).blob());
      } else blobs.push(new Blob([f.bytes.slice().buffer as ArrayBuffer]));
    }
    const out: ScanPageItem[] = [];
    for (let i = 0; i < blobs.length; i++) {
      progress(`Cleaning up page ${i + 1} of ${blobs.length}…`, (i + 1) / blobs.length);
      const probe = await createImageBitmap(blobs[i]);
      // Resolution unknown: as if the short side were A4 wide.
      const dpi = Math.max(72, Math.round(Math.min(probe.width, probe.height) / 8.27));
      probe.close();
      out.push(await makeItem(blobs[i], dpi, cleanup));
    }
    return out;
  });
}

/** Re-applies the cleanup to every page (after changing the options). */
export async function reprocess(pages: ScanPageItem[], cleanup: PageCleanup): Promise<ScanPageItem[] | undefined> {
  return withBusy('Cleaning up the pages…', async (progress) => {
    const out: ScanPageItem[] = [];
    for (let i = 0; i < pages.length; i++) {
      progress(`Cleaning up page ${i + 1} of ${pages.length}…`, (i + 1) / pages.length);
      out.push({ ...pages[i], ...(await processPage(pages[i].original, pages[i].dpi, cleanup, pages[i].turns)) });
    }
    return out;
  });
}

export async function turnPage(p: ScanPageItem, cleanup: PageCleanup): Promise<ScanPageItem> {
  return { ...p, ...(await processPage(p.original, p.dpi, { ...cleanup, orient: false }, (p.turns + 1) % 4)) };
}

async function outPage(p: ScanPageItem): Promise<ScanOutPage> {
  if (p.mode === 'bw') {
    const img = await pixelsOf(p.processed);
    return { kind: 'bits', bits: binarize(toGray(img), 127), width: img.width, height: img.height, dpi: p.dpi };
  }
  return { kind: 'jpeg', bytes: new Uint8Array(await p.processed.arrayBuffer()), width: p.width, height: p.height, dpi: p.dpi };
}

export interface CreateOptions {
  /** Split at blank pages (separator sheets always split). */
  splitAtBlank: boolean;
  removeBlank: boolean;
  ocr: string | null;
  append: boolean;
}

/** Builds the PDF(s): one is opened; several are saved in a folder. */
export async function createScanPdfs(pages: ScanPageItem[], opts: CreateOptions): Promise<boolean> {
  const groups = splitPages(
    pages.map((p) => p.role),
    { atBlank: opts.splitAtBlank, dropBlank: opts.removeBlank },
  );
  if (!groups.length) {
    usePDFStore.getState().toast('There are no pages to save (only blank pages or separator sheets).', 'info');
    return false;
  }
  let folder: string | null = null;
  if (groups.length > 1 && isDesktop) {
    folder = await pickFolder();
    if (!folder) return false;
  }
  const docs = await withBusy('Creating the PDF…', async (progress) => {
    const out: Array<{ name: string; bytes: Uint8Array }> = [];
    for (let g = 0; g < groups.length; g++) {
      progress(groups.length > 1 ? `Creating document ${g + 1} of ${groups.length}…` : 'Creating the PDF…', g / groups.length);
      const name = groups[g].name ?? (groups.length > 1 ? `Scan ${g + 1}` : 'Scan');
      let bytes = await buildScanPdf(await Promise.all(groups[g].pages.map((i) => outPage(pages[i]))), { title: name });
      if (opts.ocr) {
        progress('Recognising text (OCR)…', null);
        const { ocrBytes } = await import('./batch');
        bytes = await ocrBytes(bytes, opts.ocr);
      }
      out.push({ name, bytes });
    }
    return out;
  });
  if (!docs) return false;
  if (docs.length === 1) {
    await deliverPdf(docs[0].bytes, `${docs[0].name}.pdf`, opts.append);
    return true;
  }
  const safe = (n: string) => n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'Scan';
  if (folder) {
    for (const d of docs) {
      let path = `${folder}\\${safe(d.name)}.pdf`;
      for (let n = 2; (await fileStamp(path)) !== null; n++) path = `${folder}\\${safe(d.name)} (${n}).pdf`;
      await writeFile(path, d.bytes);
    }
    usePDFStore.getState().toast(`${docs.length} PDF documents saved in ${folder}.`, 'success');
  } else {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    docs.forEach((d, i) => zip.file(`${String(i + 1).padStart(2, '0')} ${safe(d.name)}.pdf`, d.bytes));
    await saveFileQuiet(await zip.generateAsync({ type: 'uint8array' }), 'Scans.zip', [{ name: 'ZIP archive', extensions: ['zip'] }]);
  }
  return true;
}

/** Separator sheets to print: one per name (or one plain sheet). */
export async function saveSeparatorSheets(names: string[]): Promise<void> {
  const bytes = await separatorSheet(names.length ? names : [null as unknown as string]);
  await saveFileQuiet(bytes, 'Adika separator sheets.pdf', [{ name: 'PDF document', extensions: ['pdf'] }]);
}
