/**
 * The tag tree of a tagged PDF (structure tree, ISO 32000 §14.7), read for
 * the Tags panel and edited: change an element's type (P → H2, Span →
 * Figure…), set its alternate text, title or language, move it before or
 * after its neighbours (reading order), unwrap it (its children take its
 * place) or delete it with its children. Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from 'pdf-lib';

export interface TagNode {
  /** "12-0" (object number - generation) of the element. */
  id: string;
  type: string;
  title: string;
  alt: string;
  lang: string;
  /** 0-based page of the element's first content, or null. */
  page: number | null;
  /** Marked-content ids directly in this element. */
  mcids: number[];
  children: TagNode[];
}

const str = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '');
const idOf = (r: PDFRef) => `${r.objectNumber}-${r.generationNumber}`;

function root(doc: PDFDocument): PDFDict | null {
  const r = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  return r instanceof PDFDict ? r : null;
}

function kidsArray(doc: PDFDocument, d: PDFDict): PDFObject[] {
  const k = d.get(PDFName.of('K'));
  if (k === undefined) return [];
  const v = k instanceof PDFRef ? doc.context.lookup(k) : k;
  if (v instanceof PDFArray) return v.asArray();
  return [k];
}

/** The tree (without the root), or null when the document is not tagged. */
export function readTagTree(doc: PDFDocument): TagNode[] | null {
  const r = root(doc);
  if (!r) return null;
  const pages = doc.getPages().map((p) => p.ref);
  const pageOf = (pg: PDFObject | undefined) => (pg instanceof PDFRef ? pages.findIndex((p) => p.objectNumber === pg.objectNumber && p.generationNumber === pg.generationNumber) : -1);
  const seen = new Set<string>();
  const walk = (ref: PDFRef, inherited: number | null, depth: number): TagNode | null => {
    const d = doc.context.lookup(ref);
    if (!(d instanceof PDFDict) || depth > 200 || seen.has(idOf(ref))) return null;
    seen.add(idOf(ref));
    const s = d.lookup(PDFName.of('S'));
    const own = pageOf(d.get(PDFName.of('Pg')));
    const page = own >= 0 ? own : inherited;
    const node: TagNode = { id: idOf(ref), type: s instanceof PDFName ? s.decodeText() : '?', title: str(d.lookup(PDFName.of('T'))), alt: str(d.lookup(PDFName.of('Alt'))), lang: str(d.lookup(PDFName.of('Lang'))), page, mcids: [], children: [] };
    for (const k of kidsArray(doc, d)) {
      if (k instanceof PDFNumber) node.mcids.push(k.asNumber());
      else if (k instanceof PDFRef) {
        const kd = doc.context.lookup(k);
        if (kd instanceof PDFDict && kd.lookup(PDFName.of('Type')) === PDFName.of('MCR')) {
          const m = kd.lookup(PDFName.of('MCID'));
          if (m instanceof PDFNumber) node.mcids.push(m.asNumber());
          if (node.page === null) {
            const p = pageOf(kd.get(PDFName.of('Pg')));
            if (p >= 0) node.page = p;
          }
        } else if (kd instanceof PDFDict && kd.lookup(PDFName.of('Type')) === PDFName.of('OBJR')) {
          // an annotation or XObject: not shown as a tag of its own
        } else {
          const c = walk(k, page, depth + 1);
          if (c) node.children.push(c);
        }
      } else if (k instanceof PDFDict && k.lookup(PDFName.of('Type')) === PDFName.of('MCR')) {
        const m = k.lookup(PDFName.of('MCID'));
        if (m instanceof PDFNumber) node.mcids.push(m.asNumber());
      }
    }
    if (node.page === null) node.page = node.children.find((c) => c.page !== null)?.page ?? null;
    return node;
  };
  const out: TagNode[] = [];
  for (const k of kidsArray(doc, r)) if (k instanceof PDFRef) {
    const n = walk(k, null, 0);
    if (n) out.push(n);
  }
  return out;
}

function refById(doc: PDFDocument, id: string): PDFRef {
  const [n, g] = id.split('-').map(Number);
  const ref = PDFRef.of(n, g);
  if (!(doc.context.lookup(ref) instanceof PDFDict)) throw new Error('That tag is no longer in the document.');
  return ref;
}

/** The element's parent and its kids array (made an array when it was a single kid). */
function parentKids(doc: PDFDocument, ref: PDFRef): { parent: PDFDict; kids: PDFArray; index: number } {
  const d = doc.context.lookup(ref) as PDFDict;
  const p = d.lookup(PDFName.of('P'));
  const parent = p instanceof PDFDict ? p : root(doc);
  if (!parent) throw new Error('The document has no tag tree.');
  let k = parent.get(PDFName.of('K'));
  let kids = k instanceof PDFRef ? doc.context.lookup(k) : k;
  if (!(kids instanceof PDFArray)) {
    kids = doc.context.obj(k === undefined ? [] : [k]);
    parent.set(PDFName.of('K'), kids);
    k = kids;
  }
  const arr = kids as PDFArray;
  const index = arr.asArray().findIndex((x) => x instanceof PDFRef && x.objectNumber === ref.objectNumber && x.generationNumber === ref.generationNumber);
  return { parent, kids: arr, index };
}

export function setTagProps(doc: PDFDocument, id: string, p: { type?: string; alt?: string; title?: string; lang?: string }): void {
  const d = doc.context.lookup(refById(doc, id)) as PDFDict;
  if (p.type) d.set(PDFName.of('S'), PDFName.of(p.type.replace(/[^\w]/g, '') || 'Span'));
  const text = (k: string, v: string | undefined) => {
    if (v === undefined) return;
    if (v.trim()) d.set(PDFName.of(k), PDFHexString.fromText(v));
    else d.delete(PDFName.of(k));
  };
  text('Alt', p.alt);
  text('T', p.title);
  text('Lang', p.lang);
}

/** Moves an element one place earlier (-1) or later (+1) among its siblings: the reading order. */
export function moveTag(doc: PDFDocument, id: string, delta: -1 | 1): boolean {
  const ref = refById(doc, id);
  const { kids, index } = parentKids(doc, ref);
  const to = index + delta;
  if (index < 0 || to < 0 || to >= kids.size()) return false;
  const other = kids.get(to);
  kids.set(to, ref);
  kids.set(index, other);
  return true;
}

/** Unwrap: the element's children take its place in its parent. */
export function unwrapTag(doc: PDFDocument, id: string): void {
  const ref = refById(doc, id);
  const d = doc.context.lookup(ref) as PDFDict;
  const { parent, kids, index } = parentKids(doc, ref);
  if (index < 0) return;
  const children = kidsArray(doc, d);
  const parentRef = parent === root(doc) ? doc.catalog.get(PDFName.of('StructTreeRoot')) : d.get(PDFName.of('P'));
  for (const c of children) {
    const cd = c instanceof PDFRef ? doc.context.lookup(c) : undefined;
    if (cd instanceof PDFDict && cd.has(PDFName.of('S')) && parentRef) cd.set(PDFName.of('P'), parentRef);
  }
  kids.remove(index);
  children.forEach((c, i) => kids.insert(index + i, c));
}

/** Deletes an element and everything under it from the tag tree (the page content stays). */
export function deleteTag(doc: PDFDocument, id: string): void {
  const ref = refById(doc, id);
  const { kids, index } = parentKids(doc, ref);
  if (index >= 0) kids.remove(index);
}

/** Common standard structure types for the type picker. */
export const TAG_TYPES = ['Document', 'Part', 'Sect', 'Div', 'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot', 'Figure', 'Caption', 'Formula', 'Form', 'Link', 'Annot', 'Span', 'Quote', 'BlockQuote', 'Note', 'Reference', 'TOC', 'TOCI', 'Index', 'Artifact'];
