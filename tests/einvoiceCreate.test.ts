import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { checkEInvoice, parseEInvoice } from '@/lib/einvoice/parse';
import { calculate, emptyDraft, emptyLine, round, roundingFor, type DraftLine, type InvoiceDraft } from '@/lib/einvoice/model';
import { CIUS_RO, PEPPOL_BILLING, PEPPOL_PROFILE, writeCii, writeUbl } from '@/lib/einvoice/write';
import { cuiValid, defaultEndpoint, ibanValid, normalizeRoCounty, normalizeSector, validateInvoice } from '@/lib/einvoice/rules';
import { advanceSeries, draftFromInvoice, emptyBook, formatSeriesNumber, newSeller, readBook, searchCustomers, upsertCustomer, upsertProduct } from '@/lib/einvoice/book';
import { renderEInvoice } from '@/lib/einvoice/render';
import { facturXLevel, findEmbeddedInvoice, makeHybridInvoice } from '@/lib/einvoice/facturx';
import { parseXml, kids, kid, localName, textOf, type XEl } from '@/lib/xml';
import type { FontVariant } from '@/lib/fonts';
import { EFACTURA_UBL } from './helpers/einvoices';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const weight = v.bold ? '700Bold' : '400Regular';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', weight, `NotoSans_${weight}.ttf`))));
};

const line = (p: Partial<DraftLine>): DraftLine => ({ ...emptyLine(), ...p });

/** A Romanian invoice that passes every check. */
function roDraft(over: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const d = emptyDraft('ro', '2026-10-01');
  return {
    ...d,
    number: 'ADK-2026-0100',
    dueDate: '2026-10-31',
    seller: { ...d.seller, name: 'Adika Software SRL', vatId: 'RO12345674', companyId: 'J12/3456/2020', street: 'Str. Memorandumului 28', city: 'Cluj-Napoca', postalCode: '400114', region: 'RO-CJ', email: 'facturi@adika.example' },
    buyer: { ...d.buyer, name: 'Tipografia Sector SRL', vatId: 'RO18594852', companyId: 'J40/1/2001', street: 'Calea Victoriei 10', city: 'SECTOR3', region: 'RO-B' },
    payment: { ...d.payment, meansCode: '30', iban: 'RO49AAAA1B31007593840000', accountName: 'Adika Software SRL', terms: 'Plata în 30 de zile.' },
    lines: [
      line({ name: 'Licență Adika PDF', quantity: 3, unit: 'H87', price: 500, vatPercent: 21 }),
      line({ name: 'Instruire', quantity: 4, unit: 'HUR', price: 150, discountPercent: 10, vatPercent: 21 }),
      line({ name: 'Manual tipărit', quantity: 2, unit: 'H87', price: 49.99, vatPercent: 11 }),
    ],
    notes: ['Factură emisă conform contractului nr. 12/2026.'],
    ...over,
  };
}

const errors = (d: InvoiceDraft) => validateInvoice(calculate(d)).filter((i) => i.severity === 'error');
const rules = (d: InvoiceDraft) => errors(d).map((i) => i.rule);
const childNames = (el: XEl) => kids(el).map((k) => localName(k.name));
/** True when `names` appear in this order among the element's children. */
const inOrder = (el: XEl, names: string[]) => {
  const idx = names.map((n) => childNames(el).indexOf(n));
  return idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]);
};

describe('e-invoice calculation (EN 16931)', () => {
  it('rounds each line, groups VAT per category and rate, and adds up the totals', () => {
    const c = calculate(roDraft());
    expect(c.lines.map((l) => l.net)).toEqual([1500, 540, 99.98]);
    expect(c.lines[1]).toMatchObject({ gross: 600, discount: 60 });
    expect(c.vat).toEqual([
      { category: 'S', percent: 21, taxable: 2040, amount: 428.4, exemptionCode: '', exemptionReason: '' },
      { category: 'S', percent: 11, taxable: 99.98, amount: 11, exemptionCode: '', exemptionReason: '' },
    ]);
    expect(c.totals).toEqual({ lineNet: 2139.98, allowances: 0, charges: 0, taxExclusive: 2139.98, tax: 439.4, taxInclusive: 2579.38, prepaid: 0, rounding: 0, payable: 2579.38 });
  });

  it('rounds half away from zero, prices per base quantity, document allowances and charges, prepaid and rounding', () => {
    expect([round(1.005), round(-1.005), round(2.675), round(10.004999)]).toEqual([1.01, -1.01, 2.68, 10]);
    const d = roDraft({
      lines: [line({ name: 'Șuruburi', quantity: 3, price: 3.335, vatPercent: 21 }), line({ name: 'Hârtie', quantity: 250, unit: 'KGM', price: 12.5, baseQuantity: 100, vatPercent: 21 })],
      allowances: [
        { charge: false, reason: 'Discount fidelitate', amount: 5, vatCategory: 'S', vatPercent: 21 },
        { charge: true, reason: 'Transport', amount: 20, vatCategory: 'S', vatPercent: 21 },
      ],
      prepaid: 10,
    });
    const c = calculate(d);
    expect(c.lines.map((l) => l.net)).toEqual([10.01, 31.25]);
    expect(c.totals).toMatchObject({ lineNet: 41.26, allowances: 5, charges: 20, taxExclusive: 56.26, tax: 11.81, taxInclusive: 68.07, prepaid: 10, payable: 58.07 });
    const r = roundingFor(c.totals.taxInclusive, c.totals.prepaid, 1);
    expect(r).toBe(-0.07);
    expect(calculate({ ...d, rounding: r }).totals.payable).toBe(58);
    const back = parseEInvoice(writeUbl(calculate({ ...d, rounding: r })));
    expect(checkEInvoice(back)).toEqual([]);
    expect(back.totals).toMatchObject({ allowances: 5, charges: 20, prepaid: 10, rounding: -0.07, payable: 58 });
    expect(back.lines[1]).toMatchObject({ quantity: 250, unitPrice: 0.125, net: 31.25 });
  });

  it('exempt categories carry reasons and VATEX codes; zero-rated categories have rate 0, O has none', () => {
    const d = roDraft({
      lines: [line({ name: 'Servicii UE', quantity: 1, price: 1000, vatCategory: 'AE', vatPercent: 21 }), line({ name: 'Curs autorizat', quantity: 1, price: 200, vatCategory: 'E', vatPercent: 0 })],
      exemptions: { E: { code: 'VATEX-EU-132-1I', reason: 'Scutit conform art. 292 Cod fiscal' } },
    });
    const c = calculate(d);
    expect(c.vat).toEqual([
      { category: 'AE', percent: 0, taxable: 1000, amount: 0, exemptionCode: 'VATEX-EU-AE', exemptionReason: 'Reverse charge' },
      { category: 'E', percent: 0, taxable: 200, amount: 0, exemptionCode: 'VATEX-EU-132-1I', exemptionReason: 'Scutit conform art. 292 Cod fiscal' },
    ]);
    expect(errors(d)).toEqual([]);
    const xml = writeUbl(c);
    expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>');
    expect(checkEInvoice(parseEInvoice(xml))).toEqual([]);
    expect(rules({ ...d, exemptions: { E: { code: '', reason: '' } } })).toContain('BR-E-10');
    // Not subject to VAT: no rate, no VAT numbers, no other categories.
    const o = roDraft({ lines: [line({ name: 'Donație', price: 100, vatCategory: 'O' })] });
    const oc = calculate(o);
    expect(oc.vat[0]).toMatchObject({ category: 'O', percent: null, amount: 0 });
    expect(writeUbl(oc)).not.toMatch(/<cbc:ID>O<\/cbc:ID><cbc:Percent>/);
    expect(rules(o)).toContain('BR-O-02');
    expect(rules({ ...o, lines: [...o.lines, line({ name: 'x', price: 1 })] })).toContain('BR-O-11');
    // Intra-community supply: both VAT numbers and a delivery date.
    const k = roDraft({ lines: [line({ name: 'Livrare', price: 100, vatCategory: 'K' })] });
    expect(rules(k)).toContain('BR-IC-11');
    const kx = writeUbl(calculate({ ...k, deliveryDate: '2026-09-30' }));
    expect(kx).toContain('<cbc:ActualDeliveryDate>2026-09-30</cbc:ActualDeliveryDate>');
    expect(kx).toContain('<cac:DeliveryLocation><cac:Address><cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode>');
  });

  it('a Romanian invoice in another currency also gives the VAT total in RON (BT-111)', () => {
    const d = roDraft({ currency: 'EUR', exchangeRate: 5.0812 });
    expect(rules({ ...d, exchangeRate: 0 })).toContain('BR-RO-030');
    const c = calculate(d);
    expect(c.taxCurrency).toEqual({ code: 'RON', tax: round(439.4 * 5.0812) });
    const xml = writeUbl(c);
    expect(xml).toContain('<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>');
    expect(xml).toContain(`<cac:TaxTotal><cbc:TaxAmount currencyID="RON">${round(439.4 * 5.0812).toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>`);
    const back = parseEInvoice(xml);
    expect(back.totals.tax).toBe(439.4);
    expect(checkEInvoice(back)).toEqual([]);
    const cii = parseEInvoice(writeCii(c));
    expect(cii.totals.tax).toBe(439.4);
    expect(checkEInvoice(cii)).toEqual([]);
  });
});

describe('CIUS-RO rules (e-Factura)', () => {
  it('a complete Romanian invoice has no problems', () => {
    expect(validateInvoice(calculate(roDraft()))).toEqual([]);
  });

  it('checks fiscal codes: CUI check digit, RO prefix, CNP for persons', () => {
    expect([cuiValid('RO12345674'), cuiValid('12345674'), cuiValid('12345678'), cuiValid('18400000'), cuiValid('1')]).toEqual([true, true, false, true, false]);
    const d = roDraft();
    expect(rules({ ...d, seller: { ...d.seller, vatId: 'RO12345678' } })).toContain('CIUS-RO BT-31');
    expect(rules({ ...d, seller: { ...d.seller, vatId: '', companyId: '12345674' } })).not.toContain('CIUS-RO BT-31');
    expect(rules({ ...d, buyer: { ...d.buyer, vatId: '', companyId: '1900101123457', name: 'Ion Popescu' } })).toEqual([]);
    expect(rules({ ...d, buyer: { ...d.buyer, vatId: '', companyId: '0000000000000' } })).toEqual([]);
    expect(rules({ ...d, buyer: { ...d.buyer, vatId: '', companyId: '1900101123456' } })).toContain('CIUS-RO BT-48');
  });

  it('checks counties (ISO 3166-2:RO) and Bucharest sectors', () => {
    const d = roDraft();
    expect(rules({ ...d, seller: { ...d.seller, region: 'Cluj' } })).toContain('CIUS-RO BT-39');
    expect(rules({ ...d, seller: { ...d.seller, region: '' } })).toContain('CIUS-RO BT-39');
    expect(rules({ ...d, buyer: { ...d.buyer, city: 'București' } })).toContain('CIUS-RO BT-52');
    expect(rules({ ...d, buyer: { ...d.buyer, country: 'DE', region: '', vatId: 'DE123456789', city: 'Berlin' } })).toEqual([]);
    expect([normalizeRoCounty('Cluj'), normalizeRoCounty('jud. Iași'), normalizeRoCounty('CJ'), normalizeRoCounty('Bucuresti'), normalizeRoCounty('Atlantis')]).toEqual(['RO-CJ', 'RO-IS', 'RO-CJ', 'RO-B', '']);
    expect([normalizeSector('Sector 3'), normalizeSector('sectorul 6'), normalizeSector('Cluj-Napoca')]).toEqual(['SECTOR3', 'SECTOR6', 'Cluj-Napoca']);
  });

  it('checks the number, type, lengths, payment account and due date', () => {
    const d = roDraft();
    expect(rules({ ...d, number: 'ABC' })).toContain('BR-RO-010');
    expect(rules({ ...d, typeCode: '383' })).toContain('BR-RO-020');
    expect(rules({ ...d, lines: [line({ name: 'x'.repeat(101), price: 1 })] })).toContain('CIUS-RO BT-153');
    expect(rules({ ...d, notes: Array(21).fill('n') })).toContain('CIUS-RO BT-22');
    expect(rules({ ...d, payment: { ...d.payment, iban: '' } })).toContain('BR-61');
    expect(rules({ ...d, payment: { ...d.payment, iban: 'RO49AAAA1B31007593840001' } })).toContain('BT-84');
    expect(rules({ ...d, dueDate: '', payment: { ...d.payment, terms: '' } })).toContain('BR-CO-25');
    expect(rules({ ...d, lines: [line({ name: 'x', price: 10, vatPercent: 0 })] })).toContain('BR-S-05');
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
  });
});

describe('writing e-invoices', () => {
  it('RO e-Factura: UBL 2.1 Invoice with the CIUS-RO identifier, in schema order, re-read without problems', () => {
    const xml = writeUbl(calculate(roDraft()));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"')).toBe(true);
    const root = parseXml(xml);
    expect(textOf(kid(root, 'CustomizationID'))).toBe(CIUS_RO);
    expect(kid(root, 'ProfileID')).toBeUndefined();
    expect(inOrder(root, ['CustomizationID', 'ID', 'IssueDate', 'DueDate', 'InvoiceTypeCode', 'Note', 'DocumentCurrencyCode', 'AccountingSupplierParty', 'AccountingCustomerParty', 'PaymentMeans', 'PaymentTerms', 'TaxTotal', 'LegalMonetaryTotal', 'InvoiceLine'])).toBe(true);
    const lineEl = kids(root, 'InvoiceLine')[1];
    expect(inOrder(lineEl, ['ID', 'InvoicedQuantity', 'LineExtensionAmount', 'AllowanceCharge', 'Item', 'Price'])).toBe(true);
    expect(xml).toContain('<cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="RON">60.00</cbc:Amount><cbc:BaseAmount currencyID="RON">600.00</cbc:BaseAmount>');
    expect(xml).toContain('<cbc:CountrySubentity>RO-B</cbc:CountrySubentity>');
    const inv = parseEInvoice(xml);
    expect(inv).toMatchObject({ syntax: 'UBL', kind: 'invoice', number: 'ADK-2026-0100', currency: 'RON', dueDate: '2026-10-31' });
    expect(inv.seller).toMatchObject({ name: 'Adika Software SRL', vatId: 'RO12345674', companyId: 'J12/3456/2020' });
    expect(inv.buyer.address).toMatchObject({ city: 'SECTOR3', region: 'RO-B', country: 'RO' });
    expect(inv.payment).toMatchObject({ meansCode: '30', iban: 'RO49AAAA1B31007593840000', terms: 'Plata în 30 de zile.' });
    expect(inv.totals).toMatchObject({ lineNet: 2139.98, tax: 439.4, payable: 2579.38 });
    expect(checkEInvoice(inv)).toEqual([]);
  });

  it('Peppol BIS 3.0: customization, profile, endpoints with schemes, one note', () => {
    const base = roDraft();
    const d: InvoiceDraft = { ...base, profile: 'peppol', currency: 'EUR', notes: ['First note', 'Second note'], buyerReference: 'PO-1' };
    expect(rules(d)).toEqual(expect.arrayContaining(['PEPPOL-EN16931-R010', 'PEPPOL-EN16931-R020']));
    expect(defaultEndpoint(d.seller)).toEqual({ id: 'RO12345674', scheme: '9947' });
    const ep = (p: InvoiceDraft['seller']) => ({ ...p, endpointId: defaultEndpoint(p).id, endpointScheme: defaultEndpoint(p).scheme });
    const ok = { ...d, seller: ep(d.seller), buyer: ep(d.buyer) };
    expect(errors(ok)).toEqual([]);
    expect(rules({ ...ok, buyerReference: '' })).toContain('PEPPOL-EN16931-R003');
    const xml = writeUbl(calculate(ok));
    const root = parseXml(xml);
    expect(textOf(kid(root, 'CustomizationID'))).toBe(PEPPOL_BILLING);
    expect(textOf(kid(root, 'ProfileID'))).toBe(PEPPOL_PROFILE);
    expect(kids(root, 'Note')).toHaveLength(1);
    expect(xml).toContain('<cbc:EndpointID schemeID="9947">RO12345674</cbc:EndpointID>');
    expect(inOrder(kid(kid(root, 'AccountingSupplierParty')!, 'Party')!, ['EndpointID', 'PostalAddress', 'PartyTaxScheme', 'PartyLegalEntity', 'Contact'])).toBe(true);
    expect(checkEInvoice(parseEInvoice(xml))).toEqual([]);
  });

  it('Factur-X: CII EN 16931 in schema order, re-read without problems, embedded in a PDF/A-3', async () => {
    const d = roDraft({ profile: 'facturx', allowances: [{ charge: true, reason: 'Transport', amount: 25, vatCategory: 'S', vatPercent: 21 }], prepaid: 100 });
    const c = calculate(d);
    const xml = writeCii(c);
    const root = parseXml(xml);
    expect(localName(root.name)).toBe('CrossIndustryInvoice');
    expect(facturXLevel(xml)).toBe('EN 16931');
    const tx = kid(root, 'SupplyChainTradeTransaction')!;
    expect(inOrder(tx, ['IncludedSupplyChainTradeLineItem', 'ApplicableHeaderTradeAgreement', 'ApplicableHeaderTradeDelivery', 'ApplicableHeaderTradeSettlement'])).toBe(true);
    const set = kid(tx, 'ApplicableHeaderTradeSettlement')!;
    expect(inOrder(set, ['InvoiceCurrencyCode', 'SpecifiedTradeSettlementPaymentMeans', 'ApplicableTradeTax', 'SpecifiedTradeAllowanceCharge', 'SpecifiedTradePaymentTerms', 'SpecifiedTradeSettlementHeaderMonetarySummation'])).toBe(true);
    const inv = parseEInvoice(xml);
    expect(inv).toMatchObject({ syntax: 'CII', number: 'ADK-2026-0100', issueDate: '2026-10-01', dueDate: '2026-10-31' });
    expect(inv.totals).toMatchObject({ charges: 25, prepaid: 100, payable: c.totals.payable });
    expect(inv.lines[1]).toMatchObject({ allowances: 60, net: 540 });
    expect(checkEInvoice(inv)).toEqual([]);
    const pdf = await renderEInvoice(inv, { loadFont });
    const r = await makeHybridInvoice(pdf, xml);
    expect(r).toMatchObject({ kind: 'Factur-X', level: 'EN 16931' });
    const found = await findEmbeddedInvoice(r.bytes);
    expect(found?.name).toBe('factur-x.xml');
    expect(checkEInvoice(parseEInvoice(found!.xml))).toEqual([]);
    const doc = await PDFDocument.load(r.bytes);
    const xmp = new TextDecoder().decode((doc.catalog.lookup(PDFName.of('Metadata')) as unknown as { getContents(): Uint8Array }).getContents());
    expect(xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(xmp).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
  });

  it('a UBL e-Factura in a PDF/A-3 with the readable invoice', async () => {
    const xml = writeUbl(calculate(roDraft()));
    const pdf = await renderEInvoice(parseEInvoice(xml), { loadFont });
    const r = await makeHybridInvoice(pdf, xml);
    expect(r.kind).toBe('UBL');
    const found = await findEmbeddedInvoice(r.bytes);
    expect(found?.name).toBe('ADK-2026-0100.xml');
    expect(parseEInvoice(found!.xml).customization).toBe(CIUS_RO);
  });

  it('a credit note for an opened invoice: CreditNote 381 with positive amounts referring to the invoice', () => {
    const original = parseEInvoice(EFACTURA_UBL);
    const d = draftFromInvoice(original, { profile: 'ro', credit: true, today: '2026-10-05' });
    expect(d).toMatchObject({ typeCode: '381', precedingNumber: 'ADK-2026-0042', precedingDate: '2026-09-15', currency: 'RON', issueDate: '2026-10-05', dueDate: '2026-10-05' });
    expect(d.lines.map((l) => [l.name, l.quantity, l.price, l.vatPercent])).toEqual([
      ['Adika PDF Editor – licență', 3, 500, 19],
      ['Instruire utilizatori', 4, 150, 19],
    ]);
    const issues = validateInvoice(calculate({ ...d, number: 'ADK-2026-NC1', seller: { ...d.seller, vatId: 'RO12345674' }, buyer: { ...d.buyer, vatId: 'RO18594852' } }));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const xml = writeUbl(calculate({ ...d, number: 'ADK-2026-NC1', dueDate: '2026-10-20' }));
    const root = parseXml(xml);
    expect(localName(root.name)).toBe('CreditNote');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(kid(root, 'DueDate')).toBeUndefined();
    expect(inOrder(root, ['IssueDate', 'CreditNoteTypeCode', 'DocumentCurrencyCode', 'OrderReference', 'BillingReference', 'AccountingSupplierParty', 'PaymentMeans', 'TaxTotal', 'LegalMonetaryTotal', 'CreditNoteLine'])).toBe(true);
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="H87">3</cbc:CreditedQuantity>');
    expect(xml).toContain('<cbc:PaymentDueDate>2026-10-20</cbc:PaymentDueDate>');
    const back = parseEInvoice(xml);
    expect(back).toMatchObject({ kind: 'credit', typeCode: '381', precedingInvoice: 'ADK-2026-0042', dueDate: '2026-10-20' });
    expect(back.totals.payable).toBe(original.totals.payable);
    expect(checkEInvoice(back)).toEqual([]);
    const cii = parseEInvoice(writeCii(calculate({ ...d, number: 'NC1' })));
    expect(cii).toMatchObject({ kind: 'credit', precedingInvoice: 'ADK-2026-0042' });
    expect(checkEInvoice(cii)).toEqual([]);
  });
});

describe('invoicing data', () => {
  it('numbering series, customers and the catalogue', () => {
    const seller = { ...newSeller(), series: [{ prefix: 'ADK-2026-', next: 41, digits: 4 }] };
    expect(formatSeriesNumber(seller.series[0])).toBe('ADK-2026-0041');
    expect(advanceSeries(seller, 'ADK-2026-0041').series[0].next).toBe(42);
    expect(advanceSeries(seller, 'OTHER-7').series[0].next).toBe(41);
    let book = emptyBook();
    const d = roDraft();
    book = upsertCustomer(book, d.buyer, '2026-01-01');
    book = upsertCustomer(book, { ...d.seller }, '2026-01-02');
    book = upsertCustomer(book, { ...d.buyer, email: 'nou@example.ro' }, '2026-01-03');
    expect(book.customers).toHaveLength(2);
    expect(book.customers[0]).toMatchObject({ name: 'Tipografia Sector SRL', email: 'nou@example.ro' });
    expect(searchCustomers(book, '18594852').map((c) => c.name)).toEqual(['Tipografia Sector SRL']);
    expect(searchCustomers(book, 'cluj').map((c) => c.name)).toEqual(['Adika Software SRL']);
    book = upsertProduct(book, d.lines[0]);
    book = upsertProduct(book, { ...d.lines[0], price: 550 });
    expect(book.products).toHaveLength(1);
    expect(book.products[0]).toMatchObject({ name: 'Licență Adika PDF', price: 550, unit: 'H87', vatPercent: 21 });
    const again = readBook(JSON.stringify(book));
    expect(again.customers).toHaveLength(2);
    expect(readBook('not json')).toEqual(emptyBook());
  });
});
