/**
 * Electronic invoices (EN 16931) read into one model:
 * - UBL 2.1 Invoice / CreditNote: the Romanian e-Factura (RO e-Factura,
 *   CIUS-RO), Peppol BIS, XRechnung UBL;
 * - UN/CEFACT CII (CrossIndustryInvoice): Factur-X, ZUGFeRD, XRechnung CII.
 * Plus the arithmetic checks a reader can make without the official
 * validation rules (line sums, VAT, amount due). Pure.
 */
import { attr, kid, kids, localName, parseXml, path, textOf, type XEl } from '@/lib/xml';

export interface Address {
  street: string;
  city: string;
  postalCode: string;
  region: string;
  country: string;
}

export interface Party {
  name: string;
  /** VAT number (e.g. RO1234567). */
  vatId: string;
  /** Legal registration (CUI / trade register number). */
  companyId: string;
  address: Address;
  email: string;
  phone: string;
}

export interface InvoiceLine {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  vatCategory: string;
  vatPercent: number | null;
  net: number;
}

export interface VatBreakdown {
  category: string;
  percent: number | null;
  taxable: number;
  amount: number;
  exemption: string;
}

export interface AllowanceCharge {
  charge: boolean;
  reason: string;
  amount: number;
}

export interface EInvoice {
  syntax: 'UBL' | 'CII';
  kind: 'invoice' | 'credit';
  /** Specification (BT-24), e.g. "urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1". */
  customization: string;
  number: string;
  issueDate: string;
  dueDate: string;
  typeCode: string;
  currency: string;
  buyerReference: string;
  orderReference: string;
  contractReference: string;
  notes: string[];
  seller: Party;
  buyer: Party;
  deliveryDate: string;
  payment: { meansCode: string; iban: string; accountName: string; bic: string; reference: string; terms: string };
  lines: InvoiceLine[];
  allowances: AllowanceCharge[];
  vat: VatBreakdown[];
  totals: { lineNet: number; allowances: number; charges: number; taxExclusive: number; tax: number; taxInclusive: number; prepaid: number; rounding: number; payable: number };
}

const num = (s: string | undefined) => {
  const n = Number((s ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};
const t = (el: XEl | undefined) => textOf(el).trim();

/** "20240131" (CII format 102) or "2024-01-31" -> "2024-01-31". */
function isoDate(s: string): string {
  const v = s.trim();
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v.slice(0, 10);
}

const emptyAddress = (): Address => ({ street: '', city: '', postalCode: '', region: '', country: '' });
const emptyParty = (): Party => ({ name: '', vatId: '', companyId: '', address: emptyAddress(), email: '', phone: '' });

/** Which e-invoice an XML is, or null. */
export function detectEInvoice(xml: string): 'UBL' | 'CII' | null {
  const m = /<\s*(?:[\w-]+:)?(Invoice|CreditNote|CrossIndustryInvoice)[\s>]/.exec(xml.slice(0, 4000));
  if (!m) return null;
  return m[1] === 'CrossIndustryInvoice' ? 'CII' : 'UBL';
}

export function parseEInvoice(xml: string): EInvoice {
  const root = parseXml(xml);
  const name = localName(root.name);
  if (name === 'CrossIndustryInvoice') return parseCii(root);
  if (name === 'Invoice' || name === 'CreditNote') return parseUbl(root, name === 'CreditNote');
  throw new Error('This XML is not an electronic invoice (UBL Invoice, CreditNote or CII).');
}

// ------------------------------------------------------------------ UBL

function ublParty(p: XEl | undefined): Party {
  const party = emptyParty();
  if (!p) return party;
  const a = kid(p, 'PostalAddress');
  party.name = t(path(p, 'PartyLegalEntity', 'RegistrationName')) || t(path(p, 'PartyName', 'Name'));
  for (const ts of kids(p, 'PartyTaxScheme')) {
    const id = t(kid(ts, 'CompanyID'));
    const scheme = t(path(ts, 'TaxScheme', 'ID'));
    if (id && (!party.vatId || scheme === 'VAT')) party.vatId = id;
  }
  party.companyId = t(path(p, 'PartyLegalEntity', 'CompanyID')) || t(path(p, 'PartyIdentification', 'ID'));
  party.address = {
    street: [t(kid(a, 'StreetName')), t(kid(a, 'AdditionalStreetName')), t(path(a, 'AddressLine', 'Line'))].filter(Boolean).join(', '),
    city: t(kid(a, 'CityName')),
    postalCode: t(kid(a, 'PostalZone')),
    region: t(kid(a, 'CountrySubentity')),
    country: t(path(a, 'Country', 'IdentificationCode')),
  };
  party.email = t(path(p, 'Contact', 'ElectronicMail'));
  party.phone = t(path(p, 'Contact', 'Telephone'));
  return party;
}

function parseUbl(root: XEl, credit: boolean): EInvoice {
  const lines: InvoiceLine[] = kids(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((l) => {
    const q = kid(l, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
    const item = kid(l, 'Item');
    const cat = kid(item, 'ClassifiedTaxCategory');
    const base = num(t(path(l, 'Price', 'BaseQuantity'))) || 1;
    const pct = t(kid(cat, 'Percent'));
    return {
      id: t(kid(l, 'ID')),
      name: t(kid(item, 'Name')),
      description: t(kid(item, 'Description')),
      quantity: num(t(q)),
      unit: attr(q, 'unitCode') ?? '',
      unitPrice: num(t(path(l, 'Price', 'PriceAmount'))) / base,
      vatCategory: t(kid(cat, 'ID')),
      vatPercent: pct ? num(pct) : null,
      net: num(t(kid(l, 'LineExtensionAmount'))),
    };
  });
  const taxTotals = kids(root, 'TaxTotal');
  // The VAT in the document currency is the TaxTotal with subtotals (a second one may be in the tax currency).
  const tax = taxTotals.find((x) => kids(x, 'TaxSubtotal').length) ?? taxTotals[0];
  const vat = kids(tax, 'TaxSubtotal').map((s) => {
    const cat = kid(s, 'TaxCategory');
    const pct = t(kid(cat, 'Percent'));
    return { category: t(kid(cat, 'ID')), percent: pct ? num(pct) : null, taxable: num(t(kid(s, 'TaxableAmount'))), amount: num(t(kid(s, 'TaxAmount'))), exemption: t(kid(cat, 'TaxExemptionReason')) || t(kid(cat, 'TaxExemptionReasonCode')) };
  });
  const m = kid(root, 'LegalMonetaryTotal');
  const pm = kid(root, 'PaymentMeans');
  return {
    syntax: 'UBL',
    kind: credit ? 'credit' : 'invoice',
    customization: t(kid(root, 'CustomizationID')),
    number: t(kid(root, 'ID')),
    issueDate: isoDate(t(kid(root, 'IssueDate'))),
    dueDate: isoDate(t(kid(root, 'DueDate')) || t(path(root, 'PaymentMeans', 'PaymentDueDate'))),
    typeCode: t(kid(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode')),
    currency: t(kid(root, 'DocumentCurrencyCode')),
    buyerReference: t(kid(root, 'BuyerReference')),
    orderReference: t(path(root, 'OrderReference', 'ID')),
    contractReference: t(path(root, 'ContractDocumentReference', 'ID')),
    notes: kids(root, 'Note').map((n) => t(n)).filter(Boolean),
    seller: ublParty(path(root, 'AccountingSupplierParty', 'Party')),
    buyer: ublParty(path(root, 'AccountingCustomerParty', 'Party')),
    deliveryDate: isoDate(t(path(root, 'Delivery', 'ActualDeliveryDate'))),
    payment: {
      meansCode: t(kid(pm, 'PaymentMeansCode')),
      iban: t(path(pm, 'PayeeFinancialAccount', 'ID')),
      accountName: t(path(pm, 'PayeeFinancialAccount', 'Name')),
      bic: t(path(pm, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID')),
      reference: t(kid(pm, 'PaymentID')),
      terms: t(path(root, 'PaymentTerms', 'Note')),
    },
    lines,
    allowances: kids(root, 'AllowanceCharge').map((a) => ({ charge: t(kid(a, 'ChargeIndicator')) === 'true', reason: t(kid(a, 'AllowanceChargeReason')), amount: num(t(kid(a, 'Amount'))) })),
    vat,
    totals: {
      lineNet: num(t(kid(m, 'LineExtensionAmount'))),
      allowances: num(t(kid(m, 'AllowanceTotalAmount'))),
      charges: num(t(kid(m, 'ChargeTotalAmount'))),
      taxExclusive: num(t(kid(m, 'TaxExclusiveAmount'))),
      tax: num(t(kid(tax, 'TaxAmount'))),
      taxInclusive: num(t(kid(m, 'TaxInclusiveAmount'))),
      prepaid: num(t(kid(m, 'PrepaidAmount'))),
      rounding: num(t(kid(m, 'PayableRoundingAmount'))),
      payable: num(t(kid(m, 'PayableAmount'))),
    },
  };
}

// ------------------------------------------------------------------ CII

function ciiParty(p: XEl | undefined): Party {
  const party = emptyParty();
  if (!p) return party;
  const a = kid(p, 'PostalTradeAddress');
  party.name = t(kid(p, 'Name'));
  for (const r of kids(p, 'SpecifiedTaxRegistration')) {
    const id = kid(r, 'ID');
    if (attr(id, 'schemeID') === 'VA' || !party.vatId) party.vatId = t(id);
  }
  party.companyId = t(path(p, 'SpecifiedLegalOrganization', 'ID'));
  party.address = {
    street: [t(kid(a, 'LineOne')), t(kid(a, 'LineTwo')), t(kid(a, 'LineThree'))].filter(Boolean).join(', '),
    city: t(kid(a, 'CityName')),
    postalCode: t(kid(a, 'PostcodeCode')),
    region: t(kid(a, 'CountrySubDivisionName')),
    country: t(kid(a, 'CountryID')),
  };
  party.email = t(path(p, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID')) || t(path(p, 'URIUniversalCommunication', 'URIID'));
  party.phone = t(path(p, 'DefinedTradeContact', 'TelephoneUniversalCommunication', 'CompleteNumber'));
  return party;
}

function parseCii(root: XEl): EInvoice {
  const doc = kid(root, 'ExchangedDocument');
  const tx = kid(root, 'SupplyChainTradeTransaction');
  const agr = kid(tx, 'ApplicableHeaderTradeAgreement');
  const set = kid(tx, 'ApplicableHeaderTradeSettlement');
  const sum = kid(set, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const pm = kid(set, 'SpecifiedTradeSettlementPaymentMeans');
  const typeCode = t(kid(doc, 'TypeCode'));
  const lines: InvoiceLine[] = kids(tx, 'IncludedSupplyChainTradeLineItem').map((l) => {
    const q = path(l, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
    const ls = kid(l, 'SpecifiedLineTradeSettlement');
    const tax = kid(ls, 'ApplicableTradeTax');
    const price = path(l, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice');
    const base = num(t(kid(price, 'BasisQuantity'))) || 1;
    const pct = t(kid(tax, 'RateApplicablePercent'));
    return {
      id: t(path(l, 'AssociatedDocumentLineDocument', 'LineID')),
      name: t(path(l, 'SpecifiedTradeProduct', 'Name')),
      description: t(path(l, 'SpecifiedTradeProduct', 'Description')),
      quantity: num(t(q)),
      unit: attr(q, 'unitCode') ?? '',
      unitPrice: num(t(kid(price, 'ChargeAmount'))) / base,
      vatCategory: t(kid(tax, 'CategoryCode')),
      vatPercent: pct ? num(pct) : null,
      net: num(t(path(ls, 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount'))),
    };
  });
  const taxTotal = kids(sum, 'TaxTotalAmount');
  const currency = t(kid(set, 'InvoiceCurrencyCode'));
  const tax = taxTotal.find((x) => attr(x, 'currencyID') === currency) ?? taxTotal[0];
  return {
    syntax: 'CII',
    kind: typeCode === '381' ? 'credit' : 'invoice',
    customization: t(path(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')),
    number: t(kid(doc, 'ID')),
    issueDate: isoDate(t(path(doc, 'IssueDateTime', 'DateTimeString'))),
    dueDate: isoDate(t(path(set, 'SpecifiedTradePaymentTerms', 'DueDateDateTime', 'DateTimeString'))),
    typeCode,
    currency,
    buyerReference: t(kid(agr, 'BuyerReference')),
    orderReference: t(path(agr, 'BuyerOrderReferencedDocument', 'IssuerAssignedID')),
    contractReference: t(path(agr, 'ContractReferencedDocument', 'IssuerAssignedID')),
    notes: kids(doc, 'IncludedNote').map((n) => t(kid(n, 'Content'))).filter(Boolean),
    seller: ciiParty(kid(agr, 'SellerTradeParty')),
    buyer: ciiParty(kid(agr, 'BuyerTradeParty')),
    deliveryDate: isoDate(t(path(tx, 'ApplicableHeaderTradeDelivery', 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime', 'DateTimeString'))),
    payment: {
      meansCode: t(kid(pm, 'TypeCode')),
      iban: t(path(pm, 'PayeePartyCreditorFinancialAccount', 'IBANID')),
      accountName: t(path(pm, 'PayeePartyCreditorFinancialAccount', 'AccountName')),
      bic: t(path(pm, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID')),
      reference: t(kid(set, 'PaymentReference')),
      terms: t(path(set, 'SpecifiedTradePaymentTerms', 'Description')),
    },
    lines,
    allowances: kids(set, 'SpecifiedTradeAllowanceCharge').map((a) => ({ charge: t(path(a, 'ChargeIndicator', 'Indicator')) === 'true', reason: t(kid(a, 'Reason')), amount: num(t(kid(a, 'ActualAmount'))) })),
    vat: kids(set, 'ApplicableTradeTax').map((x) => {
      const pct = t(kid(x, 'RateApplicablePercent'));
      return { category: t(kid(x, 'CategoryCode')), percent: pct ? num(pct) : null, taxable: num(t(kid(x, 'BasisAmount'))), amount: num(t(kid(x, 'CalculatedAmount'))), exemption: t(kid(x, 'ExemptionReason')) };
    }),
    totals: {
      lineNet: num(t(kid(sum, 'LineTotalAmount'))),
      allowances: num(t(kid(sum, 'AllowanceTotalAmount'))),
      charges: num(t(kid(sum, 'ChargeTotalAmount'))),
      taxExclusive: num(t(kid(sum, 'TaxBasisTotalAmount'))),
      tax: num(t(tax)),
      taxInclusive: num(t(kid(sum, 'GrandTotalAmount'))),
      prepaid: num(t(kid(sum, 'TotalPrepaidAmount'))),
      rounding: num(t(kid(sum, 'RoundingAmount'))),
      payable: num(t(kid(sum, 'DuePayableAmount'))),
    },
  };
}

// ------------------------------------------------------------------ checks

const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

/** Problems a reader can see: missing essentials and sums that do not add up. */
export function checkEInvoice(inv: EInvoice): string[] {
  const out: string[] = [];
  if (!inv.number) out.push('The invoice has no number.');
  if (!inv.issueDate) out.push('The invoice has no issue date.');
  if (!inv.seller.name) out.push('The seller has no name.');
  if (!inv.buyer.name) out.push('The buyer has no name.');
  if (!inv.currency) out.push('The invoice has no currency.');
  if (!inv.lines.length) out.push('The invoice has no lines.');
  const lineSum = inv.lines.reduce((s, l) => s + l.net, 0);
  if (inv.lines.length && !near(lineSum, inv.totals.lineNet)) out.push(`The lines add up to ${lineSum.toFixed(2)}, the invoice says ${inv.totals.lineNet.toFixed(2)}.`);
  const exclusive = inv.totals.lineNet - inv.totals.allowances + inv.totals.charges;
  if (inv.totals.taxExclusive && !near(exclusive, inv.totals.taxExclusive)) out.push(`The amount without VAT should be ${exclusive.toFixed(2)}, the invoice says ${inv.totals.taxExclusive.toFixed(2)}.`);
  const vatSum = inv.vat.reduce((s, v) => s + v.amount, 0);
  if (inv.vat.length && !near(vatSum, inv.totals.tax)) out.push(`The VAT lines add up to ${vatSum.toFixed(2)}, the invoice says ${inv.totals.tax.toFixed(2)}.`);
  for (const v of inv.vat) {
    if (v.percent === null) continue;
    const expect = Math.round(v.taxable * v.percent) / 100;
    if (Math.abs(expect - v.amount) > 0.011 + v.taxable * 0.00001) out.push(`VAT ${v.percent}% of ${v.taxable.toFixed(2)} is ${expect.toFixed(2)}, the invoice says ${v.amount.toFixed(2)}.`);
  }
  if (inv.totals.taxInclusive && !near(inv.totals.taxExclusive + inv.totals.tax, inv.totals.taxInclusive)) out.push(`The total with VAT should be ${(inv.totals.taxExclusive + inv.totals.tax).toFixed(2)}, the invoice says ${inv.totals.taxInclusive.toFixed(2)}.`);
  const due = inv.totals.taxInclusive - inv.totals.prepaid + inv.totals.rounding;
  if (inv.totals.payable && !near(due, inv.totals.payable)) out.push(`The amount due should be ${due.toFixed(2)}, the invoice says ${inv.totals.payable.toFixed(2)}.`);
  return out;
}

/** UN/ECE Rec. 20 unit codes people meet on invoices. */
export const UNIT_NAMES: Record<string, string> = {
  H87: 'pcs',
  C62: 'pcs',
  XPP: 'pcs',
  EA: 'pcs',
  SET: 'set',
  KGM: 'kg',
  GRM: 'g',
  TNE: 't',
  MTR: 'm',
  MTK: 'm²',
  MTQ: 'm³',
  LTR: 'l',
  KMT: 'km',
  HUR: 'h',
  DAY: 'day',
  WEE: 'week',
  MON: 'month',
  ANN: 'year',
  KWH: 'kWh',
  MIN: 'min',
  PR: 'pair',
  BX: 'box',
  ZZ: '',
};

/** Names of the documents in an ANAF e-Factura ZIP (invoice XML and its signature). */
export function pickInvoiceXml(names: string[]): string | null {
  const xml = names.filter((n) => /\.xml$/i.test(n) && !/^semnatura|signature/i.test(n.split('/').pop() ?? ''));
  return xml[0] ?? null;
}

