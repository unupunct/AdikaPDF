import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, type PDFDict, type PDFRef } from 'pdf-lib';
import { deleteTag, moveTag, readTagTree, setTagProps, unwrapTag } from '@/lib/pdf/structTree';

/** Document > [P (mcid 0), Sect > [H1 (mcid 1), Figure (mcid 2, alt)]]. */
async function tagged() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const docRef = ctx.nextRef();
  const sectRef = ctx.nextRef();
  const el = (s: string, parent: PDFRef, k: unknown, extra: Record<string, unknown> = {}) => ctx.register(ctx.obj({ Type: 'StructElem', S: s, P: parent, Pg: page.ref, K: k as never, ...extra }));
  const p = el('P', docRef, 0);
  const h1 = el('H1', sectRef, 1);
  const fig = el('Figure', sectRef, 2, { Alt: PDFHexString.fromText('Logo') });
  ctx.assign(sectRef, ctx.obj({ Type: 'StructElem', S: 'Sect', P: docRef, K: [h1, fig] }));
  ctx.assign(docRef, ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: [p, sectRef] }));
  ctx.assign(rootRef, ctx.obj({ Type: 'StructTreeRoot', K: docRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  return PDFDocument.load(await doc.save());
}

const shape = (nodes: ReturnType<typeof readTagTree>): unknown => nodes?.map((n) => (n.children.length ? { [n.type]: shape(n.children) } : n.type));

describe('tag tree', () => {
  it('reads the tags with their pages, content ids and alternate text', async () => {
    const doc = await tagged();
    const t = readTagTree(doc)!;
    expect(shape(t)).toEqual([{ Document: ['P', { Sect: ['H1', 'Figure'] }] }]);
    const fig = t[0].children[1].children[1];
    expect(fig).toMatchObject({ type: 'Figure', alt: 'Logo', page: 0, mcids: [2] });
    expect(readTagTree(await PDFDocument.create())).toBeNull();
  });

  it('changes types and alt text, the reading order, unwraps and deletes', async () => {
    const doc = await tagged();
    const t = readTagTree(doc)!;
    const [p, sect] = t[0].children;
    setTagProps(doc, p.id, { type: 'H2', alt: 'Intro' });
    expect(moveTag(doc, sect.id, -1)).toBe(true);
    expect(moveTag(doc, sect.id, -1)).toBe(false);
    let again = readTagTree(await PDFDocument.load(await doc.save()))!;
    expect(shape(again)).toEqual([{ Document: [{ Sect: ['H1', 'Figure'] }, 'H2'] }]);
    expect(again[0].children[1].alt).toBe('Intro');
    unwrapTag(doc, sect.id);
    again = readTagTree(doc)!;
    expect(shape(again)).toEqual([{ Document: ['H1', 'Figure', 'H2'] }]);
    // The children now point at their new parent.
    const parentOf = (id: string) => {
      const [a, b] = id.split('-').map(Number);
      for (const [ref, obj] of doc.context.enumerateIndirectObjects()) if (ref.objectNumber === a && ref.generationNumber === b) return ((obj as PDFDict).get(PDFName.of('P')) as PDFRef).objectNumber;
      return -1;
    };
    expect(parentOf(again[0].children[0].id)).toBe(Number(again[0].id.split('-')[0]));
    deleteTag(doc, again[0].children[1].id);
    expect(shape(readTagTree(doc))).toEqual([{ Document: ['H1', 'H2'] }]);
  });
});
