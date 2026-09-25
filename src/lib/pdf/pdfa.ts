// PDF/A-2b conversion helpers.
//
// This module adds the structural markers that PDF/A-2b requires (sRGB output
// intent with an embedded ICC profile, XMP metadata consistent with the Info
// dictionary, a trailer /ID) and removes the features that PDF/A forbids
// outright (encryption, JavaScript, embedded files, XFA). It does NOT embed
// missing fonts or flatten transparency; `pdfaWarnings` reports those so the
// UI can tell the user honestly to validate the result with veraPDF.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from 'pdf-lib';

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
    '<pdfaid:part>2</pdfaid:part>',
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
  lines.push('</rdf:Description>', '</rdf:RDF>', '</x:xmpmeta>');
  // Padding so in-place XMP editors can grow the packet.
  const pad = (' '.repeat(99) + '\n').repeat(20);
  return lines.join('\n') + '\n' + pad + '<?xpacket end="w"?>';
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

function dictOf(doc: PDFDocument, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

function isJsAction(doc: PDFDocument, o: PDFObject | undefined): boolean {
  const d = dictOf(doc, o);
  if (!d) return false;
  const s = nameOf(d.get(PDFName.of('S')));
  // Actions PDF/A-2 forbids.
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

function infoText(doc: PDFDocument, key: string): string | undefined {
  const infoRef = doc.context.trailerInfo.Info;
  const info = dictOf(doc, infoRef as PDFObject | undefined);
  const v = info?.get(PDFName.of(key));
  const r = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (r instanceof PDFString || r instanceof PDFHexString) {
    const t = r.decodeText();
    return t.length ? t : undefined;
  }
  return undefined;
}

export async function convertToPdfA(
  bytes: Uint8Array,
  meta: { title: string; author: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) {
    throw new Error('PDF/A cannot be produced from an encrypted PDF. Remove the password protection first.');
  }
  const ctx = doc.context;
  const catalog = doc.catalog;

  // --- Strip forbidden features -------------------------------------------
  const names = dictOf(doc, catalog.get(PDFName.of('Names')));
  if (names) {
    names.delete(PDFName.of('JavaScript'));
    names.delete(PDFName.of('EmbeddedFiles'));
  }
  if (isJsAction(doc, catalog.get(PDFName.of('OpenAction')))) catalog.delete(PDFName.of('OpenAction'));
  catalog.delete(PDFName.of('AA'));
  catalog.delete(PDFName.of('AF'));
  catalog.delete(PDFName.of('NeedsRendering'));
  catalog.delete(PDFName.of('Collection'));
  const acro = dictOf(doc, catalog.get(PDFName.of('AcroForm')));
  if (acro) {
    acro.delete(PDFName.of('XFA'));
    acro.delete(PDFName.of('NeedAppearances'));
  }

  const A = PDFName.of('A');
  const AA = PDFName.of('AA');
  const JS = PDFName.of('JS');
  const Annots = PDFName.of('Annots');
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : undefined;
    if (!d) continue;
    d.delete(AA);
    if (isJsAction(doc, d.get(A))) d.delete(A);
    if (nameOf(d.get(PDFName.of('S'))) === 'JavaScript') d.delete(JS);
    // Chained actions (/Next) may also carry JavaScript.
    const next = d.get(PDFName.of('Next'));
    if (isJsAction(doc, next)) d.delete(PDFName.of('Next'));
    d.delete(PDFName.of('AF'));
    // Drop file-attachment annotations (embedded files).
    const annots = d.get(Annots);
    const arr = annots instanceof PDFRef ? ctx.lookup(annots) : annots;
    if (arr instanceof PDFArray) {
      for (let i = arr.size() - 1; i >= 0; i--) {
        const ad = dictOf(doc, arr.get(i));
        const sub = nameOf(ad?.get(PDFName.of('Subtype')));
        if (sub === 'FileAttachment' || sub === 'Sound' || sub === 'Movie' || sub === 'Screen' || sub === 'RichMedia' || sub === '3D') {
          arr.remove(i);
        }
      }
    }
  }

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
  });
  const xmpStream = ctx.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  catalog.set(PDFName.of('Metadata'), ctx.register(xmpStream));

  // --- Output intent ------------------------------------------------------
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

  // Classic xref table: keeps the trailer /ID in the file trailer.
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export async function pdfaWarnings(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const warnings: string[] = [];
  if (doc.isEncrypted) {
    warnings.push('The document is encrypted; PDF/A forbids encryption.');
    return warnings;
  }
  const ctx = doc.context;
  const nonEmbedded = new Set<string>();
  let transparencyGroups = 0;
  let softMasks = 0;

  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : undefined;
    if (!d) continue;
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
    if (type === 'ExtGState' && smask && nameOf(smask) !== 'None') softMasks++;
  }

  if (nonEmbedded.size) {
    const list = [...nonEmbedded].slice(0, 10).join(', ');
    const more = nonEmbedded.size > 10 ? ` and ${nonEmbedded.size - 10} more` : '';
    warnings.push(
      `${nonEmbedded.size} font(s) are not embedded (${list}${more}). PDF/A requires every font to be embedded; validators will reject this file.`,
    );
  }
  if (transparencyGroups) {
    warnings.push(
      `${transparencyGroups} transparency group(s) found. PDF/A-2 allows transparency, but blending must resolve against the sRGB output intent; check the result.`,
    );
  }
  if (softMasks) {
    warnings.push(`${softMasks} soft mask(s) found in graphics states.`);
  }
  warnings.push('The result carries PDF/A-2b markers but has not been validated. Validate it with veraPDF before archiving.');
  return warnings;
}
