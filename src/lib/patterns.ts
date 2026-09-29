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

export function findPattern(id: PatternId, text: string): Range[] {
  switch (id) {
    case 'email':
      return all(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, text);
    case 'iban':
      return all(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, text, ibanValid);
    case 'cnp':
      return all(/(?<!\d)[1-9]\d{12}(?!\d)/g, text, cnpValid);
    case 'card':
      // Not glued to other letters/digits (e.g. the digits inside an IBAN).
      return all(/(?<![\p{L}\p{N}])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}])/gu, text, luhnValid);
    case 'phone':
      // 9–15 digits, optional +/00 prefix, usual separators; not part of a longer number.
      return all(/(?<![\w+])(?:\+|00)?\(?\d[\d .\-/()]{7,18}\d(?![\w])/g, text, (m) => {
        const n = digits(m).length;
        if (n < 9 || n > 15) return false;
        if (/^\d{13}$/.test(m) && cnpValid(m)) return false; // a CNP, not a phone
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
