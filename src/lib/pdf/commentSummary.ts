/**
 * "Summarize comments": lists every markup comment of a document in a new A4
 * PDF, like Acrobat's comment summary:
 *  - a title block (title, document name, date, number of comments),
 *  - per page with comments a "Page N" heading, an optional small image of
 *    the page with numbered markers (left) and the numbered comments (right):
 *    type, author, date, the marked text of text markups and the comment text.
 * Text is wrapped to the column and flows onto new pages. Noto fonts are
 * embedded in full, so any Latin/Greek/Cyrillic text (ă â î ș ț …) prints.
 *
 * The pdf.js document comes from the caller (browser build in the app, the
 * legacy build in node tests); page images come from an optional callback.
 */
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type Color } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export type LoadFont = (v: { family: 'sans' | 'serif' | 'mono'; bold: boolean; italic: boolean }) => Promise<Uint8Array>;

export interface PageImage {
  bytes: Uint8Array;
  type: 'png' | 'jpg';
  /** Pixel size (only the aspect ratio matters). */
  width: number;
  height: number;
}

export interface SummarizeOptions {
  /** Heading of the summary (default "Comment summary"). */
  title?: string;
  /** File name shown under the title (default: the document's Title metadata). */
  documentName?: string;
  /**
   * Renders page `pageNumber` (1-based) at most `maxWidth` pixels wide (twice
   * the thumbnail width in points, for a sharp print). null → no image.
   */
  renderPage?: (pageNumber: number, maxWidth: number) => Promise<PageImage | null>;
}

/** One comment as listed in the summary. */
export interface SummaryComment {
  page: number;
  subtype: string;
  /** Human name: Note, Highlight, Text box… */
  type: string;
  author: string;
  date: Date | null;
  contents: string;
  /** Text under a text markup (highlight, underline…), if any. */
  markedText: string;
  /** Top-left corner in top-left viewport coordinates (scale 1). */
  at: [number, number];
  isReply: boolean;
}

const TYPE_NAMES: Record<string, string> = {
  Text: 'Note',
  FreeText: 'Text box',
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strikethrough',
  Squiggly: 'Squiggly underline',
  Square: 'Rectangle',
  Circle: 'Oval',
  Line: 'Line',
  Polygon: 'Polygon',
  PolyLine: 'Polyline',
  Ink: 'Drawing',
  Stamp: 'Stamp',
  Caret: 'Insert text',
  FileAttachment: 'File attachment',
};

const TEXT_MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

// A4 portrait, points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;
const FOOTER = 30;
const THUMB_W = 150;
const THUMB_MAX_H = 230;
const GUTTER = 16;

const DARK = rgb(0.13, 0.13, 0.13);
const GREY = rgb(0.42, 0.42, 0.42);
const ACCENT = rgb(0.16, 0.39, 0.75);

// ------------------------------------------------------------------ reading

/** Parses a PDF date (D:YYYYMMDDHHmmSSOHH'mm', trailing parts optional). */
export function parsePdfDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s.trim());
  if (!m) return null;
  const n = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);
  const [year, month, day, hour, min, sec] = [n(m[1], 0), n(m[2], 1), n(m[3], 1), n(m[4], 0), n(m[5], 0), n(m[6], 0)];
  if (!m[7]) return new Date(year, month - 1, day, hour, min, sec);
  let t = Date.UTC(year, month - 1, day, hour, min, sec);
  if (m[7] === '+' || m[7] === '-') {
    const off = (n(m[8], 0) * 60 + n(m[9], 0)) * 60_000;
    t += m[7] === '+' ? -off : off;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** dd.mm.yyyy HH:mm in local time. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Control characters out, tabs to spaces, line breaks normalised to \n. */
function clean(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f﻿]/g, '')
    .normalize('NFC');
}

/** Text under the quads (user space bboxes, 8 numbers each) of a text markup, estimated per character. */
function markedText(items: TextItem[], quads: ArrayLike<number>): string {
  const boxes: Array<[number, number, number, number]> = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  const inside = (x: number, y: number) => boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  const parts: string[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const [a, b, c, d, e, f] = it.transform;
    const along = Math.hypot(a, b) || 1;
    const size = Math.hypot(c, d) || along;
    const dx = a / along;
    const dy = b / along;
    const n = it.str.length;
    // Character positions are proportional estimates, so whole words are
    // taken when most of their characters fall inside a quad.
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    const words: string[] = [];
    while ((m = re.exec(it.str))) {
      let hits = 0;
      for (let k = m.index; k < m.index + m[0].length; k++) {
        // Centre of character k, a third of the font size above the baseline.
        const u = (it.width * (k + 0.5)) / n;
        if (inside(e + dx * u - dy * size * 0.35, f + dy * u + dx * size * 0.35)) hits++;
      }
      if (hits * 2 >= m[0].length) words.push(m[0]);
    }
    if (words.length) parts.push(words.join(' '));
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

interface RawAnnotation {
  id: string;
  subtype: string;
  rect: number[];
  contentsObj?: { str: string };
  titleObj?: { str: string };
  modificationDate?: string | null;
  creationDate?: string | null;
  inReplyTo?: string | null;
  replyType?: string;
  quadPoints?: ArrayLike<number> | null;
}

async function pageComments(page: PDFPageProxy, pageNumber: number): Promise<SummaryComment[]> {
  const annots = (await page.getAnnotations()) as RawAnnotation[];
  const kept = annots.filter((a) => Object.hasOwn(TYPE_NAMES, a.subtype) && a.replyType !== 'Group');
  if (!kept.length) return [];
  const vp = page.getViewport({ scale: 1 });
  let items: TextItem[] | null = null;
  const byId = new Map<string, SummaryComment>();
  const all: Array<{ c: SummaryComment; raw: RawAnnotation }> = [];
  for (const a of kept) {
    const [x1, y1, x2, y2] = a.rect;
    const p1 = vp.convertToViewportPoint(x1, y1);
    const p2 = vp.convertToViewportPoint(x2, y2);
    let marked = '';
    if (TEXT_MARKUP.has(a.subtype)) {
      if (!items) items = (await page.getTextContent()).items.filter((i): i is TextItem => 'str' in i);
      marked = clean(markedText(items, a.quadPoints ?? [x1, y2, x2, y2, x1, y1, x2, y1]));
    }
    const isReply = !!a.inReplyTo;
    const c: SummaryComment = {
      page: pageNumber,
      subtype: a.subtype,
      type: isReply ? 'Reply' : TYPE_NAMES[a.subtype],
      author: clean(a.titleObj?.str ?? '').trim(),
      date: parsePdfDate(a.modificationDate) ?? parsePdfDate(a.creationDate),
      contents: clean(a.contentsObj?.str ?? '').trim(),
      markedText: marked,
      at: [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1])],
      isReply,
    };
    byId.set(a.id, c);
    all.push({ c, raw: a });
  }
  // Top-level comments in reading order, each followed by its replies (oldest first).
  const replies = new Map<SummaryComment, SummaryComment[]>();
  const top: SummaryComment[] = [];
  for (const { c, raw } of all) {
    const parent = raw.inReplyTo ? byId.get(raw.inReplyTo) : undefined;
    if (parent && parent !== c) {
      const list = replies.get(parent) ?? [];
      list.push(c);
      replies.set(parent, list);
    } else {
      top.push(c);
    }
  }
  top.sort((p, q) => (Math.abs(p.at[1] - q.at[1]) > 2 ? p.at[1] - q.at[1] : p.at[0] - q.at[0]));
  const out: SummaryComment[] = [];
  const push = (c: SummaryComment) => {
    out.push(c);
    const list = (replies.get(c) ?? []).sort((p, q) => (p.date?.getTime() ?? 0) - (q.date?.getTime() ?? 0));
    for (const r of list) push(r);
  };
  for (const c of top) push(c);
  return out;
}

/** All comments of the document, page by page, in the order they are listed. */
export async function collectComments(doc: PDFDocumentProxy): Promise<SummaryComment[]> {
  const out: SummaryComment[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    for (const c of await pageComments(await doc.getPage(n), n)) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ writing

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

/** Top-down page flow: lines are placed at `y` and new pages start as needed. */
class Flow {
  page!: PDFPage;
  y = 0;
  /** While y is above this, text goes in the narrow column right of the page image. */
  imageBottom = -Infinity;
  /** Called on every new page (continuation heading). */
  onNewPage: (() => void) | null = null;

  constructor(
    private out: PDFDocument,
    public fonts: Fonts,
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.out.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    this.imageBottom = -Infinity;
    this.onNewPage?.();
  }

  /** Makes room for `h` points, starting a new page if needed. */
  ensure(h: number): void {
    if (this.y - h < MARGIN + FOOTER) this.newPage();
  }

  column(): { x: number; width: number } {
    return this.y > this.imageBottom ? { x: MARGIN + THUMB_W + GUTTER, width: PAGE_W - 2 * MARGIN - THUMB_W - GUTTER } : { x: MARGIN, width: PAGE_W - 2 * MARGIN };
  }

  /** Wrapped paragraph; `\n` starts a new line. Long words are broken. */
  paragraph(text: string, font: PDFFont, size: number, color: Color, indent = 0, lead = 1.35): void {
    const lh = size * lead;
    for (const hard of text.split('\n')) {
      const words = hard.split(/ +/).filter(Boolean);
      if (!words.length) {
        this.ensure(lh);
        this.y -= lh;
        continue;
      }
      let i = 0;
      while (i < words.length) {
        this.ensure(lh);
        const col = this.column();
        const width = col.width - indent;
        let line = '';
        while (i < words.length) {
          const next = line ? `${line} ${words[i]}` : words[i];
          if (font.widthOfTextAtSize(next, size) <= width) {
            line = next;
            i++;
          } else if (!line) {
            // A single word wider than the column: break it by characters.
            const chars = Array.from(words[i]);
            let k = 1;
            while (k < chars.length && font.widthOfTextAtSize(chars.slice(0, k + 1).join(''), size) <= width) k++;
            line = chars.slice(0, k).join('');
            words[i] = chars.slice(k).join('');
            break;
          } else {
            break;
          }
        }
        this.page.drawText(line, { x: col.x + indent, y: this.y - size, size, font, color });
        this.y -= lh;
      }
    }
  }

  /** A line made of differently styled pieces, wrapped as one paragraph if too long. */
  spans(spans: Array<{ text: string; font: PDFFont; color: Color }>, size: number, indent = 0): void {
    const col = this.column();
    const total = spans.reduce((w, s) => w + s.font.widthOfTextAtSize(s.text, size), 0);
    if (total > col.width - indent) {
      // Rare (very long author names): fall back to plain wrapping.
      this.paragraph(spans.map((s) => s.text).join(''), spans[0].font, size, spans[0].color, indent);
      return;
    }
    const lh = size * 1.35;
    this.ensure(lh);
    const c = this.column();
    let x = c.x + indent;
    for (const s of spans) {
      this.page.drawText(s.text, { x, y: this.y - size, size, font: s.font, color: s.color });
      x += s.font.widthOfTextAtSize(s.text, size);
    }
    this.y -= lh;
  }

  rule(color = rgb(0.8, 0.8, 0.8)): void {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.6, color });
  }
}

/** Numbered marker circle. */
function marker(page: PDFPage, font: PDFFont, n: number, x: number, y: number): void {
  const label = String(n);
  const size = 6.5;
  const r = Math.max(5, font.widthOfTextAtSize(label, size) / 2 + 2);
  page.drawCircle({ x, y, size: r, color: rgb(1, 0.85, 0.2), borderColor: DARK, borderWidth: 0.5 });
  page.drawText(label, { x: x - font.widthOfTextAtSize(label, size) / 2, y: y - size * 0.35, size, font, color: DARK });
}

export async function summarizeComments(doc: PDFDocumentProxy, loadFont: LoadFont, opts: SummarizeOptions = {}): Promise<{ bytes: Uint8Array; count: number }> {
  const comments = await collectComments(doc);
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const [regular, bold, italic] = await Promise.all([
    loadFont({ family: 'sans', bold: false, italic: false }),
    loadFont({ family: 'sans', bold: true, italic: false }),
    loadFont({ family: 'sans', bold: false, italic: true }),
  ]);
  const fonts: Fonts = {
    regular: await out.embedFont(regular, { subset: false }),
    bold: await out.embedFont(bold, { subset: false }),
    italic: await out.embedFont(italic, { subset: false }),
  };
  const title = opts.title ?? 'Comment summary';
  out.setTitle(title);
  out.setCreator('Adika PDF Editor');
  let name = opts.documentName;
  if (name === undefined) {
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof t === 'string' && t.trim()) name = t.trim();
    } catch {
      // No metadata: leave the name out.
    }
  }

  const flow = new Flow(out, fonts);
  flow.paragraph(clean(title), fonts.bold, 20, DARK);
  if (name) flow.paragraph(`Document: ${clean(name)}`, fonts.regular, 10, DARK);
  flow.paragraph(`Created: ${formatDate(new Date())}`, fonts.regular, 10, GREY);
  flow.paragraph(comments.length === 1 ? '1 comment' : `${comments.length} comments`, fonts.regular, 10, GREY);
  flow.y -= 6;
  flow.rule(DARK);
  flow.y -= 14;

  if (!comments.length) {
    flow.paragraph('This document has no comments.', fonts.regular, 12, DARK);
  }

  let number = 0;
  for (let i = 0; i < comments.length; ) {
    const pageNo = comments[i].page;
    let j = i;
    while (j < comments.length && comments[j].page === pageNo) j++;
    const group = comments.slice(i, j);
    i = j;

    let image: PDFImage | null = null;
    if (opts.renderPage) {
      try {
        const r = await opts.renderPage(pageNo, THUMB_W * 2);
        if (r) image = r.type === 'png' ? await out.embedPng(r.bytes) : await out.embedJpg(r.bytes);
      } catch {
        image = null;
      }
    }
    let imgW = 0;
    let imgH = 0;
    if (image) {
      const scale = Math.min(THUMB_W / image.width, THUMB_MAX_H / image.height);
      imgW = image.width * scale;
      imgH = image.height * scale;
    }

    // Keep the heading with the image, or with at least the first lines of the first comment.
    flow.onNewPage = null;
    flow.ensure(28 + Math.max(imgH, 50));
    flow.y -= 4;
    flow.paragraph(`Page ${pageNo}`, fonts.bold, 13, ACCENT);
    flow.y -= 2;
    flow.rule();
    flow.y -= 8;
    flow.onNewPage = () => {
      flow.paragraph(`Page ${pageNo} (continued)`, fonts.bold, 10, GREY);
      flow.y -= 4;
    };

    const first = number + 1;
    if (image) {
      const top = flow.y;
      flow.page.drawImage(image, { x: MARGIN, y: top - imgH, width: imgW, height: imgH });
      flow.page.drawRectangle({ x: MARGIN, y: top - imgH, width: imgW, height: imgH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
      // Numbered markers where the comments are (viewport coordinates → image).
      const vp = (await doc.getPage(pageNo)).getViewport({ scale: 1 });
      const sx = imgW / vp.width;
      const sy = imgH / vp.height;
      group.forEach((c, k) => {
        if (c.isReply) return;
        const x = Math.min(Math.max(MARGIN + c.at[0] * sx, MARGIN + 4), MARGIN + imgW - 4);
        const y = Math.min(Math.max(top - c.at[1] * sy, top - imgH + 4), top - 4);
        marker(flow.page, fonts.bold, first + k, x, y);
      });
      flow.imageBottom = top - imgH - 6;
    }

    for (const c of group) {
      number++;
      const meta = [c.author, c.date ? formatDate(c.date) : ''].filter(Boolean).join('  ·  ');
      const indent = c.isReply ? 14 : 0;
      flow.ensure(30);
      flow.spans(
        [
          { text: `${number}. ${c.type}`, font: fonts.bold, color: DARK },
          ...(meta ? [{ text: `   ${meta}`, font: fonts.regular, color: GREY }] : []),
        ],
        10,
        indent,
      );
      if (c.markedText) flow.paragraph(`“${c.markedText}”`, fonts.italic, 10, GREY, indent + 12);
      if (c.contents && c.contents !== c.markedText) flow.paragraph(c.contents, fonts.regular, 10, DARK, indent + 12);
      flow.y -= 8;
    }
    // Next page section starts below the image.
    if (Number.isFinite(flow.imageBottom) && flow.y > flow.imageBottom) flow.y = flow.imageBottom - 4;
    flow.imageBottom = -Infinity;
    flow.y -= 6;
  }
  flow.onNewPage = null;

  // Footer: "n / total" on every page.
  const pages = out.getPages();
  pages.forEach((p, k) => {
    const label = `${k + 1} / ${pages.length}`;
    const w = fonts.regular.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: MARGIN / 2 + 4, size: 8, font: fonts.regular, color: GREY });
  });
  return { bytes: await out.save(), count: comments.length };
}
