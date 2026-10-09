/**
 * Embeds the fonts a PDF only names (PDF/A requires every font program).
 * Each simple font (Type1, TrueType) without a font file gets one:
 * 1. the same typeface installed in Windows (TrueType, licence allowing it),
 * 2. a metric-compatible open font shipped with pdf.js: Liberation Sans for
 *    Helvetica / Arial, the Foxit fonts (bare CFF, embedded as Type 1C) for
 *    Times, Courier, Symbol and ZapfDingbats,
 * 3. for other non-symbolic fonts with /Widths, Liberation Sans drawn on the
 *    original widths.
 * The original widths are kept so nothing moves: a TrueType copy has its
 * advance widths set to them (dictionary and program agree, as PDF/A
 * requires); for the CFF fonts the program's own widths are used where they
 * differ by more than one unit. Non-symbolic TrueType fonts get a WinAnsi- or
 * MacRoman-based /Encoding; symbolic ones are only embedded as Type 1C.
 * A font no program is found for stays as it was (reported).
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import type { SystemFont } from '@/lib/platform';
import { embeddingAllowed, fontFromCollection, readFontProgram, sfntTables } from './fontProgram';
import { glyphNameToUnicode } from './fontEncoding';
import { matchInstalled, parseBaseName } from './fontFallback';
import { pruneTrueType } from './fontEmbed';
import { CFF_STANDARD_STRINGS, ENCODINGS } from './stdEncodings';

export interface PdfAFontSources {
  /** A font file of pdf.js' standard_fonts folder (LiberationSans-Regular.ttf, FoxitSerif.pfb, …); null when unavailable. */
  standardFont: (file: string) => Promise<Uint8Array | null>;
  /** Fonts installed in Windows (optional). */
  installed?: () => Promise<SystemFont[]>;
  readInstalled?: (path: string) => Promise<Uint8Array>;
}

export interface FontEmbedReport {
  embedded: Array<{ font: string; with: string }>;
  /** Fonts left without a program. */
  failed: string[];
  notes: string[];
}

const FLAG_FIXED = 1;
const FLAG_SERIF = 2;
const FLAG_SYMBOLIC = 4;
const FLAG_NONSYMBOLIC = 32;
const FLAG_ITALIC = 64;

const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const num = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : undefined);

type Std = 'helvetica' | 'times' | 'courier' | 'symbol' | 'dingbats';

/** Which standard-14 family a base font name means (with the usual Windows aliases). */
function standardFamily(family: string): Std | null {
  if (['helvetica', 'arial', 'arimo', 'liberationsans'].includes(family)) return 'helvetica';
  if (['times', 'timesroman', 'timesnewroman', 'tinos', 'liberationserif'].includes(family)) return 'times';
  if (['courier', 'couriernew', 'cousine', 'liberationmono'].includes(family)) return 'courier';
  if (family === 'symbol') return 'symbol';
  if (family === 'zapfdingbats' || family === 'dingbats') return 'dingbats';
  return null;
}

/** The Symbol / ZapfDingbats font encodings (code -> glyph name). */
function fontSpecificEncoding(std: 'symbol' | 'dingbats'): string[] {
  const enc = std === 'symbol' ? Encodings.Symbol : Encodings.ZapfDingbats;
  const out = new Array<string>(256).fill('');
  for (const cp of enc.supportedCodePoints) {
    const { code, name } = enc.encodeUnicodeCodePoint(cp);
    if (code < 256 && !out[code]) out[code] = name;
  }
  return out;
}

function afmFont(std: Std, bold: boolean, italic: boolean): Font {
  const names: Record<Std, FontNames> = {
    helvetica: bold ? (italic ? FontNames.HelveticaBoldOblique : FontNames.HelveticaBold) : italic ? FontNames.HelveticaOblique : FontNames.Helvetica,
    times: bold ? (italic ? FontNames.TimesRomanBoldItalic : FontNames.TimesRomanBold) : italic ? FontNames.TimesRomanItalic : FontNames.TimesRoman,
    courier: bold ? (italic ? FontNames.CourierBoldOblique : FontNames.CourierBold) : italic ? FontNames.CourierOblique : FontNames.Courier,
    symbol: FontNames.Symbol,
    dingbats: FontNames.ZapfDingbats,
  };
  return Font.load(names[std]);
}

// ---------------------------------------------------------------- Type 1 (bare CFF)

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** A bare CFF font (the Foxit fonts of pdf.js), embedded as FontFile3 /Type1C. */
export interface CffProgram {
  bytes: Uint8Array;
  fontName: string;
  bbox: number[];
  italicAngle: number;
  /** Advance width by glyph name (1000 units). */
  widths: Map<string, number>;
  /** The font's built-in encoding (code -> glyph name). */
  encoding: string[];
}

/** Reads a CFF INDEX at `at`: its items and the offset after it. */
function cffIndex(b: Uint8Array, at: number): { items: Uint8Array[]; end: number } {
  const count = (b[at] << 8) | b[at + 1];
  if (!count) return { items: [], end: at + 2 };
  const size = b[at + 2];
  const off = (i: number) => {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + b[at + 3 + i * size + k];
    return v;
  };
  const base = at + 3 + (count + 1) * size - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) items.push(b.subarray(base + off(i), base + off(i + 1)));
  return { items, end: base + off(count) };
}

/** CFF DICT: operator (12 x as 1200 + x) -> operands. */
function cffDict(d: Uint8Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  for (let i = 0; i < d.length; ) {
    const v = d[i++];
    if (v <= 21) {
      out.set(v === 12 ? 1200 + d[i++] : v, ops);
      ops = [];
    } else if (v === 28) {
      ops.push(((d[i] << 24) >> 16) | d[i + 1]);
      i += 2;
    } else if (v === 29) {
      ops.push((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
      i += 4;
    } else if (v === 30) {
      let s = '';
      for (let done = false; !done && i < d.length; ) {
        const byte = d[i++];
        for (const n of [byte >> 4, byte & 15]) {
          if (n === 15) {
            done = true;
            break;
          }
          s += n < 10 ? String(n) : ['.', 'E', 'E-', '', '-'][n - 10];
        }
      }
      ops.push(Number(s));
    } else if (v >= 32 && v <= 246) ops.push(v - 139);
    else if (v >= 247 && v <= 250) ops.push((v - 247) * 256 + d[i++] + 108);
    else if (v >= 251 && v <= 254) ops.push(-(v - 251) * 256 - d[i++] - 108);
  }
  return out;
}

/** Width operand of a Type 2 charstring (null: the default width). */
function type2Width(cs: Uint8Array, local: Uint8Array[], global: Uint8Array[]): number | null {
  const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
  const stack: number[] = [];
  // Subroutines may hold the hints that come first; they are followed until the first stack-clearing operator.
  const run = (s: Uint8Array, depth: number): number | null | undefined => {
    for (let i = 0; i < s.length; ) {
      const v = s[i++];
      if (v >= 32 || v === 28) {
        const val = v === 28 ? ((s[i] << 24) >> 16) | s[i + 1] : v <= 246 ? v - 139 : v <= 250 ? (v - 247) * 256 + s[i] + 108 : v <= 254 ? -(v - 251) * 256 - s[i] - 108 : ((s[i] << 24) | (s[i + 1] << 16) | (s[i + 2] << 8) | s[i + 3]) / 65536;
        i += v === 28 ? 2 : v >= 247 && v <= 254 ? 1 : v === 255 ? 4 : 0;
        stack.push(val);
        continue;
      }
      const n = stack.length;
      if (v === 10 || v === 29) {
        const subrs = v === 10 ? local : global;
        const sub = subrs[stack.pop()! + bias(subrs.length)];
        if (!sub || depth > 10) return null;
        const r = run(sub, depth + 1);
        if (r !== undefined) return r;
        continue;
      }
      if (v === 11) return undefined; // return from a subroutine
      // The first stack-clearing operator: an extra (first) operand is the width.
      if ([1, 3, 18, 19, 20, 23].includes(v)) return n % 2 ? stack[0] : null;
      if (v === 21) return n > 2 ? stack[0] : null;
      if (v === 4 || v === 22) return n > 1 ? stack[0] : null;
      if (v === 14) return n === 1 || n === 5 ? stack[0] : null;
      return null;
    }
    return undefined;
  };
  return run(cs, 0) ?? null;
}

export function readCff(b: Uint8Array): CffProgram | null {
  try {
    if (b[0] !== 1) return null;
    const names = cffIndex(b, b[2]);
    const top = cffIndex(b, names.end);
    const strings = cffIndex(b, top.end);
    const globalSubrs = cffIndex(b, strings.end).items;
    const dict = cffDict(top.items[0]);
    const str = (sid: number) => (sid < CFF_STANDARD_STRINGS.length ? CFF_STANDARD_STRINGS[sid] : latin1(strings.items[sid - CFF_STANDARD_STRINGS.length] ?? new Uint8Array()));
    const charStrings = cffIndex(b, dict.get(17)![0]).items;
    const [privSize, privOff] = dict.get(18) ?? [0, 0];
    const priv = cffDict(b.subarray(privOff, privOff + privSize));
    const dflt = priv.get(20)?.[0] ?? 0;
    const nominal = priv.get(21)?.[0] ?? 0;
    const localSubrs = priv.has(19) ? cffIndex(b, privOff + priv.get(19)![0]).items : [];
    // charset: glyph id -> name.
    const glyphNames = ['.notdef'];
    const cs = dict.get(15)?.[0] ?? 0;
    if (cs === 0) for (let g = 1; g < charStrings.length; g++) glyphNames.push(str(g));
    else {
      const format = b[cs];
      let p = cs + 1;
      while (glyphNames.length < charStrings.length) {
        if (format === 0) {
          glyphNames.push(str((b[p] << 8) | b[p + 1]));
          p += 2;
        } else {
          const sid = (b[p] << 8) | b[p + 1];
          const left = format === 1 ? b[p + 2] : (b[p + 2] << 8) | b[p + 3];
          p += format === 1 ? 3 : 4;
          for (let k = 0; k <= left && glyphNames.length < charStrings.length; k++) glyphNames.push(str(sid + k));
        }
      }
    }
    const widths = new Map<string, number>();
    charStrings.forEach((c, g) => {
      const w = type2Width(c, localSubrs, globalSubrs);
      widths.set(glyphNames[g], w === null ? dflt : w + nominal);
    });
    // Built-in encoding.
    const encOff = dict.get(16)?.[0] ?? 0;
    let encoding = new Array<string>(256).fill('');
    if (encOff === 0) encoding = ENCODINGS.StandardEncoding.slice();
    else if (encOff > 1) {
      const format = b[encOff];
      let p = encOff + 1;
      if ((format & 0x7f) === 0) {
        const n = b[p++];
        for (let g = 1; g <= n; g++) encoding[b[p++]] = glyphNames[g];
      } else {
        const n = b[p++];
        let g = 1;
        for (let r = 0; r < n; r++) {
          const firstCode = b[p++];
          const left = b[p++];
          for (let k = 0; k <= left; k++) encoding[firstCode + k] = glyphNames[g++];
        }
      }
      if (format & 0x80) {
        const n = b[p++];
        for (let k = 0; k < n; k++) {
          encoding[b[p]] = str((b[p + 1] << 8) | b[p + 2]);
          p += 3;
        }
      }
    }
    return {
      bytes: b,
      fontName: latin1(names.items[0] ?? new Uint8Array()) || 'Unknown',
      bbox: dict.get(5) ?? [0, -200, 1000, 900],
      italicAngle: dict.get(1202)?.[0] ?? 0,
      widths,
      encoding,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- TrueType widths

/** Sets advance widths (font units) of glyphs in a TrueType copy; returns the glyphs that share the last metric (not set). */
function setAdvances(ttf: Uint8Array, advances: Map<number, number>): Set<number> {
  const tables = sfntTables(ttf);
  const hhea = tables?.get('hhea');
  const hmtx = tables?.get('hmtx');
  const failed = new Set<number>();
  if (!hhea || !hmtx) return new Set(advances.keys());
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const nMetrics = dv.getUint16(hhea.off + 34);
  let max = dv.getUint16(hhea.off + 10);
  for (const [gid, adv] of advances) {
    if (gid >= nMetrics || adv < 0 || adv > 0xffff) {
      failed.add(gid);
      continue;
    }
    dv.setUint16(hmtx.off + gid * 4, adv);
    max = Math.max(max, adv);
  }
  dv.setUint16(hhea.off + 10, max);
  return failed;
}

// ---------------------------------------------------------------- the fonts

interface Target {
  dict: PDFDict;
  base: string;
}

function unembeddedSimpleFonts(doc: PDFDocument): { simple: Target[]; other: string[] } {
  const simple: Target[] = [];
  const other: string[] = [];
  const seen = new Set<PDFDict>();
  const visit = (d: PDFDict) => {
    if (seen.has(d) || nameOf(d.get(PDFName.of('Type'))) !== 'Font') return;
    seen.add(d);
    const sub = nameOf(d.get(PDFName.of('Subtype')));
    const fd = d.lookup(PDFName.of('FontDescriptor'));
    const has = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    const base = nameOf(d.get(PDFName.of('BaseFont'))) ?? 'unnamed font';
    if (sub === 'Type1' || sub === 'MMType1' || sub === 'TrueType') {
      if (!has) simple.push({ dict: d, base });
    } else if (sub === 'CIDFontType0' || sub === 'CIDFontType2') {
      if (!has) other.push(base);
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) visit(obj);
    // Fonts written directly in a resource dictionary.
    if (obj instanceof PDFDict || obj instanceof PDFStream) {
      const d = obj instanceof PDFStream ? obj.dict : obj;
      const res = d.lookup(PDFName.of('Resources'));
      const fonts = res instanceof PDFDict ? res.lookup(PDFName.of('Font')) : d.lookup(PDFName.of('Font'));
      if (fonts instanceof PDFDict) for (const [, f] of fonts.entries()) if (f instanceof PDFDict) visit(f);
    }
  }
  return { simple, other };
}

/** Code -> glyph name of a simple font (its /Encoding over the base encoding). */
function encodingOf(doc: PDFDocument, dict: PDFDict, fallback: string[]): { names: string[]; base: string | null; differences: boolean } {
  const enc = dict.lookup(PDFName.of('Encoding'));
  let base: string | null = null;
  let names = fallback.slice();
  let differences = false;
  const baseName = enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFDict ? nameOf(enc.lookup(PDFName.of('BaseEncoding'))) : undefined;
  if (baseName && ENCODINGS[baseName]) {
    base = baseName;
    names = ENCODINGS[baseName].slice();
  }
  if (enc instanceof PDFDict) {
    const diffs = enc.lookup(PDFName.of('Differences'));
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const v of diffs.asArray()) {
        const x = v instanceof PDFRef ? doc.context.lookup(v) : v;
        if (x instanceof PDFNumber) code = x.asNumber();
        else if (x instanceof PDFName && code < 256) {
          names[code++] = x.decodeText();
          differences = true;
        }
      }
    }
  }
  return { names, base, differences };
}

/** The widths the font dictionary gives (code -> width), if any. */
function dictWidths(dict: PDFDict): Map<number, number> | null {
  const first = num(dict.lookup(PDFName.of('FirstChar')));
  const w = dict.lookup(PDFName.of('Widths'));
  if (first === undefined || !(w instanceof PDFArray)) return null;
  const out = new Map<number, number>();
  w.asArray().forEach((v, i) => {
    const n = num(v instanceof PDFRef ? undefined : v) ?? 0;
    out.set(first + i, n);
  });
  return out;
}

async function installedTrueType(src: PdfAFontSources, base: string, bold: boolean, italic: boolean, serif: boolean, mono: boolean): Promise<{ bytes: Uint8Array; label: string } | null> {
  if (!src.installed || !src.readInstalled) return null;
  const fonts = await src.installed().catch(() => []);
  for (const f of matchInstalled(fonts, { baseName: base, bold, italic, serif, mono, capHeight: 0, xHeight: 0 }).slice(0, 4)) {
    if (!embeddingAllowed(f.fsType)) continue;
    try {
      const bytes = fontFromCollection(await src.readInstalled(f.path), f.index);
      const p = readFontProgram(bytes);
      if (p?.kind === 'truetype' && embeddingAllowed(p.fsType) && p.hasCmap(3, 1)) return { bytes: bytes.slice(), label: f.fullName || f.family };
    } catch {
      /* next */
    }
  }
  return null;
}

/** Embeds a font program for every simple font that has none. */
export async function embedMissingFonts(doc: PDFDocument, src: PdfAFontSources): Promise<FontEmbedReport> {
  const report: FontEmbedReport = { embedded: [], failed: [], notes: [] };
  const { simple, other } = unembeddedSimpleFonts(doc);
  report.failed.push(...other);
  const ctx = doc.context;
  let adjusted = 0;
  for (const { dict, base } of simple) {
    const parsed = parseBaseName(base);
    const fd = dict.lookup(PDFName.of('FontDescriptor'));
    const flags = fd instanceof PDFDict ? (num(fd.lookup(PDFName.of('Flags'))) ?? 0) : 0;
    const std = standardFamily(parsed.family);
    const bold = parsed.bold || (fd instanceof PDFDict && (num(fd.lookup(PDFName.of('FontWeight'))) ?? 400) >= 600);
    const italic = parsed.italic || !!(flags & FLAG_ITALIC);
    const serif = std === 'times' || !!(flags & FLAG_SERIF);
    const mono = std === 'courier' || !!(flags & FLAG_FIXED);
    const symbolic = std === 'symbol' || std === 'dingbats' || (!!(flags & FLAG_SYMBOLIC) && !(flags & FLAG_NONSYMBOLIC));
    const afm = std ? afmFont(std, bold, italic) : null;
    const origWidths = dictWidths(dict);
    const cleanName = base.replace(/^[A-Z]{6}\+/, '').replace(/[,\s]/g, '-');

    // ---- TrueType: installed font, Liberation Sans, or Liberation Sans on the original widths.
    let ttf: { bytes: Uint8Array; label: string } | null = null;
    if (!symbolic) {
      ttf = await installedTrueType(src, base, bold, italic, serif, mono);
      if (!ttf && (std === 'helvetica' || (!std && origWidths))) {
        const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
        const b = await src.standardFont(`LiberationSans-${style}.ttf`);
        if (b) ttf = { bytes: b.slice(), label: 'Liberation Sans' };
      }
    }
    if (ttf) {
      const program = readFontProgram(ttf.bytes);
      if (!program) {
        report.failed.push(base);
        continue;
      }
      const { names, base: encBase, differences } = encodingOf(doc, dict, ENCODINGS.StandardEncoding);
      const upem = program.unitsPerEm;
      const codes: number[] = [];
      const gidOf = new Map<number, number>();
      for (let c = 0; c < 256; c++) {
        const n = names[c];
        if (!n) continue;
        const uni = glyphNameToUnicode(n);
        const g = (uni ? program.gidForUnicode(uni.codePointAt(0)!) : 0) || program.gidForName(n);
        if (g > 0) {
          gidOf.set(c, g);
          codes.push(c);
        }
      }
      if (!codes.length) {
        report.failed.push(base);
        continue;
      }
      const first = origWidths ? Math.min(...origWidths.keys()) : Math.min(...codes);
      const last = origWidths ? Math.max(...origWidths.keys()) : Math.max(...codes);
      const widths: number[] = [];
      const advances = new Map<number, number>();
      for (let c = first; c <= last; c++) {
        const g = gidOf.get(c);
        const own = g ? (program.advance(g) * 1000) / upem : 0;
        let w = origWidths?.get(c) ?? (afm && names[c] ? afm.getWidthOfGlyph(names[c]) : undefined) ?? own;
        if (g) {
          const adv = Math.round((w * upem) / 1000);
          // One glyph, two codes with different widths: the first wins, the dictionary follows the program.
          if (advances.has(g) && advances.get(g) !== adv) w = (advances.get(g)! * 1000) / upem;
          else advances.set(g, adv);
        }
        widths.push(Math.round(w * 1000) / 1000);
      }
      const failed = setAdvances(ttf.bytes, advances);
      for (const g of failed) {
        // A glyph that shares the last metric keeps its own width.
        for (let c = first; c <= last; c++) if (gidOf.get(c) === g) widths[c - first] = Math.round((program.advance(g) * 1000) / upem);
        adjusted++;
      }
      let bytes = ttf.bytes;
      try {
        bytes = pruneTrueType(ttf.bytes, new Set(gidOf.values()));
      } catch {
        /* whole font */
      }
      // Non-symbolic TrueType: WinAnsi or MacRoman base encoding, other codes through /Differences.
      let encoding: PDFObject;
      if (encBase === 'WinAnsiEncoding' || encBase === 'MacRomanEncoding') encoding = differences ? (dict.get(PDFName.of('Encoding')) as PDFObject) : PDFName.of(encBase);
      else {
        const win = ENCODINGS.WinAnsiEncoding;
        const diffs: PDFObject[] = [];
        let prev = -2;
        for (let c = 0; c < 256; c++) {
          if (!names[c] || names[c] === win[c]) continue;
          if (c !== prev + 1) diffs.push(PDFNumber.of(c));
          diffs.push(PDFName.of(names[c]));
          prev = c;
        }
        encoding = diffs.length ? ctx.obj({ Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: diffs }) : PDFName.of('WinAnsiEncoding');
      }
      const tables = sfntTables(bytes)!;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const head = tables.get('head')!;
      const hhea = tables.get('hhea');
      const post = tables.get('post');
      const s = (v: number) => Math.round((v * 1000) / upem);
      const bbox = [dv.getInt16(head.off + 36), dv.getInt16(head.off + 38), dv.getInt16(head.off + 40), dv.getInt16(head.off + 42)].map(s);
      const italicAngle = post ? dv.getInt32(post.off + 4) / 65536 : 0;
      const file = ctx.flateStream(bytes, { Length1: bytes.length });
      const descriptor = ctx.obj({
        Type: 'FontDescriptor',
        FontName: cleanName,
        Flags: FLAG_NONSYMBOLIC | (serif ? FLAG_SERIF : 0) | (mono ? FLAG_FIXED : 0) | (italic ? FLAG_ITALIC : 0),
        FontBBox: bbox,
        ItalicAngle: italicAngle,
        Ascent: hhea ? s(dv.getInt16(hhea.off + 4)) : bbox[3],
        Descent: hhea ? s(dv.getInt16(hhea.off + 6)) : bbox[1],
        CapHeight: Math.round((program.capHeight || 0.7) * 1000),
        StemV: bold ? 140 : 80,
        FontFile2: ctx.register(file),
      });
      dict.set(PDFName.of('Subtype'), PDFName.of('TrueType'));
      dict.set(PDFName.of('BaseFont'), PDFName.of(cleanName));
      dict.set(PDFName.of('FirstChar'), PDFNumber.of(first));
      dict.set(PDFName.of('LastChar'), PDFNumber.of(last));
      dict.set(PDFName.of('Widths'), ctx.obj(widths));
      dict.set(PDFName.of('Encoding'), encoding);
      dict.set(PDFName.of('FontDescriptor'), ctx.register(descriptor));
      report.embedded.push({ font: base, with: ttf.label });
      continue;
    }

    // ---- Type 1: the Foxit fonts for the standard families.
    const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : '';
    const file =
      std === 'times' ? `FoxitSerif${style}.pfb` : std === 'courier' ? `FoxitFixed${style}.pfb` : std === 'symbol' ? 'FoxitSymbol.pfb' : std === 'dingbats' ? 'FoxitDingbats.pfb' : null;
    const pfb = file ? await src.standardFont(file) : null;
    const t1 = pfb ? readCff(pfb) : null;
    if (!t1 || !t1.widths.size) {
      report.failed.push(base);
      continue;
    }
    // Symbol / ZapfDingbats codes mean their own encodings; the replacement's built-in one may differ.
    const builtIn = std === 'symbol' || std === 'dingbats' ? fontSpecificEncoding(std) : symbolic ? t1.encoding : ENCODINGS.StandardEncoding;
    const { names } = encodingOf(doc, dict, builtIn);
    if ((std === 'symbol' || std === 'dingbats') && !dict.has(PDFName.of('Encoding'))) {
      const diffs: PDFObject[] = [];
      let prev = -2;
      for (let c = 0; c < 256; c++) {
        if (!names[c] || t1.encoding[c] === names[c] || !t1.widths.has(names[c])) continue;
        if (c !== prev + 1) diffs.push(PDFNumber.of(c));
        diffs.push(PDFName.of(names[c]));
        prev = c;
      }
      if (diffs.length) dict.set(PDFName.of('Encoding'), ctx.obj({ Type: 'Encoding', Differences: diffs }));
    }
    const codes = [...names.keys()].filter((c) => names[c] && t1.widths.has(names[c]));
    const first = origWidths ? Math.min(...origWidths.keys()) : Math.min(...codes);
    const last = origWidths ? Math.max(...origWidths.keys()) : Math.max(...codes);
    const widths: number[] = [];
    for (let c = first; c <= last; c++) {
      const own = names[c] ? t1.widths.get(names[c]) : undefined;
      const orig = origWidths?.get(c) ?? (afm && names[c] ? afm.getWidthOfGlyph(names[c]) : undefined);
      if (own === undefined) widths.push(orig ?? 0);
      else if (orig !== undefined && Math.abs(orig - own) <= 1) widths.push(orig);
      else {
        if (orig !== undefined) adjusted++;
        widths.push(own);
      }
    }
    const stream = ctx.flateStream(t1.bytes, { Subtype: 'Type1C' });
    const descriptor = ctx.obj({
      Type: 'FontDescriptor',
      FontName: cleanName,
      Flags: symbolic ? FLAG_SYMBOLIC : FLAG_NONSYMBOLIC | (serif ? FLAG_SERIF : 0) | (mono ? FLAG_FIXED : 0) | (italic ? FLAG_ITALIC : 0),
      FontBBox: t1.bbox,
      ItalicAngle: t1.italicAngle,
      Ascent: afm?.Ascender ?? t1.bbox[3],
      Descent: afm?.Descender ?? t1.bbox[1],
      CapHeight: afm?.CapHeight ?? Math.round(t1.bbox[3] * 0.75),
      StemV: bold ? 140 : 80,
      FontFile3: ctx.register(stream),
    });
    dict.set(PDFName.of('Subtype'), PDFName.of('Type1'));
    dict.set(PDFName.of('BaseFont'), PDFName.of(cleanName));
    dict.set(PDFName.of('FirstChar'), PDFNumber.of(first));
    dict.set(PDFName.of('LastChar'), PDFNumber.of(last));
    dict.set(PDFName.of('Widths'), ctx.obj(widths));
    dict.set(PDFName.of('FontDescriptor'), ctx.register(descriptor));
    report.embedded.push({ font: base, with: t1.fontName });
  }
  if (adjusted) report.notes.push(`${adjusted} glyph width(s) follow the embedded font where the original differed.`);
  return report;
}
