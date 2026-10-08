/**
 * Convert → New e-invoice: issues an e-Factura (CIUS-RO), Peppol UBL or
 * Factur-X invoice from the form, saves the chosen files (XML, PDF/A-3 with
 * the XML, Factur-X PDF), opens the readable invoice, and keeps the seller
 * profiles, customers, catalogue and numbering in the app data folder.
 * Nothing is sent anywhere (uploading to ANAF's SPV is up to the user).
 */
import { create } from 'zustand';
import { usePDFStore } from '@/store/usePDFStore';
import { translate } from '@/lib/i18n';
import { loadFontBytes } from '@/lib/fonts';
import { appDataRead, appDataWrite, base64ToBytes } from '@/lib/platform';
import { saveFile } from './saveGuard';
import { PDF_FILTER, errorMessage, openPdfBytes, withBusy } from './document';
import { invoiceLabels, invoiceLocale, currentEInvoice } from './einvoice';
import { paymentMeansName } from '@/lib/einvoice/render';
import { checkEInvoice, parseEInvoice, type EInvoice } from '@/lib/einvoice/parse';
import { calculate, type EInvoiceProfile, type InvoiceDraft } from '@/lib/einvoice/model';
import { writeCii, writeUbl } from '@/lib/einvoice/write';
import { advanceSeries, draftFromInvoice, formatSeriesNumber, partyFromInvoice, readBook, upsertCustomer, upsertProduct, type InvoiceBook } from '@/lib/einvoice/book';

const FILE = 'einvoice-book.json';
const XML_FILTER = [{ name: 'XML data', extensions: ['xml'] }];

export type EInvoiceOutput = 'xml' | 'pdf' | 'facturx';

let cache: InvoiceBook | null = null;

export async function loadInvoiceBook(): Promise<InvoiceBook> {
  if (cache) return cache;
  try {
    cache = readBook(new TextDecoder().decode(await appDataRead(FILE)) || '{}');
  } catch {
    cache = readBook('{}');
  }
  return cache;
}

export async function saveInvoiceBook(book: InvoiceBook): Promise<void> {
  cache = book;
  try {
    await appDataWrite(FILE, new TextEncoder().encode(JSON.stringify(book)));
  } catch (e) {
    usePDFStore.getState().toast(errorMessage(e), 'error');
  }
}

/** A draft the New e-invoice dialog starts from (a credit note, a copy), or null for a new invoice. */
export const useInvoicePrefill = create<{ draft: InvoiceDraft | null }>()(() => ({ draft: null }));

export function openNewEInvoice(draft: InvoiceDraft | null = null): void {
  useInvoicePrefill.setState({ draft });
  usePDFStore.getState().openModal('einvoiceNew');
}

/** The profile an existing invoice was made for. */
function profileOf(inv: EInvoice): EInvoiceProfile {
  if (/CIUS-RO/i.test(inv.customization)) return 'ro';
  if (inv.syntax === 'CII') return 'facturx';
  if (/peppol/i.test(inv.customization)) return 'peppol';
  return inv.seller.address.country.toUpperCase() === 'RO' ? 'ro' : 'peppol';
}

/** E-invoice dialog → Create credit note: the open invoice credited in full (type 381), to edit before issuing. */
export async function createCreditNote(invoice?: EInvoice): Promise<void> {
  const inv = invoice ?? (await currentEInvoice())?.invoice;
  if (!inv) {
    usePDFStore.getState().toast('This document carries no electronic invoice.', 'error');
    return;
  }
  const draft = draftFromInvoice(inv, { profile: profileOf(inv), credit: true });
  // The seller's saved profile supplies the next number.
  const book = await loadInvoiceBook();
  const seller = book.sellers.find((s) => sameParty(s.party, draft.seller));
  if (seller?.series[0]) draft.number = formatSeriesNumber(seller.series[0]);
  openNewEInvoice(draft);
}

const idOf = (p: { vatId: string; companyId: string }) => (p.vatId || p.companyId).replace(/\s+/g, '').toUpperCase().replace(/^RO/, '');
const sameParty = (a: { vatId: string; companyId: string }, b: { vatId: string; companyId: string }) => !!idOf(a) && idOf(a) === idOf(b);

/** An opened invoice issued by one of the saved sellers: its buyer joins the customer list. */
export async function rememberCustomerOf(inv: EInvoice): Promise<void> {
  const book = await loadInvoiceBook();
  if (!book.sellers.some((s) => sameParty(s.party, { vatId: inv.seller.vatId, companyId: inv.seller.companyId }))) return;
  await saveInvoiceBook(upsertCustomer(book, partyFromInvoice(inv.buyer)));
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'invoice';

/** The XML of the draft in its profile's syntax. */
export function draftXml(draft: InvoiceDraft): { xml: string; cii: boolean } {
  const c = calculate(draft);
  return draft.profile === 'facturx' ? { xml: writeCii(c), cii: true } : { xml: writeUbl(c), cii: false };
}

async function readablePdf(xml: string, logo: Uint8Array | undefined, attachName: string | null): Promise<Uint8Array> {
  const { renderEInvoice } = await import('@/lib/einvoice/render');
  const inv = parseEInvoice(xml);
  return renderEInvoice(inv, {
    loadFont: loadFontBytes,
    labels: invoiceLabels(),
    locale: invoiceLocale(),
    warnings: checkEInvoice(inv).map(translate),
    meansName: (c) => translate(paymentMeansName(c)),
    logo,
    xml: attachName ? { name: attachName, bytes: new TextEncoder().encode(xml) } : undefined,
  });
}

/**
 * Issues the invoice: writes the chosen files, opens the readable invoice
 * and updates the invoicing data (customer, catalogue, next number).
 * Returns false when nothing was saved.
 */
export async function issueEInvoice(draft: InvoiceDraft, outputs: EInvoiceOutput[], sellerId: string, saveProducts: boolean): Promise<boolean> {
  const book = await loadInvoiceBook();
  const seller = book.sellers.find((s) => s.id === sellerId);
  const logo = seller?.logo ? base64ToBytes(seller.logo) : undefined;
  const base = safeName(draft.number);
  const files = await withBusy('Making the e-invoice…', async () => {
    const { makeHybridInvoice } = await import('@/lib/einvoice/facturx');
    const { xml } = draftXml(draft);
    const out: Array<{ bytes: Uint8Array; file: string; pdf: boolean }> = [];
    if (outputs.includes('xml')) out.push({ bytes: new TextEncoder().encode(xml), file: `${base}.xml`, pdf: false });
    if (outputs.includes('pdf') || outputs.includes('facturx')) {
      const pdf = await readablePdf(xml, logo, null);
      if (outputs.includes('pdf')) out.push({ bytes: (await makeHybridInvoice(pdf, xml)).bytes, file: `${base}.pdf`, pdf: true });
      if (outputs.includes('facturx') && draft.profile !== 'facturx') out.push({ bytes: (await makeHybridInvoice(pdf, writeCii(calculate(draft)))).bytes, file: `${base}-facturx.pdf`, pdf: true });
    }
    const view = out.some((f) => f.pdf) ? null : await readablePdf(xml, logo, `${base}.xml`);
    return { out, view };
  });
  if (!files) return false;
  let shown: { bytes: Uint8Array; name: string; path: string | null } | null = null;
  let saved = 0;
  for (const f of files.out) {
    const path = await saveFile(f.bytes, f.file, f.pdf ? PDF_FILTER : XML_FILTER, { successMessage: false });
    if (!path) continue;
    saved++;
    if (f.pdf && !shown) shown = { bytes: f.bytes, name: path === 'downloaded' ? f.file : (path.split(/[\\/]/).pop() ?? f.file), path: path === 'downloaded' ? null : path };
  }
  if (!saved && files.out.length) return false;
  // Remember the customer, the items and the number.
  let next = upsertCustomer(book, draft.buyer);
  if (saveProducts) for (const l of draft.lines) next = upsertProduct(next, l);
  if (seller) next = { ...next, sellers: next.sellers.map((s) => (s.id === seller.id ? advanceSeries(s, draft.number) : s)), lastSellerId: seller.id };
  await saveInvoiceBook(next);
  const kind = draft.typeCode === '381' ? 'Credit note' : 'Invoice';
  if (shown) await openPdfBytes(shown.bytes, shown.name, shown.path);
  else if (files.view) {
    if (await openPdfBytes(files.view, `${translate(kind)} ${base}.pdf`, null)) usePDFStore.setState({ dirty: true });
  }
  usePDFStore.getState().toast(saved ? `E-invoice ${draft.number} made: ${saved} file(s) saved.` : `E-invoice ${draft.number} made.`, 'success');
  return true;
}
