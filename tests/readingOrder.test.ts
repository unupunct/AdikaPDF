import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mergeBoxes, readPageOrder, reorderPage, retagItems, tagRegion } from '@/lib/pdf/readingOrder';
import { readParentTree, readStructure } from '@/lib/pdf/structEdit';
import { checkPdfUa } from '@/lib/pdf/pdfua';
import { uaDoc, type UaDocSpec } from './helpers/uaDoc';

const line = (T: (s: string) => string, mcid: number, y: number, tag = 'P') => `/${tag} <</MCID ${mcid}>> BDC BT /F1 12 Tf 60 ${y} Td ${T(`Item ${mcid}`)} Tj ET EMC`;

/** H1 + Sect[P, P] + P, each line lower on the page; an untagged line and a rule at the bottom. */
const spec: UaDocSpec = {
  content: (T) => [
    [line(T, 0, 760, 'H1'), line(T, 1, 720), line(T, 2, 700), line(T, 3, 680), `BT /F1 12 Tf 60 300 Td ${T('Untagged words')} Tj ET`, '0 0 1 RG 60 280 m 300 280 l S'].join('\n'),
  ],
  tree: [{ S: 'H1', mcid: 0 }, { S: 'Sect', kids: [{ S: 'P', mcid: 1 }, { S: 'P', mcid: 2 }] }, { S: 'P', mcid: 3 }],
};

const load = async (b?: Uint8Array) => PDFDocument.load(b ?? (await uaDoc(spec)));
const roundTrip = async (doc: PDFDocument) => PDFDocument.load(await doc.save());
const texts = (doc: PDFDocument) => readPageOrder(doc, 0).items.map((i) => i.text);
const pageSrc = (doc: PDFDocument) => new TextDecoder('latin1').decode(decodePDFRawStream(doc.getPage(0).node.lookup(PDFName.of('Contents')) as PDFRawStream).decode());

/** The ParentTree entry of every MCID points at the element whose /K holds it. */
function parentTreeConsistent(doc: PDFDocument): boolean {
  const st = readStructure(doc)!;
  const arr = readParentTree(doc).get(0);
  const a = (arr instanceof PDFArray ? arr : doc.context.lookup(arr as never)) as PDFArray;
  return st.nodes.every((n) => n.mcids.every((m) => a.lookup(m.mcid) === n.dict));
}

describe('reading order', () => {
  it('lists the tagged items with boxes in tree order, and the untagged regions', async () => {
    const doc = await load();
    const o = readPageOrder(doc, 0);
    expect(o.tagged).toBe(true);
    expect(o.items.map((i) => [i.order, i.type, i.text])).toEqual([
      [1, 'H1', 'Item 0'],
      [2, 'P', 'Item 1'],
      [3, 'P', 'Item 2'],
      [4, 'P', 'Item 3'],
    ]);
    expect(o.items[0].box!.y0).toBeGreaterThan(o.items[1].box!.y1 - 1);
    expect(o.untagged).toHaveLength(2);
    expect(mergeBoxes([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 }])).toHaveLength(1);
  });

  it('reordering moves elements (also across parents); /K and the ParentTree stay right; pdf.js reads the new order', async () => {
    const doc = await load();
    const ids = readPageOrder(doc, 0).items.map((i) => i.id);
    // Item 3 first, then the H1, then the two paragraphs of the section swapped.
    expect(reorderPage(doc, 0, [ids[3], ids[0], ids[2], ids[1]])).toBe(true);
    const again = await roundTrip(doc);
    expect(texts(again)).toEqual(['Item 3', 'Item 0', 'Item 2', 'Item 1']);
    const st = readStructure(again)!;
    expect(st.top[0].children.map((c) => c.type)).toEqual(['P', 'H1', 'Sect']);
    // /P points at the new parent.
    const moved = st.nodes.find((n) => n.mcids[0]?.mcid === 3)!;
    expect(moved.dict.get(PDFName.of('P'))).toEqual(st.top[0].ref);
    expect(parentTreeConsistent(again)).toBe(true);
    const pdf = await pdfjs.getDocument({ data: (await again.save()).slice(), verbosity: 0 }).promise;
    const tree = (await (await pdf.getPage(1)).getStructTree()) as unknown as { children: Array<{ role: string; children: Array<{ role: string; children?: Array<{ role?: string; type?: string; id?: string }> }> }> };
    expect(tree.children[0].children.map((c) => c.role)).toEqual(['P', 'H1', 'Sect']);
    await pdf.loadingTask.destroy();
    // Moving across parents: the paragraph of the end goes into the section.
    const ids2 = readPageOrder(again, 0).items.map((i) => i.id);
    reorderPage(again, 0, [ids2[1], ids2[2], ids2[0], ids2[3]]);
    expect(texts(again)).toEqual(['Item 0', 'Item 2', 'Item 3', 'Item 1']);
    expect(parentTreeConsistent(again)).toBe(true);
  });

  it('retags the selection: heading, list, table, artifact', async () => {
    const doc = await load();
    const ids = readPageOrder(doc, 0).items.map((i) => i.id);
    retagItems(doc, 0, [ids[1]], 'H2');
    expect(readPageOrder(doc, 0).items[1].type).toBe('H2');
    retagItems(doc, 0, [ids[1], ids[2]], 'List');
    const st = readStructure(doc)!;
    const shape = (n: (typeof st.nodes)[number]): unknown => (n.children.length ? { [n.type]: n.children.map(shape) } : n.type);
    expect(shape(st.top[0])).toEqual({ Document: ['H1', { Sect: [{ L: [{ LI: [{ LBody: ['H2'] }] }, { LI: [{ LBody: ['P'] }] }] }] }, 'P'] });
    expect((await checkPdfUa(await doc.save())).issues.filter((i) => i.checkpoint === '09')).toEqual([]);

    const doc2 = await load();
    const ids2 = readPageOrder(doc2, 0).items.map((i) => i.id);
    retagItems(doc2, 0, [ids2[2], ids2[3]], 'Table');
    const t = readStructure(doc2)!.nodes.find((n) => n.type === 'Table')!;
    expect(t.children.map((r) => r.children.map((c) => c.type))).toEqual([['TH'], ['TD']]);

    const doc3 = await load();
    const ids3 = readPageOrder(doc3, 0).items.map((i) => i.id);
    retagItems(doc3, 0, [ids3[3]], 'Artifact');
    const saved = await roundTrip(doc3);
    expect(texts(saved)).toEqual(['Item 0', 'Item 1', 'Item 2']);
    expect(pageSrc(saved)).toMatch(/\/Artifact BMC BT \/F1 12 Tf 60 680/);
    const arr = readParentTree(saved).get(0) as PDFArray;
    expect(arr.get(3)?.toString()).toBe('null');
    expect(parentTreeConsistent(saved)).toBe(true);
  });

  it('a drawn rectangle tags untagged content in reading order, or marks it as artifact', async () => {
    const doc = await load();
    // Around the untagged words at y = 300.
    expect(tagRegion(doc, 0, { x0: 40, y0: 290, x1: 400, y1: 320 }, 'H2')).toBe(1);
    const saved = await roundTrip(doc);
    const o = readPageOrder(saved, 0);
    expect(o.items.map((i) => i.text)).toEqual(['Item 0', 'Item 1', 'Item 2', 'Item 3', 'Untagged words']);
    expect(o.items[4].type).toBe('H2');
    expect(o.untagged).toHaveLength(1);
    expect(parentTreeConsistent(saved)).toBe(true);
    // The rule becomes an artifact; nothing untagged is left.
    expect(tagRegion(saved, 0, { x0: 50, y0: 270, x1: 320, y1: 290 }, 'Artifact')).toBe(1);
    const final = await roundTrip(saved);
    expect(readPageOrder(final, 0).untagged).toEqual([]);
    expect((await checkPdfUa(await final.save())).issues.filter((i) => i.condition === '01-005')).toEqual([]);
    // Nothing untagged there: nothing to do.
    expect(tagRegion(final, 0, { x0: 0, y0: 0, x1: 20, y1: 20 }, 'P')).toBe(0);
  });

  it('a region above existing items is inserted before them', async () => {
    const top: UaDocSpec = {
      content: (T) => [[`BT /F1 12 Tf 60 800 Td ${T('Title words')} Tj ET`, line(T, 0, 700)].join('\n')],
      tree: [{ S: 'P', mcid: 0 }],
    };
    const doc = await PDFDocument.load(await uaDoc(top));
    tagRegion(doc, 0, { x0: 0, y0: 790, x1: 595, y1: 830 }, 'H1');
    expect(texts(doc)).toEqual(['Title words', 'Item 0']);
    const st = readStructure(doc)!;
    expect(st.top[0].children.map((c) => c.type)).toEqual(['H1', 'P']);
    const h1 = st.nodes.find((n) => n.type === 'H1')!;
    expect((h1.dict.get(PDFName.of('Pg')) as unknown) instanceof PDFDict).toBe(false);
  });
});
