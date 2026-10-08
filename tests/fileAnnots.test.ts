import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { annotId, isUntouched, linkToFile, pdfDateToIso, readPageAnnots, stampPicturePdf, type FileAnnot } from '@/lib/pdf/fileAnnots';
import type { EditorObject, PageRef, SourceDoc } from '@/types';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const weight = v.bold ? '700Bold' : '400Regular';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', weight, `NotoSans_${weight}.ttf`))));
}
const opts = { loadFont, measure: (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5 };

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

type Raw = { id: string; subtype: string; rect: number[]; inReplyTo?: string; popupRef?: string | null; color?: Uint8ClampedArray | null; titleObj?: { str: string }; contentsObj?: { str: string }; quadPoints?: Float32Array; vertices?: Float32Array };
async function annots(bytes: Uint8Array, n = 1): Promise<Raw[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  return (await (await task.promise).getPage(n)).getAnnotations() as Promise<Raw[]>;
}

/** A page with one annotation of each kind, as other apps write them. */
async function source(): Promise<{ src: SourceDoc; ids: Record<string, string> }> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([600, 800]);
  page.drawText('Contractul se semneaza maine.', { x: 50, y: 700, size: 14, font });
  const ids: Record<string, string> = {};
  const list: PDFRef[] = [];
  const add = (key: string, dict: Record<string, unknown>) => {
    const ref = d.context.register(d.context.obj({ Type: 'Annot', F: 4, P: page.ref, ...dict }));
    list.push(ref);
    ids[key] = annotId(ref);
    return ref;
  };
  const meta = (nm: string, author: string, contents: string) => ({ NM: PDFString.of(nm), T: PDFHexString.fromText(author), Contents: PDFHexString.fromText(contents), CreationDate: PDFString.of("D:20250102030405+02'00'"), M: PDFString.of("D:20250102030405+02'00'") });
  const note = add('note', { Subtype: 'Text', Rect: [50, 600, 70, 620], C: [1, 1, 0], Name: 'Comment', ...meta('nm-note', 'Ana', 'Verifică data') });
  const popup = add('popup', { Subtype: 'Popup', Rect: [70, 520, 270, 620], Parent: note, Open: false });
  (d.context.lookup(note) as PDFDict).set(PDFName.of('Popup'), popup);
  add('reply', { Subtype: 'Text', Rect: [50, 600, 70, 620], IRT: note, ...meta('nm-reply', 'Dan', 'De acord') });
  const hl = add('highlight', { Subtype: 'Highlight', Rect: [48, 695, 260, 715], QuadPoints: [50, 714, 258, 714, 50, 696, 258, 696], C: [1, 1, 0], ...meta('nm-hl', 'Ana', 'Important'), Custom: PDFString.of('kept') });
  add('hlReply', { Subtype: 'Text', Rect: [260, 700, 280, 720], IRT: hl, ...meta('nm-hl-reply', 'Dan', 'Da') });
  add('freetext', { Subtype: 'FreeText', Rect: [300, 600, 500, 640], DA: PDFString.of('/Helv 12 Tf 0 0 1 rg'), ...meta('nm-ft', 'Eva', 'Text liber') });
  add('square', { Subtype: 'Square', Rect: [100, 400, 200, 480], C: [1, 0, 0], BS: { W: 2 }, ...meta('nm-sq', 'Ana', '') });
  add('circle', { Subtype: 'Circle', Rect: [250, 400, 350, 480], C: [0, 0, 1], BS: { W: 1 }, ...meta('nm-ci', 'Ana', '') });
  add('line', { Subtype: 'Line', Rect: [90, 290, 310, 310], L: [100, 300, 300, 300], LE: ['None', 'OpenArrow'], C: [0, 0.5, 0], BS: { W: 2 }, ...meta('nm-li', 'Ana', '') });
  add('polygon', { Subtype: 'Polygon', Rect: [390, 390, 510, 510], Vertices: [400, 400, 500, 400, 450, 500], C: [0.5, 0, 0.5], ...meta('nm-pg', 'Ana', 'Triunghi') });
  add('ink', { Subtype: 'Ink', Rect: [90, 190, 210, 260], InkList: [[100, 200, 150, 250, 200, 200], [100, 230, 200, 230]], C: [0, 0, 0], BS: { W: 3 }, ...meta('nm-ink', 'Ana', '') });
  const ap = d.context.register(d.context.formXObject([], { BBox: [0, 0, 100, 40], Resources: d.context.obj({}) }));
  add('stamp', { Subtype: 'Stamp', Rect: [400, 200, 500, 240], Name: 'Approved', AP: { N: ap }, ...meta('nm-st', 'Ana', 'Aprobat') });
  add('link', { Subtype: 'Link', Rect: [50, 100, 150, 120], A: { S: 'URI', URI: PDFString.of('https://example.com') } });
  add('caret', { Subtype: 'Caret', Rect: [300, 100, 310, 110], ...meta('nm-ca', 'Ana', 'Inserează') });
  page.node.set(PDFName.of('Annots'), d.context.obj(list));
  const bytes = await d.save();
  return { src: { id: 'src', name: 'a.pdf', bytes, pageCount: 1 }, ids };
}

const pageRef = (takenAnnots?: string[]): PageRef => ({ id: 'p1', kind: 'source', sourceId: 'src', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 600, height: 800, takenAnnots });

async function read(src: SourceDoc): Promise<FileAnnot[]> {
  return readPageAnnots(await PDFDocument.load(src.bytes), 0, pageRef(), () => 'p1');
}

function take(list: FileAnnot[], id: string): EditorObject {
  const fa = list.find((a) => a.id === id)!;
  expect(fa.object).not.toBeNull();
  return linkToFile(fa.object!, fa);
}

describe('comments already in the file', () => {
  it('reads each annotation with the object it becomes', async () => {
    const { src, ids } = await source();
    const list = await read(src);
    const by = (k: string) => list.find((a) => a.id === ids[k])!;
    expect(list.some((a) => a.subtype === 'Popup')).toBe(false);
    expect(by('note').object).toMatchObject({ type: 'note', x: 50, y: 180, color: '#ffff00', text: 'Verifică data', author: 'Ana' });
    expect(by('note').related.sort()).toEqual([ids.popup, ids.reply].sort());
    expect(by('highlight').object).toMatchObject({ type: 'markup', kind: 'highlight', x: 50, y: 86, width: 208, height: 18 });
    expect(by('freetext').object).toMatchObject({ type: 'text', annotation: true, fontSize: 12, color: '#0000ff', text: 'Text liber', x: 300, y: 160, width: 200 });
    expect(by('square').object).toMatchObject({ type: 'rect', x: 101, y: 321, width: 98, height: 78, stroke: '#ff0000', strokeWidth: 2 });
    expect(by('circle').object).toMatchObject({ type: 'ellipse' });
    expect(by('line').object).toMatchObject({ type: 'arrow', x: 100, y: 500, points: [0, 0, 200, 0] });
    expect(by('polygon').object).toMatchObject({ type: 'poly', kind: 'polygon', points: [0, 100, 100, 100, 50, 0] });
    expect(by('ink').object).toMatchObject({ type: 'vector', path: 'M 0 50 L 50 0 L 100 50 M 0 20 L 100 20', strokeWidth: 3 });
    expect(by('stamp').object).toMatchObject({ type: 'stamp', name: 'Approved', width: 100, height: 40 });
    expect(by('stamp').needsPicture).toBe(true);
    expect(by('link').object).toMatchObject({ type: 'link', target: { kind: 'url', url: 'https://example.com' } });
    expect(by('caret').object).toBeNull();
    expect(pdfDateToIso("D:20250102030405+02'00'")).toBe('2025-01-02T01:04:05.000Z');
    const pic = await stampPicturePdf(await PDFDocument.load(src.bytes), ids.stamp);
    expect(pic).toMatchObject({ width: 100, height: 40 });
  });

  it('leaves untouched comments alone and saves edits and deletions into the original', async () => {
    const { src, ids } = await source();
    const before = await annots(src.bytes);
    const list = await read(src);
    // Taken over but not changed: the file stays as it is.
    const idle = take(list, ids.square);
    expect(isUntouched(idle)).toBe(true);
    const note = take(list, ids.note);
    const hl = take(list, ids.highlight);
    const ft = take(list, ids.freetext);
    const ink = take(list, ids.ink);
    const stamp = take(list, ids.stamp);
    const objects = [
      idle,
      { ...note, x: note.x + 100, text: 'Data e greșită' },
      { ...hl, color: '#00ff00' },
      { ...ft, text: 'Text nou' },
      { ...ink, x: ink.x + 10 },
      { ...stamp, x: stamp.x - 100 },
    ] as EditorObject[];
    expect(isUntouched(objects[1])).toBe(false);
    // Taken over without an object: deleted (the highlight's reply stays with its edited parent).
    const taken = [ids.square, ids.note, ids.highlight, ids.freetext, ids.ink, ids.stamp, ids.polygon, ids.caret, ids.link];
    const out = await buildPdf({ sources: { src }, pages: [pageRef(taken)], objects, fieldValues: {} }, opts);
    const after = await annots(out);
    const byId = (id: string) => after.find((a) => a.id === id);

    // Deleted: the polygon, the caret and the link.
    expect(byId(ids.polygon)).toBeUndefined();
    expect(byId(ids.caret)).toBeUndefined();
    expect(byId(ids.link)).toBeUndefined();
    // Untouched: same rect as before.
    expect(byId(ids.square)?.rect).toEqual(before.find((a) => a.id === ids.square)?.rect);
    expect(byId(ids.circle)?.rect).toEqual(before.find((a) => a.id === ids.circle)?.rect);
    expect(byId(ids.line)).toBeDefined();
    // Edited in place: same object, author and /NM, new values.
    const n = byId(ids.note)!;
    expect(n.contentsObj?.str).toBe('Data e greșită');
    expect(n.titleObj?.str).toBe('Ana');
    expect(n.rect[0]).toBeCloseTo(150);
    expect(n.popupRef).toBe(ids.popup);
    expect(byId(ids.reply)?.inReplyTo).toBe(ids.note);
    const h = byId(ids.highlight)!;
    expect(Array.from(h.color ?? [])).toEqual([0, 255, 0]);
    expect(h.contentsObj?.str).toBe('Important');
    expect(byId(ids.hlReply)?.inReplyTo).toBe(ids.highlight);
    expect(byId(ids.freetext)?.contentsObj?.str).toBe('Text nou');
    expect(byId(ids.ink)?.rect[0]).toBeGreaterThan(before.find((a) => a.id === ids.ink)!.rect[0] + 5);
    expect(byId(ids.stamp)?.rect[0]).toBeCloseTo(300);
    // No extra annotations: the edits went into the originals.
    expect(after.length).toBe(before.length - 3);
    // Unknown entries survive an edit.
    const doc = await PDFDocument.load(out);
    const annotsArr = doc.getPage(0).node.Annots() as PDFArray;
    const dicts = annotsArr.asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const hlDict = dicts.find((x) => (x.lookup(PDFName.of('NM')) as PDFString | undefined)?.decodeText() === 'nm-hl')!;
    expect((hlDict.lookup(PDFName.of('Custom')) as PDFString).decodeText()).toBe('kept');
    expect(hlDict.lookup(PDFName.of('M'))).toBeDefined();
  });

  it('rewrites edited shapes, lines and polygons with new appearances', async () => {
    const { src, ids } = await source();
    const list = await read(src);
    const circle = take(list, ids.circle);
    const line = take(list, ids.line);
    const poly = take(list, ids.polygon);
    const objects = [
      { ...circle, stroke: '#ff0000', y: circle.y + 50 },
      { ...line, stroke: '#0000ff', strokeWidth: 4 },
      { ...poly, fill: '#00ff00' },
    ] as EditorObject[];
    const out = await buildPdf({ sources: { src }, pages: [pageRef([ids.circle, ids.line, ids.polygon])], objects, fieldValues: {} }, opts);
    const after = await annots(out);
    const byId = (id: string) => after.find((a) => a.id === id)! as Raw & { lineCoordinates?: number[]; borderStyle?: { width: number }; hasAppearance?: boolean; interiorColor?: Uint8ClampedArray };
    expect(Array.from(byId(ids.circle).color ?? [])).toEqual([255, 0, 0]);
    expect(byId(ids.circle).rect[1]).toBeLessThan(400);
    expect(Array.from(byId(ids.line).color ?? [])).toEqual([0, 0, 255]);
    expect(byId(ids.line).borderStyle?.width).toBe(4);
    expect(byId(ids.line).hasAppearance).toBe(true);
    const doc = await PDFDocument.load(out);
    const dicts = (doc.getPage(0).node.Annots() as PDFArray).asArray().map((r) => doc.context.lookup(r) as PDFDict);
    const pg = dicts.find((x) => (x.lookup(PDFName.of('NM')) as PDFString | undefined)?.decodeText() === 'nm-pg')!;
    expect((pg.lookup(PDFName.of('IC')) as PDFArray).asArray().map(String)).toEqual(['0', '1', '0']);
    expect((pg.lookup(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Triunghi');
    expect(after.length).toBe((await annots(src.bytes)).length);
  });

  it('deletes a parent with its popup and replies', async () => {
    const { src, ids } = await source();
    const out = await buildPdf({ sources: { src }, pages: [pageRef([ids.note])], objects: [], fieldValues: {} }, opts);
    const after = await annots(out);
    for (const k of ['note', 'popup', 'reply']) expect(after.find((a) => a.id === ids[k])).toBeUndefined();
    expect(after.find((a) => a.id === ids.highlight)).toBeDefined();
    expect(after.find((a) => a.id === ids.hlReply)).toBeDefined();
  });

  it('edits the copy on a duplicated page, not the original', async () => {
    const { src, ids } = await source();
    const list = await read(src);
    const sq = take(list, ids.square);
    const copy: PageRef = { ...pageRef([ids.square]), id: 'p2' };
    const out = await buildPdf({ sources: { src }, pages: [pageRef(), copy], objects: [{ ...sq, pageId: 'p2', stroke: '#0000ff' } as EditorObject], fieldValues: {} }, opts);
    const first = await annots(out, 1);
    const second = await annots(out, 2);
    expect(Array.from(first.find((a) => a.subtype === 'Square')!.color ?? [])).toEqual([255, 0, 0]);
    const squares = second.filter((a) => a.subtype === 'Square');
    expect(squares).toHaveLength(1);
    expect(Array.from(squares[0].color ?? [])).toEqual([0, 0, 255]);
    // The copy has every annotation of the original except pop-ups (they belong to the original's comments).
    expect(second.length).toBe(first.filter((a) => a.subtype !== 'Popup').length);
  });

  it('removes taken-over comments under a redaction box, edited or not', async () => {
    const { src, ids } = await source();
    const list = await read(src);
    const square = take(list, ids.square);
    const hl = take(list, ids.highlight);
    const box = (x: number, y: number, width: number, height: number) => ({ id: `rd${x}`, type: 'redact', pageId: 'p1', x, y, width, height, rotation: 0, opacity: 1, fill: '#000000' });
    const objects = [square, { ...hl, color: '#00ff00' }, box(90, 310, 130, 100), box(40, 80, 230, 30)] as EditorObject[];
    const out = await buildPdf({ sources: { src }, pages: [pageRef([ids.square, ids.highlight])], objects, fieldValues: {} }, opts);
    const after = await annots(out);
    expect(after.find((a) => a.id === ids.square)).toBeUndefined();
    expect(after.find((a) => a.id === ids.highlight)).toBeUndefined();
    expect(after.some((a) => a.subtype === 'Square' || a.subtype === 'Highlight')).toBe(false);
    expect(after.some((a) => a.subtype === 'Circle')).toBe(true);
  });
});
