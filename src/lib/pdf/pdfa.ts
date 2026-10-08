// PDF/A-1b / 2b / 3b conversion helpers.
//
// This module adds the structural markers that PDF/A requires (sRGB output
// intent with an embedded ICC profile, XMP metadata consistent with the Info
// dictionary, a trailer /ID) and removes the features that PDF/A forbids
// outright (encryption, JavaScript, XFA; embedded files for 1b/2b; optional
// content for 1b). PDF/A-3b keeps embedded files and gives each one the
// associated-file markers (/AFRelationship, catalog /AF, MIME /Subtype,
// /Params /ModDate). It does NOT embed missing fonts or flatten transparency;
// `pdfaWarnings` reports those so the UI can tell the user honestly to
// validate the result with veraPDF.

import {
  AFRelationship,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib';
import { scanContentOps } from './compress';

export const PDFA_PRODUCER = 'Adika PDF Editor';

// ---------------------------------------------------------------------------
// sRGB ICC v2 profile (pure)
// ---------------------------------------------------------------------------

function ascii(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

class ByteWriter {
  private buf: number[] = [];
  get length(): number {
    return this.buf.length;
  }
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }
  u32(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  s15f16(v: number): this {
    return this.u32(Math.round(v * 65536) | 0);
  }
  sig(s: string): this {
    const b = ascii(s.padEnd(4, ' ').slice(0, 4));
    for (const x of b) this.u8(x);
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  pad4(): this {
    while (this.buf.length % 4) this.u8(0);
    return this;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

function descTag(text: string): Uint8Array {
  // textDescriptionType (ICC v2): ASCII + empty Unicode + empty ScriptCode.
  const a = ascii(text);
  return new ByteWriter()
    .sig('desc')
    .u32(0)
    .u32(a.length + 1)
    .bytes(a)
    .u8(0)
    .u32(0) // unicode language code
    .u32(0) // unicode count
    .u16(0) // scriptcode code
    .u8(0) // scriptcode count
    .zeros(67)
    .toBytes();
}

function textTag(text: string): Uint8Array {
  return new ByteWriter().sig('text').u32(0).bytes(ascii(text)).u8(0).toBytes();
}

function xyzTag(x: number, y: number, z: number): Uint8Array {
  return new ByteWriter().sig('XYZ ').u32(0).s15f16(x).s15f16(y).s15f16(z).toBytes();
}

function srgbCurveTag(entries = 1024): Uint8Array {
  const w = new ByteWriter().sig('curv').u32(0).u32(entries);
  for (let i = 0; i < entries; i++) {
    const v = i / (entries - 1);
    const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    w.u16(Math.round(Math.min(1, Math.max(0, lin)) * 65535));
  }
  return w.toBytes();
}

/**
 * Builds a compact, valid ICC v2.1 display profile for sRGB IEC61966-2.1:
 * D50 PCS, Bradford-adapted sRGB primaries and a 1024-entry sRGB tone curve
 * shared by the three TRC tags.
 */
export function buildSrgbIccProfile(): Uint8Array {
  const curve = srgbCurveTag(1024);
  const tags: { sig: string; data: Uint8Array }[] = [
    { sig: 'desc', data: descTag('sRGB IEC61966-2.1') },
    { sig: 'cprt', data: textTag('No copyright, use freely') },
    { sig: 'wtpt', data: xyzTag(0.9642, 1.0, 0.8249) },
    { sig: 'rXYZ', data: xyzTag(0.4360747, 0.2225045, 0.0139322) },
    { sig: 'gXYZ', data: xyzTag(0.3850649, 0.7168786, 0.0971045) },
    { sig: 'bXYZ', data: xyzTag(0.1430804, 0.0606169, 0.7141733) },
    { sig: 'rTRC', data: curve },
    { sig: 'gTRC', data: curve },
    { sig: 'bTRC', data: curve },
  ];

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  // Lay out data blocks; identical data (the shared curve) is stored once.
  const placed = new Map<Uint8Array, number>();
  const entries: { sig: string; offset: number; size: number }[] = [];
  let cursor = headerSize + tableSize;
  cursor = (cursor + 3) & ~3;
  const blocks: { offset: number; data: Uint8Array }[] = [];
  for (const t of tags) {
    let off = placed.get(t.data);
    if (off === undefined) {
      off = cursor;
      placed.set(t.data, off);
      blocks.push({ offset: off, data: t.data });
      cursor = (cursor + t.data.length + 3) & ~3;
    }
    entries.push({ sig: t.sig, offset: off, size: t.data.length });
  }
  const total = cursor;

  const w = new ByteWriter();
  // Header
  w.u32(total); // profile size
  w.u32(0); // preferred CMM
  w.u32(0x02100000); // version 2.1.0
  w.sig('mntr');
  w.sig('RGB ');
  w.sig('XYZ ');
  w.u16(2024).u16(1).u16(1).u16(0).u16(0).u16(0); // creation date
  w.sig('acsp');
  w.u32(0); // primary platform
  w.u32(0); // flags
  w.u32(0); // device manufacturer
  w.u32(0); // device model
  w.zeros(8); // device attributes
  w.u32(0); // rendering intent: perceptual
  w.s15f16(0.9642).s15f16(1.0).s15f16(0.8249); // PCS illuminant D50
  w.u32(0); // creator
  w.zeros(16); // profile ID (v2: zero)
  w.zeros(28); // reserved
  // Tag table
  w.u32(entries.length);
  for (const e of entries) w.sig(e.sig).u32(e.offset).u32(e.size);
  // Tag data
  for (const b of blocks) {
    while (w.length < b.offset) w.u8(0);
    w.bytes(b.data);
  }
  w.pad4();
  const out = w.toBytes();
  if (out.length !== total) throw new Error('ICC layout mismatch');
  return out;
}

// ---------------------------------------------------------------------------
// XMP (pure)
// ---------------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ISO-8601 UTC without milliseconds, matching pdf-lib's "D:YYYYMMDDHHmmssZ". */
export function xmpDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface XmpFields {
  title: string;
  author: string;
  producer: string;
  createDate: Date;
  modifyDate: Date;
  subject?: string;
  keywords?: string;
  creatorTool?: string;
  /** ISO 19005 part: 1, 2 or 3 (default 2). Conformance is always B. */
  part?: 1 | 2 | 3;
  /** More rdf:Description blocks (e.g. Factur-X invoice data with its extension schema). */
  extra?: string;
}

export function buildPdfAXmp(f: XmpFields): string {
  const lang = (v: string) =>
    `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt>`;
  const lines = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about=""',
    '  xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"',
    '  xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '  xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '  xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    `<pdfaid:part>${f.part ?? 2}</pdfaid:part>`,
    '<pdfaid:conformance>B</pdfaid:conformance>',
    '<dc:format>application/pdf</dc:format>',
    `<dc:title>${lang(f.title)}</dc:title>`,
    `<dc:creator><rdf:Seq><rdf:li>${escapeXml(f.author)}</rdf:li></rdf:Seq></dc:creator>`,
  ];
  if (f.subject) lines.push(`<dc:description>${lang(f.subject)}</dc:description>`);
  lines.push(
    `<xmp:CreateDate>${xmpDate(f.createDate)}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${xmpDate(f.modifyDate)}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${xmpDate(f.modifyDate)}</xmp:MetadataDate>`,
  );
  if (f.creatorTool) lines.push(`<xmp:CreatorTool>${escapeXml(f.creatorTool)}</xmp:CreatorTool>`);
  lines.push(`<pdf:Producer>${escapeXml(f.producer)}</pdf:Producer>`);
  if (f.keywords) lines.push(`<pdf:Keywords>${escapeXml(f.keywords)}</pdf:Keywords>`);
  lines.push('</rdf:Description>');
  if (f.extra) lines.push(f.extra);
  lines.push('</rdf:RDF>', '</x:xmpmeta>');
  // Padding so in-place XMP editors can grow the packet.
  const pad = (' '.repeat(99) + '\n').repeat(20);
  return lines.join('\n') + '\n' + pad + '<?xpacket end="w"?>';
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** PDF/A conformance level produced by `convertToPdfA`. */
export type PdfALevel = '1b' | '2b' | '3b';

export type PdfAAttachmentRelationship = 'Source' | 'Data' | 'Alternative' | 'Supplement' | 'Unspecified';

export interface PdfAAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  relationship?: PdfAAttachmentRelationship;
  description?: string;
}

export interface PdfAMeta {
  title: string;
  author: string;
  /** Default '2b'. */
  level?: PdfALevel;
  /** Files to embed as associated files. Only honoured for PDF/A-3b. */
  attachments?: PdfAAttachment[];
  /** More XMP (rdf:Description blocks), e.g. Factur-X. */
  extraXmp?: string;
  /** A TrueType font (embedded) to redraw form fields that have no appearance of their own. */
  fieldFont?: Uint8Array;
}

export interface PdfAConversionResult {
  bytes: Uint8Array;
  /** What the conversion changed or ignored (human-readable). */
  notes: string[];
}

const ALLOWED_AF = new Set(['Source', 'Data', 'Alternative', 'Supplement', 'Unspecified']);

function levelPart(level: PdfALevel): 1 | 2 | 3 {
  return level === '1b' ? 1 : level === '3b' ? 3 : 2;
}

function levelLabel(level: PdfALevel): string {
  return `PDF/A-${level}`;
}

function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

function dictOf(doc: PDFDocument, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

function arrayOf(doc: PDFDocument, o: PDFObject | undefined): PDFArray | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFArray ? v : undefined;
}

function numberOf(doc: PDFDocument, o: PDFObject | undefined): number | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function isJsAction(doc: PDFDocument, o: PDFObject | undefined): boolean {
  const d = dictOf(doc, o);
  if (!d) return false;
  const s = nameOf(d.get(PDFName.of('S')));
  // Actions PDF/A forbids.
  return s === 'JavaScript' || s === 'Launch' || s === 'ImportData' || s === 'Sound' || s === 'Movie' || s === 'RichMediaExecute';
}

function randomId(): Uint8Array {
  const b = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function textOf(doc: PDFDocument, o: PDFObject | undefined): string | undefined {
  const r = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (r instanceof PDFString || r instanceof PDFHexString) {
    const t = r.decodeText();
    return t.length ? t : undefined;
  }
  return undefined;
}

function infoText(doc: PDFDocument, key: string): string | undefined {
  const infoRef = doc.context.trailerInfo.Info;
  const info = dictOf(doc, infoRef as PDFObject | undefined);
  return textOf(doc, info?.get(PDFName.of(key)));
}

/** A file specification that carries an embedded file (/EF). */
function isFilespec(d: PDFDict): boolean {
  return d.has(PDFName.of('EF'));
}

/**
 * Visits every dictionary of every indirect object, including direct
 * sub-dictionaries (e.g. an ExtGState written inline in /Resources). The
 * callback receives the dictionary and whether it belongs to a stream.
 */
function visitDicts(doc: PDFDocument, fn: (d: PDFDict, ref: PDFRef, stream: PDFStream | undefined) => void): void {
  const walk = (o: PDFObject, ref: PDFRef, depth: number) => {
    if (depth > 8) return;
    if (o instanceof PDFDict) {
      fn(o, ref, undefined);
      for (const v of o.values()) if (v instanceof PDFDict || v instanceof PDFArray) walk(v, ref, depth + 1);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        if (v instanceof PDFDict || v instanceof PDFArray) walk(v, ref, depth + 1);
      }
    }
  };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      fn(obj.dict, ref, obj);
      for (const v of obj.dict.values()) if (v instanceof PDFDict || v instanceof PDFArray) walk(v, ref, 1);
    } else {
      walk(obj, ref, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Annotations: PDF/A wants every one printable and (except Popup / Link) with
// a normal appearance.
// ---------------------------------------------------------------------------

const F_INVISIBLE = 1;
const F_HIDDEN = 2;
const F_PRINT = 4;
const F_NOVIEW = 32;
const F_TOGGLENOVIEW = 256;

function pageAnnots(doc: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  for (const page of doc.getPages()) {
    const arr = arrayOf(doc, page.node.get(PDFName.of('Annots')));
    if (arr) for (let i = 0; i < arr.size(); i++) {
      const a = dictOf(doc, arr.get(i));
      if (a) out.push(a);
    }
  }
  return out;
}

function needsAppearance(doc: PDFDocument, a: PDFDict): boolean {
  const sub = nameOf(a.get(PDFName.of('Subtype')));
  if (sub === 'Popup' || sub === 'Link') return false;
  const r = arrayOf(doc, a.get(PDFName.of('Rect')))?.asArray().map((v) => numberOf(doc, v) ?? 0);
  // Annotations of no size need no appearance.
  return !(r && r.length === 4 && (r[0] === r[2] || r[1] === r[3]));
}

function hasNormalAppearance(doc: PDFDocument, a: PDFDict): boolean {
  const n = dictOf(doc, a.get(PDFName.of('AP')))?.get(PDFName.of('N'));
  const v = n instanceof PDFRef ? doc.context.lookup(n) : n;
  return v instanceof PDFStream || v instanceof PDFDict;
}

function annotFlags(doc: PDFDocument, a: PDFDict): number {
  return numberOf(doc, a.get(PDFName.of('F'))) ?? 0;
}

const flagsOk = (f: number) => (f & F_PRINT) !== 0 && (f & (F_INVISIBLE | F_HIDDEN | F_NOVIEW | F_TOGGLENOVIEW)) === 0;

/**
 * Field appearances regenerated (when the form asked for it with
 * NeedAppearances or a widget has none), Print flags set, extra appearance
 * states dropped. Returns the notes for the user.
 */
async function fixAnnotations(doc: PDFDocument, needAppearances: boolean, fieldFont: Uint8Array | undefined): Promise<string[]> {
  const notes: string[] = [];
  const annots = pageAnnots(doc);
  const widgetsWithoutAp = annots.filter((a) => nameOf(a.get(PDFName.of('Subtype'))) === 'Widget' && needsAppearance(doc, a) && !hasNormalAppearance(doc, a)).length;
  if ((needAppearances || widgetsWithoutAp) && doc.catalog.has(PDFName.of('AcroForm'))) {
    if (fieldFont) {
      try {
        const fontkit = (await import('@pdf-lib/fontkit')).default;
        doc.registerFontkit(fontkit);
        const font = await doc.embedFont(fieldFont, { subset: false });
        const form = doc.getForm();
        // NeedAppearances: the stored appearances may be stale, so all are redone.
        if (needAppearances) for (const f of form.getFields()) form.markFieldAsDirty(f.ref);
        form.updateFieldAppearances(font);
        notes.push('Form field appearances were regenerated (PDF/A does not allow viewers to draw them).');
      } catch {
        notes.push('Some form field appearances could not be regenerated.');
      }
    }
  }
  let fixedFlags = 0;
  for (const a of pageAnnots(doc)) {
    if (nameOf(a.get(PDFName.of('Subtype'))) === 'Popup') continue;
    const f = annotFlags(doc, a);
    if (!flagsOk(f)) {
      a.set(PDFName.of('F'), PDFNumber.of((f | F_PRINT) & ~(F_INVISIBLE | F_HIDDEN | F_NOVIEW | F_TOGGLENOVIEW)));
      fixedFlags++;
    }
    // Only the normal appearance is allowed.
    const ap = dictOf(doc, a.get(PDFName.of('AP')));
    if (ap) {
      ap.delete(PDFName.of('D'));
      ap.delete(PDFName.of('R'));
    }
  }
  if (fixedFlags) notes.push(`${fixedFlags} annotation(s) were made printable and visible (PDF/A requires the Print flag).`);
  return notes;
}

/** Colour components of the first output intent's profile (3 for sRGB), or 0. */
function outputIntentComponents(doc: PDFDocument): number {
  const intents = arrayOf(doc, doc.catalog.get(PDFName.of('OutputIntents')));
  const first = intents && dictOf(doc, intents.get(0));
  const prof = first && dictOf(doc, first.get(PDFName.of('DestOutputProfile')));
  return (prof && numberOf(doc, prof.get(PDFName.of('N')))) ?? 0;
}

function decodedContent(doc: PDFDocument, o: PDFObject | undefined): Uint8Array[] {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (v instanceof PDFRawStream) {
    try {
      return [decodePDFRawStream(v).decode()];
    } catch {
      return [];
    }
  }
  const arr = v instanceof PDFArray ? v : undefined;
  return arr ? arr.asArray().flatMap((x) => decodedContent(doc, x)) : [];
}

function usesCmykOps(parts: Uint8Array[], res: PDFDict | undefined, doc: PDFDocument): boolean {
  const named = dictOf(doc, res?.get(PDFName.of('ColorSpace')));
  // A DefaultCMYK colour space turns DeviceCMYK into a calibrated one.
  if (named?.has(PDFName.of('DefaultCMYK'))) return false;
  for (const p of parts) {
    for (const { op, name } of scanContentOps(p)) {
      if (op === 'k' || op === 'K') return true;
      if ((op === 'cs' || op === 'CS') && name && (name === 'DeviceCMYK' || nameOf(named?.get(PDFName.of(name))) === 'DeviceCMYK')) return true;
    }
  }
  return false;
}

/** Pages, form XObjects and images that paint with DeviceCMYK. */
function deviceCmykUses(doc: PDFDocument): number {
  let n = 0;
  for (const page of doc.getPages()) {
    if (usesCmykOps(decodedContent(doc, page.node.get(PDFName.of('Contents'))), page.node.Resources(), doc)) n++;
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = nameOf(obj.dict.get(PDFName.of('Subtype')));
    if (sub === 'Image' && nameOf(obj.dict.lookup(PDFName.of('ColorSpace'))) === 'DeviceCMYK') n++;
    else if (sub === 'Form' && usesCmykOps(decodedContent(doc, obj), dictOf(doc, obj.dict.get(PDFName.of('Resources'))), doc)) n++;
  }
  return n;
}

function stringBytes(o: PDFObject | undefined): Uint8Array {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return new Uint8Array();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Name-tree leaves must be sorted by key; pdf-lib appends attachments unsorted. */
function sortEmbeddedFilesTree(doc: PDFDocument): void {
  const names = dictOf(doc, doc.catalog.get(PDFName.of('Names')));
  const ef = dictOf(doc, names?.get(PDFName.of('EmbeddedFiles')));
  const arr = arrayOf(doc, ef?.get(PDFName.of('Names')));
  if (!arr || ef?.has(PDFName.of('Kids'))) return;
  const pairs: [PDFObject, PDFObject][] = [];
  for (let i = 0; i + 1 < arr.size(); i += 2) pairs.push([arr.get(i), arr.get(i + 1)]);
  pairs.sort((x, y) => compareBytes(stringBytes(x[0]), stringBytes(y[0])));
  const sorted = doc.context.obj([]);
  for (const [k, v] of pairs) {
    sorted.push(k);
    sorted.push(v);
  }
  ef?.set(PDFName.of('Names'), sorted);
}

/** Deletes embedded file streams (PDF/A-1b/2b): pdf-lib would otherwise keep the orphans. */
function dropEmbeddedFiles(doc: PDFDocument): number {
  const ctx = doc.context;
  let n = 0;
  visitDicts(doc, (d) => {
    const ef = dictOf(doc, d.get(PDFName.of('EF')));
    if (!ef) return;
    for (const v of ef.values()) if (v instanceof PDFRef) ctx.delete(v);
    d.delete(PDFName.of('EF'));
    d.delete(PDFName.of('RF'));
    n++;
  });
  return n;
}

/** Sets the 3-byte version in a "%PDF-x.y" header in place. */
function patchHeaderVersion(bytes: Uint8Array, version: string): Uint8Array {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (/^%PDF-\d\.\d$/.test(head)) {
    for (let i = 0; i < 3; i++) bytes[5 + i] = version.charCodeAt(i);
  }
  return bytes;
}

/**
 * Makes every embedded file PDF/A-3 conformant: /AFRelationship on the file
 * specification, /F + /UF, MIME /Subtype and /Params /ModDate on the embedded
 * file stream, and a document-level /AF array listing all of them.
 */
function normalizeAssociatedFiles(doc: PDFDocument, now: Date): number {
  const ctx = doc.context;
  const FS = PDFName.of('FS');
  // Direct file specifications inside annotations cannot be listed in /AF by
  // reference; make them indirect first.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const fs = obj.get(FS);
    if (fs instanceof PDFDict && isFilespec(fs)) obj.set(FS, ctx.register(fs));
  }
  const refs: PDFRef[] = [];
  const seen = new Set<string>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || !isFilespec(obj)) continue;
    const rel = nameOf(obj.get(PDFName.of('AFRelationship')));
    if (!rel || !ALLOWED_AF.has(rel)) obj.set(PDFName.of('AFRelationship'), PDFName.of('Unspecified'));
    const f = textOf(doc, obj.get(PDFName.of('F')));
    const uf = textOf(doc, obj.get(PDFName.of('UF')));
    const fileName = uf ?? f ?? 'attachment';
    if (!uf) obj.set(PDFName.of('UF'), PDFHexString.fromText(fileName));
    if (!f) obj.set(PDFName.of('F'), PDFString.of(fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[()\\]/g, '_')));
    const ef = dictOf(doc, obj.get(PDFName.of('EF')));
    if (ef) {
      for (const key of ef.keys()) {
        const stream = ctx.lookup(ef.get(key));
        if (!(stream instanceof PDFStream)) continue;
        const sd = stream.dict;
        if (!(sd.get(PDFName.of('Subtype')) instanceof PDFName)) {
          sd.set(PDFName.of('Subtype'), PDFName.of('application/octet-stream'));
        }
        let params = dictOf(doc, sd.get(PDFName.of('Params')));
        if (!params) {
          params = ctx.obj({});
          sd.set(PDFName.of('Params'), params);
        }
        if (!params.has(PDFName.of('ModDate'))) params.set(PDFName.of('ModDate'), PDFString.fromDate(now));
      }
    }
    const tag = ref.toString();
    if (!seen.has(tag)) {
      seen.add(tag);
      refs.push(ref);
    }
  }
  if (!refs.length) {
    doc.catalog.delete(PDFName.of('AF'));
    return 0;
  }
  const af = ctx.obj([]);
  const existing = arrayOf(doc, doc.catalog.get(PDFName.of('AF')));
  const listed = new Set<string>();
  if (existing) {
    for (let i = 0; i < existing.size(); i++) {
      const e = existing.get(i);
      if (e instanceof PDFRef && seen.has(e.toString()) && !listed.has(e.toString())) {
        listed.add(e.toString());
        af.push(e);
      }
    }
  }
  for (const r of refs) if (!listed.has(r.toString())) af.push(r);
  doc.catalog.set(PDFName.of('AF'), af);
  return refs.length;
}

/**
 * Converts to PDF/A (default level 2b) and reports what was changed.
 * Throws for encrypted input.
 */
export async function convertToPdfADetailed(bytes: Uint8Array, meta: PdfAMeta): Promise<PdfAConversionResult> {
  const level: PdfALevel = meta.level ?? '2b';
  const label = levelLabel(level);
  const notes: string[] = [];
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) {
    throw new Error('PDF/A cannot be produced from an encrypted PDF. Remove the password protection first.');
  }
  const ctx = doc.context;
  const catalog = doc.catalog;
  const keepFiles = level === '3b';

  // --- Strip forbidden features -------------------------------------------
  const names = dictOf(doc, catalog.get(PDFName.of('Names')));
  if (names) {
    names.delete(PDFName.of('JavaScript'));
    if (!keepFiles && names.has(PDFName.of('EmbeddedFiles'))) {
      names.delete(PDFName.of('EmbeddedFiles'));
      notes.push(`Embedded files were removed (${label} does not allow them).`);
    }
  }
  if (isJsAction(doc, catalog.get(PDFName.of('OpenAction')))) catalog.delete(PDFName.of('OpenAction'));
  catalog.delete(PDFName.of('AA'));
  if (!keepFiles) catalog.delete(PDFName.of('AF'));
  catalog.delete(PDFName.of('NeedsRendering'));
  catalog.delete(PDFName.of('Collection'));
  if (level === '1b') {
    catalog.delete(PDFName.of('Version'));
    if (catalog.has(PDFName.of('OCProperties'))) {
      catalog.delete(PDFName.of('OCProperties'));
      notes.push('Optional content (layers) was removed: PDF/A-1 does not support it. All layers are now always visible.');
    }
  }
  const acro = dictOf(doc, catalog.get(PDFName.of('AcroForm')));
  let needAppearances = false;
  if (acro) {
    acro.delete(PDFName.of('XFA'));
    needAppearances = String(acro.lookup(PDFName.of('NeedAppearances'))) === 'true';
    acro.delete(PDFName.of('NeedAppearances'));
  }

  const A = PDFName.of('A');
  const AA = PDFName.of('AA');
  const JS = PDFName.of('JS');
  const Annots = PDFName.of('Annots');
  const OC = PDFName.of('OC');
  const Group = PDFName.of('Group');
  let removedAttachAnnots = 0;
  let removedGroups = 0;
  visitDicts(doc, (d) => {
    d.delete(AA);
    if (isJsAction(doc, d.get(A))) d.delete(A);
    if (nameOf(d.get(PDFName.of('S'))) === 'JavaScript') d.delete(JS);
    // Chained actions (/Next) may also carry JavaScript.
    const next = d.get(PDFName.of('Next'));
    if (isJsAction(doc, next)) d.delete(PDFName.of('Next'));
    if (!keepFiles) d.delete(PDFName.of('AF'));
    if (level === '1b') {
      d.delete(OC);
      const g = dictOf(doc, d.get(Group));
      const type = nameOf(d.get(PDFName.of('Type')));
      if (g && nameOf(g.get(PDFName.of('S'))) === 'Transparency' && (type === 'Page' || nameOf(d.get(PDFName.of('Subtype'))) === 'Form')) {
        d.delete(Group);
        removedGroups++;
      }
    }
    // Drop annotation types PDF/A forbids (and file attachments unless 3b).
    const arr = arrayOf(doc, d.get(Annots));
    if (arr) {
      for (let i = arr.size() - 1; i >= 0; i--) {
        const ad = dictOf(doc, arr.get(i));
        const sub = nameOf(ad?.get(PDFName.of('Subtype')));
        if (sub === 'FileAttachment' && !keepFiles) {
          arr.remove(i);
          removedAttachAnnots++;
        } else if (sub === 'Sound' || sub === 'Movie' || sub === 'Screen' || sub === 'RichMedia' || sub === '3D') {
          arr.remove(i);
        }
      }
    }
  });
  if (!keepFiles) {
    const dropped = dropEmbeddedFiles(doc);
    if (dropped && !notes.some((n) => n.startsWith('Embedded files'))) {
      notes.push(`Embedded files were removed (${label} does not allow them).`);
    }
  }
  notes.push(...(await fixAnnotations(doc, needAppearances, meta.fieldFont)));
  if (removedAttachAnnots) notes.push(`${removedAttachAnnots} file-attachment annotation(s) were removed.`);
  if (removedGroups) notes.push(`${removedGroups} transparency group(s) were removed (PDF/A-1 forbids them).`);

  // --- Info dictionary ----------------------------------------------------
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  let created: Date | undefined;
  try {
    created = doc.getCreationDate();
  } catch {
    created = undefined;
  }
  if (!created || Number.isNaN(created.getTime())) created = now;
  created = new Date(Math.floor(created.getTime() / 1000) * 1000);

  const subject = infoText(doc, 'Subject');
  const keywords = infoText(doc, 'Keywords');
  const creatorTool = infoText(doc, 'Creator');

  // Reset Info to a clean, consistent set of entries.
  const info = ctx.obj({});
  ctx.trailerInfo.Info = ctx.register(info);
  doc.setTitle(meta.title, { showInWindowTitleBar: true });
  doc.setAuthor(meta.author);
  doc.setProducer(PDFA_PRODUCER);
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  if (subject) doc.setSubject(subject);
  if (keywords) info.set(PDFName.of('Keywords'), PDFHexString.fromText(keywords));
  if (creatorTool) doc.setCreator(creatorTool);

  // --- Associated files (3b) ---------------------------------------------
  const attachments = meta.attachments ?? [];
  if (attachments.length && !keepFiles) {
    notes.push(
      `${attachments.length} attachment(s) were not embedded: ${label} does not allow embedded files. Choose PDF/A-3b to keep them.`,
    );
  }
  if (keepFiles) {
    for (const a of attachments) {
      const rel = a.relationship && ALLOWED_AF.has(a.relationship) ? a.relationship : 'Unspecified';
      await doc.attach(a.bytes, a.name, {
        mimeType: a.mime || 'application/octet-stream',
        description: a.description ?? a.name,
        creationDate: now,
        modificationDate: now,
        afRelationship: AFRelationship[rel],
      });
    }
    // Materialise the file specifications so they can be normalised below.
    await doc.flush();
    sortEmbeddedFilesTree(doc);
    const n = normalizeAssociatedFiles(doc, now);
    if (n) notes.push(`${n} embedded file(s) are associated with the document (/AF).`);
  }

  // --- XMP metadata (uncompressed) ----------------------------------------
  const xmp = buildPdfAXmp({
    title: meta.title,
    author: meta.author,
    producer: PDFA_PRODUCER,
    createDate: created,
    modifyDate: now,
    subject,
    keywords,
    creatorTool,
    part: levelPart(level),
    extra: meta.extraXmp,
  });
  const xmpStream = ctx.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  catalog.set(PDFName.of('Metadata'), ctx.register(xmpStream));

  // --- Output intent ------------------------------------------------------
  // The ICC v2 sRGB profile is valid for all three parts (PDF/A-1 requires v2
  // or lower; later parts accept it too).
  const icc = buildSrgbIccProfile();
  const iccStream = ctx.flateStream(icc, { N: 3 });
  const iccRef = ctx.register(iccStream);
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    DestOutputProfile: iccRef,
  });
  catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));

  const idHex = toHex(randomId());
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(idHex), PDFHexString.of(idHex)]);

  // Classic xref table (no object or xref streams, which PDF 1.4 lacks):
  // keeps the trailer /ID in the file trailer.
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  if (level === '1b') patchHeaderVersion(out, '1.4');
  return { bytes: out, notes };
}

/** Converts to PDF/A (default level 2b). See `convertToPdfADetailed`. */
export async function convertToPdfA(bytes: Uint8Array, meta: PdfAMeta): Promise<Uint8Array> {
  return (await convertToPdfADetailed(bytes, meta)).bytes;
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

function filterNames(doc: PDFDocument, o: PDFObject | undefined): string[] {
  const n = nameOf(o instanceof PDFRef ? doc.context.lookup(o) : o);
  if (n) return [n];
  const arr = arrayOf(doc, o);
  const out: string[] = [];
  if (arr) for (let i = 0; i < arr.size(); i++) {
    const x = nameOf(arr.get(i));
    if (x) out.push(x);
  }
  return out;
}

function detectLevel(doc: PDFDocument): PdfALevel | undefined {
  const m = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
  if (!(m instanceof PDFRawStream) || m.dict.has(PDFName.of('Filter'))) return undefined;
  const xmp = new TextDecoder().decode(m.contents);
  const part = /<pdfaid:part>\s*(\d)\s*</.exec(xmp)?.[1] ?? /pdfaid:part="(\d)"/.exec(xmp)?.[1];
  return part === '1' ? '1b' : part === '2' ? '2b' : part === '3' ? '3b' : undefined;
}

/**
 * Lists the PDF/A problems this module cannot fix automatically, adapted to
 * the level (detected from the XMP when not given; default 2b). The last line
 * always asks for veraPDF validation.
 */
export async function pdfaWarnings(bytes: Uint8Array, level?: PdfALevel): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const warnings: string[] = [];
  if (doc.isEncrypted) {
    warnings.push('The document is encrypted; PDF/A forbids encryption.');
    return warnings;
  }
  const lv: PdfALevel = level ?? detectLevel(doc) ?? '2b';
  const label = levelLabel(lv);
  const ctx = doc.context;
  const nonEmbedded = new Set<string>();
  let transparencyGroups = 0;
  let softMasks = 0;
  let imageSoftMasks = 0;
  let alpha = 0;
  const blendModes = new Set<string>();
  let jpx = 0;
  let deep = 0;
  let lzw = 0;
  let filespecs = 0;
  let filespecsNoRel = 0;
  let efNoMime = 0;
  let efNoModDate = 0;
  const af = arrayOf(doc, doc.catalog.get(PDFName.of('AF')));
  const afRefs = new Set<string>();
  if (af) for (let i = 0; i < af.size(); i++) afRefs.add(String(af.get(i)));
  let filespecsNotInAf = 0;

  visitDicts(doc, (d, ref, stream) => {
    const type = nameOf(d.get(PDFName.of('Type')));
    const subtype = nameOf(d.get(PDFName.of('Subtype')));

    if (type === 'FontDescriptor') {
      const has =
        d.has(PDFName.of('FontFile')) || d.has(PDFName.of('FontFile2')) || d.has(PDFName.of('FontFile3'));
      if (!has) nonEmbedded.add(nameOf(d.get(PDFName.of('FontName'))) ?? 'unnamed font');
    } else if (type === 'Font' && (subtype === 'Type1' || subtype === 'TrueType' || subtype === 'MMType1')) {
      if (!d.has(PDFName.of('FontDescriptor'))) {
        nonEmbedded.add(nameOf(d.get(PDFName.of('BaseFont'))) ?? 'standard font');
      }
    }

    const group = dictOf(doc, d.get(PDFName.of('Group')));
    if (group && nameOf(group.get(PDFName.of('S'))) === 'Transparency') transparencyGroups++;
    const smask = d.get(PDFName.of('SMask'));
    if (type === 'ExtGState') {
      if (smask && nameOf(smask) !== 'None') softMasks++;
      for (const k of ['CA', 'ca']) {
        const v = numberOf(doc, d.get(PDFName.of(k)));
        if (v !== undefined && v < 1) alpha++;
      }
      for (const bm of filterNames(doc, d.get(PDFName.of('BM')))) {
        if (bm !== 'Normal' && bm !== 'Compatible') blendModes.add(bm);
      }
    }
    if (stream) {
      const filters = filterNames(doc, d.get(PDFName.of('Filter')));
      if (filters.includes('LZWDecode')) lzw++;
      if (subtype === 'Image') {
        if (filters.includes('JPXDecode')) jpx++;
        if (numberOf(doc, d.get(PDFName.of('BitsPerComponent'))) === 16) deep++;
        if (smask && !(smask instanceof PDFName)) imageSoftMasks++;
      }
    }
    if (isFilespec(d)) {
      filespecs++;
      const rel = nameOf(d.get(PDFName.of('AFRelationship')));
      if (!rel || !ALLOWED_AF.has(rel)) filespecsNoRel++;
      if (!afRefs.has(ref.toString())) filespecsNotInAf++;
      const ef = dictOf(doc, d.get(PDFName.of('EF')));
      if (ef) {
        for (const key of ef.keys()) {
          const s = ctx.lookup(ef.get(key));
          if (!(s instanceof PDFStream)) continue;
          if (!(s.dict.get(PDFName.of('Subtype')) instanceof PDFName)) efNoMime++;
          const params = dictOf(doc, s.dict.get(PDFName.of('Params')));
          if (!params?.has(PDFName.of('ModDate'))) efNoModDate++;
        }
      }
    }
  });

  if (nonEmbedded.size) {
    const list = [...nonEmbedded].slice(0, 10).join(', ');
    const more = nonEmbedded.size > 10 ? ` and ${nonEmbedded.size - 10} more` : '';
    warnings.push(
      `${nonEmbedded.size} font(s) are not embedded (${list}${more}). PDF/A requires every font to be embedded; validators will reject this file.`,
    );
  }

  if (lv === '1b') {
    const head = String.fromCharCode(...bytes.subarray(0, 8));
    if (head !== '%PDF-1.4' && !/^%PDF-1\.[0-3]$/.test(head)) {
      warnings.push(`The file header is "${head}"; PDF/A-1 is based on PDF 1.4.`);
    }
    const transparency = transparencyGroups + softMasks + imageSoftMasks + alpha + blendModes.size;
    if (transparency) {
      const parts: string[] = [];
      if (transparencyGroups) parts.push(`${transparencyGroups} transparency group(s)`);
      if (softMasks) parts.push(`${softMasks} soft mask(s) in graphics states`);
      if (imageSoftMasks) parts.push(`${imageSoftMasks} image(s) with an alpha channel (SMask)`);
      if (alpha) parts.push(`${alpha} constant opacity value(s) below 1 (/CA, /ca)`);
      if (blendModes.size) parts.push(`blend modes ${[...blendModes].join(', ')}`);
      warnings.push(
        `Transparency found: ${parts.join('; ')}. PDF/A-1 forbids transparency; flatten the document or choose PDF/A-2b.`,
      );
    }
    if (jpx) warnings.push(`${jpx} JPEG 2000 image(s) (JPXDecode) found; PDF/A-1 forbids JPEG 2000. Choose PDF/A-2b or re-compress the images.`);
    if (deep) warnings.push(`${deep} image(s) with 16 bits per component found; PDF/A-1 allows at most 8.`);
    if (doc.catalog.has(PDFName.of('OCProperties'))) {
      warnings.push('The document contains optional content (layers); PDF/A-1 forbids it.');
    }
  } else {
    if (transparencyGroups) {
      warnings.push(
        `${transparencyGroups} transparency group(s) found. ${label} allows transparency, but blending must resolve against the sRGB output intent; check the result.`,
      );
    }
    if (softMasks) {
      warnings.push(`${softMasks} soft mask(s) found in graphics states.`);
    }
  }
  if (lzw) warnings.push(`${lzw} stream(s) use LZW compression, which PDF/A forbids. Re-compress the document.`);

  if (lv === '3b') {
    if (filespecsNoRel) warnings.push(`${filespecsNoRel} embedded file(s) lack a valid /AFRelationship.`);
    if (filespecsNotInAf) warnings.push(`${filespecsNotInAf} embedded file(s) are not listed in the document /AF array.`);
    if (efNoMime) warnings.push(`${efNoMime} embedded file stream(s) lack a MIME type (/Subtype).`);
    if (efNoModDate) warnings.push(`${efNoModDate} embedded file stream(s) lack /Params /ModDate.`);
  } else if (filespecs) {
    warnings.push(`${filespecs} embedded file(s) found; ${label} does not allow arbitrary embedded files. Choose PDF/A-3b to keep them.`);
  }

  const annots = pageAnnots(doc);
  const noAp = annots.filter((a) => needsAppearance(doc, a) && !hasNormalAppearance(doc, a)).length;
  const noPrint = annots.filter((a) => nameOf(a.get(PDFName.of('Subtype'))) !== 'Popup' && !flagsOk(annotFlags(doc, a))).length;
  if (noAp) warnings.push(`${noAp} annotation(s) or form field(s) have no appearance stream; PDF/A requires one. Flatten the form or fill the fields again before converting.`);
  if (noPrint) warnings.push(`${noPrint} annotation(s) are hidden or not set to print; PDF/A requires them to be printable.`);
  const acro = dictOf(doc, doc.catalog.get(PDFName.of('AcroForm')));
  if (acro && String(acro.lookup(PDFName.of('NeedAppearances'))) === 'true') warnings.push('The form asks viewers to draw its fields (NeedAppearances); PDF/A forbids that.');
  const cmyk = deviceCmykUses(doc);
  if (cmyk && outputIntentComponents(doc) !== 4) {
    warnings.push(`${cmyk} page(s), image(s) or drawing(s) use DeviceCMYK colours, but the output intent is RGB (sRGB). PDF/A requires device colours to match the output intent: convert the colours to RGB first (or use a CMYK output intent).`);
  }

  warnings.push(`The result carries ${label} markers but has not been validated. Validate it with veraPDF before archiving.`);
  return warnings;
}
