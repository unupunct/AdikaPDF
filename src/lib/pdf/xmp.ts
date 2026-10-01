/**
 * XMP metadata (the document's XML metadata packet): title, authors,
 * description, keywords, copyright status / notice / URL, and the custom
 * properties of the Info dictionary. Writing keeps everything else in the
 * packet (PDF/A identification, Factur-X data, other schemas) and keeps XMP
 * and Info in step, as PDF/A and Acrobat expect. Pure (pdf-lib + xml.ts).
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import { attr, isEl, kids, localName, parseXmlDoc, serializeXml, textOf, type XEl } from '@/lib/xml';

export type RightsStatus = 'unknown' | 'copyrighted' | 'public';

export interface XmpFields {
  title: string;
  authors: string[];
  description: string;
  keywords: string;
  rightsStatus: RightsStatus;
  copyright: string;
  copyrightUrl: string;
}

const NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
};

/** Info dictionary keys that are not custom properties. */
const STANDARD_INFO = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);

const str = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : '');

export function readXmpPacket(doc: PDFDocument): string | null {
  const m = doc.catalog.lookup(PDFName.of('Metadata'));
  if (!(m instanceof PDFStream)) return null;
  try {
    const bytes = m instanceof PDFRawStream ? decodePDFRawStream(m).decode() : (m as unknown as { getContents(): Uint8Array }).getContents();
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function descriptions(root: XEl): XEl[] {
  const out: XEl[] = [];
  const walk = (e: XEl) => {
    for (const c of kids(e)) {
      if (localName(c.name) === 'Description') out.push(c);
      else walk(c);
    }
  };
  walk(root);
  return out;
}

/** A property (element or attribute form) in any rdf:Description. */
function prop(descs: XEl[], qname: string): XEl | string | undefined {
  for (const d of descs) {
    const a = attr(d, qname);
    if (a !== undefined) return a;
    const e = d.children.find((c): c is XEl => isEl(c) && c.name === qname);
    if (e) return e;
  }
  return undefined;
}

const liTexts = (e: XEl | string | undefined): string[] => {
  if (e === undefined) return [];
  if (typeof e === 'string') return [e];
  const container = kids(e)[0];
  if (!container) return [textOf(e).trim()].filter(Boolean);
  return kids(container, 'li').map((li) => textOf(li).trim());
};

/** Custom properties of the Info dictionary (name -> text). */
export function readCustomInfo(doc: PDFDocument): Record<string, string> {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  const out: Record<string, string> = {};
  if (info instanceof PDFDict) for (const [k, v] of info.entries()) if (!STANDARD_INFO.has(k.decodeText())) out[k.decodeText()] = str(v);
  return out;
}

export function readXmpFields(doc: PDFDocument): XmpFields | null {
  const xml = readXmpPacket(doc);
  if (!xml) return null;
  let root: XEl;
  try {
    root = parseXmlDoc(xml);
  } catch {
    return null;
  }
  const d = descriptions(root);
  const marked = prop(d, 'xmpRights:Marked');
  const m = typeof marked === 'string' ? marked : marked ? textOf(marked).trim() : '';
  const web = prop(d, 'xmpRights:WebStatement');
  return {
    title: liTexts(prop(d, 'dc:title'))[0] ?? '',
    authors: liTexts(prop(d, 'dc:creator')),
    description: liTexts(prop(d, 'dc:description'))[0] ?? '',
    keywords: (() => {
      const k = prop(d, 'pdf:Keywords');
      if (k !== undefined) return typeof k === 'string' ? k : textOf(k).trim();
      return liTexts(prop(d, 'dc:subject')).join(', ');
    })(),
    rightsStatus: /^true$/i.test(m) ? 'copyrighted' : /^false$/i.test(m) ? 'public' : 'unknown',
    copyright: liTexts(prop(d, 'dc:rights'))[0] ?? '',
    copyrightUrl: typeof web === 'string' ? web : web ? textOf(web).trim() : '',
  };
}

const el = (name: string, attrs: Array<[string, string]> = [], children: XEl['children'] = []): XEl => ({ name, attrs, children });
const alt = (name: string, v: string) => el(name, [], [el('rdf:Alt', [], [el('rdf:li', [['xml:lang', 'x-default']], [v])])]);
const seq = (name: string, vs: string[]) => el(name, [], [el('rdf:Seq', [], vs.map((v) => el('rdf:li', [], [v])))]);
const bag = (name: string, vs: string[]) => el(name, [], [el('rdf:Bag', [], vs.map((v) => el('rdf:li', [], [v])))]);
const isoNow = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const SKELETON = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/**
 * Writes the fields into the document's XMP (made when missing) and the Info
 * dictionary, and replaces the custom Info properties with `custom`.
 */
export function writeXmp(doc: PDFDocument, f: XmpFields, opts: { producer?: string; modified?: Date; custom?: Record<string, string> } = {}): void {
  const old = readXmpPacket(doc);
  let docEl: XEl;
  try {
    docEl = parseXmlDoc(old && /<rdf:RDF/.test(old) ? old : SKELETON);
  } catch {
    docEl = parseXmlDoc(SKELETON);
  }
  const rdf = (function find(e: XEl): XEl | undefined {
    for (const c of kids(e)) {
      if (localName(c.name) === 'RDF') return c;
      const r = find(c);
      if (r) return r;
    }
    return undefined;
  })(docEl);
  if (!rdf) throw new Error('XMP without rdf:RDF');
  const descs = descriptions(rdf);
  const ours = [
    'dc:title',
    'dc:creator',
    'dc:description',
    'dc:subject',
    'dc:rights',
    'pdf:Keywords',
    'pdf:Producer',
    'xmp:ModifyDate',
    'xmp:MetadataDate',
    'xmpRights:Marked',
    'xmpRights:WebStatement',
  ];
  // Our properties leave every description (element or attribute form)…
  for (const d of descs) {
    d.attrs = d.attrs.filter(([k]) => !ours.includes(k));
    d.children = d.children.filter((c) => !(isEl(c) && ours.includes(c.name)));
  }
  // …and go into one description of their own.
  const mine = el('rdf:Description', [['rdf:about', ''], ...Object.entries(NS).map(([p, u]) => [`xmlns:${p}`, u] as [string, string])]);
  const add = (e: XEl) => mine.children.push(e);
  if (f.title) add(alt('dc:title', f.title));
  if (f.authors.length) add(seq('dc:creator', f.authors));
  if (f.description) add(alt('dc:description', f.description));
  const words = f.keywords.split(/[,;]\s*/).map((w) => w.trim()).filter(Boolean);
  if (words.length) {
    add(bag('dc:subject', words));
    add(el('pdf:Keywords', [], [f.keywords]));
  }
  if (f.copyright) add(alt('dc:rights', f.copyright));
  if (f.rightsStatus !== 'unknown') add(el('xmpRights:Marked', [], [f.rightsStatus === 'copyrighted' ? 'True' : 'False']));
  if (f.copyrightUrl) add(el('xmpRights:WebStatement', [], [f.copyrightUrl]));
  if (opts.producer) add(el('pdf:Producer', [], [opts.producer]));
  const when = isoNow(opts.modified ?? new Date());
  add(el('xmp:ModifyDate', [], [when]));
  add(el('xmp:MetadataDate', [], [when]));
  // Descriptions left empty go.
  rdf.children = rdf.children.filter((c) => !(isEl(c) && localName(c.name) === 'Description' && !c.children.some(isEl) && c.attrs.every(([k]) => k === 'rdf:about' || k.startsWith('xmlns'))));
  rdf.children.push(mine);
  let body = serializeXml(docEl);
  if (!/^<\?xpacket/.test(body)) body = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>${body}<?xpacket end="w"?>`;
  // Padding so in-place editors can grow the packet.
  body = body.replace(/<\?xpacket end=/, `${(' '.repeat(99) + '\n').repeat(10)}<?xpacket end=`);
  const stream = doc.context.stream(new TextEncoder().encode(body), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  // Info in step.
  doc.setTitle(f.title);
  doc.setAuthor(f.authors.join('; '));
  doc.setSubject(f.description);
  doc.setKeywords(words);
  if (opts.custom) {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const k of info.keys()) if (!STANDARD_INFO.has(k.decodeText())) info.delete(k);
      for (const [k, v] of Object.entries(opts.custom)) if (k.trim() && /^[A-Za-z0-9_.-]+$/.test(k.trim())) info.set(PDFName.of(k.trim()), PDFHexString.fromText(v));
    }
  }

}

/** Text for display: the packet without its padding. */
export function xmpForDisplay(xml: string): string {
  return xml.replace(/\s{20,}/g, '\n').trim();
}
