/**
 * Writes a calculated invoice draft as XML:
 * - UBL 2.1 Invoice / CreditNote for the Romanian e-Factura (CIUS-RO 1.0.1)
 *   and Peppol BIS Billing 3.0 (plain EN 16931 otherwise);
 * - UN/CEFACT CII (CrossIndustryInvoice D16B) for Factur-X / ZUGFeRD EN 16931.
 * Elements follow the schemas' sequence; empty optional data is left out. Pure.
 */
import { serializeXml, type XEl } from '@/lib/xml';
import { amountText, decimalText, effectivePercent as effective, type CalcInvoice, type DraftParty } from './model';

export const CIUS_RO = 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1';
export const PEPPOL_BILLING = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
export const PEPPOL_PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';
export const EN16931 = 'urn:cen.eu:en16931:2017';

const UBL_NS = {
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
};
const CII_NS = {
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  qdt: 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
};

type Kid = XEl | string | null | undefined | false | Kid[];

/** An element, or null when it ends up with no content (text elements with empty text, containers with no children). */
function el(name: string, attrs: Record<string, string | undefined> | null, ...kids: Kid[]): XEl | null {
  const children: Array<XEl | string> = [];
  const push = (k: Kid) => {
    if (Array.isArray(k)) k.forEach(push);
    else if (typeof k === 'string') {
      if (k.trim()) children.push(k.trim());
    } else if (k) children.push(k);
  };
  kids.forEach(push);
  if (!children.length) return null;
  return { name, attrs: Object.entries(attrs ?? {}).filter((a): a is [string, string] => !!a[1]), children };
}
const e = (name: string, ...kids: Kid[]) => el(name, null, ...kids);

/** The reason written for an allowance or charge without one (Romanian on e-Factura). */
const reasonWord = (profile: string, charge: boolean) => (profile === 'ro' ? (charge ? 'Majorare' : 'Reducere') : charge ? 'Charge' : 'Discount');

/** "2026-09-15" -> "20260915" (CII format 102). */
const d102 = (iso: string) => iso.replace(/-/g, '');

/** The specification identifier (BT-24) of a profile. */
export function customizationId(profile: CalcInvoice['draft']['profile']): string {
  return profile === 'ro' ? CIUS_RO : profile === 'peppol' ? PEPPOL_BILLING : EN16931;
}

// ------------------------------------------------------------------ UBL

function ublParty(p: DraftParty, peppol: boolean): XEl | null {
  const endpoint = p.endpointId.trim();
  return e(
    'cac:Party',
    endpoint ? el('cbc:EndpointID', { schemeID: p.endpointScheme.trim() || (peppol ? '0088' : undefined) }, endpoint) : null,
    e(
      'cac:PostalAddress',
      e('cbc:StreetName', p.street),
      e('cbc:CityName', p.city),
      e('cbc:PostalZone', p.postalCode),
      e('cbc:CountrySubentity', p.region),
      e('cac:Country', e('cbc:IdentificationCode', p.country.toUpperCase())),
    ),
    p.vatId.trim() ? e('cac:PartyTaxScheme', e('cbc:CompanyID', p.vatId.replace(/\s+/g, '')), e('cac:TaxScheme', e('cbc:ID', 'VAT'))) : null,
    e('cac:PartyLegalEntity', e('cbc:RegistrationName', p.name), e('cbc:CompanyID', p.companyId)),
    e('cac:Contact', e('cbc:Telephone', p.phone), e('cbc:ElectronicMail', p.email)),
  );
}

function ublTaxCategory(tag: string, category: string, percent: number | null, exemption?: { code: string; reason: string }): XEl | null {
  return e(
    tag,
    e('cbc:ID', category),
    percent === null ? null : e('cbc:Percent', decimalText(percent, 2)),
    exemption ? [e('cbc:TaxExemptionReasonCode', exemption.code), e('cbc:TaxExemptionReason', exemption.reason)] : null,
    e('cac:TaxScheme', e('cbc:ID', 'VAT')),
  );
}

/** UBL 2.1 Invoice (or CreditNote for type 381). */
export function writeUbl(c: CalcInvoice): string {
  const d = c.draft;
  const credit = c.kind === 'credit';
  const peppol = d.profile === 'peppol';
  const cur = { currencyID: d.currency };
  const amt = (name: string, n: number, currency = d.currency) => el(name, { currencyID: currency }, amountText(n));
  const notes = d.notes.map((n) => n.trim()).filter(Boolean);
  const kCountry = c.lines.some((l) => l.vatCategory === 'K') ? d.buyer.country : '';
  const root = el(
    credit ? 'CreditNote' : 'Invoice',
    { xmlns: credit ? UBL_NS.CreditNote : UBL_NS.Invoice, 'xmlns:cac': UBL_NS.cac, 'xmlns:cbc': UBL_NS.cbc },
    e('cbc:CustomizationID', customizationId(d.profile)),
    peppol ? e('cbc:ProfileID', PEPPOL_PROFILE) : null,
    e('cbc:ID', d.number),
    e('cbc:IssueDate', d.issueDate),
    credit ? null : e('cbc:DueDate', d.dueDate),
    e(credit ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', d.typeCode),
    // Peppol allows one document note.
    peppol ? e('cbc:Note', notes.join('\n')) : notes.map((n) => e('cbc:Note', n)),
    e('cbc:DocumentCurrencyCode', d.currency),
    c.taxCurrency ? e('cbc:TaxCurrencyCode', c.taxCurrency.code) : null,
    e('cbc:BuyerReference', d.buyerReference),
    e('cac:OrderReference', e('cbc:ID', d.orderReference)),
    d.precedingNumber.trim() ? e('cac:BillingReference', e('cac:InvoiceDocumentReference', e('cbc:ID', d.precedingNumber), e('cbc:IssueDate', d.precedingDate))) : null,
    e('cac:ContractDocumentReference', e('cbc:ID', d.contractReference)),
    e('cac:AccountingSupplierParty', ublParty(d.seller, peppol)),
    e('cac:AccountingCustomerParty', ublParty(d.buyer, peppol)),
    e('cac:Delivery', e('cbc:ActualDeliveryDate', d.deliveryDate), kCountry ? e('cac:DeliveryLocation', e('cac:Address', e('cac:Country', e('cbc:IdentificationCode', kCountry)))) : null),
    d.payment.meansCode
      ? e(
          'cac:PaymentMeans',
          e('cbc:PaymentMeansCode', d.payment.meansCode),
          credit ? e('cbc:PaymentDueDate', d.dueDate) : null,
          e('cbc:PaymentID', d.payment.reference),
          e('cac:PayeeFinancialAccount', e('cbc:ID', d.payment.iban.replace(/\s+/g, '')), e('cbc:Name', d.payment.accountName), e('cac:FinancialInstitutionBranch', e('cbc:ID', d.payment.bic))),
        )
      : null,
    e('cac:PaymentTerms', e('cbc:Note', d.payment.terms)),
    d.allowances.map((a) =>
      e(
        'cac:AllowanceCharge',
        e('cbc:ChargeIndicator', a.charge ? 'true' : 'false'),
        e('cbc:AllowanceChargeReason', a.reason || reasonWord(d.profile, a.charge)),
        el('cbc:Amount', cur, amountText(a.amount)),
        ublTaxCategory('cac:TaxCategory', a.vatCategory, effective(a.vatCategory, a.vatPercent)),
      ),
    ),
    e(
      'cac:TaxTotal',
      amt('cbc:TaxAmount', c.totals.tax),
      c.vat.map((v) =>
        e(
          'cac:TaxSubtotal',
          amt('cbc:TaxableAmount', v.taxable),
          amt('cbc:TaxAmount', v.amount),
          ublTaxCategory('cac:TaxCategory', v.category, v.percent, v.exemptionCode || v.exemptionReason ? { code: v.exemptionCode, reason: v.exemptionReason } : undefined),
        ),
      ),
    ),
    c.taxCurrency ? e('cac:TaxTotal', amt('cbc:TaxAmount', c.taxCurrency.tax, c.taxCurrency.code)) : null,
    e(
      'cac:LegalMonetaryTotal',
      amt('cbc:LineExtensionAmount', c.totals.lineNet),
      amt('cbc:TaxExclusiveAmount', c.totals.taxExclusive),
      amt('cbc:TaxInclusiveAmount', c.totals.taxInclusive),
      d.allowances.some((a) => !a.charge) ? amt('cbc:AllowanceTotalAmount', c.totals.allowances) : null,
      d.allowances.some((a) => a.charge) ? amt('cbc:ChargeTotalAmount', c.totals.charges) : null,
      c.totals.prepaid ? amt('cbc:PrepaidAmount', c.totals.prepaid) : null,
      c.totals.rounding ? amt('cbc:PayableRoundingAmount', c.totals.rounding) : null,
      amt('cbc:PayableAmount', c.totals.payable),
    ),
    c.lines.map((l) =>
      e(
        credit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine',
        e('cbc:ID', l.id),
        el(credit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity', { unitCode: l.unit }, decimalText(l.quantity)),
        amt('cbc:LineExtensionAmount', l.net),
        l.discount
          ? e(
              'cac:AllowanceCharge',
              e('cbc:ChargeIndicator', 'false'),
              e('cbc:AllowanceChargeReasonCode', '95'),
              e('cbc:AllowanceChargeReason', reasonWord(d.profile, false)),
              e('cbc:MultiplierFactorNumeric', decimalText(l.discountPercent, 4)),
              amt('cbc:Amount', l.discount),
              amt('cbc:BaseAmount', l.gross),
            )
          : null,
        e(
          'cac:Item',
          e('cbc:Description', l.description),
          e('cbc:Name', l.name),
          e('cac:SellersItemIdentification', e('cbc:ID', l.itemId)),
          ublTaxCategory('cac:ClassifiedTaxCategory', l.vatCategory, effective(l.vatCategory, l.vatPercent)),
        ),
        e('cac:Price', el('cbc:PriceAmount', cur, decimalText(l.price)), l.baseQuantity !== 1 ? el('cbc:BaseQuantity', { unitCode: l.unit }, decimalText(l.baseQuantity)) : null),
      ),
    ),
  );
  return serializeXml(root!, true);
}


// ------------------------------------------------------------------ CII

function ciiParty(tag: string, p: DraftParty): XEl | null {
  const endpoint = p.endpointId.trim();
  return e(
    tag,
    e('ram:Name', p.name),
    e('ram:SpecifiedLegalOrganization', e('ram:ID', p.companyId)),
    e('ram:DefinedTradeContact', e('ram:TelephoneUniversalCommunication', e('ram:CompleteNumber', p.phone)), e('ram:EmailURIUniversalCommunication', e('ram:URIID', p.email))),
    e('ram:PostalTradeAddress', e('ram:PostcodeCode', p.postalCode), e('ram:LineOne', p.street), e('ram:CityName', p.city), e('ram:CountryID', p.country.toUpperCase()), e('ram:CountrySubDivisionName', p.region)),
    endpoint ? e('ram:URIUniversalCommunication', el('ram:URIID', { schemeID: p.endpointScheme.trim() || 'EM' }, endpoint)) : null,
    p.vatId.trim() ? e('ram:SpecifiedTaxRegistration', el('ram:ID', { schemeID: 'VA' }, p.vatId.replace(/\s+/g, ''))) : null,
  );
}

/** UN/CEFACT CII (Factur-X / ZUGFeRD, EN 16931 profile). */
export function writeCii(c: CalcInvoice): string {
  const d = c.draft;
  const amt = (name: string, n: number) => e(name, amountText(n));
  const date = (name: string, iso: string) => (iso ? e(name, el('udt:DateTimeString', { format: '102' }, d102(iso))) : null);
  const kCountry = c.lines.some((l) => l.vatCategory === 'K') ? d.buyer.country : '';
  const indicator = (charge: boolean) => e('ram:ChargeIndicator', e('udt:Indicator', charge ? 'true' : 'false'));
  const root = el(
    'rsm:CrossIndustryInvoice',
    { 'xmlns:rsm': CII_NS.rsm, 'xmlns:ram': CII_NS.ram, 'xmlns:qdt': CII_NS.qdt, 'xmlns:udt': CII_NS.udt },
    e('rsm:ExchangedDocumentContext', e('ram:GuidelineSpecifiedDocumentContextParameter', e('ram:ID', EN16931))),
    e('rsm:ExchangedDocument', e('ram:ID', d.number), e('ram:TypeCode', d.typeCode), date('ram:IssueDateTime', d.issueDate), d.notes.map((n) => e('ram:IncludedNote', e('ram:Content', n)))),
    e(
      'rsm:SupplyChainTradeTransaction',
      c.lines.map((l) =>
        e(
          'ram:IncludedSupplyChainTradeLineItem',
          e('ram:AssociatedDocumentLineDocument', e('ram:LineID', l.id)),
          e('ram:SpecifiedTradeProduct', e('ram:SellerAssignedID', l.itemId), e('ram:Name', l.name), e('ram:Description', l.description)),
          e('ram:SpecifiedLineTradeAgreement', e('ram:NetPriceProductTradePrice', e('ram:ChargeAmount', decimalText(l.price)), l.baseQuantity !== 1 ? el('ram:BasisQuantity', { unitCode: l.unit }, decimalText(l.baseQuantity)) : null)),
          e('ram:SpecifiedLineTradeDelivery', el('ram:BilledQuantity', { unitCode: l.unit }, decimalText(l.quantity))),
          e(
            'ram:SpecifiedLineTradeSettlement',
            e('ram:ApplicableTradeTax', e('ram:TypeCode', 'VAT'), e('ram:CategoryCode', l.vatCategory), effective(l.vatCategory, l.vatPercent) === null ? null : e('ram:RateApplicablePercent', decimalText(effective(l.vatCategory, l.vatPercent)!, 2))),
            l.discount
              ? e('ram:SpecifiedTradeAllowanceCharge', indicator(false), e('ram:CalculationPercent', decimalText(l.discountPercent, 4)), amt('ram:BasisAmount', l.gross), amt('ram:ActualAmount', l.discount), e('ram:ReasonCode', '95'), e('ram:Reason', reasonWord(d.profile, false)))
              : null,
            e('ram:SpecifiedTradeSettlementLineMonetarySummation', amt('ram:LineTotalAmount', l.net)),
          ),
        ),
      ),
      e(
        'ram:ApplicableHeaderTradeAgreement',
        e('ram:BuyerReference', d.buyerReference),
        ciiParty('ram:SellerTradeParty', d.seller),
        ciiParty('ram:BuyerTradeParty', d.buyer),
        e('ram:BuyerOrderReferencedDocument', e('ram:IssuerAssignedID', d.orderReference)),
        e('ram:ContractReferencedDocument', e('ram:IssuerAssignedID', d.contractReference)),
      ),
      // The delivery element is required, even when empty.
      e('ram:ApplicableHeaderTradeDelivery', kCountry ? e('ram:ShipToTradeParty', e('ram:PostalTradeAddress', e('ram:CountryID', kCountry))) : null, d.deliveryDate ? e('ram:ActualDeliverySupplyChainEvent', date('ram:OccurrenceDateTime', d.deliveryDate)) : null) ?? { name: 'ram:ApplicableHeaderTradeDelivery', attrs: [], children: [] },
      e(
        'ram:ApplicableHeaderTradeSettlement',
        e('ram:PaymentReference', d.payment.reference),
        c.taxCurrency ? e('ram:TaxCurrencyCode', c.taxCurrency.code) : null,
        e('ram:InvoiceCurrencyCode', d.currency),
        d.payment.meansCode
          ? e(
              'ram:SpecifiedTradeSettlementPaymentMeans',
              e('ram:TypeCode', d.payment.meansCode),
              e('ram:PayeePartyCreditorFinancialAccount', e('ram:IBANID', d.payment.iban.replace(/\s+/g, '')), e('ram:AccountName', d.payment.accountName)),
              e('ram:PayeeSpecifiedCreditorFinancialInstitution', e('ram:BICID', d.payment.bic)),
            )
          : null,
        c.vat.map((v) =>
          e(
            'ram:ApplicableTradeTax',
            amt('ram:CalculatedAmount', v.amount),
            e('ram:TypeCode', 'VAT'),
            e('ram:ExemptionReason', v.exemptionReason),
            amt('ram:BasisAmount', v.taxable),
            e('ram:CategoryCode', v.category),
            e('ram:ExemptionReasonCode', v.exemptionCode),
            v.percent === null ? null : e('ram:RateApplicablePercent', decimalText(v.percent, 2)),
          ),
        ),
        d.allowances.map((a) =>
          e(
            'ram:SpecifiedTradeAllowanceCharge',
            indicator(a.charge),
            amt('ram:ActualAmount', a.amount),
            e('ram:Reason', a.reason || reasonWord(d.profile, a.charge)),
            e('ram:CategoryTradeTax', e('ram:TypeCode', 'VAT'), e('ram:CategoryCode', a.vatCategory), effective(a.vatCategory, a.vatPercent) === null ? null : e('ram:RateApplicablePercent', decimalText(effective(a.vatCategory, a.vatPercent)!, 2))),
          ),
        ),
        e('ram:SpecifiedTradePaymentTerms', e('ram:Description', d.payment.terms), date('ram:DueDateDateTime', d.dueDate)),
        e(
          'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
          amt('ram:LineTotalAmount', c.totals.lineNet),
          d.allowances.some((a) => a.charge) ? amt('ram:ChargeTotalAmount', c.totals.charges) : null,
          d.allowances.some((a) => !a.charge) ? amt('ram:AllowanceTotalAmount', c.totals.allowances) : null,
          amt('ram:TaxBasisTotalAmount', c.totals.taxExclusive),
          el('ram:TaxTotalAmount', { currencyID: d.currency }, amountText(c.totals.tax)),
          c.taxCurrency ? el('ram:TaxTotalAmount', { currencyID: c.taxCurrency.code }, amountText(c.taxCurrency.tax)) : null,
          c.totals.rounding ? amt('ram:RoundingAmount', c.totals.rounding) : null,
          amt('ram:GrandTotalAmount', c.totals.taxInclusive),
          c.totals.prepaid ? amt('ram:TotalPrepaidAmount', c.totals.prepaid) : null,
          amt('ram:DuePayableAmount', c.totals.payable),
        ),
        d.precedingNumber.trim() ? e('ram:InvoiceReferencedDocument', e('ram:IssuerAssignedID', d.precedingNumber), d.precedingDate ? e('ram:FormattedIssueDateTime', el('qdt:DateTimeString', { format: '102' }, d102(d.precedingDate))) : null) : null,
      ),
    ),
  );
  return serializeXml(root!, true);
}
