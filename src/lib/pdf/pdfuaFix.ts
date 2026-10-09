/**
 * Fixes for PDF/UA failures (`pdfua.ts`), each opt-in: metadata (PDF/UA
 * identifier, title), DisplayDocTitle, language, MarkInfo, role mapping,
 * structure elements for links / fields / comments (OBJR), tab order, link
 * and field descriptions, list structure (LBody, ListNumbering), table header
 * scope, note IDs, layer configurations, file names of attachments, CIDSet,
 * and untagged content (running headers, footers, page numbers and drawings
 * become artifacts; text a paragraph, pictures figures). Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject, type PDFPage } from 'pdf-lib';
import { isUntagged, unionBox, walkPage, wrappableRanges, spliceContent, setPageContent } from './contentWalk';
import {
  attach,
  documentElement,
  idOf,
  kidsArray,
  kidsOf,
  newElement,
  nextParentKey,
  pageParents,
  readParentTree,
  readStructure,
  resolveRole,
  setParent,
  STANDARD_TYPES,
  structRoot,
  textOf,
  writeParentTree,
  type StructNode,
  type Structure,
} from './structEdit';
import { cidSetMissing, fileSpecs, numberingOf, pageAnnots, structAttr, type UaFix } from './pdfua';
import { readXmpFields, readXmpPacket, writeXmp } from './xmp';
import { humanize, makeAccessible } from './accessibility';
import type { Box } from './textRemoval';

export interface UaFixOptions {
  fixes: UaFix[];
  /** For the metadata title when the document has none. */
  title?: string;
  /** BCP 47 language for the Lang fix. */
  lang?: string;
}

const deref = (doc: PDFDocument, v: PDFObject | undefined) => (v instanceof PDFRef ? doc.context.lookup(v) : v);

export async function fixPdfUa(bytes: Uint8Array, opts: UaFixOptions): Promise<{ bytes: Uint8Array; applied: UaFix[] }> {
  const applied: UaFix[] = [];
  let input = bytes;
  if (opts.fixes.includes('tagDocument')) {
    const probe = await PDFDocument.load(bytes, { updateMetadata: false });
    if (!structRoot(probe)) {
      input = (await makeAccessible(bytes, { title: opts.title ?? '', lang: opts.lang ?? '', alt: {}, decorative: [], tag: true })).bytes;
      applied.push('tagDocument');
    }
  }
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  applied.push(...applyUaFixes(doc, opts));
  return { bytes: await doc.save({ useObjectStreams: true }), applied };
}

/** Applies the fixes to a loaded document; returns those that changed something. */
export function applyUaFixes(doc: PDFDocument, opts: UaFixOptions): UaFix[] {
  const want = new Set(opts.fixes);
  const done: UaFix[] = [];
  const run = (f: UaFix, fn: () => boolean) => {
    if (want.has(f) && fn()) done.push(f);
  };
  run('metadata', () => fixMetadata(doc, opts.title ?? ''));
  run('displayDocTitle', () => {
    let vp = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
    if (!(vp instanceof PDFDict)) {
      vp = doc.context.obj({});
      doc.catalog.set(PDFName.of('ViewerPreferences'), vp);
    }
    (vp as PDFDict).set(PDFName.of('DisplayDocTitle'), doc.context.obj(true));
    return true;
  });
  run('language', () => {
    const lang = opts.lang?.trim();
    if (!lang) return false;
    doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
    return true;
  });
  const tagged = !!structRoot(doc);
  const markInfo = () => {
    let mi = doc.catalog.lookup(PDFName.of('MarkInfo'));
    if (!(mi instanceof PDFDict)) {
      mi = doc.context.obj({});
      doc.catalog.set(PDFName.of('MarkInfo'), mi);
    }
    return mi as PDFDict;
  };
  run('marked', () => tagged && (markInfo().set(PDFName.of('Marked'), doc.context.obj(true)), true));
  run('suspects', () => (markInfo().set(PDFName.of('Suspects'), doc.context.obj(false)), true));
  run('tabs', () => {
    let any = false;
    for (const p of doc.getPages()) {
      const a = p.node.lookup(PDFName.of('Annots'));
      if (a instanceof PDFArray && a.size()) {
        p.node.set(PDFName.of('Tabs'), PDFName.of('S'));
        any = true;
      }
    }
    return any;
  });
  run('linkContents', () => {
    let any = false;
    doc.getPages().forEach((p, pi) => {
      for (const a of pageAnnots(doc, p, pi)) {
        if (a.subtype !== 'Link' || textOf(a.dict.lookup(PDFName.of('Contents'))).trim()) continue;
        const action = a.dict.lookup(PDFName.of('A'));
        const uri = action instanceof PDFDict ? textOf(action.lookup(PDFName.of('URI'))) : '';
        a.dict.set(PDFName.of('Contents'), PDFHexString.fromText(uri ? `Link: ${uri.replace(/^mailto:/i, '')}` : 'Link to another page'));
        any = true;
      }
    });
    return any;
  });
  run('fieldTU', () => {
    let any = false;
    doc.getPages().forEach((p, pi) => {
      for (const a of pageAnnots(doc, p, pi)) {
        if (a.subtype !== 'Widget') continue;
        // The field: the widget itself or its parent with the name.
        let field: PDFDict = a.dict;
        const names: string[] = [];
        for (let d: PDFDict | undefined = a.dict, i = 0; d && i < 20; i++) {
          if (textOf(d.lookup(PDFName.of('TU'))).trim()) {
            names.length = 0;
            break;
          }
          const t = textOf(d.lookup(PDFName.of('T')));
          if (t) {
            if (!names.length) field = d;
            names.unshift(t);
          }
          const par: PDFObject | undefined = d.lookup(PDFName.of('Parent'));
          d = par instanceof PDFDict ? par : undefined;
        }
        if (!names.length && textOf(field.lookup(PDFName.of('TU'))).trim()) continue;
        if (textOf(field.lookup(PDFName.of('TU'))).trim()) continue;
        field.set(PDFName.of('TU'), PDFHexString.fromText(names.length ? humanize(names.join('.')) : 'Form field'));
        any = true;
      }
    });
    return any;
  });
  run('ocConfig', () => {
    const ocp = doc.catalog.lookup(PDFName.of('OCProperties'));
    if (!(ocp instanceof PDFDict)) return false;
    let any = false;
    const list: PDFDict[] = [];
    const d = ocp.lookup(PDFName.of('D'));
    if (d instanceof PDFDict) list.push(d);
    const configs = ocp.lookup(PDFName.of('Configs'));
    if (configs instanceof PDFArray) for (const c of configs.asArray()) {
      const cd = deref(doc, c);
      if (cd instanceof PDFDict) list.push(cd);
    }
    list.forEach((c, i) => {
      if (!textOf(c.lookup(PDFName.of('Name'))).trim()) {
        c.set(PDFName.of('Name'), PDFHexString.fromText(i === 0 && c === d ? 'Default' : `Configuration ${i}`));
        any = true;
      }
      if (c.has(PDFName.of('AS'))) {
        c.delete(PDFName.of('AS'));
        any = true;
      }
    });
    return any;
  });
  run('fileSpec', () => {
    let any = false;
    for (const fs of fileSpecs(doc)) {
      const f = fs.dict.lookup(PDFName.of('F'));
      const uf = fs.dict.lookup(PDFName.of('UF'));
      const name = textOf(uf) || textOf(f) || fs.name || 'attachment';
      if (!f) fs.dict.set(PDFName.of('F'), PDFString.of(name.replace(/[^\x20-\x7e]/g, '_')));
      if (!uf) fs.dict.set(PDFName.of('UF'), PDFHexString.fromText(name));
      any ||= !f || !uf;
    }
    return any;
  });
  run('cidSet', () => {
    let any = false;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.lookup(PDFName.of('Type')) === PDFName.of('FontDescriptor') && obj.has(PDFName.of('CIDSet')) && cidSetMissing(doc, obj)) {
        obj.delete(PDFName.of('CIDSet'));
        any = true;
      }
    }
    return any;
  });
  if (!structRoot(doc)) return done;

  const map = readParentTree(doc);
  let treeChanged = false;
  const changed = (v: boolean) => {
    treeChanged ||= v;
    return v;
  };
  run('roleMap', () => changed(fixRoleMap(doc)));
  run('noteIds', () => {
    const st = readStructure(doc)!;
    const notes = st.nodes.filter((n) => n.role === 'Note');
    const used = new Map<string, number>();
    for (const n of notes) {
      const id = textOf(n.dict.lookup(PDFName.of('ID')));
      if (id) used.set(id, (used.get(id) ?? 0) + 1);
    }
    let k = 1;
    let any = false;
    const all = new Set(st.nodes.map((n) => textOf(n.dict.lookup(PDFName.of('ID')))).filter(Boolean));
    for (const n of notes) {
      const id = textOf(n.dict.lookup(PDFName.of('ID')));
      if (id && used.get(id) === 1) continue;
      if (id) used.set(id, (used.get(id) ?? 1) - 1);
      while (all.has(`note-${k}`)) k++;
      all.add(`note-${k}`);
      n.dict.set(PDFName.of('ID'), PDFString.of(`note-${k}`));
      any = true;
    }
    return any;
  });
  run('listBody', () => changed(fixLists(doc, map)));
  run('listNumbering', () => fixListNumbering(doc));
  run('thScope', () => fixThScope(doc));
  run('annotTags', () => changed(fixAnnotTags(doc, map)));
  run('untagged', () => changed(fixUntagged(doc, map)));
  if (treeChanged) writeParentTree(doc, map);
  return done;
}

// ---------------------------------------------------------------- metadata

function fixMetadata(doc: PDFDocument, fallbackTitle: string): boolean {
  const fields = readXmpFields(doc);
  const title = fields?.title || doc.getTitle()?.trim() || fallbackTitle.trim();
  if (!readXmpPacket(doc) || (!fields?.title && title)) {
    writeXmp(
      doc,
      fields
        ? { ...fields, title }
        : { title, authors: doc.getAuthor() ? [doc.getAuthor()!] : [], description: doc.getSubject() ?? '', keywords: doc.getKeywords() ?? '', rightsStatus: 'unknown', copyright: '', copyrightUrl: '' },
    );
  }
  let xmp = readXmpPacket(doc) ?? '';
  const ua = '<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description>';
  if (/<pdfuaid:part>[^<]*<\/pdfuaid:part>/.test(xmp)) xmp = xmp.replace(/<pdfuaid:part>[^<]*<\/pdfuaid:part>/, '<pdfuaid:part>1</pdfuaid:part>');
  else if (/pdfuaid:part\s*=\s*["'][^"']*["']/.test(xmp)) xmp = xmp.replace(/pdfuaid:part\s*=\s*["'][^"']*["']/, 'pdfuaid:part="1"');
  else xmp = xmp.replace(/<\/rdf:RDF>/, `${ua}</rdf:RDF>`);
  const stream = doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return true;
}

// ---------------------------------------------------------------- role map

/** A standard type for a non-standard one: by its name, else by what it holds. */
export function guessRole(type: string, n?: StructNode): string {
  const t = type.toLowerCase();
  const by: Array<[RegExp, string]> = [
    [/^h(ead(ing)?)?([1-6])$/, 'H$3'],
    [/^(title|heading|head)$/, 'H1'],
    [/^(para(graph)?|text|body ?text|normal)$/, 'P'],
    [/^(image|img|picture|graphic|photo)$/, 'Figure'],
    [/^(list)$/, 'L'],
    [/^(list ?item|item)$/, 'LI'],
    [/^(table)$/, 'Table'],
    [/^(row)$/, 'TR'],
    [/^(cell)$/, 'TD'],
    [/^(header ?cell)$/, 'TH'],
    [/^(foot ?note|endnote|note)$/, 'Note'],
    [/^(link|hyperlink)$/, 'Link'],
    [/^(article)$/, 'Art'],
    [/^(section|chapter)$/, 'Sect'],
    [/^(textbox|frame|box|group|container)$/, 'Div'],
    [/^(caption)$/, 'Caption'],
    [/^(quote)$/, 'Quote'],
    [/^(code)$/, 'Code'],
    [/^(span|char|inline|emphasis|strong|em|b|i)$/, 'Span'],
  ];
  for (const [re, role] of by) if (re.test(t)) return t.replace(re, role);
  if (n && n.children.length && !n.mcids.length) return 'Div';
  if (n?.parent && ['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Span', 'Link', 'LBody', 'TD', 'TH', 'Caption', 'Quote', 'Note'].includes(n.parent.role)) return 'Span';
  return 'P';
}

function fixRoleMap(doc: PDFDocument): boolean {
  const root = structRoot(doc)!;
  const st = readStructure(doc)!;
  let rm = root.lookup(PDFName.of('RoleMap'));
  if (!(rm instanceof PDFDict)) {
    rm = doc.context.obj({});
    root.set(PDFName.of('RoleMap'), rm);
  }
  const roleMap = rm as PDFDict;
  let any = false;
  for (const k of [...roleMap.keys()]) {
    if (STANDARD_TYPES.has(k.decodeText())) {
      roleMap.delete(k);
      any = true;
    }
  }
  const current = new Map<string, string>();
  for (const [k, v] of roleMap.entries()) if (v instanceof PDFName) current.set(k.decodeText(), v.decodeText());
  const done = new Set<string>();
  for (const n of st.nodes) {
    if (STANDARD_TYPES.has(n.type) || done.has(n.type)) continue;
    done.add(n.type);
    const r = resolveRole(n.type, current);
    if (!r.circular && STANDARD_TYPES.has(r.role)) continue;
    roleMap.set(PDFName.of(n.type), PDFName.of(guessRole(n.type, n)));
    current.set(n.type, guessRole(n.type, n));
    any = true;
  }
  return any;
}

// ---------------------------------------------------------------- lists and tables

/** A kid of a structure element moves to a new parent: its /P, or the ParentTree for content. */
function reparentKid(doc: PDFDocument, kid: PDFObject, newRef: PDFRef, page: number, map: Map<number, PDFObject>): void {
  if (kid instanceof PDFNumber) {
    if (page >= 0) setParent(pageParents(doc, doc.getPage(page), map), kid.asNumber(), newRef);
    return;
  }
  const d = deref(doc, kid);
  if (!(d instanceof PDFDict)) return;
  const type = d.lookup(PDFName.of('Type'));
  if (type === PDFName.of('MCR')) {
    const m = d.lookup(PDFName.of('MCID'));
    const pg = d.get(PDFName.of('Pg'));
    const pi = pg instanceof PDFRef ? doc.getPages().findIndex((p) => p.ref === pg || idOf(p.ref) === idOf(pg)) : page;
    if (m instanceof PDFNumber && pi >= 0 && !d.has(PDFName.of('Stm'))) setParent(pageParents(doc, doc.getPage(pi), map), m.asNumber(), newRef);
  } else if (type === PDFName.of('OBJR')) {
    const obj = d.lookup(PDFName.of('Obj'));
    const sp = obj instanceof PDFDict ? obj.lookup(PDFName.of('StructParent')) : undefined;
    if (sp instanceof PDFNumber) map.set(sp.asNumber(), newRef);
  } else if (d.has(PDFName.of('S'))) d.set(PDFName.of('P'), newRef);
}

/** Wraps kids [from, to) of an element into a new chain of elements (e.g. LI > LBody). */
function wrapKids(doc: PDFDocument, n: StructNode, indexes: number[], chain: string[], map: Map<number, PDFObject>): void {
  if (!n.ref || !indexes.length) return;
  const kids = kidsArray(doc, n.dict);
  const moved = indexes.map((i) => kids.get(i));
  const pg = n.dict.get(PDFName.of('Pg'));
  const page = pg instanceof PDFRef ? doc.getPages().findIndex((p) => idOf(p.ref) === idOf(pg)) : n.page;
  const pgPage = page >= 0 ? doc.getPage(page) : null;
  // Outermost new element takes the place of the first moved kid.
  let parentRef = n.ref;
  let outer: PDFRef | null = null;
  let inner: PDFRef = n.ref;
  for (const t of chain) {
    const e = newElement(doc, t, parentRef, pgPage, undefined);
    if (outer === null) outer = e.ref;
    else kidsArray(doc, doc.context.lookup(parentRef) as PDFDict).push(e.ref);
    parentRef = e.ref;
    inner = e.ref;
  }
  const innerDict = doc.context.lookup(inner) as PDFDict;
  const innerKids = kidsArray(doc, innerDict);
  for (const k of moved) {
    innerKids.push(k);
    reparentKid(doc, k, inner, page, map);
  }
  for (const i of [...indexes].sort((a, b) => b - a)) kids.remove(i);
  kids.insert(Math.min(indexes[0], kids.size()), outer!);
}

function kidRole(doc: PDFDocument, st: Structure, kid: PDFObject): string | null {
  const d = deref(doc, kid);
  if (!(d instanceof PDFDict)) return null;
  const s = d.lookup(PDFName.of('S'));
  return s instanceof PDFName ? resolveRole(s.decodeText(), st.roleMap).role : null;
}

function fixLists(doc: PDFDocument, map: Map<number, PDFObject>): boolean {
  const st = readStructure(doc)!;
  let any = false;
  for (const n of st.nodes) {
    if (n.role !== 'L' && n.role !== 'LI') continue;
    const allowed = n.role === 'L' ? ['LI', 'L', 'Caption'] : ['Lbl', 'LBody'];
    const kids = kidsOf(doc, n.dict);
    const bad = kids.map((k, i) => [k, i] as const).filter(([k]) => !allowed.includes(kidRole(doc, st, k) ?? '')).map(([, i]) => i);
    if (!bad.length) continue;
    if (n.role === 'LI') wrapKids(doc, n, bad, ['LBody'], map);
    // In a list each stray kid becomes an item of its own.
    else for (const i of [...bad].reverse()) wrapKids(doc, n, [i], ['LI', 'LBody'], map);
    any = true;
  }
  return any;
}

function setAttr(doc: PDFDocument, d: PDFDict, owner: string, key: string, value: PDFObject): void {
  const a = deref(doc, d.get(PDFName.of('A')));
  const list = a instanceof PDFArray ? a.asArray().map((x) => deref(doc, x)) : [a];
  for (const x of list) if (x instanceof PDFDict && x.lookup(PDFName.of('O')) === PDFName.of(owner)) {
    x.set(PDFName.of(key), value);
    return;
  }
  const attr = doc.context.obj({ O: owner });
  attr.set(PDFName.of(key), value);
  if (a instanceof PDFArray) a.push(attr);
  else if (a instanceof PDFDict) d.set(PDFName.of('A'), doc.context.obj([a, attr]));
  else d.set(PDFName.of('A'), attr);
}

function fixListNumbering(doc: PDFDocument): boolean {
  const st = readStructure(doc)!;
  const pages = doc.getPages();
  const textCache = new Map<number, Map<number, string>>();
  const mcText = (page: number, mcid: number) => {
    if (!textCache.has(page)) {
      const m = new Map<number, string>();
      try {
        const w = walkPage(doc, pages[page]);
        for (const op of w.ops) if (op.mcid !== null && op.text) m.set(op.mcid, (m.get(op.mcid) ?? '') + op.text);
      } catch {
        /* unreadable */
      }
      textCache.set(page, m);
    }
    return textCache.get(page)!.get(mcid) ?? '';
  };
  let any = false;
  for (const l of st.nodes.filter((n) => n.role === 'L')) {
    const labels = l.children
      .filter((c) => c.role === 'LI')
      .map((li) => li.children.find((c) => c.role === 'Lbl'))
      .filter((x): x is StructNode => !!x)
      .map((lbl) => textOf(lbl.dict.lookup(PDFName.of('ActualText'))) || lbl.mcids.map((m) => (m.page >= 0 ? mcText(m.page, m.mcid) : '')).join(''));
    const want = numberingOf(labels);
    const has = structAttr(doc, l.dict, 'ListNumbering', 'List');
    if (!want || (has instanceof PDFName && has.decodeText() !== 'None')) continue;
    setAttr(doc, l.dict, 'List', 'ListNumbering', PDFName.of(want));
    any = true;
  }
  return any;
}

function fixThScope(doc: PDFDocument): boolean {
  const st = readStructure(doc)!;
  let any = false;
  for (const t of st.nodes.filter((n) => n.role === 'Table')) {
    const rows: StructNode[] = [];
    const collect = (n: StructNode) => n.children.forEach((c) => (c.role === 'TR' ? rows.push(c) : ['THead', 'TBody', 'TFoot'].includes(c.role) ? collect(c) : undefined));
    collect(t);
    const cells = rows.flatMap((r) => r.children.filter((c) => c.role === 'TH' || c.role === 'TD'));
    if (cells.some((c) => structAttr(doc, c.dict, 'Headers') instanceof PDFArray)) continue;
    rows.forEach((r, ri) => {
      r.children
        .filter((c) => c.role === 'TH' || c.role === 'TD')
        .forEach((c, ci) => {
          if (c.role !== 'TH' || structAttr(doc, c.dict, 'Scope', 'Table') instanceof PDFName) return;
          const scope = ri === 0 && ci === 0 && rows.length > 1 && r.children.every((x) => x.role === 'TH') ? 'Column' : ri === 0 ? 'Column' : ci === 0 ? 'Row' : 'Both';
          setAttr(doc, c.dict, 'Table', 'Scope', PDFName.of(scope));
          any = true;
        });
    });
  }
  return any;
}

// ---------------------------------------------------------------- annotations

/** Index in the document element after the last top-level element with content on `page` (or before later pages). */
function insertionIndex(doc: PDFDocument, st: Structure, docEl: { dict: PDFDict; ref: PDFRef }, page: number): number {
  const kids = kidsArray(doc, docEl.dict).asArray();
  const pagesOf = (k: PDFObject) => {
    const n = st.nodes.find((x) => x.ref && k instanceof PDFRef && idOf(x.ref) === idOf(k));
    if (!n) return [] as number[];
    const out: number[] = [];
    const visit = (x: StructNode, d: number) => {
      for (const m of x.mcids) if (m.page >= 0) out.push(m.page);
      for (const o of x.objrs) if (o.page >= 0) out.push(o.page);
      if (!x.mcids.length && !x.objrs.length && x.page >= 0) out.push(x.page);
      if (d < 50) x.children.forEach((c) => visit(c, d + 1));
    };
    visit(n, 0);
    return out;
  };
  let idx = -1;
  kids.forEach((k, i) => {
    const ps = pagesOf(k);
    if (ps.length && Math.min(...ps) <= page) idx = i;
  });
  return idx + 1;
}

function fixAnnotTags(doc: PDFDocument, map: Map<number, PDFObject>): boolean {
  const docEl = documentElement(doc);
  const st = readStructure(doc)!;
  const inTree = new Set<string>();
  for (const n of st.nodes) for (const o of n.objrs) inTree.add(idOf(o.obj));
  let any = false;
  doc.getPages().forEach((page, pi) => {
    let at = insertionIndex(doc, st, docEl, pi);
    for (const a of pageAnnots(doc, page, pi)) {
      if (!a.ref || inTree.has(idOf(a.ref)) || ['Popup', 'PrinterMark', 'TrapNet'].includes(a.subtype) || a.hidden) continue;
      const sp = a.dict.lookup(PDFName.of('StructParent'));
      if (sp instanceof PDFNumber && deref(doc, map.get(sp.asNumber())) instanceof PDFDict) continue;
      const S = a.subtype === 'Link' ? 'Link' : a.subtype === 'Widget' ? 'Form' : 'Annot';
      const objr = doc.context.obj({ Type: 'OBJR', Obj: a.ref, Pg: page.ref });
      const el = newElement(doc, S, docEl.ref, page, [objr]);
      attach(doc, el.ref, docEl.ref, at++);
      const key = nextParentKey(doc, map);
      a.dict.set(PDFName.of('StructParent'), PDFNumber.of(key));
      map.set(key, el.ref);
      any = true;
    }
  });
  return any;
}

// ---------------------------------------------------------------- untagged content

const PAGE_NUMBER = /^\s*(?:(?:page|pagina|pag\.|p\.|seite|página|oldal)\s*)?[0-9ivxlcdm]+(?:\s*(?:of|din|\/|von|de|sur|di)\s*[0-9]+)?\s*$/i;

function bandOf(page: PDFPage, box: Box | null): 'top' | 'bottom' | null {
  if (!box) return null;
  const c = page.getCropBox();
  if (box.y0 >= c.y + c.height * 0.9) return 'top';
  if (box.y1 <= c.y + c.height * 0.1) return 'bottom';
  return null;
}

const norm = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

type Kind = 'artifact' | 'text' | 'figure';

/** What untagged content should become: decoration (artifact), text (P) or a picture (Figure). */
export function classifyUntagged(doc: PDFDocument): Array<Map<number, Kind>> {
  const pages = doc.getPages();
  const walks = pages.map((p) => {
    try {
      return walkPage(doc, p);
    } catch {
      return null;
    }
  });
  // Running headers / footers: the same text (numbers aside) in a band on several pages.
  const seen = new Map<string, Set<number>>();
  walks.forEach((w, pi) => {
    for (const op of w?.ops ?? []) {
      if (op.kind !== 'text' || !isUntagged(op) || !op.text?.trim() || !bandOf(pages[pi], op.box)) continue;
      const k = norm(op.text);
      seen.set(k, (seen.get(k) ?? new Set()).add(pi));
    }
  });
  return walks.map((w, pi) => {
    const out = new Map<number, Kind>();
    const c = pages[pi].getCropBox();
    const area = c.width * c.height || 1;
    for (const op of w?.ops ?? []) {
      if (!isUntagged(op)) continue;
      let k: Kind;
      if (op.kind === 'path' || op.kind === 'shading') k = 'artifact';
      else if (op.kind === 'image' || op.kind === 'form') {
        const b = op.box;
        k = b && ((b.x1 - b.x0) * (b.y1 - b.y0)) / area > 0.01 && (b.x1 - b.x0) < c.width * 0.98 ? 'figure' : 'artifact';
      } else {
        const t = op.text ?? '';
        const band = bandOf(pages[pi], op.box);
        k = band && (PAGE_NUMBER.test(t) || (t.trim() && (seen.get(norm(t))?.size ?? 0) > 1) || !t.trim()) ? 'artifact' : 'text';
      }
      out.set(op.instr, k);
    }
    return out;
  });
}

function fixUntagged(doc: PDFDocument, map: Map<number, PDFObject>): boolean {
  const pages = doc.getPages();
  const kinds = classifyUntagged(doc);
  const docEl = documentElement(doc);
  const st = readStructure(doc)!;
  let any = false;
  pages.forEach((page, pi) => {
    const kind = kinds[pi];
    if (!kind.size) return;
    const w = walkPage(doc, page);
    const of = (k: Kind) => w.ops.filter((o) => kind.get(o.instr) === k);
    const ranges: Array<{ a: number; b: number; kind: Kind }> = [];
    for (const k of ['artifact', 'text', 'figure'] as Kind[]) for (const [a, b] of wrappableRanges(w, of(k))) ranges.push({ a, b, kind: k });
    ranges.sort((x, y) => x.a - y.a);
    const kept: typeof ranges = [];
    for (const r of ranges) if (!kept.length || r.a >= kept[kept.length - 1].b) kept.push(r);
    if (!kept.length) return;
    const parents = pageParents(doc, page, map);
    let mcid = Math.max(parents.size(), ...w.seqs.map((s) => (s.mcid ?? -1) + 1));
    const edits: Array<{ at: number; text: string; order: number }> = [];
    const opsIn = (r: { a: number; b: number }) => w.ops.filter((o) => o.instr >= r.a && o.instr < r.b);
    // Text ranges close together join one paragraph.
    const blocks: Array<{ kind: Kind; mcids: number[]; box: Box | null }> = [];
    let last: { kind: Kind; mcids: number[]; box: Box | null } | null = null;
    for (const r of kept) {
      if (r.kind === 'artifact') {
        edits.push({ at: w.instrs[r.a].start, text: '/Artifact BMC\n', order: 1 }, { at: w.instrs[r.b - 1].end, text: '\nEMC\n', order: 0 });
        continue;
      }
      const box = opsIn(r).reduce<Box | null>((b, o) => unionBox(b, o.box), null);
      const id = mcid++;
      const tag = r.kind === 'text' ? 'P' : 'Figure';
      edits.push({ at: w.instrs[r.a].start, text: `/${tag} <</MCID ${id}>> BDC\n`, order: 1 }, { at: w.instrs[r.b - 1].end, text: '\nEMC\n', order: 0 });
      const h = box ? box.y1 - box.y0 : 0;
      const near = !!(last && last.kind === 'text' && r.kind === 'text' && last.box && box && last.box.y0 - box.y1 < Math.max(h, 6) * 1.6 && box.y0 <= last.box.y1 + h);
      if (near && last) {
        last.mcids.push(id);
        last.box = unionBox(last.box, box);
      } else {
        last = { kind: r.kind, mcids: [id], box };
        blocks.push(last);
      }
    }
    setPageContent(doc, page, spliceContent(w.src, edits));
    let at = insertionIndex(doc, st, docEl, pi);
    for (const b of blocks) {
      const el = newElement(doc, b.kind === 'text' ? 'P' : 'Figure', docEl.ref, page, b.mcids.length === 1 ? b.mcids[0] : b.mcids.map((m) => PDFNumber.of(m)));
      if (b.kind === 'figure' && b.box) el.dict.set(PDFName.of('A'), doc.context.obj({ O: 'Layout', BBox: [b.box.x0, b.box.y0, b.box.x1, b.box.y1].map((v) => Math.round(v * 100) / 100) }));
      attach(doc, el.ref, docEl.ref, at++);
      for (const m of b.mcids) setParent(parents, m, el.ref);
    }
    any = true;
  });
  return any;
}

