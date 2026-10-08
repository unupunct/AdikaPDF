/**
 * The invoicing data kept on this computer: seller profiles (company, bank
 * accounts, logo, numbering series), customers (added from every invoice
 * made or opened) and a product / service catalogue. Plus drafts made from
 * a parsed invoice (credit notes, a copy). Pure; actions/einvoiceCreate.ts
 * stores the book in the app data folder.
 */
import type { EInvoice, Party } from './parse';
import { DEFAULT_EXEMPTIONS, VAT_CATEGORIES, emptyDraft, emptyParty, round, type DraftLine, type DraftParty, type EInvoiceProfile, type InvoiceDraft, type VatCategory } from './model';
import { normalizeRoCounty, normalizeSector } from './rules';

export interface BankAccount {
  iban: string;
  bic: string;
  bank: string;
}

export interface NumberSeries {
  prefix: string;
  next: number;
  /** Zero padding of the number part. */
  digits: number;
}

export interface SellerProfile {
  id: string;
  party: DraftParty;
  accounts: BankAccount[];
  /** PNG or JPEG as base64, drawn on the readable PDF. */
  logo: string;
  series: NumberSeries[];
  profile: EInvoiceProfile;
  currency: string;
  /** Days from issue to due date. */
  paymentDays: number;
  terms: string;
}

export interface Customer extends DraftParty {
  id: string;
  lastUsed: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  itemId: string;
  unit: string;
  price: number;
  vatCategory: VatCategory;
  vatPercent: number;
}

export interface InvoiceBook {
  version: 1;
  sellers: SellerProfile[];
  customers: Customer[];
  products: CatalogItem[];
  lastSellerId: string;
}

export const emptyBook = (): InvoiceBook => ({ version: 1, sellers: [], customers: [], products: [], lastSellerId: '' });

let counter = 0;
export const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A book read from JSON, with missing parts filled in. */
export function readBook(json: string): InvoiceBook {
  try {
    const b = JSON.parse(json) as Partial<InvoiceBook>;
    if (!b || typeof b !== 'object') return emptyBook();
    return {
      version: 1,
      sellers: Array.isArray(b.sellers) ? b.sellers.map((s) => ({ ...newSeller(), ...s, party: { ...emptyParty(), ...s.party } })) : [],
      customers: Array.isArray(b.customers) ? b.customers.map((c) => ({ ...emptyParty(), ...c })) : [],
      products: Array.isArray(b.products) ? b.products : [],
      lastSellerId: typeof b.lastSellerId === 'string' ? b.lastSellerId : '',
    };
  } catch {
    return emptyBook();
  }
}

export function newSeller(country = 'RO'): SellerProfile {
  return {
    id: newId(),
    party: emptyParty(country),
    accounts: [],
    logo: '',
    series: [{ prefix: `${new Date().getFullYear()}-`, next: 1, digits: 4 }],
    profile: country === 'RO' ? 'ro' : 'peppol',
    currency: country === 'RO' ? 'RON' : 'EUR',
    paymentDays: 30,
    terms: '',
  };
}

/** The next number of a series, e.g. "ADK-2026-0042". */
export const formatSeriesNumber = (s: NumberSeries) => `${s.prefix}${String(Math.max(0, Math.floor(s.next))).padStart(Math.max(0, s.digits), '0')}`;

/** After an invoice was issued with `number`: the series that produced it moves on. */
export function advanceSeries(seller: SellerProfile, number: string): SellerProfile {
  return {
    ...seller,
    series: seller.series.map((s) => {
      if (!number.startsWith(s.prefix)) return s;
      const n = Number(number.slice(s.prefix.length));
      return Number.isInteger(n) && n >= s.next ? { ...s, next: n + 1 } : s;
    }),
  };
}

const partyKey = (p: DraftParty) => (p.vatId.replace(/\s+/g, '') || p.companyId.replace(/\s+/g, '') || p.name.trim()).toLowerCase();

/** Adds or refreshes a customer (matched by VAT number, registration number or name). */
export function upsertCustomer(book: InvoiceBook, p: DraftParty, now = new Date().toISOString()): InvoiceBook {
  if (!p.name.trim()) return book;
  const key = partyKey(p);
  const old = book.customers.find((c) => partyKey(c) === key);
  const c: Customer = { ...p, id: old?.id ?? newId(), lastUsed: now };
  return { ...book, customers: [c, ...book.customers.filter((x) => x !== old)].slice(0, 2000) };
}

/** Customers matching a search (name, VAT number, registration, city), most recently used first. */
export function searchCustomers(book: InvoiceBook, q: string, limit = 8): Customer[] {
  const f = q.trim().toLowerCase();
  const list = [...book.customers].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
  if (!f) return list.slice(0, limit);
  return list.filter((c) => [c.name, c.vatId, c.companyId, c.city].some((v) => v.toLowerCase().includes(f))).slice(0, limit);
}

/** Adds a line's item to the catalogue, or updates the item with the same name. */
export function upsertProduct(book: InvoiceBook, l: DraftLine): InvoiceBook {
  if (!l.name.trim()) return book;
  const old = book.products.find((p) => p.name.trim().toLowerCase() === l.name.trim().toLowerCase());
  const p: CatalogItem = { id: old?.id ?? newId(), name: l.name.trim(), description: l.description, itemId: l.itemId, unit: l.unit, price: l.price / (l.baseQuantity || 1), vatCategory: l.vatCategory, vatPercent: l.vatPercent };
  return { ...book, products: [p, ...book.products.filter((x) => x !== old)] };
}

export function lineFromProduct(p: CatalogItem, quantity = 1): DraftLine {
  return { name: p.name, description: p.description, itemId: p.itemId, quantity, unit: p.unit, price: p.price, baseQuantity: 1, discountPercent: 0, vatCategory: p.vatCategory, vatPercent: p.vatPercent };
}

/** An invoice draft for a seller profile: its details, next number, currency, due date and account. */
export function draftForSeller(seller: SellerProfile, today = new Date().toISOString().slice(0, 10)): InvoiceDraft {
  const d = emptyDraft(seller.profile, today);
  const acc = seller.accounts[0];
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + (seller.paymentDays || 0));
  return {
    ...d,
    number: seller.series[0] ? formatSeriesNumber(seller.series[0]) : '',
    currency: seller.currency || d.currency,
    dueDate: seller.paymentDays ? due.toISOString().slice(0, 10) : '',
    seller: { ...seller.party },
    payment: { ...d.payment, iban: acc?.iban ?? '', bic: acc?.bic ?? '', accountName: seller.party.name, terms: seller.terms },
  };
}

// ------------------------------------------------------------------ from a parsed invoice

/** A parsed party as a draft party (Romanian county names become ISO codes, Bucharest sectors SECTORn). */
export function partyFromInvoice(p: Party): DraftParty {
  const country = p.address.country.toUpperCase();
  const ro = country === 'RO';
  const region = ro ? normalizeRoCounty(p.address.region) || p.address.region : p.address.region;
  return {
    name: p.name,
    vatId: p.vatId,
    companyId: p.companyId,
    street: p.address.street,
    city: ro ? normalizeSector(p.address.city) : p.address.city,
    postalCode: p.address.postalCode,
    region,
    country,
    email: p.email,
    phone: p.phone,
    endpointId: '',
    endpointScheme: '',
  };
}

const asCategory = (c: string): VatCategory => (VAT_CATEGORIES as string[]).includes(c) ? (c as VatCategory) : 'S';

/**
 * A draft from an existing invoice. `credit` makes the credit note for it:
 * type 381 with the same lines and positive amounts (EN 16931 and CIUS-RO:
 * a credit note's amounts are credited), referring to the invoice (BT-25).
 */
export function draftFromInvoice(inv: EInvoice, opts: { profile: EInvoiceProfile; credit: boolean; today?: string }): InvoiceDraft {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const d = emptyDraft(opts.profile, today);
  // A credit note of a credit note, or a storno invoice with negative quantities, credits back with the signs turned.
  const sign = opts.credit && inv.totals.payable < 0 ? -1 : 1;
  const exemptions: InvoiceDraft['exemptions'] = {};
  for (const v of inv.vat) {
    if (!v.exemption) continue;
    const vatex = /^VATEX-/i.test(v.exemption);
    exemptions[asCategory(v.category)] = { code: vatex ? v.exemption : (DEFAULT_EXEMPTIONS[asCategory(v.category)]?.code ?? ''), reason: vatex ? '' : v.exemption };
  }
  const firstVat = inv.vat[0];
  return {
    ...d,
    typeCode: opts.credit ? '381' : inv.typeCode || '380',
    number: '',
    currency: inv.currency || d.currency,
    buyerReference: inv.buyerReference,
    orderReference: inv.orderReference,
    contractReference: inv.contractReference,
    precedingNumber: opts.credit ? inv.number : inv.precedingInvoice,
    precedingDate: opts.credit ? inv.issueDate : '',
    notes: opts.credit ? [] : inv.notes,
    seller: partyFromInvoice(inv.seller),
    buyer: partyFromInvoice(inv.buyer),
    payment: { ...d.payment, meansCode: inv.payment.meansCode || d.payment.meansCode, iban: inv.payment.iban, bic: inv.payment.bic, accountName: inv.payment.accountName, reference: opts.credit ? '' : inv.payment.reference, terms: opts.credit ? '' : inv.payment.terms },
    dueDate: opts.credit ? today : inv.dueDate,
    deliveryDate: inv.deliveryDate,
    lines: inv.lines.map((l) => {
      const gross = l.quantity * l.unitPrice;
      const pct = gross && l.allowances ? round((l.allowances / gross) * 100, 4) : 0;
      return {
        name: l.name,
        description: l.description,
        itemId: '',
        quantity: sign * l.quantity,
        unit: l.unit || 'H87',
        price: l.unitPrice,
        baseQuantity: 1,
        discountPercent: pct,
        vatCategory: asCategory(l.vatCategory),
        vatPercent: l.vatPercent ?? 0,
      };
    }),
    allowances: inv.allowances.map((a) => ({ charge: a.charge, reason: a.reason, amount: a.amount, vatCategory: asCategory(firstVat?.category ?? 'S'), vatPercent: firstVat?.percent ?? 0 })),
    exemptions,
  };
}
