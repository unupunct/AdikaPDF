/**
 * What still points at a page that left the document (deleted, or replaced
 * by a redaction raster) keeps it — and its text — in the saved file:
 * bookmarks, named destinations, links, the open action, form widgets and
 * the structure tree. `retargetPageRefs` moves those references to the
 * page's replacement or drops them; `scrubStructTree` removes the tags of
 * gone pages and the alternate text of redacted content.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';

/**
 * Replaces every reference to a key of `fates` (a page ref) by its value:
 * the page that took its place, or nothing (null) — a dictionary entry is
 * deleted, an array item becomes null, a destination to it is dropped.
 */
export function retargetPageRefs(doc: PDFDocument, fates: Map<string, PDFRef | null>): void {
  if (!fates.size) return;
  const ctx = doc.context;
  const gone = (v: unknown) => v instanceof PDFRef && fates.has(v.toString());
  // A destination array whose page is deleted.
  const deadDest = (v: unknown) => {
    const arr = v instanceof PDFRef ? ctx.lookup(v) : v;
    if (!(arr instanceof PDFArray) || arr.size() === 0) return false;
    const first = arr.get(0);
    return gone(first) && fates.get(first.toString()) === null;
  };
  const seen = new Set<unknown>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (stack.length) {
    let v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.toString())) continue;
      seen.add(v.toString());
      v = ctx.lookup(v);
    }
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof PDFStream) stack.push(v.dict);
    else if (v instanceof PDFDict) {
      for (const [k, x] of v.entries()) {
        if (gone(x)) {
          const to = fates.get(x.toString());
          if (to) v.set(k, to);
          else v.delete(k);
        } else if ((k === PDFName.of('D') || k === PDFName.of('Dest') || k === PDFName.of('OpenAction')) && deadDest(x)) v.delete(k);
        else stack.push(x);
      }
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) {
        const x = v.get(i);
        if (gone(x)) v.set(i, fates.get(x.toString()) ?? PDFNull);
        else stack.push(x);
      }
    }
  }
}

export interface StructScrub {
  /** Pages whose marked content is gone (deleted or rasterised): their tags go. */
  gonePages: Set<string>;
  /** Annotations taken off their page: their object references go. */
  goneObjs: Set<string>;
  /** Page ref -> marked-content ids that were redacted: their tags lose /Alt, /ActualText and /E. */
  mcids: Map<string, Set<number>>;
}

const TEXT_KEYS = ['Alt', 'ActualText', 'E'];

/** Cleans the structure tree (tags) after redaction / page removal. Returns the number of tags removed. */
export function scrubStructTree(doc: PDFDocument, s: StructScrub): number {
  const ctx = doc.context;
  const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  if (!(root instanceof PDFDict)) return 0;
  const dropped = new Set<string>();
  const visited = new Set<PDFDict>();
  const refKey = (v: unknown) => (v instanceof PDFRef ? v.toString() : undefined);
  const lookup = (v: unknown) => (v instanceof PDFRef ? ctx.lookup(v) : v);

  /** Filters an element's kids; returns whether the element keeps any content and whether its text must go. */
  const visit = (elem: PDFDict, inheritedPg: string | undefined, depth: number): { keep: boolean; scrub: boolean } => {
    if (visited.has(elem) || depth > 256) return { keep: true, scrub: false };
    visited.add(elem);
    const pg = refKey(elem.get(PDFName.of('Pg'))) ?? inheritedPg;
    const k = elem.get(PDFName.of('K'));
    const kArr = lookup(k);
    const items: unknown[] = kArr instanceof PDFArray ? kArr.asArray() : k === undefined ? [] : [k];
    let scrub = false;
    const kept: unknown[] = [];
    for (const item of items) {
      const d = lookup(item);
      if (d instanceof PDFNumber) {
        if (pg && s.gonePages.has(pg)) continue;
        if (pg && s.mcids.get(pg)?.has(d.asNumber())) scrub = true;
        kept.push(item);
      } else if (d instanceof PDFDict) {
        const type = d.lookup(PDFName.of('Type'));
        if (type === PDFName.of('MCR')) {
          const mpg = refKey(d.get(PDFName.of('Pg'))) ?? pg;
          if (mpg && s.gonePages.has(mpg)) continue;
          const id = d.lookup(PDFName.of('MCID'));
          if (mpg && id instanceof PDFNumber && s.mcids.get(mpg)?.has(id.asNumber())) scrub = true;
          kept.push(item);
        } else if (type === PDFName.of('OBJR')) {
          const obj = d.get(PDFName.of('Obj'));
          const opg = refKey(d.get(PDFName.of('Pg'))) ?? pg;
          const target = lookup(obj);
          const apg = target instanceof PDFDict ? refKey(target.get(PDFName.of('P'))) : undefined;
          if ((refKey(obj) && s.goneObjs.has(refKey(obj)!)) || (opg && s.gonePages.has(opg)) || (apg && s.gonePages.has(apg))) continue;
          kept.push(item);
        } else {
          const r = visit(d, pg, depth + 1);
          if (r.scrub) scrub = true;
          if (!r.keep) {
            const key = refKey(item);
            if (key) dropped.add(key);
            continue;
          }
          kept.push(item);
        }
      } else kept.push(item);
    }
    if (kept.length !== items.length) {
      if (kept.length === 0) elem.delete(PDFName.of('K'));
      else elem.set(PDFName.of('K'), kept.length === 1 && !(lookup(kept[0]) instanceof PDFNumber) ? (kept[0] as PDFRef) : ctx.obj(kept as never[]));
    }
    if (scrub) for (const key of TEXT_KEYS) elem.delete(PDFName.of(key));
    const ownPgGone = !!pg && s.gonePages.has(pg);
    const keep = !(items.length > 0 && kept.length === 0) && !(ownPgGone && kept.length === 0);
    return { keep, scrub };
  };

  const top = root.get(PDFName.of('K'));
  const topArr = lookup(top);
  const topItems: unknown[] = topArr instanceof PDFArray ? topArr.asArray() : top === undefined ? [] : [top];
  const topKept = topItems.filter((item) => {
    const d = lookup(item);
    if (!(d instanceof PDFDict)) return true;
    const r = visit(d, undefined, 0);
    if (!r.keep && refKey(item)) dropped.add(refKey(item)!);
    return r.keep;
  });
  if (topKept.length !== topItems.length) root.set(PDFName.of('K'), ctx.obj(topKept as never[]));

  // Parent tree (MCID / annotation -> tag) and ID tree: no entry may point at a removed tag.
  const isDropped = (v: unknown) => !!refKey(v) && dropped.has(refKey(v)!);
  const cleanTree = (node: unknown, leafKey: 'Nums' | 'Names', depth = 0) => {
    const d = lookup(node);
    if (!(d instanceof PDFDict) || depth > 64) return;
    const leaf = d.lookup(PDFName.of(leafKey));
    if (leaf instanceof PDFArray) {
      const out: unknown[] = [];
      for (let i = 0; i + 1 < leaf.size(); i += 2) {
        const key = leaf.get(i);
        const val = leaf.get(i + 1);
        const arr = lookup(val);
        if (isDropped(val)) continue;
        if (arr instanceof PDFArray) for (let j = 0; j < arr.size(); j++) if (isDropped(arr.get(j))) arr.set(j, PDFNull);
        out.push(key, val);
      }
      if (out.length !== leaf.size()) d.set(PDFName.of(leafKey), ctx.obj(out as never[]));
    }
    const kids = d.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) cleanTree(kids.get(i), leafKey, depth + 1);
  };
  if (dropped.size) {
    cleanTree(root.get(PDFName.of('ParentTree')), 'Nums');
    cleanTree(root.get(PDFName.of('IDTree')), 'Names');
  }
  return dropped.size;
}
