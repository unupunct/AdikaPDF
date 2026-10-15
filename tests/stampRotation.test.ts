import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { annotId, linkToFile, readPageAnnots, stampPicturePdf } from '@/lib/pdf/fileAnnots';
import type { EditorObject, PageRef, SourceDoc, StampObject } from '@/types';
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
async function pdfjsAnnots(bytes: Uint8Array): Promise<Array<{ id: string; subtype: string; rect: number[] }>> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  return (await (await task.promise).getPage(1)).getAnnotations() as never;
}

const pageRef = (takenAnnots?: string[], baseRotation: 0 | 90 = 0): PageRef => ({ id: 'p1', kind: 'source', sourceId: 'src', sourceIndex: 0, baseRotation, userRotation: 0, width: 600, height: 800, takenAnnots });

function stampDicts(doc: PDFDocument): PDFDict[] {
  const arr = doc.getPage(0).node.Annots() as PDFArray;
  return arr.asArray().map((r) => doc.context.lookup(r) as PDFDict).filter((d) => (d.lookup(PDFName.of('Subtype')) as PDFName).decodeText() === 'Stamp');
}
const numbers = (d: PDFDict, k: string) => (d.lookup(PDFName.of(k)) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());

async function blank(): Promise<SourceDoc> {
  const d = await PDFDocument.create();
  d.addPage([600, 800]);
  return { id: 'src', name: 'a.pdf', bytes: await d.save(), pageCount: 1 };
}

/** A page with a stamp another app turned by 90° (Matrix + /Rotate, as Acrobat writes it). */
async function turnedStamp(): Promise<{ src: SourceDoc; id: string }> {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  // A 120 × 40 stamp turned 90° counter-clockwise: it covers 40 × 120 on the page.
  const ap = d.context.register(d.context.stream('1 0 0 RG 2 w 2 2 116 36 re S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 40], Matrix: [0, 1, -1, 0, 40, 0], Resources: {} }));
  const ref = d.context.register(
    d.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [300, 300, 340, 420], Rotate: 90, Name: 'Approved', C: [1, 0, 0], F: 4, P: page.ref, AP: { N: ap }, Contents: PDFHexString.fromText('Aprobat'), NM: PDFString.of('nm-st') }),
  );
  page.node.set(PDFName.of('Annots'), d.context.obj([ref]));
  return { src: { id: 'src', name: 'b.pdf', bytes: await d.save(), pageCount: 1 }, id: annotId(ref) };
}

const stamp = (rotation: number): StampObject => ({
  id: 'st1',
  pageId: 'p1',
  type: 'stamp',
  x: 100,
  y: 100,
  width: 150,
  height: 50,
  rotation,
  opacity: 1,
  label: 'APROBAT',
  subtitle: 'Ana Pop',
  color: '#b91c1c',
  name: 'Approved',
  text: '',
  author: 'Ana',
  createdAt: '2026-10-01T10:00:00Z',
  modifiedAt: '2026-10-01T10:00:00Z',
});

describe('stamp rotation', () => {
  it('writes a turned stamp: turned appearance /Matrix, /Rect around it, /Rotate for Acrobat', async () => {
    const src = await blank();
    const out = await buildPdf({ sources: { src }, pages: [pageRef()], objects: [stamp(90)], fieldValues: {} }, opts);
    const d = stampDicts(await PDFDocument.load(out))[0];
    // 90° clockwise on screen = 270° counter-clockwise in user space.
    expect((d.lookup(PDFName.of('Rotate')) as PDFNumber).asNumber()).toBe(270);
    const n = (d.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const m = numbers(n.dict, 'Matrix');
    expect(m[0]).toBeCloseTo(0);
    expect(m[1]).toBeCloseTo(-1);
    const r = numbers(d, 'Rect');
    // Turned about its top-left corner (100, 100 on screen): 50 wide, 150 tall, left of x = 100.
    expect(r[2] - r[0]).toBeCloseTo(50);
    expect(r[3] - r[1]).toBeCloseTo(150);
    expect(r[0]).toBeCloseTo(50);
    expect(r[3]).toBeCloseTo(700);
    // pdf.js draws it in that box.
    const [a] = await pdfjsAnnots(out);
    expect(a.rect[2] - a.rect[0]).toBeCloseTo(50);
    expect(a.rect[3] - a.rect[1]).toBeCloseTo(150);
    // An unturned stamp has no /Rotate.
    const plain = stampDicts(await PDFDocument.load(await buildPdf({ sources: { src }, pages: [pageRef()], objects: [stamp(0)], fieldValues: {} }, opts)))[0];
    expect(plain.has(PDFName.of('Rotate'))).toBe(false);
    // Any angle: the box grows to the turned outline.
    const odd = stampDicts(await PDFDocument.load(await buildPdf({ sources: { src }, pages: [pageRef()], objects: [stamp(30)], fieldValues: {} }, opts)))[0];
    expect((odd.lookup(PDFName.of('Rotate')) as PDFNumber).asNumber()).toBe(330);
    const or = numbers(odd, 'Rect');
    expect(or[2] - or[0]).toBeCloseTo(150 * Math.cos(Math.PI / 6) + 50 * Math.sin(Math.PI / 6), 3);
  });

  it('reads a turned stamp of the file upright with its rotation', async () => {
    const { src, id } = await turnedStamp();
    const doc = await PDFDocument.load(src.bytes);
    const fa = readPageAnnots(doc, 0, pageRef(), () => 'p1').find((a) => a.id === id)!;
    const o = fa.object as StampObject;
    expect(o.width).toBeCloseTo(120);
    expect(o.height).toBeCloseTo(40);
    expect(o.rotation).toBeCloseTo(270);
    // Its outline on screen is the /Rect: x 300…340, y (800 - 420)…(800 - 300).
    const corners = [
      [0, 0],
      [o.width, 0],
      [o.width, o.height],
      [0, o.height],
    ].map(([x, y]) => {
      const a = (o.rotation * Math.PI) / 180;
      return [o.x + x * Math.cos(a) - y * Math.sin(a), o.y + x * Math.sin(a) + y * Math.cos(a)];
    });
    expect(Math.min(...corners.map((c) => c[0]))).toBeCloseTo(300);
    expect(Math.max(...corners.map((c) => c[0]))).toBeCloseTo(340);
    expect(Math.min(...corners.map((c) => c[1]))).toBeCloseTo(380);
    expect(Math.max(...corners.map((c) => c[1]))).toBeCloseTo(500);
    // The picture is the appearance upright.
    const pic = await stampPicturePdf(doc, id);
    expect(pic?.width).toBeCloseTo(120);
    expect(pic?.height).toBeCloseTo(40);
    // On a page turned by 90°, the same stamp looks upright on screen.
    const onTurned = readPageAnnots(doc, 0, pageRef(undefined, 90), () => 'p1').find((a) => a.id === id)!.object as StampObject;
    expect(onTurned.rotation).toBeCloseTo(0);
  });

  it('saves a stamp of the file turned in Adika into its original', async () => {
    const { src, id } = await turnedStamp();
    const fa = readPageAnnots(await PDFDocument.load(src.bytes), 0, pageRef(), () => 'p1').find((a) => a.id === id)!;
    const taken = linkToFile({ ...fa.object!, id: 'o1', pageId: 'p1' }, fa) as StampObject;
    // Turned back upright and moved.
    const edited = { ...taken, rotation: 0, x: 100, y: 100 } as EditorObject;
    const out = await buildPdf({ sources: { src }, pages: [pageRef([id])], objects: [edited], fieldValues: {} }, opts);
    const doc = await PDFDocument.load(out);
    const dicts = stampDicts(doc);
    expect(dicts.length).toBe(1);
    const d = dicts[0];
    expect((d.lookup(PDFName.of('NM')) as PDFString).decodeText()).toBe('nm-st');
    expect(d.has(PDFName.of('Rotate'))).toBe(false);
    const r = numbers(d, 'Rect');
    expect(r[2] - r[0]).toBeCloseTo(120);
    expect(r[3] - r[1]).toBeCloseTo(40);
    expect(r[0]).toBeCloseTo(100);
    expect(r[3]).toBeCloseTo(700);
    // The new appearance draws the original one (kept as a form) with its turn taken out.
    const n = (d.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const xo = (n.dict.lookup(PDFName.of('Resources')) as PDFDict).lookup(PDFName.of('XObject')) as PDFDict;
    expect(xo.get(PDFName.of('S'))).toBeInstanceOf(PDFRef);
    expect(Array.from((d.lookup(PDFName.of('C')) as PDFArray).asArray(), (v) => (v as PDFNumber).asNumber())).toEqual([1, 0, 0]);
    // Read again: upright now, same size.
    const again = readPageAnnots(doc, 0, pageRef(), () => 'p1')[0].object as StampObject;
    expect(again.rotation).toBeCloseTo(0);
    expect(again.width).toBeCloseTo(120);
    // Turned by 45°: /Rotate 315 and the turned box.
    const out45 = await buildPdf({ sources: { src }, pages: [pageRef([id])], objects: [{ ...taken, rotation: 45 } as EditorObject], fieldValues: {} }, opts);
    const d45 = stampDicts(await PDFDocument.load(out45))[0];
    expect((d45.lookup(PDFName.of('Rotate')) as PDFNumber).asNumber()).toBe(315);
    const back = readPageAnnots(await PDFDocument.load(out45), 0, pageRef(), () => 'p1')[0].object as StampObject;
    expect(back.rotation).toBeCloseTo(45);
    expect(back.width).toBeCloseTo(120);
    expect(back.height).toBeCloseTo(40);
  });
});
