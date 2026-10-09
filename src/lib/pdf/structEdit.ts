/**
 * The structure tree as a walkable model (elements with their parents, role
 * mapping, marked-content ids per page, annotation references) and the edits
 * the PDF/UA fixes and the reading-order editor make: the ParentTree number
 * tree, StructParents keys, inserting / moving / removing elements. Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib';

/** Standard structure types of PDF 1.7 (ISO 32000-1 §14.8.4). */
export const STANDARD_TYPES = new Set([
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private',
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  'Figure', 'Formula', 'Form',
]);

export interface McRef {
  mcid: number;
  /** 0-based page, -1 when unknown. */
  page: number;
  /** In a Form XObject (MCR with /Stm), not the page content. */
  stream: boolean;
}

export interface StructNode {
  ref: PDFRef | null;
  dict: PDFDict;
  /** "12-0" for indirect elements. */
  id: string;
  /** /S as written. */
  type: string;
  /** /S through the RoleMap (the standard type when the mapping ends at one). */
  role: string;
  parent: StructNode | null;
  children: StructNode[];
  mcids: McRef[];
  objrs: Array<{ obj: PDFRef; page: number }>;
  /** 0-based page of its own /Pg (or inherited), -1 when none. */
  page: number;
  depth: number;
}

export interface Structure {
  root: PDFDict;
  rootRef: PDFRef | null;
  roleMap: Map<string, string>;
  /** Every element in document (reading) order. */
  nodes: StructNode[];
  top: StructNode[];
}

export const idOf = (r: PDFRef) => `${r.objectNumber}-${r.generationNumber}`;
export const textOf = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '');
const deref = (doc: PDFDocument, v: PDFObject | undefined) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
const sameRef = (a: PDFObject | undefined, b: PDFRef) => a instanceof PDFRef && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;

export function structRoot(doc: PDFDocument): PDFDict | null {
  const r = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  return r instanceof PDFDict ? r : null;
}

export function readRoleMap(doc: PDFDocument): Map<string, string> {
  const out = new Map<string, string>();
  const rm = structRoot(doc)?.lookup(PDFName.of('RoleMap'));
  if (rm instanceof PDFDict) for (const [k, v] of rm.entries()) if (v instanceof PDFName) out.set(k.decodeText(), v.decodeText());
  return out;
}

/** The type a structure type maps to: the end of its RoleMap chain. */
export function resolveRole(type: string, roleMap: Map<string, string>): { role: string; circular: boolean } {
  const seen = new Set<string>([type]);
  let t = type;
  // A standard type is not followed further (remapping it is its own failure).
  while (!STANDARD_TYPES.has(t) && roleMap.has(t)) {
    t = roleMap.get(t)!;
    if (seen.has(t)) return { role: t, circular: true };
    seen.add(t);
  }
  return { role: t, circular: false };
}

function pageIndexer(doc: PDFDocument) {
  const pages = doc.getPages();
  const map = new Map(pages.map((p, i) => [idOf(p.ref), i]));
  return (pg: PDFObject | undefined) => (pg instanceof PDFRef ? (map.get(idOf(pg)) ?? -1) : -1);
}

export function kidsOf(doc: PDFDocument, d: PDFDict): PDFObject[] {
  const k = d.get(PDFName.of('K'));
  if (k === undefined) return [];
  const v = deref(doc, k);
  return v instanceof PDFArray ? v.asArray() : [k];
}

export function readStructure(doc: PDFDocument): Structure | null {
  const root = structRoot(doc);
  if (!root) return null;
  const rootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const roleMap = readRoleMap(doc);
  const pageOf = pageIndexer(doc);
  const nodes: StructNode[] = [];
  const seen = new Set<PDFDict>();
  const walk = (k: PDFObject, parent: StructNode | null, inherited: number, depth: number): StructNode | null => {
    const d = deref(doc, k);
    if (!(d instanceof PDFDict) || seen.has(d) || depth > 300) return null;
    const type = d.lookup(PDFName.of('S'));
    if (!(type instanceof PDFName)) return null;
    seen.add(d);
    const own = pageOf(d.get(PDFName.of('Pg')));
    const page = own >= 0 ? own : inherited;
    const t = type.decodeText();
    const node: StructNode = { ref: k instanceof PDFRef ? k : null, dict: d, id: k instanceof PDFRef ? idOf(k) : `d${nodes.length}`, type: t, role: resolveRole(t, roleMap).role, parent, children: [], mcids: [], objrs: [], page, depth };
    nodes.push(node);
    for (const kid of kidsOf(doc, d)) {
      if (kid instanceof PDFNumber) {
        node.mcids.push({ mcid: kid.asNumber(), page, stream: false });
        continue;
      }
      const kd = deref(doc, kid);
      if (!(kd instanceof PDFDict)) continue;
      const kt = kd.lookup(PDFName.of('Type'));
      if (kt === PDFName.of('MCR')) {
        const m = kd.lookup(PDFName.of('MCID'));
        const p = pageOf(kd.get(PDFName.of('Pg')));
        if (m instanceof PDFNumber) node.mcids.push({ mcid: m.asNumber(), page: p >= 0 ? p : page, stream: kd.has(PDFName.of('Stm')) });
      } else if (kt === PDFName.of('OBJR')) {
        const o = kd.get(PDFName.of('Obj'));
        const p = pageOf(kd.get(PDFName.of('Pg')));
        if (o instanceof PDFRef) node.objrs.push({ obj: o, page: p >= 0 ? p : page });
      } else {
        const c = walk(kid, node, page, depth + 1);
        if (c) node.children.push(c);
      }
    }
    return node;
  };
  const top: StructNode[] = [];
  for (const k of kidsOf(doc, root)) {
    const n = walk(k, null, -1, 0);
    if (n) top.push(n);
  }
  return { root, rootRef: rootRef instanceof PDFRef ? rootRef : null, roleMap, nodes, top };
}

/** Pages of an element's content (its own marked content and annotations). */
export function contentPages(n: StructNode): Set<number> {
  return new Set([...n.mcids.map((m) => m.page), ...n.objrs.map((o) => o.page)].filter((p) => p >= 0));
}

// ---------------------------------------------------------------- ParentTree

/** All entries of a number tree (Nums arrays, Kids followed). */
export function readNumberTree(doc: PDFDocument, tree: PDFObject | undefined): Map<number, PDFObject> {
  const out = new Map<number, PDFObject>();
  const seen = new Set<PDFDict>();
  const walk = (node: PDFObject | undefined, depth: number) => {
    const d = deref(doc, node);
    if (!(d instanceof PDFDict) || seen.has(d) || depth > 40) return;
    seen.add(d);
    const nums = d.lookup(PDFName.of('Nums'));
    if (nums instanceof PDFArray) for (let i = 0; i + 1 < nums.size(); i += 2) {
      const k = nums.lookup(i);
      if (k instanceof PDFNumber) out.set(k.asNumber(), nums.get(i + 1));
    }
    const kids = d.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  walk(tree, 0);
  return out;
}

export function readParentTree(doc: PDFDocument): Map<number, PDFObject> {
  return readNumberTree(doc, structRoot(doc)?.get(PDFName.of('ParentTree')));
}

/** Writes the ParentTree back as one flat number tree and keeps ParentTreeNextKey past its keys. */
export function writeParentTree(doc: PDFDocument, map: Map<number, PDFObject>): void {
  const root = structRoot(doc);
  if (!root) return;
  const keys = [...map.keys()].sort((a, b) => a - b);
  const nums: PDFObject[] = [];
  for (const k of keys) nums.push(PDFNumber.of(k), map.get(k)!);
  root.set(PDFName.of('ParentTree'), doc.context.register(doc.context.obj({ Nums: nums })));
  const next = root.lookup(PDFName.of('ParentTreeNextKey'));
  const need = keys.length ? keys[keys.length - 1] + 1 : 0;
  if (!(next instanceof PDFNumber) || next.asNumber() < need) root.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(need));
}

/** A free ParentTree key. */
export function nextParentKey(doc: PDFDocument, map: Map<number, PDFObject>): number {
  const next = structRoot(doc)?.lookup(PDFName.of('ParentTreeNextKey'));
  let k = Math.max(next instanceof PDFNumber ? next.asNumber() : 0, map.size ? Math.max(...map.keys()) + 1 : 0);
  for (const p of doc.getPages()) {
    const sp = p.node.lookup(PDFName.of('StructParents'));
    if (sp instanceof PDFNumber) k = Math.max(k, sp.asNumber() + 1);
  }
  return k;
}

/** The page's ParentTree array (MCID -> element), made when missing. */
export function pageParents(doc: PDFDocument, page: PDFPage, map: Map<number, PDFObject>): PDFArray {
  let sp = page.node.lookup(PDFName.of('StructParents'));
  if (!(sp instanceof PDFNumber)) {
    sp = PDFNumber.of(nextParentKey(doc, map));
    page.node.set(PDFName.of('StructParents'), sp);
  }
  const key = (sp as PDFNumber).asNumber();
  let arr = deref(doc, map.get(key));
  if (!(arr instanceof PDFArray)) {
    arr = doc.context.obj([]);
    map.set(key, arr);
  }
  return arr as PDFArray;
}

/** Sets entry `mcid` of a page's ParentTree array (growing it with nulls). */
export function setParent(arr: PDFArray, mcid: number, elem: PDFObject): void {
  while (arr.size() <= mcid) arr.push(PDFNull);
  arr.set(mcid, elem);
}

// ---------------------------------------------------------------- tree edits

/** The element new tags go into: the root's single top element (made a Document when the root has none). */
export function documentElement(doc: PDFDocument): { dict: PDFDict; ref: PDFRef } {
  const root = structRoot(doc);
  if (!root) throw new Error('The document is not tagged.');
  const kids = kidsOf(doc, root);
  if (kids.length === 1 && kids[0] instanceof PDFRef) {
    const d = doc.context.lookup(kids[0]);
    const s = d instanceof PDFDict ? d.lookup(PDFName.of('S')) : undefined;
    const role = s instanceof PDFName ? resolveRole(s.decodeText(), readRoleMap(doc)).role : '';
    if (d instanceof PDFDict && ['Document', 'Part', 'Art', 'Sect', 'Div'].includes(role)) return { dict: d, ref: kids[0] };
  }
  const rootRef = doc.catalog.get(PDFName.of('StructTreeRoot'));
  const dict = doc.context.obj({ Type: 'StructElem', S: 'Document', P: rootRef as PDFRef, K: kids as PDFObject[] }) as PDFDict;
  const ref = doc.context.register(dict);
  for (const k of kids) {
    const kd = deref(doc, k);
    if (kd instanceof PDFDict && kd.has(PDFName.of('S'))) kd.set(PDFName.of('P'), ref);
  }
  root.set(PDFName.of('K'), doc.context.obj([ref]));
  return { dict, ref };
}

/** The element's /K as an array (a single kid becomes an array of one). */
export function kidsArray(doc: PDFDocument, d: PDFDict): PDFArray {
  const k = d.get(PDFName.of('K'));
  const v = deref(doc, k);
  if (v instanceof PDFArray) return v;
  const arr = doc.context.obj(k === undefined ? [] : [k]);
  d.set(PDFName.of('K'), arr);
  return arr;
}

export function indexInParent(doc: PDFDocument, parent: PDFDict, ref: PDFRef): number {
  return kidsArray(doc, parent)
    .asArray()
    .findIndex((x) => sameRef(x, ref));
}

/** The parent dictionary of an element (the root for top elements). */
export function parentOf(doc: PDFDocument, d: PDFDict): PDFDict | null {
  const p = d.lookup(PDFName.of('P'));
  return p instanceof PDFDict ? p : structRoot(doc);
}

/** Takes an element out of its parent; parents left empty go too (not the root). */
export function detach(doc: PDFDocument, ref: PDFRef): void {
  const d = doc.context.lookup(ref);
  if (!(d instanceof PDFDict)) return;
  const parent = parentOf(doc, d);
  if (!parent) return;
  const kids = kidsArray(doc, parent);
  const i = kids.asArray().findIndex((x) => sameRef(x, ref));
  if (i >= 0) kids.remove(i);
  const pRef = d.get(PDFName.of('P'));
  if (!kids.size() && parent !== structRoot(doc) && pRef instanceof PDFRef && parent.lookup(PDFName.of('S')) !== PDFName.of('Document')) detach(doc, pRef);
}

/** Puts an element into `parent` at `index` (the end when undefined) and points its /P there. */
export function attach(doc: PDFDocument, ref: PDFRef, parentRef: PDFRef, index?: number): void {
  const parent = doc.context.lookup(parentRef);
  const d = doc.context.lookup(ref);
  if (!(parent instanceof PDFDict) || !(d instanceof PDFDict)) return;
  const kids = kidsArray(doc, parent);
  if (index === undefined || index >= kids.size()) kids.push(ref);
  else kids.insert(Math.max(0, index), ref);
  d.set(PDFName.of('P'), parentRef);
}

/** The reference of an element's parent (the StructTreeRoot reference for top elements). */
export function parentRefOf(doc: PDFDocument, d: PDFDict): PDFRef | null {
  const p = d.get(PDFName.of('P'));
  if (p instanceof PDFRef) return p;
  const r = doc.catalog.get(PDFName.of('StructTreeRoot'));
  return r instanceof PDFRef ? r : null;
}

export function newElement(doc: PDFDocument, type: string, parentRef: PDFRef, page: PDFPage | null, k: PDFObject[] | number | undefined, extra: Record<string, PDFObject> = {}): { dict: PDFDict; ref: PDFRef } {
  const dict = doc.context.obj({ Type: 'StructElem', S: type, P: parentRef }) as PDFDict;
  if (page) dict.set(PDFName.of('Pg'), page.ref);
  if (typeof k === 'number') dict.set(PDFName.of('K'), PDFNumber.of(k));
  else if (k) dict.set(PDFName.of('K'), doc.context.obj(k));
  for (const [key, v] of Object.entries(extra)) dict.set(PDFName.of(key), v);
  return { dict, ref: doc.context.register(dict) };
}

export function refFromId(id: string): PDFRef {
  const [n, g] = id.split('-').map(Number);
  return PDFRef.of(n, g || 0);
}
