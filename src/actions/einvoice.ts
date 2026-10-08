/**
 * Electronic invoices in the app: an e-Factura / UBL / CII XML (or the ZIP
 * ANAF's SPV gives) opens as a readable invoice PDF with the XML attached;
 * the invoice inside a Factur-X / ZUGFeRD PDF can be shown and saved; a
 * PDF invoice plus its XML becomes a hybrid PDF/A-3 e-invoice.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { translate, useLang } from '@/lib/i18n';
import { loadFontBytes } from '@/lib/fonts';
import { pickFiles } from '@/lib/platform';
import { saveFile } from './saveGuard';
import { checkEInvoice, detectEInvoice, parseEInvoice, pickInvoiceXml, type EInvoice } from '@/lib/einvoice/parse';
import { EN_LABELS, paymentMeansName, type InvoiceLabels } from '@/lib/einvoice/render';
import { errorMessage, exportCurrentPdf, openPdfBytes, primarySourceBytes, saveDerived, withBusy } from './document';

export const EINVOICE_EXTENSIONS = ['xml', 'zip'];

const LOCALES: Record<string, string> = { en: 'en-GB', ro: 'ro-RO', de: 'de-DE', fr: 'fr-FR', hu: 'hu-HU', it: 'it-IT', es: 'es-ES' };
export const invoiceLocale = () => LOCALES[useLang.getState().lang] ?? 'en-GB';

export function invoiceLabels(): InvoiceLabels {
  return Object.fromEntries(Object.entries(EN_LABELS).map(([k, v]) => [k, translate(v)])) as unknown as InvoiceLabels;
}

/** The invoice XML of a file: the XML itself, or the invoice inside an e-Factura ZIP. */
async function invoiceXmlOf(bytes: Uint8Array, name: string): Promise<{ xml: string; name: string } | null> {
  if (/\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const entry = pickInvoiceXml(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
    if (!entry) return null;
    const xml = await zip.files[entry].async('string');
    return detectEInvoice(xml) ? { xml, name: entry.split('/').pop() ?? entry } : null;
  }
  const xml = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  return detectEInvoice(xml) ? { xml, name } : null;
}

/** True when the file is an electronic invoice Adika can show. */
export async function isEInvoiceFile(bytes: Uint8Array, name: string): Promise<boolean> {
  if (!/\.(xml|zip)$/i.test(name)) return false;
  try {
    return (await invoiceXmlOf(bytes, name)) !== null;
  } catch {
    return false;
  }
}

/** A readable PDF of an invoice XML, with the XML attached. */
export async function renderInvoicePdf(xml: string, xmlName: string): Promise<{ bytes: Uint8Array; invoice: EInvoice; warnings: string[] }> {
  const { renderEInvoice } = await import('@/lib/einvoice/render');
  const invoice = parseEInvoice(xml);
  const warnings = checkEInvoice(invoice).map(translate);
  const bytes = await renderEInvoice(invoice, {
    loadFont: loadFontBytes,
    labels: invoiceLabels(),
    locale: invoiceLocale(),
    xml: { name: /\.xml$/i.test(xmlName) ? xmlName : `${xmlName}.xml`, bytes: new TextEncoder().encode(xml) },
    warnings,
    meansName: (c) => translate(paymentMeansName(c)),
  });
  return { bytes, invoice, warnings };
}

/** Opens an e-invoice file (XML or ANAF ZIP) as a readable PDF. */
export async function openEInvoice(bytes: Uint8Array, name: string): Promise<boolean> {
  const r = await withBusy('Reading the e-invoice…', async () => {
    const found = await invoiceXmlOf(bytes, name);
    if (!found) throw new Error(translate('This file is not an electronic invoice (UBL, e-Factura or CII).'));
    return renderInvoicePdf(found.xml, found.name);
  });
  if (!r) return false;
  const kind = r.invoice.kind === 'credit' ? 'Credit note' : 'Invoice';
  const ok = await openPdfBytes(r.bytes, `${translate(kind)} ${r.invoice.number || name.replace(/\.[^.]+$/, '')}.pdf`, null);
  if (ok) {
    usePDFStore.setState({ dirty: true });
    const s = usePDFStore.getState();
    void import('./einvoiceCreate').then((m) => m.rememberCustomerOf(r.invoice));
    if (r.warnings.length) s.toast(`The invoice has ${r.warnings.length} problem(s): ${r.warnings[0]}`, 'error');
    else s.toast('E-invoice opened as a readable PDF; the XML is attached. Save to keep it.', 'success');
  }
  return ok;
}

/** File → Open e-invoice. */
export async function openEInvoiceDialog(): Promise<void> {
  const files = await pickFiles([{ name: 'E-invoices (XML, e-Factura ZIP)', extensions: EINVOICE_EXTENSIONS }], false);
  if (files[0]) await openEInvoice(files[0].bytes, files[0].name);
}

/** The e-invoice inside the open document (Factur-X, ZUGFeRD or attached XML). */
export async function currentEInvoice(): Promise<{ name: string; xml: string; invoice: EInvoice; warnings: string[] } | null> {
  const bytes = primarySourceBytes();
  if (!bytes) return null;
  const { findEmbeddedInvoice } = await import('@/lib/einvoice/facturx');
  const found = await findEmbeddedInvoice(bytes);
  if (!found) return null;
  try {
    const invoice = parseEInvoice(found.xml);
    return { ...found, invoice, warnings: checkEInvoice(invoice).map(translate) };
  } catch {
    return null;
  }
}

export async function saveInvoiceXml(xml: string, name: string): Promise<void> {
  await saveFile(new TextEncoder().encode(xml), name, [{ name: 'XML data', extensions: ['xml'] }]);
}

/** Embeds an invoice XML into the open PDF: Factur-X / ZUGFeRD for CII, a PDF/A-3 with the UBL invoice otherwise. */
export async function makeEInvoicePdf(): Promise<void> {
  const files = await pickFiles([{ name: 'Invoice XML (CII or UBL)', extensions: ['xml'] }], false);
  const f = files[0];
  if (!f) return;
  const xml = new TextDecoder('utf-8').decode(f.bytes).replace(/^﻿/, '');
  if (!detectEInvoice(xml)) {
    usePDFStore.getState().toast(translate('This file is not an electronic invoice (UBL, e-Factura or CII).'), 'error');
    return;
  }
  const r = await withBusy('Making the e-invoice PDF…', async (progress) => {
    const { makeHybridInvoice } = await import('@/lib/einvoice/facturx');
    const pdf = usePDFStore.getState().readOnlyReason ? primarySourceBytes()! : await exportCurrentPdf({}, progress);
    return makeHybridInvoice(pdf, xml, { title: usePDFStore.getState().docMeta?.title });
  });
  if (!r) return;
  try {
    if (!(await saveDerived(r.bytes, r.kind === 'Factur-X' ? '-facturx' : '-einvoice', true))) return;
    usePDFStore.getState().toast(r.kind === 'Factur-X' ? `Factur-X / ZUGFeRD invoice made (profile ${r.level}).` : 'PDF/A-3 made with the invoice XML embedded.', 'success');
  } catch (e) {
    usePDFStore.getState().toast(errorMessage(e), 'error');
  }
}
