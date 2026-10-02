/**
 * Hybrid e-invoices: a PDF/A-3 with the invoice XML inside.
 * - Factur-X / ZUGFeRD (CII XML as factur-x.xml, Factur-X XMP metadata);
 * - any PDF with an embedded UBL or CII invoice (e-Factura XML attached).
 * Reading finds the invoice XML among the embedded files; making one
 * converts the PDF to PDF/A-3b and embeds the XML as its alternative. Pure.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import { convertToPdfADetailed } from '@/lib/pdf/pdfa';
import { detectEInvoice, parseEInvoice } from './parse';
import { parseXml, path, textOf } from '@/lib/xml';

const KNOWN = /^(factur-x|zugferd-invoice|zugferd_invoice|xrechnung|order-x)\.xml$/i;

function embeddedFiles(doc: PDFDocument): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const ef = names instanceof PDFDict ? names.lookup(PDFName.of('EmbeddedFiles')) : undefined;
  const visit = (node: PDFObject | undefined, depth = 0) => {
    if (!(node instanceof PDFDict) || depth > 20) return;
    const arr = node.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const n = arr.lookup(i);
        const spec = arr.lookup(i + 1);
        if (!(spec instanceof PDFDict)) continue;
        const uf = spec.lookup(PDFName.of('UF')) ?? spec.lookup(PDFName.of('F'));
        const name = uf instanceof PDFString || uf instanceof PDFHexString ? uf.decodeText() : n instanceof PDFString || n instanceof PDFHexString ? n.decodeText() : 'attachment';
        const efd = spec.lookup(PDFName.of('EF'));
        const stream = efd instanceof PDFDict ? efd.lookup(PDFName.of('UF')) ?? efd.lookup(PDFName.of('F')) : undefined;
        if (stream instanceof PDFRawStream) {
          try {
            out.push({ name, bytes: decodePDFRawStream(stream).decode() });
          } catch {
            /* unreadable */
          }
        }
      }
    }
    const kidsArr = node.lookup(PDFName.of('Kids'));
    if (kidsArr instanceof PDFArray) for (let i = 0; i < kidsArr.size(); i++) visit(kidsArr.lookup(i), depth + 1);
  };
  visit(ef);
  return out;
}

/** The electronic invoice XML embedded in a PDF (Factur-X, ZUGFeRD, XRechnung or an attached e-Factura), or null. */
export async function findEmbeddedInvoice(bytes: Uint8Array): Promise<{ name: string; xml: string } | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return null;
  }
  const files = embeddedFiles(doc).filter((f) => /\.xml$/i.test(f.name));
  files.sort((a, b) => Number(KNOWN.test(b.name)) - Number(KNOWN.test(a.name)));
  for (const f of files) {
    const xml = new TextDecoder('utf-8').decode(f.bytes);
    if (detectEInvoice(xml)) return { name: f.name, xml };
  }
  return null;
}

export type FacturXLevel = 'MINIMUM' | 'BASIC WL' | 'BASIC' | 'EN 16931' | 'EXTENDED' | 'XRECHNUNG';

/** Factur-X profile from the CII guideline ID. */
export function facturXLevel(ciiXml: string): FacturXLevel {
  let id = '';
  try {
    id = textOf(path(parseXml(ciiXml), 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')).toLowerCase();
  } catch {
    /* not XML: default */
  }
  if (id.includes('xrechnung')) return 'XRECHNUNG';
  if (id.includes('extended')) return 'EXTENDED';
  if (id.includes('basicwl')) return 'BASIC WL';
  if (id.includes('minimum')) return 'MINIMUM';
  if (id.includes('basic')) return 'BASIC';
  return 'EN 16931';
}

/** The Factur-X XMP (data + PDF/A extension schema declaring it). */
export function facturXXmp(fileName: string, level: FacturXLevel): string {
  const ns = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
  const prop = (name: string, desc: string) =>
    `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${desc}</pdfaProperty:description></rdf:li>`;
  return [
    `<rdf:Description rdf:about="" xmlns:fx="${ns}">`,
    '<fx:DocumentType>INVOICE</fx:DocumentType>',
    `<fx:DocumentFileName>${fileName}</fx:DocumentFileName>`,
    '<fx:Version>1.0</fx:Version>',
    `<fx:ConformanceLevel>${level}</fx:ConformanceLevel>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">',
    '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">',
    '<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>',
    `<pdfaSchema:namespaceURI>${ns}</pdfaSchema:namespaceURI>`,
    '<pdfaSchema:prefix>fx</pdfaSchema:prefix>',
    '<pdfaSchema:property><rdf:Seq>',
    prop('DocumentFileName', 'The name of the embedded XML document'),
    prop('DocumentType', 'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER'),
    prop('Version', 'The actual version of the standard applying to the embedded XML document'),
    prop('ConformanceLevel', 'The conformance level of the embedded XML document'),
    '</rdf:Seq></pdfaSchema:property>',
    '</rdf:li></rdf:Bag></pdfaExtension:schemas>',
    '</rdf:Description>',
  ].join('\n');
}

/**
 * Makes a hybrid e-invoice: the PDF as PDF/A-3b with the XML embedded. CII
 * becomes Factur-X / ZUGFeRD (factur-x.xml, "Alternative", Factur-X XMP);
 * UBL (e.g. e-Factura) is embedded as the invoice's alternative too.
 */
export async function makeHybridInvoice(pdf: Uint8Array, xml: string, opts: { title?: string; author?: string } = {}): Promise<{ bytes: Uint8Array; kind: 'Factur-X' | 'UBL'; level: FacturXLevel | null; notes: string[] }> {
  const syntax = detectEInvoice(xml);
  if (!syntax) throw new Error('The XML is not an electronic invoice (UBL or CII).');
  const inv = parseEInvoice(xml);
  const level = syntax === 'CII' ? facturXLevel(xml) : null;
  const fileName = syntax === 'CII' ? (level === 'XRECHNUNG' ? 'xrechnung.xml' : 'factur-x.xml') : `${inv.number.replace(/[^\w.-]+/g, '_') || 'invoice'}.xml`;
  const r = await convertToPdfADetailed(pdf, {
    title: opts.title ?? `Invoice ${inv.number}`,
    author: opts.author ?? inv.seller.name,
    level: '3b',
    attachments: [{ name: fileName, mime: 'text/xml', bytes: new TextEncoder().encode(xml), relationship: level === 'MINIMUM' || level === 'BASIC WL' ? 'Data' : 'Alternative', description: `Invoice ${inv.number}` }],
    extraXmp: syntax === 'CII' ? facturXXmp(fileName, level!) : undefined,
  });
  return { bytes: r.bytes, kind: syntax === 'CII' ? 'Factur-X' : 'UBL', level, notes: r.notes };
}
