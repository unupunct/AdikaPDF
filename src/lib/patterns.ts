/**
 * Sensitive-data patterns for "Redact by pattern". Each finder returns
 * [start, end) ranges in the text; checksums (IBAN mod 97, CNP, Luhn) keep
 * false positives such as amounts or invoice numbers out.
 */

export type PatternId = 'email' | 'phone' | 'iban' | 'cnp' | 'card' | 'date';

export interface PatternDef {
  id: PatternId;
  label: string;
  example: string;
}

export const PATTERNS: PatternDef[] = [
  { id: 'email', label: 'E-mail addresses', example: 'ana.pop@firma.ro' },
  { id: 'phone', label: 'Phone numbers', example: '+40 722 123 456, 0722-123-456' },
  { id: 'iban', label: 'IBAN bank accounts', example: 'RO49 AAAA 1B31 0075 9384 0000' },
  { id: 'cnp', label: 'Romanian personal numeric codes (CNP)', example: '1800101221144' },
  { id: 'card', label: 'Payment card numbers', example: '4111 1111 1111 1111' },
  { id: 'date', label: 'Dates', example: '12.03.1985, 1985-03-12' },
];

export type Range = [number, number];

function all(re: RegExp, text: string, ok: (m: string) => boolean = () => true, trim = false): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(re)) {
    let s = m.index ?? 0;
    let e = s + m[0].length;
    if (trim) {
      while (s < e && /[\s.\-/]/.test(text[s])) s++;
      while (e > s && /[\s.\-/]/.test(text[e - 1])) e--;
    }
    if (e > s && ok(text.slice(s, e))) out.push([s, e]);
  }
  return out;
}

const digits = (s: string) => s.replace(/\D/g, '');

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function cnpValid(s: string): boolean {
  if (!/^[1-9]\d{12}$/.test(s)) return false;
  const w = '279146358279';
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * Number(w[i]);
  const c = sum % 11 === 10 ? 1 : sum % 11;
  const month = Number(s.slice(3, 5));
  const day = Number(s.slice(5, 7));
  return c === Number(s[12]) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function luhnValid(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = Number(d[d.length - 1 - i]);
    if (i % 2) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** IBAN length per country (ISO 13616 registry). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
  SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/**
 * IBANs, also lower-case and grouped with single spaces. The run of letters
 * and digits may go on after the account ("… 0000 RON"): the country's own
 * length is tried (any length from the longest down for unknown countries),
 * each candidate with its check digits.
 */
function findIbans(text: string): Range[] {
  const out: Range[] = [];
  const re = /(?<![\p{L}\p{N}])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,30}/gu;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    // End offset after each letter / digit of the run.
    const ends: number[] = [];
    for (let i = 0; i < m[0].length; i++) if (m[0][i] !== ' ') ends.push(start + i + 1);
    const known = IBAN_LENGTHS[m[0].slice(0, 2).toUpperCase()];
    const longest = Math.min(34, ends.length);
    const lengths = known ? [known] : Array.from({ length: longest - 14 }, (_, k) => longest - k);
    for (const n of lengths) {
      if (n > ends.length) continue;
      const end = ends[n - 1];
      if (ibanValid(text.slice(start, end))) {
        out.push([start, end]);
        break;
      }
    }
  }
  return out;
}

/** Usual card lengths first: 16 (most cards), 15 (Amex), 19, 13 (old Visa)… */
const CARD_LENGTHS = [16, 15, 19, 13, 14, 17, 18];

/**
 * Payment card numbers, also followed by the expiry date or the CVV
 * ("4111 1111 1111 1111 05 27"): a grouped number may end at any group
 * boundary; a number without separators must be the whole run.
 */
function findCards(text: string): Range[] {
  const out: Range[] = [];
  // Not glued to other letters/digits (e.g. the digits inside an IBAN).
  const re = /(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,30}(?![\p{L}\p{N}])/gu;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const s = m[0];
    // Digit count -> end offset, where a group ends.
    const cuts = new Map<number, number>();
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      if (!/\d/.test(s[i])) continue;
      n++;
      if (i === s.length - 1 || !/\d/.test(s[i + 1])) cuts.set(n, start + i + 1);
    }
    const grouped = /[ -]/.test(s);
    for (const len of CARD_LENGTHS) {
      const end = cuts.get(len);
      if (end === undefined || (!grouped && len !== n)) continue;
      if (luhnValid(text.slice(start, end))) {
        out.push([start, end]);
        break;
      }
    }
  }
  return out;
}

export function findPattern(id: PatternId, text: string): Range[] {
  switch (id) {
    case 'email':
      return all(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, text);
    case 'iban':
      return findIbans(text);
    case 'cnp':
      // Also written in groups ("1 800101 221144").
      return all(/(?<![\d.,])[1-9](?:[ .]?\d){12}(?!\d)/g, text, (m) => cnpValid(digits(m)));
    case 'card':
      return findCards(text);
    case 'phone':
      // 9–15 digits, optional +/00 prefix, usual separators; not part of a longer number.
      return all(/(?<![\w+])(?:\+|00)?\(?\d[\d .\-/()]{7,18}\d(?![\w])/g, text, (m) => {
        const n = digits(m).length;
        if (n < 9 || n > 15) return false;
        if (n === 13 && /^[\d .]+$/.test(m) && cnpValid(digits(m))) return false; // a CNP, not a phone
        if (/\d[.,]\d{2}$/.test(m) && !/[ \-/]/.test(m)) return false; // an amount like 1234567.50
        return /^(?:\+|00|0|\()/.test(m) || /[ \-.]/.test(m);
      }, true);
    case 'date':
      return all(/\b(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b/g, text);
  }
}

/** Plain words / phrases, one per line; matched case- and diacritic-insensitively by the caller. */
export function parseTerms(input: string): string[] {
  return input
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}
