/**
 * Checks for a new e-invoice before it is written: the EN 16931 business
 * rules a form can break (mandatory data, VAT category rules, payment
 * account), the Romanian CIUS-RO rules (ANAF e-Factura) and the Peppol BIS
 * Billing 3.0 rules. The sums themselves are always right (model.ts
 * calculates them). Pure.
 */
import { cnpValid } from '@/lib/patterns';
import { EXEMPT_CATEGORIES, type CalcInvoice, type DraftParty } from './model';

export interface InvoiceIssue {
  /** Business rule identifier, e.g. "BR-RO-010" or "BR-61". */
  rule: string;
  /** English message (the app translates it). */
  message: string;
  /** Errors make the e-invoice invalid; warnings are advice. */
  severity: 'error' | 'warning';
}

/** Romanian counties: ISO 3166-2:RO code -> name. */
export const RO_COUNTIES: Record<string, string> = {
  'RO-AB': 'Alba', 'RO-AR': 'Arad', 'RO-AG': 'Argeș', 'RO-BC': 'Bacău', 'RO-BH': 'Bihor', 'RO-BN': 'Bistrița-Năsăud', 'RO-BT': 'Botoșani',
  'RO-BR': 'Brăila', 'RO-BV': 'Brașov', 'RO-BZ': 'Buzău', 'RO-B': 'București', 'RO-CL': 'Călărași', 'RO-CS': 'Caraș-Severin', 'RO-CJ': 'Cluj',
  'RO-CT': 'Constanța', 'RO-CV': 'Covasna', 'RO-DB': 'Dâmbovița', 'RO-DJ': 'Dolj', 'RO-GL': 'Galați', 'RO-GR': 'Giurgiu', 'RO-GJ': 'Gorj',
  'RO-HR': 'Harghita', 'RO-HD': 'Hunedoara', 'RO-IL': 'Ialomița', 'RO-IS': 'Iași', 'RO-IF': 'Ilfov', 'RO-MM': 'Maramureș', 'RO-MH': 'Mehedinți',
  'RO-MS': 'Mureș', 'RO-NT': 'Neamț', 'RO-OT': 'Olt', 'RO-PH': 'Prahova', 'RO-SJ': 'Sălaj', 'RO-SM': 'Satu Mare', 'RO-SB': 'Sibiu',
  'RO-SV': 'Suceava', 'RO-TR': 'Teleorman', 'RO-TM': 'Timiș', 'RO-TL': 'Tulcea', 'RO-VL': 'Vâlcea', 'RO-VS': 'Vaslui', 'RO-VN': 'Vrancea',
};

/** Bucharest's sectors as CIUS-RO writes them in the city field. */
export const BUCHAREST_SECTORS = ['SECTOR1', 'SECTOR2', 'SECTOR3', 'SECTOR4', 'SECTOR5', 'SECTOR6'];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** A county as its ISO code: "RO-CJ", "CJ", "Cluj", "jud. Cluj", "Bucuresti" -> "RO-CJ" / "RO-B"; "" when unknown. */
export function normalizeRoCounty(s: string): string {
  const v = s.trim();
  if (!v) return '';
  const up = v.toUpperCase();
  if (RO_COUNTIES[up]) return up;
  if (RO_COUNTIES[`RO-${up}`]) return `RO-${up}`;
  const f = fold(v.replace(/^(jud(etul)?\.?|municipiul|mun\.)\s*/i, ''));
  for (const [code, name] of Object.entries(RO_COUNTIES)) if (fold(name) === f) return code;
  return '';
}

/** "Sector 3", "sectorul 3", "S3" -> "SECTOR3"; anything else unchanged. */
export function normalizeSector(city: string): string {
  const m = /^\s*(?:sect(?:or(?:ul)?)?|s)\.?\s*([1-6])\s*$/i.exec(city);
  return m ? `SECTOR${m[1]}` : city;
}

/** Romanian fiscal code (CUI / CIF) check digit, with or without the RO prefix. */
export function cuiValid(s: string): boolean {
  const v = s.trim().toUpperCase().replace(/^RO/, '').replace(/\s+/g, '');
  if (!/^\d{2,10}$/.test(v)) return false;
  const digits = v.slice(0, -1).padStart(9, '0');
  const key = '753217532';
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * Number(key[i]);
  const c = ((sum * 10) % 11) % 10;
  return c === Number(v[v.length - 1]);
}

/** IBAN check (ISO 13616, mod 97). */
export function ibanValid(s: string): boolean {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let r = 0;
  for (const ch of moved) {
    const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) r = (r * 10 + Number(d)) % 97;
  }
  return r === 1;
}

/** Peppol electronic address schemes (EAS) of the VAT numbers by country. */
export const VAT_EAS: Record<string, string> = {
  AT: '9915', BE: '9925', BG: '9926', CY: '9928', CZ: '9929', DE: '9930', EE: '9931', GR: '9933', EL: '9933', HR: '9934', IE: '9935', LT: '9937',
  LU: '9938', LV: '9939', MT: '9943', NL: '9944', PL: '9945', PT: '9946', RO: '9947', SI: '9949', SK: '9950', FR: '9957', HU: '9910', IT: '0211',
  ES: '9920', SE: '0007', DK: '0184', FI: '0216', NO: '0192',
};

/** A Peppol electronic address from the VAT number when none is given. */
export function defaultEndpoint(p: DraftParty): { id: string; scheme: string } {
  if (p.endpointId.trim()) return { id: p.endpointId.trim(), scheme: p.endpointScheme.trim() };
  const vat = p.vatId.replace(/\s+/g, '').toUpperCase();
  const cc = (vat.slice(0, 2) || p.country).toUpperCase();
  if (vat && VAT_EAS[cc]) return { id: vat, scheme: VAT_EAS[cc] };
  if (p.email.trim()) return { id: p.email.trim(), scheme: 'EM' };
  return { id: '', scheme: '' };
}

/** CIUS-RO maximum lengths: [business term, label, max]. */
const RO_LENGTHS: Array<[string, string, number]> = [
  ['BT-1', 'invoice number', 200],
  ['BT-27', 'seller name', 200],
  ['BT-44', 'buyer name', 200],
  ['BT-35', 'seller street', 150],
  ['BT-50', 'buyer street', 150],
  ['BT-37', 'seller city', 50],
  ['BT-52', 'buyer city', 50],
  ['BT-20', 'payment terms', 100],
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every problem the invoice has for its profile (empty when it can be issued). */
export function validateInvoice(c: CalcInvoice): InvoiceIssue[] {
  const d = c.draft;
  const out: InvoiceIssue[] = [];
  const err = (rule: string, message: string) => out.push({ rule, message, severity: 'error' });
  const warn = (rule: string, message: string) => out.push({ rule, message, severity: 'warning' });
  const ro = d.profile === 'ro';
  const peppol = d.profile === 'peppol';

  // --- document (EN 16931)
  if (!d.number.trim()) err('BR-02', 'The invoice needs a number.');
  if (!DATE.test(d.issueDate)) err('BR-03', 'The invoice needs an issue date.');
  if (!d.typeCode) err('BR-04', 'The invoice needs a type.');
  if (!/^[A-Z]{3}$/.test(d.currency)) err('BR-05', 'The invoice needs a currency (ISO 4217 code such as RON or EUR).');
  if (d.dueDate && !DATE.test(d.dueDate)) err('BR-CO-25', 'The due date is not a valid date.');
  if (d.dueDate && DATE.test(d.issueDate) && d.dueDate < d.issueDate) warn('BT-9', 'The due date is before the issue date.');
  if (c.totals.payable > 0 && !d.dueDate && !d.payment.terms.trim()) err('BR-CO-25', 'An amount is due: give a due date or payment terms.');
  if (!c.lines.length) err('BR-16', 'The invoice needs at least one line.');

  // --- parties
  const party = (p: DraftParty, who: 'seller' | 'buyer') => {
    const W = who === 'seller' ? 'The seller' : 'The buyer';
    if (!p.name.trim()) err(who === 'seller' ? 'BR-06' : 'BR-07', `${W} needs a name.`);
    if (!/^[A-Z]{2}$/i.test(p.country.trim())) err(who === 'seller' ? 'BR-09' : 'BR-11', `${W} needs a country (two-letter code).`);
    if (p.vatId.trim() && !/^[A-Z]{2}[A-Z0-9+*.]{2,}$/i.test(p.vatId.replace(/\s+/g, ''))) err('BR-CO-09', `${W}'s VAT number must start with the country code (e.g. RO12345678).`);
    if (p.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim())) warn('BT-43', `${W}'s e-mail address looks wrong.`);
  };
  party(d.seller, 'seller');
  party(d.buyer, 'buyer');
  if (!d.seller.vatId.trim() && !d.seller.companyId.trim()) err('BR-CO-26', 'The seller needs a VAT number or a registration number.');

  // --- lines
  c.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.name.trim()) err('BR-25', `Line ${n}: the item needs a name.`);
    if (!l.quantity) err('BR-22', `Line ${n}: the quantity is missing.`);
    if (!/^[A-Z0-9]{2,3}$/.test(l.unit)) err('BR-23', `Line ${n}: the unit must be a UN/ECE Rec. 20 code (H87, HUR, KGM…).`);
    if (l.price < 0) err('BR-27', `Line ${n}: the price cannot be negative; use a negative quantity instead.`);
    if (l.discountPercent < 0 || l.discountPercent > 100) err('BT-138', `Line ${n}: the discount must be between 0 and 100%.`);
    if (l.vatCategory === 'S' && !(l.vatPercent > 0)) err('BR-S-05', `Line ${n}: standard-rated VAT (S) needs a rate above 0.`);
    if ((l.vatCategory === 'L' || l.vatCategory === 'M') && l.vatPercent < 0) err(l.vatCategory === 'L' ? 'BR-AF-05' : 'BR-AG-05', `Line ${n}: the VAT rate cannot be negative.`);
  });
  d.allowances.forEach((a, i) => {
    if (!(a.amount > 0)) err('BR-31', `Document ${a.charge ? 'charge' : 'discount'} ${i + 1} needs an amount.`);
    if (!a.reason.trim()) warn('BR-33', `Document ${a.charge ? 'charge' : 'discount'} ${i + 1} has no reason; "${a.charge ? 'Charge' : 'Discount'}" is written.`);
  });

  // --- VAT categories
  const cats = new Set(c.vat.map((v) => v.category));
  for (const v of c.vat) {
    if (EXEMPT_CATEGORIES.has(v.category) && !v.exemptionCode && !v.exemptionReason) err(`BR-${v.category === 'K' ? 'IC' : v.category}-10`, `VAT category ${v.category} needs an exemption reason or VATEX code.`);
  }
  const sellerVat = !!d.seller.vatId.trim();
  const buyerVat = !!d.buyer.vatId.trim();
  if (cats.has('S') && !sellerVat) err('BR-S-02', 'Standard-rated VAT needs the seller\'s VAT number.');
  if (cats.has('AE')) {
    if (!sellerVat) err('BR-AE-02', 'Reverse charge (AE) needs the seller\'s VAT number.');
    if (!buyerVat && !d.buyer.companyId.trim()) err('BR-AE-02', 'Reverse charge (AE) needs the buyer\'s VAT number or registration number.');
  }
  if (cats.has('K')) {
    if (!sellerVat || !buyerVat) err('BR-IC-02', 'An intra-community supply (K) needs the VAT numbers of the seller and of the buyer.');
    if (!d.deliveryDate) err('BR-IC-11', 'An intra-community supply (K) needs the delivery date.');
  }
  if (cats.has('G') && !sellerVat) err('BR-G-02', 'An export (G) needs the seller\'s VAT number.');
  if (cats.has('O')) {
    if (cats.size > 1) err('BR-O-11', 'An invoice with "not subject to VAT" (O) cannot have other VAT categories.');
    if (sellerVat || buyerVat) err('BR-O-02', 'An invoice "not subject to VAT" (O) cannot carry VAT numbers.');
  }
  if (cats.has('E') && !sellerVat) warn('BR-E-02', 'VAT-exempt lines (E) normally carry the seller\'s VAT number.');

  // --- payment (BR-61): a credit transfer needs the account
  if (['30', '58'].includes(d.payment.meansCode) && !d.payment.iban.trim() && c.kind === 'invoice') err('BR-61', 'A credit transfer needs the account number (IBAN).');
  if (d.payment.iban.trim() && /^[A-Z]{2}\d{2}/i.test(d.payment.iban.replace(/\s+/g, '')) && !ibanValid(d.payment.iban)) err('BT-84', 'The IBAN is not valid (check digits).');
  if (d.prepaid < 0) err('BT-113', 'The paid amount cannot be negative.');

  if (ro) validateRo(c, err, warn);
  if (peppol) validatePeppol(c, err);
  return out;
}

function validateRo(c: CalcInvoice, err: (r: string, m: string) => void, warn: (r: string, m: string) => void): void {
  const d = c.draft;
  if (d.number.trim() && !/\d/.test(d.number)) err('BR-RO-010', 'The invoice number must contain at least one digit.');
  if (!['380', '381', '384', '389', '751'].includes(d.typeCode)) err('BR-RO-020', 'e-Factura accepts the invoice types 380, 381, 384, 389 and 751.');
  if (d.currency && d.currency !== 'RON' && !(d.exchangeRate > 0)) err('BR-RO-030', 'An invoice in another currency needs the exchange rate to RON for the VAT total in RON.');
  if (['381', '384'].includes(d.typeCode) && !d.precedingNumber.trim()) warn('BT-25', 'Give the number of the invoice being corrected or credited.');
  if (d.notes.length > 20) err('CIUS-RO BT-22', 'e-Factura allows at most 20 notes.');
  d.notes.forEach((n, i) => n.length > 300 && err('CIUS-RO BT-22', `Note ${i + 1} is longer than 300 characters.`));
  if (c.lines.length > 999) err('CIUS-RO BG-25', 'e-Factura allows at most 999 lines.');
  const values: Record<string, string> = {
    'BT-1': d.number, 'BT-27': d.seller.name, 'BT-44': d.buyer.name, 'BT-35': d.seller.street, 'BT-50': d.buyer.street,
    'BT-37': d.seller.city, 'BT-52': d.buyer.city, 'BT-20': d.payment.terms,
  };
  for (const [bt, label, max] of RO_LENGTHS) if ((values[bt] ?? '').length > max) err(`CIUS-RO ${bt}`, `The ${label} is longer than ${max} characters (${bt}).`);
  c.lines.forEach((l, i) => {
    if (l.name.length > 100) err('CIUS-RO BT-153', `Line ${i + 1}: the item name is longer than 100 characters.`);
    if (l.description.length > 200) err('CIUS-RO BT-154', `Line ${i + 1}: the item description is longer than 200 characters.`);
  });

  // Addresses: street and city always; the county (ISO 3166-2:RO) in Romania, Bucharest by sector.
  const address = (p: DraftParty, who: 'seller' | 'buyer') => {
    const W = who === 'seller' ? 'The seller' : 'The buyer';
    const rule = who === 'seller' ? ['CIUS-RO BT-35', 'CIUS-RO BT-37', 'CIUS-RO BT-39', 'CIUS-RO BT-37'] : ['CIUS-RO BT-50', 'CIUS-RO BT-52', 'CIUS-RO BT-54', 'CIUS-RO BT-52'];
    if (!p.street.trim()) err(rule[0], `${W} needs a street address.`);
    if (!p.city.trim()) err(rule[1], `${W} needs a city.`);
    if (p.country.toUpperCase() !== 'RO') return;
    const county = p.region.trim().toUpperCase();
    if (!county) err(rule[2], `${W} needs a county (e.g. RO-CJ; RO-B for Bucharest).`);
    else if (!RO_COUNTIES[county]) err(rule[2], `${W}'s county must be an ISO 3166-2:RO code such as RO-CJ or RO-B, not "${p.region}".`);
    else if (county === 'RO-B' && !BUCHAREST_SECTORS.includes(p.city.trim().toUpperCase())) err(rule[3], `In Bucharest the city of ${who === 'seller' ? 'the seller' : 'the buyer'} must be the sector: SECTOR1 to SECTOR6.`);
  };
  address(d.seller, 'seller');
  address(d.buyer, 'buyer');

  // Fiscal codes.
  const s = d.seller;
  if (s.country.toUpperCase() === 'RO') {
    const vat = s.vatId.replace(/\s+/g, '').toUpperCase();
    if (vat && (!vat.startsWith('RO') || !cuiValid(vat))) err('CIUS-RO BT-31', 'The seller\'s VAT number must be RO followed by a valid CUI.');
    if (!vat && !cuiValid(s.companyId)) err('CIUS-RO BT-31', 'A seller not registered for VAT must give its CUI (without RO) as registration number.');
  }
  const b = d.buyer;
  if (b.country.toUpperCase() === 'RO') {
    const vat = b.vatId.replace(/\s+/g, '').toUpperCase();
    const id = b.companyId.replace(/\s+/g, '');
    if (vat && (!vat.startsWith('RO') || !cuiValid(vat))) err('CIUS-RO BT-48', 'The buyer\'s VAT number must be RO followed by a valid CUI.');
    else if (!vat && !(cuiValid(id) || cnpValid(id) || id === '0000000000000')) err('CIUS-RO BT-48', 'A Romanian buyer needs a CUI, or a CNP for a person (13 zeros when the person has none).');
  }
}

function validatePeppol(c: CalcInvoice, err: (r: string, m: string) => void): void {
  const d = c.draft;
  if (!d.buyerReference.trim() && !d.orderReference.trim()) err('PEPPOL-EN16931-R003', 'Peppol needs a buyer reference or an order number.');
  if (!d.seller.endpointId.trim()) err('PEPPOL-EN16931-R020', 'Peppol needs the seller\'s electronic address (endpoint).');
  if (!d.buyer.endpointId.trim()) err('PEPPOL-EN16931-R010', 'Peppol needs the buyer\'s electronic address (endpoint).');
  for (const p of [d.seller, d.buyer]) if (p.endpointId.trim() && !/^\d{4}$|^EM$/.test(p.endpointScheme.trim())) err('PEPPOL EAS', 'An electronic address needs its scheme (EAS code such as 0088 or 9947).');
  if (!['380', '381', '383', '384', '386', '389', '751', '393', '395'].includes(d.typeCode)) err('PEPPOL-EN16931-P0100', 'Peppol does not accept this invoice type.');
}
