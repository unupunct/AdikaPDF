/**
 * PDF/X (print exchange): preflight for PDF/X-4 and PDF/X-1a:2003, and
 * conversion. Both need embedded fonts, a trim box on every page, an output
 * intent (the printing condition), the PDF/X version in the metadata and no
 * encryption. PDF/X-1a also needs CMYK / grey / spot colours only, no
 * transparency and PDF 1.4: pages that still have transparency (or missing
 * fonts) are rasterised to CMYK by the caller's renderer.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { genericCmykProfile, rgbToCmyk } from './color';
import { convertDocumentColors, type ConvertHooks } from './convertColors';

export type PdfXLevel = 'x4' | 'x1a';

export interface PreflightIssue {
  rule: string;
  detail: string;
  /** The conversion fixes it. */
  fixable: boolean;
  pages?: number[];
}

const VERSION_NAME: Record<PdfXLevel, string> = { x4: 'PDF/X-4', x1a: 'PDF/X-1a:2003' };
export const pdfxName = (l: PdfXLevel) => VERSION_NAME[l];

function look(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

/** Every dictionary reachable from the page tree and catalog, visited once. */
function walk(doc: PDFDocument, visit: (d: PDFDict, stream: PDFStream | null) => void): void {
  const seen = new Set<unknown>();
  const stack: unknown[] = [doc.catalog];
  while (stack.length) {
    const v = look(doc, stack.pop());
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof PDFStream) {
      visit(v.dict, v);
      for (const [, x] of v.dict.entries()) stack.push(x);
    } else if (v instanceof PDFDict) {
      visit(v, null);
      for (const [k, x] of v.entries()) if (k.decodeText() !== 'Parent') stack.push(x);
    } else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
  }
}

/** The Info dictionary (pdf-lib keeps its accessor private). */
const infoOf = (doc: PDFDocument) => (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
const nameOf = (v: unknown) => (v instanceof PDFName ? v.decodeText() : null);

function pageNumbersWith(doc: PDFDocument, test: (page: PDFPage) => boolean): number[] {
  return doc
    .getPages()
    .map((p, i) => (test(p) ? i + 1 : 0))
    .filter(Boolean);
}

/** Transparency used on a page (soft masks, constant alpha, blend modes, groups). */
export function pageHasTransparency(doc: PDFDocument, page: PDFPage): boolean {
  let found = false;
  const seen = new Set<unknown>();
  const visitRes = (res: unknown, depth: number) => {
    const r = look(doc, res);
    if (!(r instanceof PDFDict) || seen.has(r) || depth > 10) return;
    seen.add(r);
    const gs = r.lookup(PDFName.of('ExtGState'));
    if (gs instanceof PDFDict)
      for (const [, g] of gs.entries()) {
        const d = look(doc, g);
        if (!(d instanceof PDFDict)) continue;
        const sm = d.lookup(PDFName.of('SMask'));
        if (sm && nameOf(sm) !== 'None') found = true;
        for (const k of ['CA', 'ca']) {
          const a = d.lookup(PDFName.of(k));
          if (a instanceof PDFNumber && a.asNumber() < 1) found = true;
        }
        const bm = d.lookup(PDFName.of('BM'));
        const bmn = bm instanceof PDFArray ? nameOf(bm.lookup(0)) : nameOf(bm);
        if (bmn && bmn !== 'Normal' && bmn !== 'Compatible') found = true;
      }
    const xo = r.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict)
      for (const [, x] of xo.entries()) {
        const s = look(doc, x);
        if (!(s instanceof PDFStream)) continue;
        if (s.dict.has(PDFName.of('SMask'))) found = true;
        const g = s.dict.lookup(PDFName.of('Group'));
        if (g instanceof PDFDict && nameOf(g.lookup(PDFName.of('S'))) === 'Transparency') found = true;
        visitRes(s.dict.get(PDFName.of('Resources')), depth + 1);
      }
  };
  const g = page.node.lookup(PDFName.of('Group'));
  if (g instanceof PDFDict && nameOf(g.lookup(PDFName.of('S'))) === 'Transparency') found = true;
  visitRes(page.node.get(PDFName.of('Resources')) ?? page.node.getInheritableAttribute?.(PDFName.of('Resources')), 0);
  return found;
}

function unembeddedFonts(doc: PDFDocument): Set<string> {
  const out = new Set<string>();
  walk(doc, (d) => {
    if (nameOf(d.get(PDFName.of('Type'))) !== 'Font') return;
    const sub = nameOf(d.get(PDFName.of('Subtype')));
    if (sub === 'Type3' || sub === 'Type0') return;
    const fd = look(doc, d.get(PDFName.of('FontDescriptor')));
    const ok = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    if (!ok) out.add(nameOf(d.get(PDFName.of('BaseFont'))) ?? 'unnamed font');
  });
  // Type0 fonts: their descendant.
  walk(doc, (d) => {
    if (nameOf(d.get(PDFName.of('Subtype'))) !== 'CIDFontType0' && nameOf(d.get(PDFName.of('Subtype'))) !== 'CIDFontType2') return;
    const fd = look(doc, d.get(PDFName.of('FontDescriptor')));
    const ok = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    if (!ok) out.add(nameOf(d.get(PDFName.of('BaseFont'))) ?? 'unnamed font');
  });
  return out;
}

/** Fonts not embedded on a page (directly used). */
function pageHasUnembeddedFont(doc: PDFDocument, page: PDFPage, names: Set<string>): boolean {
  if (!names.size) return false;
  const res = look(doc, page.node.get(PDFName.of('Resources')));
  const fonts = res instanceof PDFDict ? res.lookup(PDFName.of('Font')) : null;
  if (!(fonts instanceof PDFDict)) return false;
  for (const [, f] of fonts.entries()) {
    const d = look(doc, f);
    if (d instanceof PDFDict && names.has(nameOf(d.get(PDFName.of('BaseFont'))) ?? '')) return true;
  }
  return false;
}

function rgbUsed(doc: PDFDocument): boolean {
  let rgb = false;
  walk(doc, (d, stream) => {
    const cs = d.get(PDFName.of('ColorSpace'));
    const v = look(doc, cs);
    if (v instanceof PDFName && ['DeviceRGB', 'CalRGB'].includes(v.decodeText())) rgb = true;
    if (v instanceof PDFArray) {
      const f = nameOf(look(doc, v.get(0)));
      if (f === 'CalRGB' || f === 'Lab') rgb = true;
      if (f === 'ICCBased') {
        const s = look(doc, v.get(1));
        const n = s instanceof PDFStream ? s.dict.lookup(PDFName.of('N')) : null;
        if (n instanceof PDFNumber && n.asNumber() === 3) rgb = true;
      }
    }
    if (v instanceof PDFDict)
      for (const [, x] of v.entries()) {
        const y = look(doc, x);
        if (y instanceof PDFName && y.decodeText() === 'DeviceRGB') rgb = true;
        if (y instanceof PDFArray && ['CalRGB', 'Lab'].includes(nameOf(look(doc, y.get(0))) ?? '')) rgb = true;
      }
    if (stream instanceof PDFRawStream && !d.has(PDFName.of('Subtype')) && !d.has(PDFName.of('Type'))) {
      // Content streams: rg / RG operators.
      try {
        const t = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode().subarray(0, 400000));
        if (/(^|\s)[\d.\s-]+\s(rg|RG)(\s|$)/.test(t)) rgb = true;
      } catch {
        /* not a content stream */
      }
    }
  });
  // Page content streams (they have no Type).
  for (const p of doc.getPages()) {
    const c = look(doc, p.node.get(PDFName.of('Contents')));
    const streams = c instanceof PDFArray ? c.asArray().map((x) => look(doc, x)) : [c];
    for (const s of streams)
      if (s instanceof PDFRawStream) {
        try {
          const t = new TextDecoder('latin1').decode(decodePDFRawStream(s).decode());
          if (/(^|\s)[\d.\s-]+\s(rg|RG)(\s|$)/.test(t) || /\/DeviceRGB\s+(cs|CS)/.test(t)) rgb = true;
        } catch {
          /* ignore */
        }
      }
  }
  return rgb;
}

function outputIntent(doc: PDFDocument): PDFDict | null {
  const ois = doc.catalog.lookup(PDFName.of('OutputIntents'));
  if (!(ois instanceof PDFArray)) return null;
  for (let i = 0; i < ois.size(); i++) {
    const oi = ois.lookup(i);
    if (oi instanceof PDFDict && nameOf(oi.get(PDFName.of('S'))) === 'GTS_PDFX') return oi;
  }
  return null;
}

export async function preflightPdfX(bytes: Uint8Array, level: PdfXLevel): Promise<PreflightIssue[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const issues: PreflightIssue[] = [];
  if (doc.context.trailerInfo.Encrypt) issues.push({ rule: 'No encryption', detail: 'The document is password protected.', fixable: false });
  const fonts = unembeddedFonts(doc);
  if (fonts.size)
    issues.push({
      rule: 'Fonts embedded',
      detail: `Not embedded: ${[...fonts].slice(0, 6).join(', ')}.`,
      fixable: level === 'x1a',
      pages: pageNumbersWith(doc, (p) => pageHasUnembeddedFont(doc, p, fonts)),
    });
  const noTrim = pageNumbersWith(doc, (p) => !p.node.has(PDFName.of('TrimBox')) && !p.node.has(PDFName.of('ArtBox')));
  if (noTrim.length) issues.push({ rule: 'Trim box', detail: `${noTrim.length} page(s) have no trim box (the finished page size).`, fixable: true, pages: noTrim });
  const oi = outputIntent(doc);
  if (!oi) issues.push({ rule: 'Output intent', detail: 'No PDF/X output intent (printing condition).', fixable: true });
  else if (level === 'x4' && !oi.has(PDFName.of('DestOutputProfile'))) issues.push({ rule: 'Output intent', detail: 'The output intent has no embedded ICC profile.', fixable: true });
  const version = infoOf(doc).lookup(PDFName.of('GTS_PDFXVersion'));
  if (!(version instanceof PDFString) || !version.decodeText().startsWith(VERSION_NAME[level].split(':')[0])) issues.push({ rule: 'PDF/X identification', detail: `The metadata does not say ${VERSION_NAME[level]}.`, fixable: true });
  const trapped = infoOf(doc).lookup(PDFName.of('Trapped'));
  if (!(trapped instanceof PDFName) || !['True', 'False'].includes(trapped.decodeText())) issues.push({ rule: 'Trapped', detail: 'The Trapped key must be True or False.', fixable: true });
  let js = false;
  let embedded = false;
  walk(doc, (d) => {
    if (nameOf(d.get(PDFName.of('S'))) === 'JavaScript' || d.has(PDFName.of('JS'))) js = true;
    if (nameOf(d.get(PDFName.of('Type'))) === 'EmbeddedFile' || nameOf(d.get(PDFName.of('Type'))) === 'Filespec') embedded = true;
  });
  if (js) issues.push({ rule: 'No JavaScript', detail: 'The document contains JavaScript actions.', fixable: true });
  if (level === 'x1a') {
    if (rgbUsed(doc)) issues.push({ rule: 'CMYK colours only', detail: 'RGB (or Lab / ICC) colours are used.', fixable: true });
    const transp = pageNumbersWith(doc, (p) => pageHasTransparency(doc, p));
    if (transp.length) issues.push({ rule: 'No transparency', detail: `${transp.length} page(s) use transparency.`, fixable: true, pages: transp });
    if (embedded) issues.push({ rule: 'No attached files', detail: 'Files are attached to the document.', fixable: true });
  }
  // Annotations inside the page that would print (forms, comments) are not allowed unless flattened.
  const printing = pageNumbersWith(doc, (p) => {
    const a = p.node.lookup(PDFName.of('Annots'));
    if (!(a instanceof PDFArray)) return false;
    return a.asArray().some((x) => {
      const d = look(doc, x);
      if (!(d instanceof PDFDict)) return false;
      const sub = nameOf(d.get(PDFName.of('Subtype')));
      const f = d.lookup(PDFName.of('F'));
      const printFlag = f instanceof PDFNumber && (f.asNumber() & 4) !== 0;
      return printFlag && sub !== 'Link' && sub !== 'PrinterMark' && sub !== 'TrapNet';
    });
  });
  if (printing.length) issues.push({ rule: 'Printing annotations', detail: `${printing.length} page(s) have comments or fields that print; flatten them first.`, fixable: false, pages: printing });
  return issues;
}

export interface PdfXOptions {
  level: PdfXLevel;
  title: string;
  /** Renders a page to CMYK pixels (8-bit, 4 channels) at `dpi`, for pages that cannot stay vector (PDF/X-1a). */
  rasterCmyk?: (pageIndex: number, dpi: number) => Promise<{ data: Uint8Array; width: number; height: number }>;
  hooks?: ConvertHooks;
}

const xmpDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function setXmp(doc: PDFDocument, level: PdfXLevel, title: string, created: Date, modified: Date): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = xmpDate(modified);
  const xmp = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>`,
    '<dc:format>application/pdf</dc:format>',
    `<xmp:CreateDate>${xmpDate(created)}</xmp:CreateDate><xmp:ModifyDate>${now}</xmp:ModifyDate><xmp:MetadataDate>${now}</xmp:MetadataDate>`,
    '<xmp:CreatorTool>Adika PDF Editor</xmp:CreatorTool><pdf:Producer>Adika PDF Editor</pdf:Producer><pdf:Trapped>False</pdf:Trapped>',
    level === 'x4' ? '<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>' : '<pdfx:GTS_PDFXVersion>PDF/X-1a:2003</pdfx:GTS_PDFXVersion><pdfx:GTS_PDFXConformance>PDF/X-1a:2003</pdfx:GTS_PDFXConformance>',
    `<xmpMM:DocumentID>uuid:${crypto.randomUUID()}</xmpMM:DocumentID><xmpMM:InstanceID>uuid:${crypto.randomUUID()}</xmpMM:InstanceID><xmpMM:VersionID>1</xmpMM:VersionID><xmpMM:RenditionClass>default</xmpMM:RenditionClass>`,
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })));
}

export async function convertToPdfX(bytes: Uint8Array, opts: PdfXOptions): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const notes: string[] = [];
  // Trim box: the crop box (or media box) when missing.
  for (const p of doc.getPages()) {
    if (!p.node.has(PDFName.of('TrimBox')) && !p.node.has(PDFName.of('ArtBox'))) {
      const b = p.getCropBox();
      p.setTrimBox(b.x, b.y, b.width, b.height);
    }
  }
  // No JavaScript, no attachments (X-1a).
  doc.catalog.delete(PDFName.of('OpenAction'));
  const names = doc.catalog.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict) {
    names.delete(PDFName.of('JavaScript'));
    if (opts.level === 'x1a') names.delete(PDFName.of('EmbeddedFiles'));
  }
  doc.catalog.delete(PDFName.of('AA'));
  if (opts.level === 'x1a') {
    // Pages that cannot stay vector: transparency or fonts that are not embedded.
    const fonts = unembeddedFonts(doc);
    const toRaster = doc
      .getPages()
      .map((p, i) => (pageHasTransparency(doc, p) || pageHasUnembeddedFont(doc, p, fonts) ? i : -1))
      .filter((i) => i >= 0);
    const report = await convertDocumentColors(doc, 'cmyk', opts.hooks);
    notes.push(...report.kept);
    if (toRaster.length) {
      if (!opts.rasterCmyk) throw new Error('Pages with transparency need rasterising, which is not available here.');
      for (const i of toRaster) {
        const page = doc.getPage(i);
        const r = await opts.rasterCmyk(i, 300);
        const box = page.getMediaBox();
        const img = ctx.register(ctx.flateStream(r.data, { Type: 'XObject', Subtype: 'Image', Width: r.width, Height: r.height, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }));
        page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Page: img } }));
        page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(new TextEncoder().encode(`q ${box.width} 0 0 ${box.height} ${box.x} ${box.y} cm /Page Do Q`))));
        page.node.delete(PDFName.of('Group'));
        page.node.delete(PDFName.of('Annots'));
      }
      notes.push(`${toRaster.length} page(s) with transparency or missing fonts were rasterised at 300 DPI (their text is no longer selectable).`);
    }
  }
  // Output intent: the generic CMYK condition, with its profile.
  const profile = ctx.register(ctx.flateStream(genericCmykProfile(), { N: 4 }));
  const oi = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFX',
    OutputConditionIdentifier: PDFString.of('Custom'),
    OutputCondition: PDFString.of('Generic CMYK (uncharacterised); the printer may convert to its own condition'),
    Info: PDFString.of('Adika generic CMYK'),
    RegistryName: PDFString.of(''),
    DestOutputProfile: profile,
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([oi]));
  const info = infoOf(doc);
  info.set(PDFName.of('GTS_PDFXVersion'), PDFString.of(VERSION_NAME[opts.level]));
  if (opts.level === 'x1a') info.set(PDFName.of('GTS_PDFXConformance'), PDFString.of('PDF/X-1a:2003'));
  info.set(PDFName.of('Trapped'), PDFName.of('False'));
  doc.setTitle(opts.title);
  doc.setProducer('Adika PDF Editor');
  doc.setCreator('Adika PDF Editor');
  // One timestamp for Info and XMP (whole seconds: PDF dates have no milliseconds); the creation date stays.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  let created: Date | undefined;
  try {
    created = doc.getCreationDate();
  } catch {
    created = undefined;
  }
  created = created && !Number.isNaN(created.getTime()) ? new Date(Math.floor(created.getTime() / 1000) * 1000) : now;
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  setXmp(doc, opts.level, opts.title, created, now);
  // File identifier (required by PDF/X): the permanent part kept, a new one for this version.
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  const hex = [...id].map((b) => b.toString(16).padStart(2, '0')).join('');
  const oldId = ctx.trailerInfo.ID;
  const first = oldId instanceof PDFArray && oldId.size() === 2 && oldId.get(0) instanceof PDFHexString ? (oldId.get(0) as PDFHexString) : PDFHexString.of(hex);
  ctx.trailerInfo.ID = ctx.obj([first, PDFHexString.of(hex)]);
  // PDF 1.4 (X-1a) has no object streams. pdf-lib always writes a 1.7 header: set the version.
  const out = await doc.save({ useObjectStreams: opts.level === 'x4' });
  out.set(new TextEncoder().encode(opts.level === 'x1a' ? '1.4' : '1.6'), 5);
  return { bytes: out, notes };
}

/** RGBA pixels -> 8-bit CMYK (4 channels) with the generic model, for rasterised pages. */
export function rgbaToCmyk(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = rgbToCmyk([rgba[i * 4] / 255, rgba[i * 4 + 1] / 255, rgba[i * 4 + 2] / 255]);
    for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.round(c[k] * 255);
  }
  return out;
}
