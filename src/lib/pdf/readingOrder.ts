/**
 * Reading order of a page (Acrobat's Reading Order tool): the tagged items of
 * the page — structure elements with content on it — in tree order, each
 * with its box from the content-stream walker, and the untagged regions. Edits
 * write back to the structure tree: a new order (elements move among their
 * siblings or to the neighbour's parent), a new type (P, H1–H6, Figure, a
 * list or a table around the selection, Artifact), and new tags for untagged
 * content inside a drawn rectangle. Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib';
import { isUntagged, mcidContent, setPageContent, spliceContent, unionBox, walkPage, wrappableRanges, type ContentWalk } from './contentWalk';
import {
  attach,
  detach,
  documentElement,
  indexInParent,
  insertionIndex,
  kidsArray,
  newElement,
  pageParents,
  parentRefOf,
  readParentTree,
  readStructure,
  setParent,
  structRoot,
  textOf,
  writeParentTree,
  type StructNode,
  type Structure,
} from './structEdit';
import type { Box } from './textRemoval';

export interface OrderItem {
  /** Structure element ("12-0"). */
  id: string;
  type: string;
  role: string;
  /** 1-based place in the page's reading order. */
  order: number;
  /** PDF user space. */
  box: Box | null;
  mcids: number[];
  /** A link, field or comment (OBJR) rather than page content. */
  annot: boolean;
  alt: string;
  text: string;
}

export interface PageOrder {
  tagged: boolean;
  items: OrderItem[];
  /** Areas of content that is neither tagged nor an artifact. */
  untagged: Box[];
}

export type OrderType = 'P' | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'Figure' | 'Formula' | 'Table' | 'List' | 'Artifact';
export const ORDER_TYPES: OrderType[] = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Figure', 'Formula', 'Table', 'List', 'Artifact'];

function annotBox(doc: PDFDocument, obj: PDFRef): Box | null {
  const a = doc.context.lookup(obj);
  const r = a instanceof PDFDict ? a.lookup(PDFName.of('Rect')) : undefined;
  if (!(r instanceof PDFArray) || r.size() !== 4) return null;
  const v = r.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
  return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

/** Merges boxes that touch (within `gap` points). */
export function mergeBoxes(boxes: Box[], gap = 3): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    let cur = { ...b };
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (o.x0 - gap <= cur.x1 && cur.x0 - gap <= o.x1 && o.y0 - gap <= cur.y1 && cur.y0 - gap <= o.y1) {
        cur = unionBox(cur, o)!;
        out.splice(i, 1);
      }
    }
    out.push(cur);
  }
  return out;
}

function pageItems(doc: PDFDocument, st: Structure, pi: number, w: ContentWalk | null): Array<{ node: StructNode; item: OrderItem }> {
  const mc = w ? mcidContent(w) : new Map();
  const out: Array<{ node: StructNode; item: OrderItem }> = [];
  for (const n of st.nodes) {
    const mcids = n.mcids.filter((m) => m.page === pi && !m.stream).map((m) => m.mcid);
    const objrs = n.objrs.filter((o) => o.page === pi);
    if (!mcids.length && !objrs.length) continue;
    let box: Box | null = null;
    let text = '';
    for (const m of mcids) {
      box = unionBox(box, mc.get(m)?.box ?? null);
      text += mc.get(m)?.text ?? '';
    }
    for (const o of objrs) box = unionBox(box, annotBox(doc, o.obj));
    out.push({ node: n, item: { id: n.id, type: n.type, role: n.role, order: out.length + 1, box, mcids, annot: !mcids.length, alt: textOf(n.dict.lookup(PDFName.of('Alt'))), text: text.slice(0, 200) } });
  }
  return out;
}

export function readPageOrder(doc: PDFDocument, pi: number): PageOrder {
  const page = doc.getPage(pi);
  let w: ContentWalk | null = null;
  try {
    w = walkPage(doc, page);
  } catch {
    w = null;
  }
  const untagged = mergeBoxes((w?.ops ?? []).filter(isUntagged).flatMap((o) => (o.box ? [o.box] : [])));
  const st = readStructure(doc);
  if (!st) return { tagged: false, items: [], untagged };
  return { tagged: true, items: pageItems(doc, st, pi, w).map((x) => x.item), untagged };
}

const isAncestor = (a: StructNode, b: StructNode) => {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
};

const chain = (n: StructNode) => {
  const out: StructNode[] = [];
  for (let x: StructNode | null = n; x; x = x.parent) out.unshift(x);
  return out;
};

/**
 * Moves `target` to just after `prev` (or to the front of the page when
 * `prev` is null). Containers stay whole when they can: the branch holding
 * the target moves next to the branch holding `prev` and the target goes to
 * the front of its branch; otherwise the element alone moves to `prev`'s parent.
 */
function placeAfter(doc: PDFDocument, st: Structure, items: Array<{ node: StructNode; item: OrderItem }>, pi: number, target: StructNode, prev: StructNode | null): boolean {
  const anchor = prev ?? items[0].node;
  if (anchor === target || isAncestor(target, anchor) || isAncestor(anchor, target)) return false;
  const ca = chain(anchor);
  const ct = chain(target);
  let i = 0;
  while (i < ca.length && i < ct.length && ca[i] === ct[i]) i++;
  const lca = i ? ca[i - 1] : null;
  const pA = ca[i];
  const tA = ct[i];
  const lcaRef = lca ? lca.ref : st.rootRef;
  const pageOnly = (n: StructNode): boolean => n.mcids.every((m) => m.page === pi) && n.objrs.every((o) => o.page === pi) && n.children.every(pageOnly);
  const onPage = new Set(items.map((x) => x.node));
  const prevPos = prev ? items.findIndex((x) => x.node === prev) : -1;
  const nextAfterPrev = items[prevPos + 1]?.node;
  const branchOk =
    !!lcaRef &&
    !!pA.ref &&
    !!tA.ref &&
    pageOnly(tA) &&
    // Nothing of the target's branch comes before it…
    ct.slice(i, -1).every((n) => !onPage.has(n)) &&
    // …and nothing of prev's branch comes after prev.
    (!prev || !nextAfterPrev || !chain(nextAfterPrev).includes(pA) || nextAfterPrev === target);
  if (branchOk) {
    const lcaDict = lca ? lca.dict : st.root;
    detach(doc, tA.ref!);
    const at = indexInParent(doc, lcaDict, pA.ref!);
    attach(doc, tA.ref!, lcaRef!, prev ? at + 1 : at);
    // The target to the front of its branch.
    for (let j = i + 1; j < ct.length; j++) {
      const n = ct[j];
      const kids = kidsArray(doc, ct[j - 1].dict);
      const k = indexInParent(doc, ct[j - 1].dict, n.ref!);
      if (k > 0) {
        kids.remove(k);
        kids.insert(0, n.ref!);
      }
    }
    return true;
  }
  if (!target.ref || !target.parent) return false;
  const parentRef = parentRefOf(doc, anchor.dict);
  if (!parentRef || !anchor.ref) return false;
  detach(doc, target.ref);
  const parent = doc.context.lookup(parentRef) as PDFDict;
  const at = indexInParent(doc, parent, anchor.ref);
  attach(doc, target.ref, parentRef, prev ? at + 1 : at);
  return true;
}

/** Puts the page's items into the order of `ids` (item ids; missing ones keep their relative place after). */
export function reorderPage(doc: PDFDocument, pi: number, ids: string[]): boolean {
  let moved = false;
  for (let k = 0; k < ids.length; k++) {
    const st = readStructure(doc);
    if (!st) return false;
    const items = pageItems(doc, st, pi, null);
    const byId = new Map(items.map((x) => [x.item.id, x.node]));
    const target = byId.get(ids[k]);
    if (!target?.ref) continue;
    const pos = items.findIndex((x) => x.node === target);
    const prev = k === 0 ? null : (byId.get(ids[k - 1]) ?? null);
    if (k > 0 && !prev) continue;
    if ((k === 0 && pos === 0) || (prev && items[pos - 1]?.node === prev)) continue;
    if (placeAfter(doc, st, items, pi, target, prev)) moved = true;
  }
  return moved;
}

/** Replaces the BDC of each marked-content id with /Artifact BMC and drops it from the tree. */
function toArtifact(doc: PDFDocument, page: PDFPage, pi: number, nodes: StructNode[], map: Map<number, PDFObject>): void {
  const w = walkPage(doc, page);
  const mcids = new Set(nodes.flatMap((n) => n.mcids.filter((m) => m.page === pi && !m.stream).map((m) => m.mcid)));
  const edits = w.seqs.filter((s) => s.mcid !== null && mcids.has(s.mcid)).map((s) => ({ at: w.instrs[s.open].start, end: w.instrs[s.open].end, text: '/Artifact BMC' }));
  setPageContent(doc, page, spliceContent(w.src, edits));
  const parents = pageParents(doc, page, map);
  for (const m of mcids) if (m < parents.size()) parents.set(m, PDFNull);
  for (const n of nodes) {
    const kids = kidsArray(doc, n.dict);
    for (let i = kids.size() - 1; i >= 0; i--) {
      const k = kids.get(i);
      const kd = k instanceof PDFRef ? doc.context.lookup(k) : k;
      const id = k instanceof PDFNumber ? k.asNumber() : kd instanceof PDFDict && kd.lookup(PDFName.of('Type')) === PDFName.of('MCR') ? (kd.lookup(PDFName.of('MCID')) as PDFNumber | undefined)?.asNumber() : undefined;
      if (id !== undefined && mcids.has(id)) kids.remove(i);
    }
    if (!kids.size() && n.ref) detach(doc, n.ref);
  }
}

/** Rows of items by vertical overlap, top to bottom, each left to right. */
function rowsOf(list: Array<{ node: StructNode; item: OrderItem }>): Array<Array<{ node: StructNode; item: OrderItem }>> {
  const sorted = [...list].sort((a, b) => (b.item.box?.y1 ?? 0) - (a.item.box?.y1 ?? 0));
  const rows: Array<Array<{ node: StructNode; item: OrderItem }>> = [];
  for (const x of sorted) {
    const b = x.item.box;
    const row = b ? rows.find((r) => r.some((y) => y.item.box && Math.min(y.item.box.y1, b.y1) - Math.max(y.item.box.y0, b.y0) > 0.5 * Math.min(b.y1 - b.y0, y.item.box.y1 - y.item.box.y0))) : undefined;
    if (row) row.push(x);
    else rows.push([x]);
  }
  for (const r of rows) r.sort((a, b) => (a.item.box?.x0 ?? 0) - (b.item.box?.x0 ?? 0));
  return rows;
}

/** Gives the selected items a new type; List and Table wrap the selection, Artifact takes it out of the tree. */
export function retagItems(doc: PDFDocument, pi: number, ids: string[], type: OrderType): void {
  const st = readStructure(doc);
  if (!st) throw new Error('The document is not tagged.');
  const page = doc.getPage(pi);
  const all = pageItems(doc, st, pi, (() => {
    try {
      return walkPage(doc, page);
    } catch {
      return null;
    }
  })());
  const sel = all.filter((x) => ids.includes(x.item.id) && x.node.ref);
  if (!sel.length) return;
  if (type === 'Artifact') {
    const map = readParentTree(doc);
    toArtifact(doc, page, pi, sel.filter((x) => !x.item.annot).map((x) => x.node), map);
    writeParentTree(doc, map);
    return;
  }
  if (type !== 'List' && type !== 'Table') {
    for (const x of sel) {
      x.node.dict.set(PDFName.of('S'), PDFName.of(type));
      if (type === 'Figure' && x.item.box && !x.node.dict.has(PDFName.of('A'))) {
        const b = x.item.box;
        x.node.dict.set(PDFName.of('A'), doc.context.obj({ O: 'Layout', BBox: [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v * 100) / 100) }));
      }
    }
    return;
  }
  // The new list / table takes the place of the first selected item.
  const first = sel[0].node;
  const parentRef = parentRefOf(doc, first.dict)!;
  const at = indexInParent(doc, doc.context.lookup(parentRef) as PDFDict, first.ref!);
  const outer = newElement(doc, type === 'List' ? 'L' : 'Table', parentRef, page, undefined);
  // In place first, so the selection's old parent never empties out.
  attach(doc, outer.ref, parentRef, Math.max(0, at));
  for (const x of sel) detach(doc, x.node.ref!);
  if (type === 'List') {
    for (const x of sel) {
      const li = newElement(doc, 'LI', outer.ref, page, undefined);
      attach(doc, li.ref, outer.ref);
      const body = newElement(doc, 'LBody', li.ref, page, undefined);
      attach(doc, body.ref, li.ref);
      attach(doc, x.node.ref!, body.ref);
    }
    return;
  }
  rowsOf(sel).forEach((row, ri) => {
    const tr = newElement(doc, 'TR', outer.ref, page, undefined);
    attach(doc, tr.ref, outer.ref);
    for (const x of row) {
      x.node.dict.set(PDFName.of('S'), PDFName.of(ri === 0 ? 'TH' : 'TD'));
      if (ri === 0) x.node.dict.set(PDFName.of('A'), doc.context.obj({ O: 'Table', Scope: 'Column' }));
      attach(doc, x.node.ref!, tr.ref);
    }
  });
}

/** Tags the untagged content inside `rect` (PDF user space) as one new element (or marks it as artifact). Returns how many pieces. */
export function tagRegion(doc: PDFDocument, pi: number, rect: Box, type: OrderType): number {
  if (!structRoot(doc)) throw new Error('The document is not tagged.');
  const page = doc.getPage(pi);
  const w = walkPage(doc, page);
  const inside = (bb: Box | null) => {
    if (!bb) return false;
    // Lines have no height (or width): give them a little.
    const b = { x0: bb.x0 - (bb.x1 - bb.x0 < 1 ? 0.5 : 0), x1: bb.x1 + (bb.x1 - bb.x0 < 1 ? 0.5 : 0), y0: bb.y0 - (bb.y1 - bb.y0 < 1 ? 0.5 : 0), y1: bb.y1 + (bb.y1 - bb.y0 < 1 ? 0.5 : 0) };
    const ix = Math.min(b.x1, rect.x1) - Math.max(b.x0, rect.x0);
    const iy = Math.min(b.y1, rect.y1) - Math.max(b.y0, rect.y0);
    const area = Math.max((b.x1 - b.x0) * (b.y1 - b.y0), 0.01);
    return ix > 0 && iy > 0 && (ix * iy) / area >= 0.5;
  };
  const ops = w.ops.filter((o) => isUntagged(o) && inside(o.box));
  const ranges = wrappableRanges(w, ops);
  if (!ranges.length) return 0;
  if (type === 'Artifact') {
    setPageContent(doc, page, spliceContent(w.src, ranges.flatMap(([a, b]) => [{ at: w.instrs[a].start, text: '/Artifact BMC\n', order: 1 }, { at: w.instrs[b - 1].end, text: '\nEMC\n', order: 0 }])));
    return ranges.length;
  }
  const tag = type === 'List' || type === 'Table' ? 'P' : type;
  const map = readParentTree(doc);
  const parents = pageParents(doc, page, map);
  let mcid = Math.max(parents.size(), ...w.seqs.map((s) => (s.mcid ?? -1) + 1));
  const ids: number[] = [];
  const edits = ranges.flatMap(([a, b]) => {
    const id = mcid++;
    ids.push(id);
    return [
      { at: w.instrs[a].start, text: `/${tag} <</MCID ${id}>> BDC\n`, order: 1 },
      { at: w.instrs[b - 1].end, text: '\nEMC\n', order: 0 },
    ];
  });
  const box = ops.reduce<Box | null>((b, o) => unionBox(b, o.box), null);
  setPageContent(doc, page, spliceContent(w.src, edits));

  // In reading order: before the first item that starts lower on the page, else after the page's last item.
  const st = readStructure(doc)!;
  const items = pageItems(doc, st, pi, null).filter((x) => x.node.ref && x.node.parent);
  const boxes = (() => {
    const mc = mcidContent(walkPage(doc, page));
    return new Map(items.map((x) => [x.node, x.item.mcids.reduce<Box | null>((b, m) => unionBox(b, mc.get(m)?.box ?? null), null)]));
  })();
  const before = box ? items.find((x) => {
    const b = boxes.get(x.node);
    return b && b.y1 < box.y1 - 1;
  }) : undefined;
  let parentRef: PDFRef;
  let at: number;
  if (before) {
    parentRef = parentRefOf(doc, before.node.dict)!;
    at = indexInParent(doc, doc.context.lookup(parentRef) as PDFDict, before.node.ref!);
  } else if (items.length) {
    const last = items[items.length - 1].node;
    parentRef = parentRefOf(doc, last.dict)!;
    at = indexInParent(doc, doc.context.lookup(parentRef) as PDFDict, last.ref!) + 1;
  } else {
    const docEl = documentElement(doc);
    parentRef = docEl.ref;
    at = insertionIndex(doc, readStructure(doc)!, docEl, pi);
  }
  const el = newElement(doc, tag, parentRef, page, ids.length === 1 ? ids[0] : ids.map((m) => PDFNumber.of(m)));
  if (tag === 'Figure' && box) el.dict.set(PDFName.of('A'), doc.context.obj({ O: 'Layout', BBox: [box.x0, box.y0, box.x1, box.y1].map((v) => Math.round(v * 100) / 100) }));
  attach(doc, el.ref, parentRef, at);
  for (const m of ids) setParent(parents, m, el.ref);
  writeParentTree(doc, map);
  return ranges.length;
}

