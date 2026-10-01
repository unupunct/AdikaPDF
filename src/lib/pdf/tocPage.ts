/**
 * A table-of-contents page made from the bookmarks: titles indented by
 * level, dot leaders and page numbers; the caller turns each entry's box
 * into a link. The number of contents pages is known before the page
 * numbers are written, so they are right once the pages are inserted. Pure.
 */
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';
import type { FontVariant } from '@/lib/fonts';

export interface TocEntry {
  title: string;
  level: number;
  /** Page index (0-based) of the target in the document before the contents pages are added. */
  target: number;
}

export interface TocOptions {
  title: string;
  loadFont: (v: FontVariant) => Promise<Uint8Array>;
  size?: [number, number];
  /** Deepest bookmark level to list (0 = top level only). */
  maxLevel?: number;
  /** Page label for a final page index (default: index + 1). */
  label?: (finalIndex: number) => string;
}

export interface TocResult {
  bytes: Uint8Array;
  pageCount: number;
  /** One per listed entry: the contents page it is on and its box (top-left origin, points). */
  links: Array<{ page: number; x: number; y: number; width: number; height: number; entry: number }>;
}

const MARGIN = 56;
const LINE = 17;
const TITLE_SPACE = 64;

export function tocPageCount(entries: number, height: number): number {
  const first = Math.floor((height - 2 * MARGIN - TITLE_SPACE) / LINE);
  const rest = Math.floor((height - 2 * MARGIN) / LINE);
  if (entries <= first) return 1;
  return 1 + Math.ceil((entries - first) / rest);
}

export async function buildTocPdf(all: TocEntry[], o: TocOptions): Promise<TocResult> {
  const [W, H] = o.size ?? [595.28, 841.89];
  const entries = all.map((e, i) => ({ ...e, i })).filter((e) => e.level <= (o.maxLevel ?? 2));
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const used = [o.title, ...entries.map((e) => e.title), '0123456789 .,:;-–—−+%/()[]#…•·?*€$£RON'];
  const reg = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: false, italic: false }), used);
  const bold = await embedFontForText(doc, await o.loadFont({ family: 'sans', bold: true, italic: false }), used);
  const pageCount = tocPageCount(entries.length, H);
  const label = o.label ?? ((i: number) => String(i + 1));
  const safe = (f: PDFFont, s: string) => {
    const set = f.getCharacterSet();
    return [...s.replace(/\s+/g, ' ').trim()].map((c) => (set.includes(c.codePointAt(0)!) ? c : '?')).join('');
  };
  const links: TocResult['links'] = [];
  let page = doc.addPage([W, H]);
  let pageNo = 0;
  page.drawText(safe(bold, o.title), { x: MARGIN, y: H - MARGIN - 22, size: 22, font: bold, color: rgb(0.1, 0.12, 0.16) });
  let y = H - MARGIN - TITLE_SPACE;
  for (const e of entries) {
    if (y < MARGIN) {
      page = doc.addPage([W, H]);
      pageNo++;
      y = H - MARGIN;
    }
    const f = e.level === 0 ? bold : reg;
    const size = e.level === 0 ? 11.5 : 10.5;
    const x = MARGIN + e.level * 16;
    const num = label(e.target + pageCount);
    const numW = reg.widthOfTextAtSize(num, size);
    const right = W - MARGIN;
    const room = right - numW - 14 - x;
    let t = safe(f, e.title) || '—';
    if (f.widthOfTextAtSize(t, size) > room) {
      while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > room) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const tw = f.widthOfTextAtSize(t, size);
    page.drawText(t, { x, y, size, font: f, color: rgb(0.1, 0.12, 0.16) });
    // Dot leaders between the title and the number.
    const dot = reg.widthOfTextAtSize('. ', size);
    const dots = Math.max(0, Math.floor((right - numW - 6 - (x + tw + 6)) / dot));
    if (dots > 0) page.drawText('. '.repeat(dots), { x: right - numW - 6 - dots * dot + reg.widthOfTextAtSize(' ', size), y, size, font: reg, color: rgb(0.6, 0.62, 0.66) });
    page.drawText(num, { x: right - numW, y, size, font: reg, color: rgb(0.1, 0.12, 0.16) });
    links.push({ page: pageNo, x, y: H - y - size, width: right - x, height: size + 5, entry: e.i });
    y -= LINE;
  }
  doc.setTitle(o.title);
  return { bytes: await doc.save(), pageCount: doc.getPageCount(), links };
}
