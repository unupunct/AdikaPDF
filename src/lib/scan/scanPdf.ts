/**
 * Scanned pages to PDF: colour and grey pages as JPEG, black-and-white
 * pages as CCITT Group 4 (a fraction of the size); page size from the scan
 * resolution. Splitting a batch at blank pages or Adika separator sheets,
 * and the printable separator sheet itself.
 */
import { PDFDocument, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib';
import { encodeG4 } from './ccitt';
import { encodeModules } from '@/lib/barcode/code128';

export type ScanMode = 'color' | 'gray' | 'bw';

export type ScanOutPage =
  | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number; dpi: number }
  /** 1 byte per pixel, 1 = black. */
  | { kind: 'bits'; bits: Uint8Array; width: number; height: number; dpi: number };

export async function buildScanPdf(pages: ScanOutPage[], meta: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer('Adika PDF Editor');
  doc.setCreator('Adika PDF Editor');
  if (meta.title) doc.setTitle(meta.title);
  for (const p of pages) {
    const wPt = (p.width / p.dpi) * 72;
    const hPt = (p.height / p.dpi) * 72;
    const page = doc.addPage([wPt, hPt]);
    if (p.kind === 'jpeg') {
      const img = await doc.embedJpg(p.bytes);
      page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    } else {
      const ref = doc.context.register(
        doc.context.stream(encodeG4(p.bits, p.width, p.height), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: p.width,
          Height: p.height,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 1,
          Filter: 'CCITTFaxDecode',
          DecodeParms: { K: -1, Columns: p.width, Rows: p.height, BlackIs1: false },
        }),
      );
      const name = page.node.newXObject('Scan', ref);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(wPt, 0, 0, hPt, 0, 0), drawObject(name), popGraphicsState());
    }
  }
  return doc.save({ useObjectStreams: true });
}

/** What a scanned page is for splitting: content, a blank page, or a separator sheet (with an optional name). */
export type PageRole = { kind: 'content' } | { kind: 'blank' } | { kind: 'separator'; name: string | null };

export const SEPARATOR_PREFIX = 'ADIKA:SPLIT';

/** The role of a page from the barcodes found on it and whether it is blank. */
export function pageRole(barcodes: string[], blank: boolean): PageRole {
  const sep = barcodes.find((b) => b === SEPARATOR_PREFIX || b.startsWith(`${SEPARATOR_PREFIX}:`));
  if (sep !== undefined) return { kind: 'separator', name: sep.length > SEPARATOR_PREFIX.length + 1 ? sep.slice(SEPARATOR_PREFIX.length + 1) : null };
  return blank ? { kind: 'blank' } : { kind: 'content' };
}

/**
 * Groups page indices into documents. Separator sheets always split (and
 * name the document after them); blank pages split when `atBlank`, and are
 * dropped when `dropBlank` (or when they split). Empty groups are skipped.
 */
export function splitPages(roles: PageRole[], opts: { atBlank: boolean; dropBlank: boolean }): Array<{ name: string | null; pages: number[] }> {
  const out: Array<{ name: string | null; pages: number[] }> = [];
  let cur: { name: string | null; pages: number[] } = { name: null, pages: [] };
  const flush = () => {
    if (cur.pages.length) out.push(cur);
  };
  roles.forEach((r, i) => {
    if (r.kind === 'separator') {
      flush();
      cur = { name: r.name, pages: [] };
    } else if (r.kind === 'blank' && opts.atBlank) {
      flush();
      cur = { name: null, pages: [] };
    } else if (r.kind === 'blank' && opts.dropBlank) {
      /* dropped */
    } else cur.pages.push(i);
  });
  flush();
  return out;
}

export function asciiName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim()
    .slice(0, 60);
}

/** A printable separator sheet: put it before each document in the feeder. */
export async function separatorSheet(names: Array<string | null>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const small = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Adika separator sheets');
  for (const raw of names.length ? names : [null]) {
    // Code 128 carries ASCII only: ă â î ș ț become a a i s t.
    const name = raw ? asciiName(raw) : null;
    const page = doc.addPage([595.28, 841.89]);
    const text = name ? `${SEPARATOR_PREFIX}:${name}` : SEPARATOR_PREFIX;
    const mods = encodeModules(text);
    const module = Math.min(1.8, 480 / mods.length);
    const width = mods.length * module;
    const x0 = (595.28 - width) / 2;
    for (const y of [560, 180]) {
      mods.forEach((bar, i) => {
        if (bar) page.drawRectangle({ x: x0 + i * module, y, width: module, height: 110, color: rgb(0, 0, 0) });
      });
    }
    const title = 'SEPARATOR';
    page.drawText(title, { x: (595.28 - font.widthOfTextAtSize(title, 44)) / 2, y: 740, size: 44, font });
    const label = name ? `Next document: ${name}` : 'A new document starts after this sheet.';
    page.drawText(label, { x: (595.28 - small.widthOfTextAtSize(label, 16)) / 2, y: 700, size: 16, font: small });
    const hint = 'Adika PDF Editor removes this page when it splits the scan.';
    page.drawText(hint, { x: (595.28 - small.widthOfTextAtSize(hint, 11)) / 2, y: 120, size: 11, font: small, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}
