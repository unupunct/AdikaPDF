/**
 * Layers (optional content groups): rename, delete with their content,
 * merge into one, flatten (the visible content stays, the layers go), and
 * the layer new objects are drawn in. Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFRef, PDFString, type PDFObject } from 'pdf-lib';
import { pageContent, parseContent, resourcesOf } from './textRemoval';

export interface LayerInfo {
  /** pdf.js' id of the layer ("12R"). */
  id: string;
  ref: PDFRef;
  name: string;
}

const idOf = (r: PDFRef) => (r.generationNumber ? `${r.objectNumber}R${r.generationNumber}` : `${r.objectNumber}R`);
const textOf = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : '');

function ocProps(doc: PDFDocument): PDFDict | undefined {
  const p = doc.catalog.lookup(PDFName.of('OCProperties'));
  return p instanceof PDFDict ? p : undefined;
}

export function listLayers(doc: PDFDocument): LayerInfo[] {
  const ocgs = ocProps(doc)?.lookup(PDFName.of('OCGs'));
  if (!(ocgs instanceof PDFArray)) return [];
  const out: LayerInfo[] = [];
  for (let i = 0; i < ocgs.size(); i++) {
    const r = ocgs.get(i);
    if (!(r instanceof PDFRef)) continue;
    const d = doc.context.lookup(r);
    out.push({ id: idOf(r), ref: r, name: d instanceof PDFDict ? textOf(d.lookup(PDFName.of('Name'))) : '' });
  }
  return out;
}

function refById(doc: PDFDocument, id: string): PDFRef {
  const l = listLayers(doc).find((x) => x.id === id);
  if (!l) throw new Error('That layer is no longer in the document.');
  return l.ref;
}

export function renameLayer(doc: PDFDocument, id: string, name: string): void {
  const d = doc.context.lookup(refById(doc, id));
  if (d instanceof PDFDict) d.set(PDFName.of('Name'), PDFHexString.fromText(name));
}

/** Does a /OC value (an OCG or an OCMD) belong to one of the layers? */
function belongs(doc: PDFDocument, v: PDFObject | undefined, refs: PDFRef[]): boolean {
  if (!v) return false;
  if (v instanceof PDFRef && refs.some((r) => r === v || (r.objectNumber === v.objectNumber && r.generationNumber === v.generationNumber))) return true;
  const d = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (d instanceof PDFDict && d.lookup(PDFName.of('Type')) === PDFName.of('OCMD')) {
    const o = d.get(PDFName.of('OCGs'));
    if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) if (!belongs(doc, o.get(i), refs)) return false;
      return o.size() > 0;
    }
    return belongs(doc, o, refs);
  }
  return false;
}

/** Removes the marked content of the layers (`/OC /name BDC … EMC`), and XObjects / annotations in them. */
function removeContent(doc: PDFDocument, page: PDFPage, refs: PDFRef[]): void {
  const res = resourcesOf(page);
  const props = res?.lookup(PDFName.of('Properties'));
  const xobjs = res?.lookup(PDFName.of('XObject'));
  const inLayer = (name: string) => props instanceof PDFDict && belongs(doc, props.get(PDFName.of(name)), refs);
  const src = pageContent(doc, page);
  const instrs = parseContent(src);
  const cut: Array<[number, number]> = [];
  let depth = 0;
  let cutDepth = -1;
  let cutStart = 0;
  instrs.forEach((ins) => {
    if (ins.op === 'BDC' || ins.op === 'BMC') {
      depth++;
      if (cutDepth < 0 && ins.op === 'BDC' && ins.args[0]?.k === 'name' && ins.args[0].v === 'OC' && ins.args[1]?.k === 'name' && inLayer(ins.args[1].v)) {
        cutDepth = depth;
        cutStart = ins.start;
      }
    } else if (ins.op === 'EMC') {
      if (depth === cutDepth) {
        cut.push([cutStart, ins.end]);
        cutDepth = -1;
      }
      depth = Math.max(0, depth - 1);
    } else if (cutDepth < 0 && ins.op === 'Do' && ins.args[0]?.k === 'name' && xobjs instanceof PDFDict) {
      const x = xobjs.lookup(PDFName.of(ins.args[0].v));
      const oc = x && 'dict' in (x as object) ? (x as unknown as { dict: PDFDict }).dict.get(PDFName.of('OC')) : undefined;
      if (belongs(doc, oc, refs)) cut.push([ins.start, ins.end]);
    }
  });
  if (cut.length) {
    const parts: Uint8Array[] = [];
    let last = 0;
    for (const [a, b] of cut) {
      parts.push(src.subarray(last, a));
      last = b;
    }
    parts.push(src.subarray(last));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
  }
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    const keep: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict && belongs(doc, a.get(PDFName.of('OC')), refs))) keep.push(annots.get(i));
    }
    if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
}

/** Takes OCG references out of an array (OCGs, ON, OFF, Order, nested Order arrays). */
function prune(doc: PDFDocument, arr: PDFObject | undefined, refs: PDFRef[]): void {
  const a = arr instanceof PDFRef ? doc.context.lookup(arr) : arr;
  if (!(a instanceof PDFArray)) return;
  for (let i = a.size() - 1; i >= 0; i--) {
    const v = a.get(i);
    if (v instanceof PDFRef && refs.some((r) => r.objectNumber === v.objectNumber)) a.remove(i);
    else if (v instanceof PDFArray) prune(doc, v, refs);
  }
}

function dropFromProperties(doc: PDFDocument, refs: PDFRef[]): void {
  const props = ocProps(doc);
  if (!props) return;
  prune(doc, props.get(PDFName.of('OCGs')), refs);
  const configs: PDFDict[] = [];
  const d = props.lookup(PDFName.of('D'));
  if (d instanceof PDFDict) configs.push(d);
  const more = props.lookup(PDFName.of('Configs'));
  if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) if (more.lookup(i) instanceof PDFDict) configs.push(more.lookup(i) as PDFDict);
  for (const c of configs) for (const k of ['ON', 'OFF', 'Order', 'Locked', 'RBGroups']) prune(doc, c.get(PDFName.of(k)), refs);
  const left = props.lookup(PDFName.of('OCGs'));
  if (!(left instanceof PDFArray) || left.size() === 0) doc.catalog.delete(PDFName.of('OCProperties'));
}

/** Deletes layers and everything drawn in them. */
export function deleteLayers(doc: PDFDocument, ids: string[]): void {
  const refs = ids.map((id) => refById(doc, id));
  for (const p of doc.getPages()) removeContent(doc, p, refs);
  dropFromProperties(doc, refs);
}

/** Merges layers into `into`: their content is in that layer from now on. */
export function mergeLayers(doc: PDFDocument, ids: string[], into: string): void {
  const target = refById(doc, into);
  const refs = ids.filter((i) => i !== into).map((id) => refById(doc, id));
  if (!refs.length) return;
  for (const page of doc.getPages()) {
    const props = resourcesOf(page)?.lookup(PDFName.of('Properties'));
    if (props instanceof PDFDict) for (const [k, v] of props.entries()) if (belongs(doc, v, refs)) props.set(k, target);
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray)
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (a instanceof PDFDict && belongs(doc, a.get(PDFName.of('OC')), refs)) a.set(PDFName.of('OC'), target);
      }
    const xo = resourcesOf(page)?.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict)
      for (const [, v] of xo.entries()) {
        const x = v instanceof PDFRef ? doc.context.lookup(v) : v;
        const dict = x && 'dict' in (x as object) ? (x as unknown as { dict: PDFDict }).dict : undefined;
        if (dict && belongs(doc, dict.get(PDFName.of('OC')), refs)) dict.set(PDFName.of('OC'), target);
      }
  }
  dropFromProperties(doc, refs);
}

/** Flattens the layers: content of the hidden ones is removed, the rest stays as ordinary page content. */
export function flattenLayers(doc: PDFDocument, hiddenIds: string[]): void {
  const all = listLayers(doc);
  const hidden = all.filter((l) => hiddenIds.includes(l.id)).map((l) => l.ref);
  if (hidden.length) for (const p of doc.getPages()) removeContent(doc, p, hidden);
  doc.catalog.delete(PDFName.of('OCProperties'));
}

/**
 * The layer named `name` (created when missing, visible) and the name of its
 * entry in the page's /Properties, for `/OC /name BDC … EMC` around content.
 */
export function layerForContent(doc: PDFDocument, page: PDFPage, name: string): string {
  let props = ocProps(doc);
  if (!props) {
    props = doc.context.obj({ OCGs: [], D: { Order: [], ON: [], OFF: [] } }) as PDFDict;
    doc.catalog.set(PDFName.of('OCProperties'), props);
  }
  let ref = listLayers(doc).find((l) => l.name === name)?.ref;
  if (!ref) {
    ref = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFHexString.fromText(name) }));
    (props.lookup(PDFName.of('OCGs')) as PDFArray).push(ref);
    const d = props.lookup(PDFName.of('D'));
    if (d instanceof PDFDict) {
      const order = d.lookup(PDFName.of('Order'));
      if (order instanceof PDFArray) order.push(ref);
      else d.set(PDFName.of('Order'), doc.context.obj([ref]));
    }
  }
  let res = page.node.lookup(PDFName.of('Resources'));
  if (!(res instanceof PDFDict)) {
    res = doc.context.obj({});
    page.node.set(PDFName.of('Resources'), res);
  }
  let pr = (res as PDFDict).lookup(PDFName.of('Properties'));
  if (!(pr instanceof PDFDict)) {
    pr = doc.context.obj({});
    (res as PDFDict).set(PDFName.of('Properties'), pr);
  }
  for (const [k, v] of (pr as PDFDict).entries()) if (v === ref) return k.decodeText();
  let n = 1;
  while ((pr as PDFDict).has(PDFName.of(`AdkOC${n}`))) n++;
  (pr as PDFDict).set(PDFName.of(`AdkOC${n}`), ref);
  return `AdkOC${n}`;
}
