/**
 * PDF Portfolios (PDF collections, ISO 32000 §12.3.5): one PDF that carries
 * several files of any kind, listed by name, description, size and date in
 * Acrobat, Foxit and Adika. The cover page lists the files too, for readers
 * that show only pages. Pure.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream, rgb, type PDFFont, type PDFObject } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';
import type { FontVariant } from '@/lib/fonts';

export interface PortfolioFile {
  name: string;
  bytes: Uint8Array;
  description?: string;
  modified?: Date;
  mime?: string;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  zip: 'application/zip',
  eml: 'message/rfc822',
  html: 'text/html',
  md: 'text/markdown',
};

export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export interface PortfolioLabels {
  title: string;
  intro: string;
  name: string;
  size: string;
  modified: string;
  description: string;
}

export const PORTFOLIO_EN: PortfolioLabels = {
  title: 'PDF Portfolio',
  intro: 'This PDF Portfolio contains the files below. Open it in Adika PDF Editor, Adobe Acrobat or Foxit to see and open them, or use the attachments panel of your PDF reader.',
  name: 'Name',
  size: 'Size',
  modified: 'Modified',
  description: 'Description',
};

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function createPortfolio(files: PortfolioFile[], o: { title: string; loadFont: (v: FontVariant) => Promise<Uint8Array>; labels?: PortfolioLabels; locale?: string }): Promise<Uint8Array> {
  if (!files.length) throw new Error('Add at least one file to the portfolio.');
  const L = o.labels ?? PORTFOLIO_EN;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const used = [o.title, JSON.stringify(L), ...files.map((f) => `${f.name} ${f.description ?? ''}`), '0123456789 .,:;-–—−+%/()[]#…•·?*€$£RON'];
  const reg = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: false, italic: false }), used);
  const bold = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: true, italic: false }), used);
  const safe = (f: PDFFont, s: string) => {
    const set = f.getCharacterSet();
    return [...s].map((c) => (set.includes(c.codePointAt(0)!) ? c : '?')).join('');
  };
  const fit = (f: PDFFont, s: string, size: number, w: number) => {
    let t = safe(f, s);
    if (f.widthOfTextAtSize(t, size) <= w) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > w) t = t.slice(0, -1);
    return `${t}…`;
  };
  const wrap = (s: string, size: number, w: number) => {
    const out: string[] = [];
    let line = '';
    for (const word of safe(reg, s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (reg.widthOfTextAtSize(next, size) > w && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const dateF = new Intl.DateTimeFormat(o.locale ?? 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const [W, H] = [595.28, 841.89];
  let page = doc.addPage([W, H]);
  let y = H - 60;
  page.drawText(safe(bold, o.title || L.title), { x: 50, y, size: 22, font: bold, color: rgb(0.1, 0.12, 0.16) });
  y -= 26;
  for (const l of wrap(L.intro, 10, W - 100)) {
    page.drawText(l, { x: 50, y, size: 10, font: reg, color: rgb(0.4, 0.43, 0.48) });
    y -= 13;
  }
  y -= 16;
  const cols = { name: 50, size: 330, date: 400, desc: 470 };
  const header = () => {
    page.drawRectangle({ x: 46, y: y - 5, width: W - 92, height: 18, color: rgb(0.11, 0.33, 0.66) });
    const w = rgb(1, 1, 1);
    page.drawText(safe(bold, L.name), { x: cols.name, y, size: 9, font: bold, color: w });
    page.drawText(safe(bold, L.size), { x: cols.size, y, size: 9, font: bold, color: w });
    page.drawText(safe(bold, L.modified), { x: cols.date, y, size: 9, font: bold, color: w });
    page.drawText(safe(bold, L.description), { x: cols.desc, y, size: 9, font: bold, color: w });
    y -= 20;
  };
  header();
  files.forEach((f, i) => {
    if (y < 60) {
      page = doc.addPage([W, H]);
      y = H - 60;
      header();
    }
    if (i % 2) page.drawRectangle({ x: 46, y: y - 5, width: W - 92, height: 17, color: rgb(0.95, 0.96, 0.98) });
    page.drawText(fit(reg, f.name, 9.5, cols.size - cols.name - 8), { x: cols.name, y, size: 9.5, font: reg });
    page.drawText(kb(f.bytes.length), { x: cols.size, y, size: 9, font: reg, color: rgb(0.4, 0.43, 0.48) });
    if (f.modified) page.drawText(safe(reg, dateF.format(f.modified)), { x: cols.date, y, size: 9, font: reg, color: rgb(0.4, 0.43, 0.48) });
    if (f.description) page.drawText(fit(reg, f.description, 9, W - 50 - cols.desc), { x: cols.desc, y, size: 9, font: reg });
    y -= 17;
  });
  for (const f of files)
    await doc.attach(f.bytes, f.name, { mimeType: f.mime ?? mimeOf(f.name), description: f.description || undefined, creationDate: f.modified, modificationDate: f.modified });
  // The collection: details view sorted by name, with a description and size column.
  const ctx = doc.context;
  const field = (subtype: string, label: string, order: number) => ctx.obj({ Type: 'CollectionField', Subtype: subtype, N: PDFHexString.fromText(label), O: order, V: true, E: false });
  const collection = ctx.obj({
    Type: 'Collection',
    Schema: ctx.obj({ Type: 'CollectionSchema', FileName: field('F', L.name, 1), Desc: field('Desc', L.description, 2), Size: field('Size', L.size, 3), ModDate: field('ModDate', L.modified, 4) }),
    View: 'D',
    Sort: ctx.obj({ Type: 'CollectionSort', S: 'FileName', A: true }),
  });
  doc.catalog.set(PDFName.of('Collection'), ctx.register(collection));
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseAttachments'));
  doc.setTitle(o.title || L.title);
  doc.setProducer('Adika PDF Editor');
  return doc.save();
}

export interface PortfolioEntry {
  name: string;
  description: string;
  size: number;
  modified: Date | null;
  bytes: Uint8Array;
}

function pdfDate(s: string): Date | null {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
}

const str = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '');

/** The files of a PDF Portfolio, or null when the PDF is not one. */
export async function readPortfolio(bytes: Uint8Array): Promise<PortfolioEntry[] | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return null;
  }
  if (!doc.catalog.lookup(PDFName.of('Collection'))) return null;
  const out: PortfolioEntry[] = [];
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const visit = (node: PDFObject | undefined, depth = 0) => {
    if (!(node instanceof PDFDict) || depth > 20) return;
    const arr = node.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const spec = arr.lookup(i + 1);
        if (!(spec instanceof PDFDict)) continue;
        const ef = spec.lookup(PDFName.of('EF'));
        const stream = ef instanceof PDFDict ? (ef.lookup(PDFName.of('UF')) ?? ef.lookup(PDFName.of('F'))) : undefined;
        if (!(stream instanceof PDFRawStream)) continue;
        let content: Uint8Array;
        try {
          content = decodePDFRawStream(stream).decode();
        } catch {
          continue;
        }
        const params = stream.dict.lookup(PDFName.of('Params'));
        const mod = params instanceof PDFDict ? str(params.lookup(PDFName.of('ModDate'))) : '';
        out.push({ name: str(spec.lookup(PDFName.of('UF'))) || str(spec.lookup(PDFName.of('F'))) || str(arr.lookup(i)), description: str(spec.lookup(PDFName.of('Desc'))), size: content.length, modified: mod ? pdfDate(mod) : null, bytes: content });
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i), depth + 1);
  };
  visit(names instanceof PDFDict ? names.lookup(PDFName.of('EmbeddedFiles')) : undefined);
  return out;
}
