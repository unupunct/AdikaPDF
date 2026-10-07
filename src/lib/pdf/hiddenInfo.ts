/**
 * Remove hidden information: finds what a PDF carries besides its visible
 * pages (metadata, scripts, attachments, comments, form data, hidden layers,
 * hidden text, bookmarks, tags, thumbnails, private application data, links,
 * earlier revisions) and removes the chosen kinds. Used by the Protect tab's
 * "Hidden info" dialog and by Sanitize (single file and batch).
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  decodePDFRawStream,
} from 'pdf-lib';
import { analyzePageText, pageContent, parseContent, removeGlyphsWhere, resourcesOf, type Glyph } from './textRemoval';
import { dropUnreachableObjects } from './prune';

export type HiddenKind =
  | 'metadata'
  | 'scripts'
  | 'attachments'
  | 'comments'
  | 'formData'
  | 'hiddenLayers'
  | 'hiddenText'
  | 'bookmarks'
  | 'tags'
  | 'thumbnails'
  | 'privateData'
  | 'links'
  | 'revisions';

export const HIDDEN_KINDS: Array<{ kind: HiddenKind; label: string; hint: string }> = [
  { kind: 'metadata', label: 'Metadata', hint: 'Document properties, XMP and metadata attached to pictures, fonts and pages' },
  { kind: 'scripts', label: 'JavaScript', hint: 'Document, page, field and comment scripts and actions' },
  { kind: 'attachments', label: 'Attached files', hint: 'Embedded files and file attachment comments' },
  { kind: 'comments', label: 'Comments and markup', hint: 'Notes, highlights, stamps, drawings and their replies' },
  { kind: 'formData', label: 'Form field values', hint: 'What was typed or chosen in the form fields (the fields stay, empty)' },
  { kind: 'hiddenLayers', label: 'Hidden layers', hint: 'Layers that are switched off, and their content' },
  { kind: 'hiddenText', label: 'Hidden text', hint: 'Invisible text (such as the text layer of a scan), text off the page or too small to read' },
  { kind: 'bookmarks', label: 'Bookmarks', hint: 'The outline shown in the Bookmarks panel' },
  { kind: 'tags', label: 'Structure tags and alternate text', hint: 'Tags for screen readers, with picture descriptions and replacement text' },
  { kind: 'thumbnails', label: 'Page thumbnails', hint: 'Small page images stored in the file' },
  { kind: 'privateData', label: 'Private application data', hint: 'Data other programs keep in the file (PieceInfo)' },
  { kind: 'links', label: 'Links to web pages and files', hint: 'Links that open web addresses, other files or programs' },
  { kind: 'revisions', label: 'Earlier versions', hint: 'Previous saves kept inside the file (incremental updates)' },
];

/** What Sanitize removes: nothing anyone would miss on the page. */
export const SANITIZE_KINDS: HiddenKind[] = ['metadata', 'scripts', 'thumbnails', 'privateData', 'revisions'];

export interface HiddenFinding {
  kind: HiddenKind;
  count: number;
  /** A few examples to show (names, excerpts). */
  preview: string[];
}

const N = (s: string) => PDFName.of(s);
const MAX_PREVIEW = 30;

function lookup(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

function dictOf(doc: PDFDocument, v: unknown): PDFDict | undefined {
  const d = lookup(doc, v);
  if (d instanceof PDFDict) return d;
  if (d instanceof PDFStream) return d.dict;
  return undefined;
}

function text(v: unknown): string {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  if (v instanceof PDFName) return v.decodeText();
  if (v instanceof PDFNumber) return String(v.asNumber());
  return '';
}

function excerpt(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function streamText(v: unknown): string {
  if (v instanceof PDFRawStream) {
    try {
      return new TextDecoder('latin1').decode(decodePDFRawStream(v).decode());
    } catch {
      return '';
    }
  }
  return '';
}

/** Every dictionary reachable from the catalog and the Info dictionary (stream dictionaries included). */
function reachableDicts(doc: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [doc.context.trailerInfo.Root];
  while (stack.length) {
    let v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.toString())) continue;
      seen.add(v.toString());
      v = doc.context.lookup(v);
    }
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof PDFStream) stack.push(v.dict);
    else if (v instanceof PDFDict) {
      out.push(v);
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
  }
  return out;
}

/** Leaves of a name tree as [name, value]. */
function nameTree(doc: PDFDocument, node: unknown, depth = 0): Array<[string, unknown]> {
  const d = dictOf(doc, node);
  if (!d || depth > 32) return [];
  const out: Array<[string, unknown]> = [];
  const names = d.lookup(N('Names'));
  if (names instanceof PDFArray) for (let i = 0; i + 1 < names.size(); i += 2) out.push([text(names.lookup(i)), names.get(i + 1)]);
  const kids = d.lookup(N('Kids'));
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) out.push(...nameTree(doc, kids.get(i), depth + 1));
  return out;
}

function annotsOf(doc: PDFDocument, page: PDFPage): Array<{ ref: unknown; dict: PDFDict }> {
  const annots = page.node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  const out: Array<{ ref: unknown; dict: PDFDict }> = [];
  for (let i = 0; i < annots.size(); i++) {
    const d = dictOf(doc, annots.get(i));
    if (d) out.push({ ref: annots.get(i), dict: d });
  }
  return out;
}

function subtypeOf(d: PDFDict): string {
  return text(d.lookup(N('Subtype')));
}

const NOT_COMMENTS = new Set(['Link', 'Widget', 'Popup', 'FileAttachment']);

function isComment(d: PDFDict): boolean {
  return !NOT_COMMENTS.has(subtypeOf(d));
}

/** A link that leaves the document: web address, another file, a program. */
function externalLink(doc: PDFDocument, d: PDFDict): string | null {
  if (subtypeOf(d) !== 'Link') return null;
  const a = dictOf(doc, d.get(N('A')));
  if (!a) return null;
  const s = text(a.lookup(N('S')));
  if (s === 'URI') return text(a.lookup(N('URI'))) || 'URI';
  if (s === 'Launch' || s === 'GoToR' || s === 'GoToE' || s === 'SubmitForm' || s === 'ImportData') {
    const f = a.lookup(N('F'));
    const fd = dictOf(doc, f);
    return `${s}: ${text(fd ? (fd.lookup(N('UF')) ?? fd.lookup(N('F'))) : f) || '?'}`;
  }
  return null;
}

function isJsAction(doc: PDFDocument, v: unknown): boolean {
  const d = dictOf(doc, v);
  return !!d && text(d.lookup(N('S'))) === 'JavaScript';
}

function jsSource(doc: PDFDocument, d: PDFDict): string {
  const js = lookup(doc, d.get(N('JS')));
  return js instanceof PDFStream ? streamText(js) : text(js);
}

// ------------------------------------------------------------------ hidden layers

function offLayers(doc: PDFDocument): Set<string> {
  const ocp = dictOf(doc, doc.catalog.get(N('OCProperties')));
  const off = dictOf(doc, ocp?.get(N('D')))?.lookup(N('OFF'));
  const out = new Set<string>();
  if (off instanceof PDFArray) for (let i = 0; i < off.size(); i++) if (off.get(i) instanceof PDFRef) out.add(String(off.get(i)));
  return out;
}

/** Is this optional-content dictionary (group or membership) shown only when an off layer is on? */
function ocIsOff(doc: PDFDocument, oc: unknown, off: Set<string>): boolean {
  if (oc instanceof PDFRef && off.has(oc.toString())) return true;
  const d = dictOf(doc, oc);
  if (!d || text(d.lookup(N('Type'))) !== 'OCMD') return false;
  const ocgs = d.get(N('OCGs'));
  const list = lookup(doc, ocgs);
  const refs = list instanceof PDFArray ? list.asArray() : [ocgs];
  const policy = text(d.lookup(N('P'))) || 'AnyOn';
  const offs = refs.map((r) => r instanceof PDFRef && off.has(r.toString()));
  return policy === 'AllOn' ? offs.some(Boolean) : offs.every(Boolean);
}

/** Removes from a page the content marked as an off layer; returns how many pieces went. */
function stripOffContent(doc: PDFDocument, page: PDFPage, off: Set<string>): number {
  const res = resourcesOf(page);
  const props = res?.lookup(N('Properties'));
  const xobjs = res?.lookup(N('XObject'));
  let src: Uint8Array;
  let instrs: ReturnType<typeof parseContent>;
  try {
    src = pageContent(doc, page);
    instrs = parseContent(src);
  } catch {
    return 0;
  }
  const cut: Array<[number, number]> = [];
  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i];
    if (ins.op === 'BDC' && ins.args[0]?.k === 'name' && ins.args[0].v === 'OC' && ins.args[1]?.k === 'name') {
      const oc = props instanceof PDFDict ? props.get(N(ins.args[1].v)) : undefined;
      if (!ocIsOff(doc, oc, off)) continue;
      let depth = 0;
      let j = i;
      for (; j < instrs.length; j++) {
        if (instrs[j].op === 'BDC' || instrs[j].op === 'BMC') depth++;
        else if (instrs[j].op === 'EMC' && --depth === 0) break;
      }
      cut.push([ins.start, instrs[Math.min(j, instrs.length - 1)].end]);
      i = j;
    } else if (ins.op === 'Do' && ins.args[0]?.k === 'name') {
      const xo = xobjs instanceof PDFDict ? xobjs.lookup(N(ins.args[0].v)) : undefined;
      if (xo instanceof PDFStream && ocIsOff(doc, xo.dict.get(N('OC')), off)) cut.push([ins.start, ins.end]);
    }
  }
  if (!cut.length) return 0;
  const parts: Uint8Array[] = [];
  let last = 0;
  for (const [s, e] of cut) {
    parts.push(src.subarray(last, s), new Uint8Array([10]));
    last = e;
  }
  parts.push(src.subarray(last));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(out)));
  // The pictures / forms of that layer go from the resources too.
  if (xobjs instanceof PDFDict) {
    for (const [k, v] of xobjs.entries()) {
      const xo = lookup(doc, v);
      if (xo instanceof PDFStream && ocIsOff(doc, xo.dict.get(N('OC')), off)) xobjs.delete(k);
    }
  }
  return cut.length;
}

/** Drops the given refs from every array inside `v` (nested arrays included). */
function dropFromArrays(doc: PDFDocument, v: unknown, gone: Set<string>, depth = 0): void {
  const x = lookup(doc, v);
  if (depth > 32) return;
  if (x instanceof PDFArray) {
    for (let i = x.size() - 1; i >= 0; i--) {
      const it = x.get(i);
      if (it instanceof PDFRef && gone.has(it.toString())) x.remove(i);
      else dropFromArrays(doc, it, gone, depth + 1);
    }
  } else if (x instanceof PDFDict) for (const [, y] of x.entries()) dropFromArrays(doc, y, gone, depth + 1);
}

// ------------------------------------------------------------------ hidden text

function hiddenGlyph(g: Glyph, crop: { x: number; y: number; width: number; height: number }): boolean {
  if (g.mode === 3 || g.mode === 7) return true;
  if (g.size > 0 && g.size < 1) return true;
  const b = g.box;
  return b.x1 < crop.x || b.x0 > crop.x + crop.width || b.y1 < crop.y || b.y0 > crop.y + crop.height;
}

// ------------------------------------------------------------------ scan

function countOutline(doc: PDFDocument, first: unknown, titles: string[], depth = 0): number {
  let n = 0;
  let item = dictOf(doc, first);
  const seen = new Set<PDFDict>();
  while (item && !seen.has(item) && depth < 64) {
    seen.add(item);
    n++;
    if (titles.length < MAX_PREVIEW) titles.push(excerpt(text(item.lookup(N('Title')))));
    n += countOutline(doc, item.get(N('First')), titles, depth + 1);
    item = dictOf(doc, item.get(N('Next')));
  }
  return n;
}

function fieldValues(doc: PDFDocument): Array<[string, string]> {
  const acro = dictOf(doc, doc.catalog.get(N('AcroForm')));
  const fields = acro?.lookup(N('Fields'));
  const out: Array<[string, string]> = [];
  const walk = (ref: unknown, prefix: string, depth: number) => {
    const d = dictOf(doc, ref);
    if (!d || depth > 32) return;
    const t = text(d.lookup(N('T')));
    const name = t ? (prefix ? `${prefix}.${t}` : t) : prefix;
    const v = d.lookup(N('V'));
    if (v !== undefined) {
      const val = v instanceof PDFArray ? v.asArray().map(text).join(', ') : text(v);
      if (val && val !== 'Off') out.push([name, val]);
    }
    const kids = d.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), name, depth + 1);
  };
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', 0);
  return out;
}

/** Number of earlier revisions (incremental updates) in the file bytes. */
export function countRevisions(bytes: Uint8Array): number {
  const s = new TextDecoder('latin1').decode(bytes);
  const n = s.match(/startxref/g)?.length ?? 0;
  const linearized = /\/Linearized\b/.test(s.slice(0, 2048)) ? 1 : 0;
  return Math.max(0, n - 1 - linearized);
}

export function scanHiddenDoc(doc: PDFDocument, bytes?: Uint8Array): HiddenFinding[] {
  const found = new Map<HiddenKind, HiddenFinding>(HIDDEN_KINDS.map(({ kind }) => [kind, { kind, count: 0, preview: [] }]));
  const add = (kind: HiddenKind, item?: string, count = 1) => {
    const f = found.get(kind)!;
    f.count += count;
    if (item && f.preview.length < MAX_PREVIEW) f.preview.push(item);
  };
  const catalog = doc.catalog;
  const dicts = reachableDicts(doc);

  // Metadata.
  const info = dictOf(doc, doc.context.trailerInfo.Info);
  if (info) for (const [k, v] of info.entries()) if (text(lookup(doc, v))) add('metadata', `${k.decodeText()}: ${excerpt(text(lookup(doc, v)))}`);
  for (const d of dicts) if (d.has(N('Metadata'))) add('metadata', d === catalog ? 'XMP metadata of the document' : `XMP metadata of ${text(d.lookup(N('Type'))) || text(d.lookup(N('Subtype'))) || 'an object'}`);

  // Scripts and actions.
  const names = dictOf(doc, catalog.get(N('Names')));
  for (const [name, v] of nameTree(doc, names?.get(N('JavaScript')))) {
    const d = dictOf(doc, v);
    add('scripts', `${name}: ${excerpt(d ? jsSource(doc, d) : '')}`);
  }
  for (const d of dicts) {
    const aa = dictOf(doc, d.get(N('AA')));
    if (aa) for (const [k] of aa.entries()) add('scripts', `Action on ${k.decodeText()}`);
    for (const key of ['A', 'OpenAction', 'Next']) {
      const v = d.get(N(key));
      const list = lookup(doc, v);
      for (const x of list instanceof PDFArray ? list.asArray() : [v]) {
        const a = dictOf(doc, x);
        if (a && isJsAction(doc, a)) add('scripts', excerpt(jsSource(doc, a)));
      }
    }
  }

  // Attachments.
  for (const [name] of nameTree(doc, names?.get(N('EmbeddedFiles')))) add('attachments', name);

  // Per page: comments, attachment comments, links, thumbnails, hidden text.
  doc.getPages().forEach((page, i) => {
    for (const { dict } of annotsOf(doc, page)) {
      const st = subtypeOf(dict);
      if (st === 'FileAttachment') {
        const fs = dictOf(doc, dict.get(N('FS')));
        add('attachments', text(fs?.lookup(N('UF')) ?? fs?.lookup(N('F'))) || `File on page ${i + 1}`);
      } else if (isComment(dict)) add('comments', `${st}, page ${i + 1}${text(dict.lookup(N('Contents'))) ? `: ${excerpt(text(dict.lookup(N('Contents'))), 60)}` : ''}`);
      const link = externalLink(doc, dict);
      if (link) add('links', excerpt(link));
    }
    if (page.node.has(N('Thumb'))) add('thumbnails', `Page ${i + 1}`);
    const crop = page.getCropBox();
    const t = analyzePageText(doc, page);
    const hidden = t.glyphs.filter((g) => hiddenGlyph(g, crop));
    if (hidden.length) add('hiddenText', `Page ${i + 1}: ${excerpt(hidden.map((g) => g.text).join(''), 60)}`, hidden.length);
  });
  const uri = dictOf(doc, catalog.get(N('URI')));
  if (uri) add('links', `Base address: ${text(uri.lookup(N('Base')))}`);

  // Form data (and the XFA copy of it).
  for (const [name, value] of fieldValues(doc)) add('formData', `${name}: ${excerpt(value, 60)}`);
  const acro = dictOf(doc, catalog.get(N('AcroForm')));
  if (acro?.has(N('XFA'))) add('formData', 'XFA form data');

  // Hidden layers.
  const off = offLayers(doc);
  for (const ref of off) {
    const d = dictOf(doc, doc.context.lookup(PDFRef.of(Number(ref.split(' ')[0]), Number(ref.split(' ')[1]))));
    add('hiddenLayers', text(d?.lookup(N('Name'))) || 'Layer');
  }

  // Bookmarks.
  const outlines = dictOf(doc, catalog.get(N('Outlines')));
  if (outlines) {
    const titles: string[] = [];
    const n = countOutline(doc, outlines.get(N('First')), titles);
    if (n) add('bookmarks', undefined, n);
    found.get('bookmarks')!.preview.push(...titles);
  }

  // Tags.
  const tree = dictOf(doc, catalog.get(N('StructTreeRoot')));
  if (tree) {
    const seen = new Set<PDFDict>();
    const walk = (v: unknown, depth: number) => {
      const d = dictOf(doc, v);
      if (!d || seen.has(d) || depth > 256) {
        const arr = lookup(doc, v);
        if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i++) walk(arr.get(i), depth + 1);
        return;
      }
      seen.add(d);
      const type = text(d.lookup(N('Type')));
      if (type === 'MCR' || type === 'OBJR') return;
      if (d !== tree) {
        const alt = ['Alt', 'ActualText', 'E'].map((k) => text(d.lookup(N(k)))).find(Boolean);
        add('tags', alt ? `${text(d.lookup(N('S')))}: ${excerpt(alt, 60)}` : undefined);
      }
      walk(d.get(N('K')), depth + 1);
    };
    walk(tree, 0);
    if (!found.get('tags')!.count) add('tags', 'Empty structure tree');
  }

  // Private application data.
  for (const d of dicts) if (d.has(N('PieceInfo'))) {
    const pi = dictOf(doc, d.get(N('PieceInfo')));
    add('privateData', pi ? [...pi.entries()].map(([k]) => k.decodeText()).join(', ') : 'PieceInfo');
  }

  if (bytes) {
    const n = countRevisions(bytes);
    if (n) add('revisions', `${n} earlier save${n > 1 ? 's' : ''}`, n);
  }
  return [...found.values()];
}

export async function scanHiddenInfo(bytes: Uint8Array): Promise<HiddenFinding[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return scanHiddenDoc(doc, bytes);
}

// ------------------------------------------------------------------ removal

function filterAnnots(doc: PDFDocument, page: PDFPage, drop: (d: PDFDict) => boolean): number {
  const list = annotsOf(doc, page);
  if (!list.length) return 0;
  const gone = new Set<string>();
  for (const { ref, dict } of list) if (drop(dict)) gone.add(String(ref));
  if (!gone.size) return 0;
  // Popups (and replies) of removed annotations go too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const { ref, dict } of list) {
      if (gone.has(String(ref))) continue;
      const parent = dict.get(N('Parent')) ?? dict.get(N('IRT'));
      if (parent && gone.has(String(parent))) {
        gone.add(String(ref));
        changed = true;
      }
    }
  }
  const keep = list.filter(({ ref }) => !gone.has(String(ref))).map(({ ref }) => ref);
  if (keep.length) page.node.set(N('Annots'), doc.context.obj(keep as never[]));
  else page.node.delete(N('Annots'));
  return gone.size;
}

/** Removes the chosen kinds of hidden information from a loaded document (in place). */
export function removeHiddenDoc(doc: PDFDocument, kinds: Iterable<HiddenKind>): void {
  const want = new Set(kinds);
  const catalog = doc.catalog;
  const names = dictOf(doc, catalog.get(N('Names')));

  if (want.has('metadata')) {
    const info = dictOf(doc, doc.context.trailerInfo.Info);
    if (info) for (const [k] of info.entries()) info.delete(k);
    for (const d of reachableDicts(doc)) d.delete(N('Metadata'));
  }

  if (want.has('scripts')) {
    names?.delete(N('JavaScript'));
    for (const d of reachableDicts(doc)) {
      d.delete(N('AA'));
      for (const key of ['A', 'OpenAction', 'Next']) {
        const v = d.get(N(key));
        const list = lookup(doc, v);
        if (list instanceof PDFArray) {
          for (let i = list.size() - 1; i >= 0; i--) if (isJsAction(doc, list.get(i))) list.remove(i);
        } else if (isJsAction(doc, v)) d.delete(N(key));
      }
    }
  }

  if (want.has('attachments')) {
    names?.delete(N('EmbeddedFiles'));
    catalog.delete(N('AF'));
    catalog.delete(N('Collection'));
    for (const page of doc.getPages()) filterAnnots(doc, page, (d) => subtypeOf(d) === 'FileAttachment');
  }

  if (want.has('comments')) for (const page of doc.getPages()) filterAnnots(doc, page, isComment);
  if (want.has('links')) {
    catalog.delete(N('URI'));
    for (const page of doc.getPages()) filterAnnots(doc, page, (d) => externalLink(doc, d) !== null);
  }

  if (want.has('formData')) {
    const acro = dictOf(doc, catalog.get(N('AcroForm')));
    if (acro) {
      // pdf-lib's form drops the XFA (which keeps its own copy of the values) as soon as it is opened.
      acro.delete(N('XFA'));
      let fields: ReturnType<ReturnType<PDFDocument['getForm']>['getFields']> = [];
      try {
        fields = doc.getForm().getFields();
      } catch {
        fields = [];
      }
      for (const f of fields) {
        try {
          if (f instanceof PDFTextField) f.setText('');
          else if (f instanceof PDFCheckBox) f.uncheck();
          else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) f.clear();
        } catch {
          f.acroField.dict.delete(N('V'));
        }
      }
      for (const [name] of fieldValues(doc)) {
        // Whatever pdf-lib could not clear (signatures, odd fields): the value goes, and its picture.
        try {
          const f = doc.getForm().getField(name);
          f.acroField.dict.delete(N('V'));
          for (const w of f.acroField.getWidgets()) w.dict.delete(N('AP'));
        } catch {
          /* not reachable by name */
        }
      }
    }
  }

  if (want.has('hiddenLayers')) {
    const off = offLayers(doc);
    if (off.size) {
      for (const page of doc.getPages()) {
        stripOffContent(doc, page, off);
        filterAnnots(doc, page, (d) => ocIsOff(doc, d.get(N('OC')), off));
      }
      dropFromArrays(doc, catalog.get(N('OCProperties')), off);
    }
  }

  if (want.has('hiddenText')) {
    for (const page of doc.getPages()) {
      const crop = page.getCropBox();
      removeGlyphsWhere(doc, page, (g) => hiddenGlyph(g, crop));
    }
  }

  if (want.has('bookmarks')) {
    catalog.delete(N('Outlines'));
    if (text(catalog.lookup(N('PageMode'))) === 'UseOutlines') catalog.delete(N('PageMode'));
  }

  if (want.has('tags')) {
    catalog.delete(N('StructTreeRoot'));
    catalog.delete(N('MarkInfo'));
    for (const page of doc.getPages()) {
      page.node.delete(N('StructParents'));
      for (const { dict } of annotsOf(doc, page)) dict.delete(N('StructParent'));
    }
  }

  if (want.has('thumbnails')) for (const page of doc.getPages()) page.node.delete(N('Thumb'));
  if (want.has('privateData')) for (const d of reachableDicts(doc)) d.delete(N('PieceInfo'));
  // Earlier revisions: a fresh save writes only the current one.
}

/** Loads, removes the chosen kinds, drops what is left unreferenced and saves a fresh file (no earlier revisions). */
export async function removeHiddenInfo(bytes: Uint8Array, kinds: Iterable<HiddenKind>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  removeHiddenBeforeSave(doc, kinds);
  dropUnreachableObjects(doc);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

/** `removeHiddenDoc` plus what must happen before unreferenced objects are dropped and the file saved. */
export function removeHiddenBeforeSave(doc: PDFDocument, kinds: Iterable<HiddenKind>): void {
  const want = new Set(kinds);
  removeHiddenDoc(doc, want);
  if (want.has('formData')) {
    // New (empty) appearances before pruning, so the old ones showing the values are dropped.
    try {
      doc.getForm().updateFieldAppearances();
    } catch {
      /* an odd field keeps no appearance */
    }
  }
}
