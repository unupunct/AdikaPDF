/**
 * Creating electronic invoices: the draft a user fills in and its EN 16931
 * calculation (line net amounts, document allowances and charges, VAT
 * breakdown per category and rate, totals, amount due). The writers
 * (write.ts) and the checks (rules.ts) both work on the calculated draft. Pure.
 */

/** Which specification the invoice follows. */
export type EInvoiceProfile = 'ro' | 'peppol' | 'facturx';

/** VAT category codes (UNCL5305 subset of EN 16931). */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M';
export const VAT_CATEGORIES: VatCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'];

/** Categories whose VAT breakdown needs an exemption reason (text or VATEX code). */
export const EXEMPT_CATEGORIES = new Set<VatCategory>(['E', 'AE', 'K', 'G', 'O']);
/** Categories with a 0 % rate. */
export const ZERO_RATE_CATEGORIES = new Set<VatCategory>(['Z', 'E', 'AE', 'K', 'G']);

/** Default VATEX codes and reasons for the exempt categories. */
export const DEFAULT_EXEMPTIONS: Partial<Record<VatCategory, { code: string; reason: string }>> = {
  AE: { code: 'VATEX-EU-AE', reason: 'Reverse charge' },
  K: { code: 'VATEX-EU-IC', reason: 'Intra-community supply' },
  G: { code: 'VATEX-EU-G', reason: 'Export outside the EU' },
  O: { code: 'VATEX-EU-O', reason: 'Not subject to VAT' },
  E: { code: '', reason: '' },
};

export interface DraftParty {
  name: string;
  /** VAT identifier with the country prefix (BT-31 / BT-48), e.g. RO12345678; empty for non-VAT payers. */
  vatId: string;
  /** Legal registration (BT-30 / BT-47): CUI, trade register number, or a person's CNP. */
  companyId: string;
  street: string;
  city: string;
  postalCode: string;
  /** Country subdivision (BT-39 / BT-54): ISO 3166-2 code such as RO-CJ. */
  region: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  email: string;
  phone: string;
  /** Electronic address (BT-34 / BT-49) and its EAS scheme, e.g. 9947 for a Romanian VAT number. */
  endpointId: string;
  endpointScheme: string;
}

export interface DraftLine {
  name: string;
  description: string;
  /** Seller's item identifier (BT-155). */
  itemId: string;
  quantity: number;
  /** UN/ECE Rec. 20 unit code (H87 piece, HUR hour, KGM kilogram…). */
  unit: string;
  /** Net price per base quantity (BT-146). */
  price: number;
  /** Price base quantity (BT-149), 1 when empty. */
  baseQuantity: number;
  /** Line discount in percent of quantity × price (BG-27). */
  discountPercent: number;
  vatCategory: VatCategory;
  vatPercent: number;
}

export interface DraftAllowanceCharge {
  charge: boolean;
  reason: string;
  amount: number;
  vatCategory: VatCategory;
  vatPercent: number;
}

export interface InvoiceDraft {
  profile: EInvoiceProfile;
  /** Invoice type code (BT-3): 380 invoice, 381 credit note, 384 corrected invoice, 389 self-billed, 751 accounting information. */
  typeCode: string;
  number: string;
  issueDate: string;
  dueDate: string;
  deliveryDate: string;
  currency: string;
  /** RON per unit of the invoice currency, for the VAT total in RON (BT-111) when the currency is not RON. */
  exchangeRate: number;
  buyerReference: string;
  orderReference: string;
  contractReference: string;
  /** The invoice this one corrects or credits (BT-25, BT-26). */
  precedingNumber: string;
  precedingDate: string;
  notes: string[];
  seller: DraftParty;
  buyer: DraftParty;
  payment: { meansCode: string; iban: string; bic: string; accountName: string; reference: string; terms: string };
  lines: DraftLine[];
  allowances: DraftAllowanceCharge[];
  /** Exemption reason per exempt category (BT-120 text, BT-121 VATEX code). */
  exemptions: Partial<Record<VatCategory, { code: string; reason: string }>>;
  prepaid: number;
  /** Payable rounding amount (BT-114). */
  rounding: number;
}

export interface CalcLine extends DraftLine {
  id: string;
  /** Quantity × price per base quantity, the base of the discount (rounded to cents). */
  gross: number;
  /** Line discount amount (rounded to cents). */
  discount: number;
  /** Line net amount BT-131 (rounded to cents). */
  net: number;
}

export interface CalcVat {
  category: VatCategory;
  /** null for category O (no rate). */
  percent: number | null;
  taxable: number;
  amount: number;
  exemptionCode: string;
  exemptionReason: string;
}

export interface CalcInvoice {
  draft: InvoiceDraft;
  kind: 'invoice' | 'credit';
  lines: CalcLine[];
  vat: CalcVat[];
  totals: { lineNet: number; allowances: number; charges: number; taxExclusive: number; tax: number; taxInclusive: number; prepaid: number; rounding: number; payable: number };
  /** VAT total in the VAT accounting currency (BT-111), when it differs from the invoice currency. */
  taxCurrency: { code: string; tax: number } | null;
}

/** Rounds half away from zero to `d` decimals, without binary-fraction surprises (1.005 -> 1.01). */
export function round(n: number, d = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  const r = (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-7)) / f;
  return r === 0 ? 0 : r;
}

/** Amount as XML text: two decimals, never "-0.00". */
export const amountText = (n: number) => round(n).toFixed(2);

/** Quantity or price as XML text: up to `d` decimals, no trailing zeros. */
export function decimalText(n: number, d = 6): string {
  const r = round(n, d);
  return String(r === 0 ? 0 : r);
}

/** UBL / CII document kind of a type code. */
export const isCreditType = (code: string) => code === '381';

/** EN 16931 VAT rate of a line: none for O, 0 for the zero-rated categories. */
export function effectivePercent(category: VatCategory, percent: number): number | null {
  if (category === 'O') return null;
  if (ZERO_RATE_CATEGORIES.has(category)) return 0;
  return percent;
}

export function emptyParty(country = 'RO'): DraftParty {
  return { name: '', vatId: '', companyId: '', street: '', city: '', postalCode: '', region: '', country, email: '', phone: '', endpointId: '', endpointScheme: '' };
}

export function emptyLine(): DraftLine {
  return { name: '', description: '', itemId: '', quantity: 1, unit: 'H87', price: 0, baseQuantity: 1, discountPercent: 0, vatCategory: 'S', vatPercent: 21 };
}

export function emptyDraft(profile: EInvoiceProfile = 'ro', today = new Date().toISOString().slice(0, 10)): InvoiceDraft {
  return {
    profile,
    typeCode: '380',
    number: '',
    issueDate: today,
    dueDate: '',
    deliveryDate: '',
    currency: profile === 'ro' ? 'RON' : 'EUR',
    exchangeRate: 0,
    buyerReference: '',
    orderReference: '',
    contractReference: '',
    precedingNumber: '',
    precedingDate: '',
    notes: [],
    seller: emptyParty(profile === 'ro' ? 'RO' : ''),
    buyer: emptyParty(profile === 'ro' ? 'RO' : ''),
    payment: { meansCode: '30', iban: '', bic: '', accountName: '', reference: '', terms: '' },
    lines: [emptyLine()],
    allowances: [],
    exemptions: {},
    prepaid: 0,
    rounding: 0,
  };
}

/** The VAT accounting currency (BT-6): RON on a Romanian invoice in another currency. */
export function taxCurrencyOf(d: InvoiceDraft): string {
  return d.profile === 'ro' && d.currency && d.currency !== 'RON' ? 'RON' : '';
}

/** The EN 16931 calculation of a draft. */
export function calculate(d: InvoiceDraft): CalcInvoice {
  const lines: CalcLine[] = d.lines.map((l, i) => {
    const base = l.baseQuantity > 0 ? l.baseQuantity : 1;
    const gross = (l.quantity * l.price) / base;
    const discount = l.discountPercent ? round((round(gross) * l.discountPercent) / 100) : 0;
    return { ...l, baseQuantity: base, id: String(i + 1), gross: round(gross), discount, net: round(gross - discount) };
  });
  // VAT breakdown: one group per category and rate.
  const groups = new Map<string, CalcVat>();
  const add = (category: VatCategory, pct: number, amount: number) => {
    const percent = effectivePercent(category, pct);
    const key = `${category}|${percent ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      const ex = EXEMPT_CATEGORIES.has(category) ? (d.exemptions[category] ?? DEFAULT_EXEMPTIONS[category] ?? { code: '', reason: '' }) : { code: '', reason: '' };
      g = { category, percent, taxable: 0, amount: 0, exemptionCode: ex.code.trim(), exemptionReason: ex.reason.trim() };
      groups.set(key, g);
    }
    g.taxable += amount;
  };
  for (const l of lines) add(l.vatCategory, l.vatPercent, l.net);
  for (const a of d.allowances) add(a.vatCategory, a.vatPercent, (a.charge ? 1 : -1) * round(a.amount));
  const vat = [...groups.values()].map((g) => {
    const taxable = round(g.taxable);
    return { ...g, taxable, amount: g.percent ? round((taxable * g.percent) / 100) : 0 };
  });
  const lineNet = round(lines.reduce((s, l) => s + l.net, 0));
  const allowances = round(d.allowances.filter((a) => !a.charge).reduce((s, a) => s + round(a.amount), 0));
  const charges = round(d.allowances.filter((a) => a.charge).reduce((s, a) => s + round(a.amount), 0));
  const taxExclusive = round(lineNet - allowances + charges);
  const tax = round(vat.reduce((s, v) => s + v.amount, 0));
  const taxInclusive = round(taxExclusive + tax);
  const prepaid = round(d.prepaid || 0);
  const rounding = round(d.rounding || 0);
  const payable = round(taxInclusive - prepaid + rounding);
  const tc = taxCurrencyOf(d);
  return {
    draft: d,
    kind: isCreditType(d.typeCode) ? 'credit' : 'invoice',
    lines,
    vat,
    totals: { lineNet, allowances, charges, taxExclusive, tax, taxInclusive, prepaid, rounding, payable },
    taxCurrency: tc ? { code: tc, tax: round(tax * (d.exchangeRate || 0)) } : null,
  };
}

/** The rounding (BT-114) that makes the amount due a whole number of `step` (e.g. 0.05 or 1). */
export function roundingFor(taxInclusive: number, prepaid: number, step: number): number {
  if (!(step > 0)) return 0;
  const due = taxInclusive - prepaid;
  return round(Math.round(due / step) * step - due);
}
