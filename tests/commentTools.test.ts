import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { cropPages, marginsToInsets } from '@/lib/pdf/crop';
import { indentBookmark, insertBookmark, moveBookmark, outdentBookmark, removeBookmark, updateBookmark, countBookmarks } from '@/lib/bookmarks';
import { cloudScallops } from '@/lib/cloud';
import { makeAttachment, makeLink, makePoly, makeStamp, makeText, STAMP_PRESETS } from '@/lib/objectFactory';
import type { BookmarkItem, EditorObject, PageRef, SourceDoc, ToolStyle } from '@/types';
import { importXfdf } from '@/lib/pdf/xfdf';
import { PDFDict, PDFName } from 'pdf-lib';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
}
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function open(bytes: Uint8Array) {
  const t = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(t);
  return t.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const style: ToolStyle = { stroke: '#e11d48', fill: null, strokeWidth: 2, opacity: 1, highlightColor: '#facc15', fontFamily: 'sans', fontSize: 12, color: '#0f172a', bold: false, italic: false };
// 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function source(rotate = 0): Promise<{ src: SourceDoc; pages: PageRef[] }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${i + 1}`, { x: 50, y: 780, size: 20, font });
    if (rotate && i === 2) p.setRotation(degrees(rotate));
  }
  const bytes = await doc.save();
  const src: SourceDoc = { id: 'src1', name: 'a.pdf', bytes, pageCount: 3 };
  const pages: PageRef[] = [0, 1, 2].map((i) => ({ id: `p${i}`, kind: 'source', sourceId: 'src1', sourceIndex: i, baseRotation: (i === 2 ? rotate : 0) as 0, userRotation: 0, width: 595, height: 842 }));
  return { src, pages };
}

async function build(objects: EditorObject[], outline: BookmarkItem[] | null = null, rotate = 0) {
  const { src, pages } = await source(rotate);
  return { bytes: await buildPdf({ sources: { src1: src }, pages, objects, fieldValues: {}, outline }, { loadFont, measure }), pages };
}

describe('comment annotations', () => {
  it('writes stamps, shapes, attachments, links, text boxes and callouts that readers see', async () => {
    const approved = STAMP_PRESETS[0];
    const objects: EditorObject[] = [
      makeStamp('p0', 300, 200, { ...approved, dynamic: true }, 'Ana Pop'),
      makeStamp('p0', 300, 300, { name: 'Image', label: '', color: '#000', dynamic: false, src: PNG, width: 100, height: 50 }, 'Ana Pop'),
      makePoly('polygon', 'p0', [100, 400, 200, 420, 150, 480], style, 'Ana'),
      makePoly('polyline', 'p0', [100, 500, 200, 520, 260, 480], style, 'Ana'),
      makePoly('cloud', 'p0', [300, 400, 420, 400, 420, 480, 300, 480], style, 'Ana'),
      makeAttachment('p0', 60, 60, { name: 'notă.txt', mime: 'text/plain', data: btoa('salut'), size: 5 }, 'Ana'),
      makeLink('p1', { x: 50, y: 50, width: 120, height: 20 }, { kind: 'url', url: 'example.com/docs' }),
      makeLink('p1', { x: 50, y: 90, width: 120, height: 20 }, { kind: 'page', pageId: 'p2' }),
      makeText('p1', 200, 200, style, { text: 'Text box comment', annotation: true, author: 'Ana', border: '#000000', background: '#ffffff', width: 150, height: 30 }),
      makeText('p1', 300, 300, style, { text: 'Callout ș', annotation: true, author: 'Ana', border: '#e11d48', background: '#ffffff', width: 120, height: 24, callout: { x: -80, y: 90 } }),
    ];
    const { bytes } = await build(objects);
    const pdf = await open(bytes);
    const a0 = (await (await pdf.getPage(1)).getAnnotations()) as Array<Record<string, unknown>>;
    const subtypes = a0.map((a) => a.subtype).filter((s) => s !== 'Popup');
    expect(subtypes).toEqual(['Stamp', 'Stamp', 'Polygon', 'PolyLine', 'Square', 'FileAttachment']);
    for (const a of a0) expect(a.hasAppearance, String(a.subtype)).toBe(true);
    expect((a0[0].contentsObj as { str: string }).str).toContain('APPROVED');
    expect((a0[0].contentsObj as { str: string }).str).toContain('Ana Pop');
    expect((a0[2].vertices as unknown[]).length).toBe(6); // 3 points, flat x/y
    const file = a0[5].file as { filename: string };
    expect(file.filename).toBe('notă.txt');
    // pdf.js 6 loads attachment contents on demand, by id.
    const content = await (pdf as unknown as { getAttachmentContent(id: string): Promise<Uint8Array> }).getAttachmentContent(a0[5].fileId as string);
    expect(new TextDecoder().decode(content)).toBe('salut');

    const a1 = (await (await pdf.getPage(2)).getAnnotations()) as Array<Record<string, unknown>>;
    const links = a1.filter((a) => a.subtype === 'Link');
    expect(links[0].url).toBe('https://example.com/docs');
    const dest = links[1].dest as unknown[];
    expect(await pdf.getPageIndex(dest[0] as Parameters<typeof pdf.getPageIndex>[0])).toBe(2);
    const free = a1.filter((a) => a.subtype === 'FreeText');
    expect(free).toHaveLength(2);
    expect((free[1].contentsObj as { str: string }).str).toBe('Callout ș');
    // The callout's appearance box reaches down to the anchor point (80 pt left, 90 pt below the box).
    const r = free[1].rect as number[];
    expect(r[0]).toBeLessThan(300 - 70);
    expect(r[1]).toBeLessThan(842 - 300 - 80);
  });

  it('cloud scallops go round the box and bulge outwards', () => {
    const s = cloudScallops(100, 50, 14);
    expect(s.length).toBeGreaterThan(8);
    expect(s[0].x0).toBe(0);
    expect(s[s.length - 1].y).toBeCloseTo(0);
    // Top edge scallops bulge up (negative y), bottom ones down.
    expect(Math.min(...s.slice(0, 3).map((c) => c.c1y))).toBeLessThan(0);
  });
});

describe('bookmarks', () => {
  const bm = (id: string, pageId: string | null, children: BookmarkItem[] = []): BookmarkItem => ({ id, title: id, pageId, top: null, url: null, bold: false, italic: false, open: true, children });

  it('tree edits: insert, move, indent, outdent, rename, delete', () => {
    let t: BookmarkItem[] = [bm('a', 'p0'), bm('b', 'p1')];
    t = insertBookmark(t, bm('c', 'p2'), 'a');
    expect(t.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    t = moveBookmark(t, 'c', 1);
    expect(t.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    t = indentBookmark(t, 'c');
    expect(t[1].children.map((x) => x.id)).toEqual(['c']);
    t = outdentBookmark(t, 'c');
    expect(t.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    t = updateBookmark(t, 'a', { title: 'Început' });
    expect(t[0].title).toBe('Început');
    t = removeBookmark(t, 'b');
    expect(countBookmarks(t)).toBe(2);
  });

  it('saves edited bookmarks as the PDF outline, following the pages', async () => {
    const outline = [bm('Introducere', 'p0', [bm('Detalii', 'p2')]), bm('Anexa', 'p1'), bm('Gone', 'deleted-page')];
    const { bytes } = await build([], outline);
    const pdf = await open(bytes);
    const o = (await pdf.getOutline()) as Array<{ title: string; dest: unknown[]; items: Array<{ title: string; dest: unknown[] }> }>;
    expect(o.map((x) => x.title)).toEqual(['Introducere', 'Anexa']);
    expect(o[0].items[0].title).toBe('Detalii');
    const idx = async (d: unknown[]) => pdf.getPageIndex(d[0] as Parameters<typeof pdf.getPageIndex>[0]);
    expect(await idx(o[0].dest)).toBe(0);
    expect(await idx(o[0].items[0].dest)).toBe(2);
    expect(await idx(o[1].dest)).toBe(1);
  });
});

describe('crop', () => {
  it('maps on-screen margins to the unrotated box for every rotation', () => {
    const m = { top: 1, right: 2, bottom: 3, left: 4 };
    expect(marginsToInsets(m, 0)).toEqual({ y1: 1, x1: 2, y0: 3, x0: 4 });
    expect(marginsToInsets(m, 90)).toEqual({ x0: 1, y1: 2, x1: 3, y0: 4 });
    expect(marginsToInsets(m, 180)).toEqual({ y0: 1, x0: 2, y1: 3, x1: 4 });
    expect(marginsToInsets(m, 270)).toEqual({ x1: 1, y0: 2, x0: 3, y1: 4 });
  });

  it('crops the chosen pages and keeps what the user sees on rotated pages', async () => {
    const { bytes } = await build([], null, 90);
    const out = await cropPages(bytes, { top: 10, right: 20, bottom: 30, left: 40 }, [1, 3]);
    expect(out.cropped).toBe(2);
    const doc = await PDFDocument.load(out.bytes);
    const [p1, p2, p3] = doc.getPages();
    expect(p1.getCropBox()).toEqual({ x: 40, y: 30, width: 595 - 60, height: 842 - 40 });
    expect(p2.getCropBox()).toEqual({ x: 0, y: 0, width: 595, height: 842 });
    // Page 3 is shown rotated 90°: the on-screen top margin comes off the PDF's left edge.
    expect(p3.getCropBox()).toEqual({ x: 10, y: 40, width: 595 - 40, height: 842 - 60 });
    // Seen through pdf.js the rotated page keeps its on-screen proportions.
    const pdf = await open(out.bytes);
    const vp = (await pdf.getPage(3)).getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo(842 - 60);
    expect(vp.height).toBeCloseTo(595 - 40);
  });
});

describe('comment import with the app fonts', () => {
  it('draws Romanian letters of imported text boxes (Noto instead of Helvetica)', async () => {
    const { bytes } = await build([]);
    const xfdf = `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><freetext page="0" rect="100,600,300,640" title="Ana" name="ft1"><contents>Țară și câmpie</contents><defaultappearance>0 0 0 rg /Helv 12 Tf</defaultappearance></freetext></annots></xfdf>`;
    const r = await importXfdf(bytes, xfdf, (v) => loadFont({ family: v.family, bold: v.bold, italic: false }));
    expect(r.added).toBe(1);
    const doc = await PDFDocument.load(r.bytes);
    const annots = doc.getPages()[0].node.Annots()!;
    const ft = doc.context.lookup(annots.get(annots.size() - 1)) as PDFDict;
    const ap = (ft.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as unknown as { dict: PDFDict };
    const fonts = (ap.dict.lookup(PDFName.of('Resources')) as PDFDict).lookup(PDFName.of('Font')) as PDFDict;
    const names = fonts.keys().map((k) => String((fonts.lookup(k) as PDFDict).lookup(PDFName.of('BaseFont'))));
    expect(names.join(' ')).toMatch(/Noto/);
  });
});
