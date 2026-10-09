/**
 * Find & redact beyond the page text: comments (/Contents, /RC, author,
 * subject, replies and popups), form fields (values, names, tooltips, XFA
 * data), bookmarks, document metadata (Info and XMP), attachments, link
 * addresses and alternate text in the structure tree. `findElsewhere` lists
 * the hits; `redactElsewhere` removes them from a loaded document (the caller
 * drops unreferenced objects and saves a fresh file, so no old copy stays).
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
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFTextField,
  decodePDFRawStream,
} from 'pdf-lib';
import type { Finder, Range } from './textSearch';
import { annotsOf, dropFromArrays, filterAnnots, isComment } from './hiddenInfo';

export type ElsewhereKind = 'comment' | 'fieldValue' | 'fieldName' | 'bookmark' | 'metadata' | 'attachment' | 'link' | 'altText';

export interface ElsewhereHit {
  kind: ElsewhereKind;
  /** Where, in English ("Comment", "Field value", "Metadata: Author"…); the page is added by the caller. */
  where: string;
  /** 0-based page of this document the hit belongs to (comments, links). */
  pageIndex?: number;
  /** Field name, attachment name, XMP element… (document content). */
  detail?: string;
  /** The matched text. */
  text: string;
}

export interface ElsewhereOptions {
  /** Kinds to redact (default: all). */
  kinds?: ElsewhereKind[];
  /** Comments with a hit: removed with their replies (default) or their text redacted. */
  comments?: 'remove' | 'redact';
  /** Also rename field names and tooltips containing a hit (default: left alone). */
  fieldNames?: boolean;
  /** Bookmarks with a hit: the matched part replaced (default) or the bookmark removed with its children. */
  bookmarks?: 'redact' | 'remove';
}

export const BLOCK = '████';

const N = (s: string) => PDFName.of(s);

interface Spot extends ElsewhereHit {
  apply: () => void;
}

function lookup(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

function dictOf(doc: PDFDocument, v: unknown): PDFDict | undefined {
  const d = lookup(doc, v);
  if (d instanceof PDFDict) return d;
  if (d instanceof PDFStream) return d.dict;
  return undefined;
}

function str(v: unknown): string {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return '';
}

function streamBytes(v: unknown): Uint8Array | null {
  if (v instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(v).decode();
    } catch {
      return v.getContents();
    }
  }
  if (v instanceof PDFStream) {
    try {
      return v.getContents();
    } catch {
      return null;
    }
  }
  return null;
}

function utf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

/** A text value: a string, or a stream (rich text, XFA). */
function textOf(doc: PDFDocument, v: unknown): string {
  const x = lookup(doc, v);
  if (x instanceof PDFStream) {
    const b = streamBytes(x);
    return b ? utf8(b) : '';
  }
  return str(x);
}

/** XHTML rich text as plain text (tags dropped, entities decoded). */
export function richToPlain(rc: string): string {
  return rc
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The matched parts replaced by ████. Pure. */
export function blockOut(s: string, ranges: Range[]): string {
  let out = '';
  let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < at) continue;
    out += s.slice(at, a) + BLOCK;
    at = b;
  }
  return out + s.slice(at);
}

const pdfText = (s: string) => PDFHexString.fromText(s);

function firstHit(finder: Finder, texts: string[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const r = finder(t);
    if (r.length) return t.slice(r[0][0], r[0][1]);
  }
  return null;
}

/** Replaces the matched parts of a string entry; true when something changed. */
function redactEntry(doc: PDFDocument, d: PDFDict, key: string, finder: Finder): boolean {
  const s = str(lookup(doc, d.get(N(key))));
  const r = s ? finder(s) : [];
  if (!r.length) return false;
  d.set(N(key), pdfText(blockOut(s, r)));
  return true;
}

// ------------------------------------------------------------------ the places

function annotationSpots(doc: PDFDocument, finder: Finder, opts: ElsewhereOptions, out: Spot[], removeAnnots: Map<number, Set<string>>): void {
  doc.getPages().forEach((page, pageIndex) => {
    const drop = (ref: unknown) => {
      const set = removeAnnots.get(pageIndex) ?? new Set<string>();
      set.add(String(ref));
      removeAnnots.set(pageIndex, set);
    };
    for (const { ref, dict } of annotsOf(doc, page)) {
      const sub = dict.lookup(N('Subtype'));
      const subtype = sub instanceof PDFName ? sub.decodeText() : '';
      if (subtype === 'Popup') continue;
      const contents = textOf(doc, dict.get(N('Contents')));
      const rc = textOf(doc, dict.get(N('RC')));
      if (subtype === 'FileAttachment') {
        const fs = dictOf(doc, dict.get(N('FS')));
        const names = fs ? [str(fs.lookup(N('UF'))), str(fs.lookup(N('F'))), str(fs.lookup(N('Desc')))] : [];
        const hit = firstHit(finder, [contents, richToPlain(rc), str(dict.lookup(N('T'))), str(dict.lookup(N('Subj'))), ...names]);
        if (hit) out.push({ kind: 'attachment', where: 'Attachment', pageIndex, detail: names[0] || names[1] || undefined, text: hit, apply: () => drop(ref) });
        continue;
      }
      if (subtype === 'Link') {
        const a = dictOf(doc, dict.get(N('A')));
        const uri = a ? str(a.lookup(N('URI'))) || textOf(doc, a.get(N('F'))) : '';
        const hit = firstHit(finder, [uri, contents]);
        if (hit) out.push({ kind: 'link', where: 'Link', pageIndex, text: hit, apply: () => drop(ref) });
        continue;
      }
      if (isComment(dict)) {
        const hit = firstHit(finder, [contents, richToPlain(rc), str(dict.lookup(N('T'))), str(dict.lookup(N('Subj')))]);
        if (!hit) continue;
        out.push({
          kind: 'comment',
          where: 'Comment',
          pageIndex,
          text: hit,
          apply: () => {
            if ((opts.comments ?? 'remove') === 'remove') return drop(ref);
            for (const k of ['Contents', 'T', 'Subj']) redactEntry(doc, dict, k, finder);
            // Rich text and the drawn appearance carry the text too.
            const plain = richToPlain(rc);
            if (rc && finder(plain).length) dict.delete(N('RC'));
            dict.delete(N('AP'));
          },
        });
        continue;
      }
      // Widgets and other annotations: /Contents is their alternate description.
      const hit = firstHit(finder, [contents]);
      if (hit) out.push({ kind: 'altText', where: 'Alternate text', pageIndex, text: hit, apply: () => void dict.delete(N('Contents')) });
    }
  });
}

function fieldSpots(doc: PDFDocument, finder: Finder, opts: ElsewhereOptions, out: Spot[], clear: Set<string>, renamed: Record<string, string>): void {
  const acro = dictOf(doc, doc.catalog.get(N('AcroForm')));
  if (!acro) return;
  const fields = acro.lookup(N('Fields'));
  const seen = new Set<PDFDict>();
  const walk = (ref: unknown, prefix: string, depth: number) => {
    const d = dictOf(doc, ref);
    if (!d || depth > 32 || seen.has(d)) return;
    seen.add(d);
    const partial = str(d.lookup(N('T')));
    const name = partial ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    const values: string[] = [];
    for (const k of ['V', 'DV']) {
      const v = lookup(doc, d.get(N(k)));
      if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) values.push(str(v.lookup(i)));
      else if (v instanceof PDFName) values.push(v.decodeText());
      else values.push(textOf(doc, v));
    }
    const vHit = firstHit(finder, values);
    if (vHit) {
      out.push({
        kind: 'fieldValue',
        where: 'Field value',
        detail: name,
        text: vHit,
        apply: () => {
          clear.add(name);
          d.delete(N('DV'));
        },
      });
    }
    const nHit = partial ? firstHit(finder, [partial]) : null;
    if (nHit) {
      out.push({
        kind: 'fieldName',
        where: 'Field name',
        detail: name,
        text: nHit,
        apply: () => {
          if (!opts.fieldNames) return;
          const next = blockOut(partial, finder(partial));
          d.set(N('T'), pdfText(next));
          renamed[name] = prefix ? `${prefix}.${next}` : next;
        },
      });
    }
    const tu = str(d.lookup(N('TU')));
    const tHit = tu ? firstHit(finder, [tu]) : null;
    if (tHit) out.push({ kind: 'fieldName', where: 'Field tooltip', detail: name, text: tHit, apply: () => void (opts.fieldNames && redactEntry(doc, d, 'TU', finder)) });
    const kids = d.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), name, depth + 1);
  };
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', 0);

  // The XFA packets keep their own copy of the form data.
  const xfa = acro.lookup(N('XFA'));
  const xfaText = xfa instanceof PDFArray ? xfa.asArray().map((x) => textOf(doc, x)) : [textOf(doc, xfa)];
  const xHit = firstHit(finder, xfaText);
  if (xHit) out.push({ kind: 'fieldValue', where: 'Form data (XFA)', text: xHit, apply: () => void acro.delete(N('XFA')) });
}

/** Clears the values of the named fields and draws them empty. */
function clearFields(doc: PDFDocument, names: Set<string>): void {
  if (!names.size) return;
  const acro = dictOf(doc, doc.catalog.get(N('AcroForm')));
  // pdf-lib's form drops the XFA (its own copy of the values) as soon as it is opened.
  acro?.delete(N('XFA'));
  const form = doc.getForm();
  for (const name of names) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      if (f instanceof PDFTextField) f.setText('');
      else if (f instanceof PDFCheckBox) f.uncheck();
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) f.clear();
      else f.acroField.dict.delete(N('V'));
    } catch {
      f.acroField.dict.delete(N('V'));
    }
    f.acroField.dict.delete(N('V'));
    try {
      if (f instanceof PDFTextField || f instanceof PDFDropdown || f instanceof PDFOptionList) f.defaultUpdateAppearances(form.getDefaultFont());
      else for (const w of f.acroField.getWidgets()) w.dict.delete(N('AP'));
    } catch {
      // No appearance is better than one showing the old value.
      for (const w of f.acroField.getWidgets()) w.dict.delete(N('AP'));
    }
  }
}

function outlineSpots(doc: PDFDocument, finder: Finder, opts: ElsewhereOptions, out: Spot[], removeItems: Set<PDFDict>): void {
  const outlines = dictOf(doc, doc.catalog.get(N('Outlines')));
  if (!outlines) return;
  const seen = new Set<PDFDict>();
  const walk = (first: unknown, depth: number) => {
    let item = dictOf(doc, first);
    while (item && !seen.has(item) && depth < 64) {
      seen.add(item);
      const it = item;
      const title = str(it.lookup(N('Title')));
      const hit = firstHit(finder, [title]);
      if (hit) {
        out.push({
          kind: 'bookmark',
          where: 'Bookmark',
          text: hit,
          apply: () => {
            if ((opts.bookmarks ?? 'redact') === 'remove') removeItems.add(it);
            else redactEntry(doc, it, 'Title', finder);
          },
        });
      }
      walk(it.get(N('First')), depth + 1);
      item = dictOf(doc, it.get(N('Next')));
    }
  };
  walk(outlines.get(N('First')), 0);
}

/** Unlinks outline items (with their children) and fixes the counts. */
function removeOutlineItems(doc: PDFDocument, items: Set<PDFDict>): void {
  if (!items.size) return;
  const outlines = dictOf(doc, doc.catalog.get(N('Outlines')));
  if (!outlines) return;
  const rebuild = (parent: PDFDict, depth: number): number => {
    const kept: unknown[] = [];
    let ref = parent.get(N('First'));
    const seen = new Set<unknown>();
    while (ref && !seen.has(String(ref)) && depth < 64) {
      seen.add(String(ref));
      const d = dictOf(doc, ref);
      if (!d) break;
      if (!items.has(d)) kept.push(ref);
      ref = d.get(N('Next'));
    }
    let visible = 0;
    kept.forEach((r, i) => {
      const d = dictOf(doc, r)!;
      if (i > 0) d.set(N('Prev'), kept[i - 1] as PDFRef);
      else d.delete(N('Prev'));
      if (i < kept.length - 1) d.set(N('Next'), kept[i + 1] as PDFRef);
      else d.delete(N('Next'));
      const below = rebuild(d, depth + 1);
      const count = d.lookup(N('Count'));
      const open = !(count instanceof PDFNumber && count.asNumber() < 0);
      if (below) d.set(N('Count'), doc.context.obj(open ? below : -below));
      else d.delete(N('Count'));
      visible += 1 + (open ? below : 0);
    });
    if (kept.length) {
      parent.set(N('First'), kept[0] as PDFRef);
      parent.set(N('Last'), kept[kept.length - 1] as PDFRef);
    } else {
      parent.delete(N('First'));
      parent.delete(N('Last'));
    }
    return visible;
  };
  const n = rebuild(outlines, 0);
  if (n) outlines.set(N('Count'), doc.context.obj(n));
  else {
    doc.catalog.delete(N('Outlines'));
  }
}

/** The XMP element enclosing an offset ("dc:creator"). */
function xmpElement(xml: string, at: number): string | undefined {
  const tags = [...xml.slice(0, at).matchAll(/<([A-Za-z][\w.-]*:[\w.-]+)[\s>]/g)].map((m) => m[1]).filter((t) => !/^rdf:(li|Seq|Bag|Alt|Description|RDF)$/.test(t) && !/^x:/.test(t));
  return tags.pop();
}

function metadataSpots(doc: PDFDocument, finder: Finder, out: Spot[]): void {
  const info = dictOf(doc, doc.context.trailerInfo.Info);
  if (info) {
    for (const [k, v] of info.entries()) {
      const s = textOf(doc, v);
      const hit = firstHit(finder, [s]);
      if (hit) out.push({ kind: 'metadata', where: `Metadata: ${k.decodeText()}`, text: hit, apply: () => void info.delete(k) });
    }
  }
  // XMP: the document's and any attached to pages, pictures or fonts.
  const owners = new Set<PDFDict>();
  const stack: unknown[] = [doc.context.trailerInfo.Root];
  const seen = new Set<unknown>();
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
      if (v.get(N('Metadata'))) owners.add(v);
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
  }
  for (const owner of owners) {
    const stream = lookup(doc, owner.get(N('Metadata')));
    const bytes = streamBytes(stream);
    if (!bytes) continue;
    const xml = utf8(bytes);
    const r = finder(xml);
    if (!r.length) continue;
    out.push({
      kind: 'metadata',
      where: 'Metadata: XMP',
      detail: xmpElement(xml, r[0][0]),
      text: xml.slice(r[0][0], r[0][1]),
      apply: () => {
        const next = doc.context.stream(new TextEncoder().encode(blockOut(xml, finder(xml))), { Type: 'Metadata', Subtype: 'XML' });
        owner.set(N('Metadata'), doc.context.register(next));
      },
    });
  }
}

function attachmentSpots(doc: PDFDocument, finder: Finder, out: Spot[], removeFiles: Set<string>): void {
  const names = dictOf(doc, doc.catalog.get(N('Names')));
  const tree = names ? dictOf(doc, names.get(N('EmbeddedFiles'))) : undefined;
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const key = str(arr.lookup(i));
        const ref = arr.get(i + 1);
        const fs = dictOf(doc, ref);
        const fileName = fs ? str(fs.lookup(N('UF'))) || str(fs.lookup(N('F'))) : '';
        const hit = firstHit(finder, [key, fileName, fs ? str(fs.lookup(N('Desc'))) : '']);
        if (hit) out.push({ kind: 'attachment', where: 'Attachment', detail: fileName || key, text: hit, apply: () => void removeFiles.add(String(ref)) });
      }
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(dictOf(doc, kids.get(i)), depth + 1);
  };
  walk(tree, 0);
}

function removeAttachments(doc: PDFDocument, gone: Set<string>): void {
  if (!gone.size) return;
  const names = dictOf(doc, doc.catalog.get(N('Names')));
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) {
      for (let i = arr.size() - 2; i >= 0; i -= 2) {
        if (gone.has(String(arr.get(i + 1)))) {
          arr.remove(i + 1);
          arr.remove(i);
        }
      }
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(dictOf(doc, kids.get(i)), depth + 1);
  };
  walk(names ? dictOf(doc, names.get(N('EmbeddedFiles'))) : undefined, 0);
  dropFromArrays(doc, doc.catalog.get(N('AF')), gone);
}

function structSpots(doc: PDFDocument, finder: Finder, out: Spot[]): void {
  const root = dictOf(doc, doc.catalog.get(N('StructTreeRoot')));
  if (!root) return;
  const seen = new Set<unknown>();
  const stack: unknown[] = [root.get(N('K'))];
  const labels: Record<string, string> = { Alt: 'Alternate text', ActualText: 'Replacement text', E: 'Abbreviation expansion', T: 'Tag title' };
  while (stack.length) {
    const v = stack.pop();
    const key = v instanceof PDFRef ? v.toString() : v;
    if (!v || seen.has(key)) continue;
    seen.add(key);
    const x = lookup(doc, v);
    if (x instanceof PDFArray) {
      for (let i = 0; i < x.size(); i++) stack.push(x.get(i));
      continue;
    }
    if (!(x instanceof PDFDict)) continue;
    for (const k of Object.keys(labels)) {
      const s = textOf(doc, x.get(N(k)));
      const hit = firstHit(finder, [s]);
      if (hit) out.push({ kind: 'altText', where: labels[k], detail: (x.lookup(N('S')) as PDFName | undefined)?.decodeText?.(), text: hit, apply: () => void x.delete(N(k)) });
    }
    if (x.get(N('K'))) stack.push(x.get(N('K')));
  }
}

function collect(doc: PDFDocument, finder: Finder, opts: ElsewhereOptions) {
  const spots: Spot[] = [];
  const removeAnnots = new Map<number, Set<string>>();
  const clear = new Set<string>();
  const renamed: Record<string, string> = {};
  const removeItems = new Set<PDFDict>();
  const removeFiles = new Set<string>();
  annotationSpots(doc, finder, opts, spots, removeAnnots);
  fieldSpots(doc, finder, opts, spots, clear, renamed);
  outlineSpots(doc, finder, opts, spots, removeItems);
  metadataSpots(doc, finder, spots);
  attachmentSpots(doc, finder, spots, removeFiles);
  structSpots(doc, finder, spots);
  return { spots, removeAnnots, clear, renamed, removeItems, removeFiles };
}

/** Every hit outside the page text. */
export function findElsewhere(doc: PDFDocument, finder: Finder): ElsewhereHit[] {
  return collect(doc, finder, {}).spots.map(({ apply: _apply, ...hit }) => hit);
}

/**
 * Redacts the hits of the chosen kinds in place. Returns how many places
 * changed and the new full names of renamed fields (old → new).
 */
export function redactElsewhere(doc: PDFDocument, finder: Finder, opts: ElsewhereOptions = {}): { changed: number; renamed: Record<string, string> } {
  const kinds = new Set(opts.kinds ?? ['comment', 'fieldValue', 'fieldName', 'bookmark', 'metadata', 'attachment', 'link', 'altText']);
  const c = collect(doc, finder, opts);
  let changed = 0;
  const run = (s: Spot) => {
    s.apply();
    changed++;
  };
  for (const s of c.spots) if (kinds.has(s.kind) && s.kind !== 'fieldName') run(s);
  const pages = doc.getPages();
  for (const [i, refs] of c.removeAnnots) filterAnnots(doc, pages[i], (d) => refs.has(String(annotRef(doc, pages[i], d))));
  // Values are cleared by the fields' old names, before any is renamed.
  clearFields(doc, c.clear);
  if (opts.fieldNames && kinds.has('fieldName')) for (const s of c.spots) if (s.kind === 'fieldName') run(s);
  removeOutlineItems(doc, c.removeItems);
  removeAttachments(doc, c.removeFiles);
  return { changed, renamed: c.renamed };
}

function annotRef(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number], d: PDFDict): unknown {
  return annotsOf(doc, page).find((a) => a.dict === d)?.ref;
}
