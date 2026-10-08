/**
 * Simple-font encodings, glyph names and ToUnicode CMaps shared by the text
 * engine (`textRemoval.ts`) and the missing-letter code finder (`fontCodes.ts`).
 */
import { PDFDocument, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { Encodings, FontNames } from '@pdf-lib/standard-fonts';

let stdMaps: { codeToName: Map<number, string>; codeToUni: Map<number, string>; nameToUni: Map<string, string> } | null = null;
export function standardMaps() {
  if (stdMaps) return stdMaps;
  const codeToName = new Map<number, string>();
  const codeToUni = new Map<number, string>();
  const nameToUni = new Map<string, string>();
  for (const enc of [Encodings.Symbol, Encodings.ZapfDingbats, Encodings.WinAnsi]) {
    for (const cp of enc.supportedCodePoints) {
      const { code, name } = enc.encodeUnicodeCodePoint(cp);
      nameToUni.set(name, String.fromCodePoint(cp));
      if (enc === Encodings.WinAnsi) {
        codeToName.set(code, name);
        codeToUni.set(code, String.fromCodePoint(cp));
      }
    }
  }
  for (const [k, v] of Object.entries({ fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', space: ' ', nbspace: ' ' })) nameToUni.set(k, v);
  stdMaps = { codeToName, codeToUni, nameToUni };
  return stdMaps;
}

export function glyphNameToUnicode(name: string): string {
  const m = standardMaps().nameToUni.get(name);
  if (m) return m;
  const uni = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (uni) return String.fromCodePoint(...(uni[1].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  return composedFromName(name);
}

/** Combining marks and their Adobe glyph-name suffixes ("t" + "commaaccent" = ț). */
const MARKS: Record<string, string> = {
  '\u0300': 'grave',
  '\u0301': 'acute',
  '\u0302': 'circumflex',
  '\u0303': 'tilde',
  '\u0304': 'macron',
  '\u0306': 'breve',
  '\u0307': 'dotaccent',
  '\u0308': 'dieresis',
  '\u030a': 'ring',
  '\u030b': 'hungarumlaut',
  '\u030c': 'caron',
  '\u0326': 'commaaccent',
  '\u0327': 'cedilla',
  '\u0328': 'ogonek',
};
const SUFFIX_TO_MARK = new Map(Object.entries(MARKS).map(([m, n]) => [n, m]));
/** Letters whose Adobe names are not a composition. */
const EXTRA_NAMES: Record<string, string> = {
  '€': 'Euro',
  ı: 'dotlessi',
  ł: 'lslash',
  Ł: 'Lslash',
  đ: 'dcroat',
  Đ: 'Dcroat',
  ħ: 'hbar',
  Ħ: 'Hbar',
  ŀ: 'ldot',
  Ŀ: 'Ldot',
  ŉ: 'napostrophe',
  ŋ: 'eng',
  Ŋ: 'Eng',
  ĸ: 'kgreenlandic',
  ſ: 'longs',
  ĳ: 'ij',
  Ĳ: 'IJ',
  '−': 'minus',
  '∆': 'Delta',
  '≤': 'lessequal',
  '≥': 'greaterequal',
  '≠': 'notequal',
  '√': 'radical',
  '∞': 'infinity',
  '◊': 'lozenge',
  '∂': 'partialdiff',
  '∑': 'summation',
  '∏': 'product',
  '∫': 'integral',
  'π': 'pi',
  'Ω': 'Omega',
  'µ': 'mu',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
};
const EXTRA_TO_UNI = new Map(Object.entries(EXTRA_NAMES).map(([u, n]) => [n, u]));

/** "scommaaccent" -> "ș" (base letter + accent suffix), "Euro" -> "€". */
function composedFromName(name: string): string {
  // The Adobe Glyph List keeps these for the cedilla forms (as pdf.js reads them).
  if (name === 'Tcommaaccent') return 'Ţ';
  if (name === 'tcommaaccent') return 'ţ';
  const extra = EXTRA_TO_UNI.get(name);
  if (extra) return extra;
  const m = /^([A-Za-z])([a-z]+)$/.exec(name);
  const mark = m ? SUFFIX_TO_MARK.get(m[2]) : undefined;
  if (!m || !mark) return '';
  const c = (m[1] + mark).normalize('NFC');
  return [...c].length === 1 ? c : '';
}

/** Glyph names a font may use for a character: Adobe names first, then uniXXXX. */
export function glyphNamesFor(ch: string): string[] {
  const cp = ch.codePointAt(0) ?? 0;
  const out: string[] = [];
  for (const [name, u] of standardMaps().nameToUni) if (u === ch) out.push(name);
  if (EXTRA_NAMES[ch]) out.push(EXTRA_NAMES[ch]);
  const d = ch.normalize('NFD');
  if (d.length === 2 && /^[A-Za-z]$/.test(d[0]) && MARKS[d[1]]) out.push(d[0] + MARKS[d[1]]);
  out.push(cp > 0xffff ? `u${cp.toString(16).toUpperCase()}` : `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  return [...new Set(out)];
}

export const STD_ALIASES: Record<string, FontNames> = {
  helvetica: FontNames.Helvetica,
  'helvetica-bold': FontNames.HelveticaBold,
  'helvetica-oblique': FontNames.HelveticaOblique,
  'helvetica-boldoblique': FontNames.HelveticaBoldOblique,
  arial: FontNames.Helvetica,
  'arial,bold': FontNames.HelveticaBold,
  'arial-boldmt': FontNames.HelveticaBold,
  arialmt: FontNames.Helvetica,
  'times-roman': FontNames.TimesRoman,
  'times-bold': FontNames.TimesRomanBold,
  'times-italic': FontNames.TimesRomanItalic,
  'times-bolditalic': FontNames.TimesRomanBoldItalic,
  timesnewroman: FontNames.TimesRoman,
  timesnewromanpsmt: FontNames.TimesRoman,
  courier: FontNames.Courier,
  'courier-bold': FontNames.CourierBold,
  'courier-oblique': FontNames.CourierOblique,
  'courier-boldoblique': FontNames.CourierBoldOblique,
  couriernew: FontNames.Courier,
  symbol: FontNames.Symbol,
  zapfdingbats: FontNames.ZapfDingbats,
};

export function streamBytes(doc: PDFDocument, v: unknown): Uint8Array | null {
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) {
    const anyS = s as unknown as { getUnencodedContents?: () => Uint8Array; getContents: () => Uint8Array };
    return anyS.getUnencodedContents ? anyS.getUnencodedContents() : anyS.getContents();
  }
  return null;
}

export function hexToBytes(h: string): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < h.length; k += 2) out.push(parseInt(h.slice(k, k + 2), 16));
  return out;
}

export function utf16(bytes: number[]): string {
  let s = '';
  for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
  if (bytes.length === 1) s += String.fromCharCode(bytes[0]);
  return s;
}

/** A ToUnicode CMap for `map` (one- or two-byte codes). */
export function writeToUnicode(map: Map<number, string>, twoByte: boolean): string {
  const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, '0');
  const uni = (s: string) => [...s].map((c) => {
    const cp = c.codePointAt(0)!;
    if (cp <= 0xffff) return hex(cp, 4);
    const v = cp - 0x10000;
    return hex(0xd800 + (v >> 10), 4) + hex(0xdc00 + (v & 0x3ff), 4);
  }).join('');
  const entries = [...map].filter(([, t]) => t).sort((a, b) => a[0] - b[0]);
  const digits = twoByte ? 4 : 2;
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([c, t]) => `<${hex(c, digits)}> <${uni(t)}>`).join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    twoByte ? '<0000> <FFFF>' : '<00> <FF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/** bfchar / bfrange entries of a ToUnicode CMap. */
export function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const code = (h: string) => parseInt(h || '0', 16);
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>/g)) map.set(code(m[1]), utf16(hexToBytes(m[2])));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = code(m[1]);
      const hi = code(m[2]);
      if (hi - lo > 0xffff) continue;
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)];
        items.forEach((it, k) => map.set(lo + k, utf16(hexToBytes(it[1]))));
      } else {
        const base = hexToBytes(m[3].slice(1, -1));
        for (let c = lo; c <= hi; c++) {
          const b = base.slice();
          b[b.length - 1] += c - lo;
          map.set(c, utf16(b));
        }
      }
    }
  }
  return map;
}

