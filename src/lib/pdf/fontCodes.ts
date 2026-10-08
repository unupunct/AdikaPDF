/**
 * Codes for letters a page does not draw yet, in the document's own font.
 *
 * A subset font holds only some glyphs, and a page draws only some of those.
 * For a letter of edited text this finds, in order:
 * - a code the font already maps to the letter (ToUnicode / encoding) whose
 *   glyph really is in the embedded program (an outline, not an empty slot),
 *   or that the viewer supplies (non-embedded standard fonts);
 * - a glyph the program has but no code reaches: a free code is added to the
 *   encoding (/Differences, /Widths and ToUnicode for simple fonts; ToUnicode
 *   and /W for Identity-H TrueType CID fonts).
 * Anything else is left to a fallback font (`fontFallback.ts`).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { Font as StdFont } from '@pdf-lib/standard-fonts';
import { STD_ALIASES, glyphNameToUnicode, glyphNamesFor, parseToUnicode, standardMaps, streamBytes, writeToUnicode } from './fontEncoding';
import { readFontProgram, type FontProgram } from './fontProgram';
import type { FontInfo } from './textRemoval';

export interface CodeChoice {
  /** The code as written in a string (1 or 2 bytes). */
  bytes: number[];
  /** Advance width per unit font size. */
  width: number;
  /** The code was added to the font's encoding for this letter. */
  added: boolean;
}

/** What a fallback font should look like. */
export interface FontStyle {
  /** BaseFont without the subset prefix. */
  baseName: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** Cap height and x-height as a fraction of the em (0 = unknown). */
  capHeight: number;
  xHeight: number;
}

const FLAG_FIXED = 1;
const FLAG_SERIF = 2;
const FLAG_SYMBOLIC = 4;
const FLAG_ITALIC = 64;
const FLAG_FORCE_BOLD = 1 << 18;

function num(v: unknown, dflt = 0): number {
  return v instanceof PDFNumber ? v.asNumber() : dflt;
}

const cache = new WeakMap<PDFDict, FontCodes>();

/** The code finder of a font (shared by every page that uses the same font dictionary). */
export function fontCodes(doc: PDFDocument, info: FontInfo): FontCodes | null {
  if (!info.dict || !info.ok) return null;
  let c = cache.get(info.dict);
  if (!c) {
    c = new FontCodes(doc, info.dict, info);
    cache.set(info.dict, c);
  }
  return c;
}

export class FontCodes {
  private readonly chosen = new Map<string, CodeChoice | null>();
  private readonly subtype: string;
  private readonly descendant: PDFDict | null;
  private readonly descriptor: PDFDict | null;
  private programRead = false;
  private programCache: FontProgram | null = null;
  private readonly diffNames = new Map<number, string>();
  /** Codes added here (simple fonts) or CIDs (Type0) -> their width in em. */
  private readonly addedWidths = new Map<number, number>();

  // Plain fields (no parameter properties): E2E loads this file with Node's type stripping.
  private readonly doc: PDFDocument;
  private readonly dict: PDFDict;
  private readonly info: FontInfo;

  constructor(doc: PDFDocument, dict: PDFDict, info: FontInfo) {
    this.doc = doc;
    this.dict = dict;
    this.info = info;
    const st = dict.lookup(PDFName.of('Subtype'));
    this.subtype = st instanceof PDFName ? st.decodeText() : '';
    const descs = dict.lookup(PDFName.of('DescendantFonts'));
    const desc = descs instanceof PDFArray ? descs.lookup(0) : null;
    this.descendant = desc instanceof PDFDict ? desc : null;
    const fd = (this.descendant ?? dict).lookup(PDFName.of('FontDescriptor'));
    this.descriptor = fd instanceof PDFDict ? fd : null;
    const enc = dict.lookup(PDFName.of('Encoding'));
    const diffs = enc instanceof PDFDict ? enc.lookup(PDFName.of('Differences')) : undefined;
    if (diffs instanceof PDFArray) {
      let c = 0;
      for (let k = 0; k < diffs.size(); k++) {
        const v = diffs.lookup(k);
        if (v instanceof PDFNumber) c = v.asNumber();
        else if (v instanceof PDFName) this.diffNames.set(c++, v.decodeText());
      }
    }
  }

  /** A code drawing `ch` in this font, adding one when the program has the glyph; null when it has not. */
  codeFor(ch: string): CodeChoice | null {
    if (this.chosen.has(ch)) return this.chosen.get(ch)!;
    let r: CodeChoice | null = null;
    try {
      r = this.info.twoByte ? this.cidCode(ch) : this.simpleCode(ch);
    } catch {
      r = null;
    }
    this.chosen.set(ch, r);
    return r;
  }

  style(): FontStyle {
    const fd = this.descriptor;
    const flags = fd ? num(fd.lookup(PDFName.of('Flags'))) : 0;
    const name = this.info.baseName;
    const weight = fd ? num(fd.lookup(PDFName.of('FontWeight'))) : 0;
    const angle = fd ? num(fd.lookup(PDFName.of('ItalicAngle'))) : 0;
    const bold = !!(flags & FLAG_FORCE_BOLD) || weight >= 600 || /bold|black|heavy|semibold|demi/i.test(name);
    const italic = !!(flags & FLAG_ITALIC) || Math.abs(angle) > 0.5 || /italic|oblique|kursiv/i.test(name);
    const mono = !!(flags & FLAG_FIXED) || /mono|courier|consol|typewriter|fixed/i.test(name);
    const serif = !mono && !/sans/i.test(name) && (!!(flags & FLAG_SERIF) || /times|roman|serif|georgia|garamond|cambria|minion|palatino|baskerville|century|bookman/i.test(name));
    const std = this.stdMetrics();
    const fromDesc = (key: string) => {
      const v = fd ? num(fd.lookup(PDFName.of(key))) : 0;
      return this.subtype === 'Type3' ? 0 : v / 1000;
    };
    const prog = this.program();
    const capHeight = fromDesc('CapHeight') || prog?.capHeight || (std && typeof std.CapHeight === 'number' ? std.CapHeight / 1000 : 0);
    const xHeight = fromDesc('XHeight') || prog?.xHeight || (std && typeof std.XHeight === 'number' ? std.XHeight / 1000 : 0);
    return { baseName: name, bold, italic, serif, mono, capHeight, xHeight };
  }

  // ---------------------------------------------------------------- helpers

  private program(): FontProgram | null {
    if (this.programRead) return this.programCache;
    this.programRead = true;
    const fd = this.descriptor;
    if (!fd) return null;
    const ff2 = fd.get(PDFName.of('FontFile2'));
    const ff3 = fd.get(PDFName.of('FontFile3'));
    const bytes = streamBytes(this.doc, ff2 ?? ff3);
    this.programCache = bytes ? readFontProgram(bytes) : null;
    return this.programCache;
  }

  private embedded(): boolean {
    const fd = this.descriptor;
    return !!fd && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
  }

  private stdMetrics(): StdFont | null {
    if (this.embedded() || this.subtype === 'Type3' || this.info.twoByte) return null;
    const std = STD_ALIASES[this.info.baseName.toLowerCase().replace(/\s+/g, '')];
    return std ? StdFont.load(std) : null;
  }

  private charSet(): Set<string> | null {
    const cs = this.descriptor?.lookup(PDFName.of('CharSet'));
    const text = cs instanceof PDFString || cs instanceof PDFHexString ? cs.decodeText() : null;
    return text ? new Set(text.split('/').filter(Boolean)) : null;
  }

  private symbolic(): boolean {
    return !!(num(this.descriptor?.lookup(PDFName.of('Flags'))) & FLAG_SYMBOLIC);
  }

  private toUnicode(): Map<number, string> | null {
    const b = streamBytes(this.doc, this.dict.get(PDFName.of('ToUnicode')));
    return b ? parseToUnicode(new TextDecoder('latin1').decode(b)) : null;
  }

  private setToUnicode(map: Map<number, string>): void {
    const stream = this.doc.context.flateStream(writeToUnicode(map, this.info.twoByte));
    this.dict.set(PDFName.of('ToUnicode'), this.doc.context.register(stream));
  }

  private nameOfCode(code: number): string {
    return this.diffNames.get(code) ?? standardMaps().codeToName.get(code) ?? '';
  }

  /** Glyph id a viewer picks for a simple TrueType font's code (as pdf.js does). */
  private trueTypeGid(p: FontProgram, code: number): number {
    const name = this.nameOfCode(code);
    if (!this.symbolic() && p.hasCmap(3, 1) && name) {
      const u = glyphNameToUnicode(name);
      const g = u ? p.lookup(3, 1, u.codePointAt(0)!) : 0;
      if (g) return g;
    }
    if (p.hasCmap(3, 0)) {
      const g = p.lookup(3, 0, code) || p.lookup(3, 0, 0xf000 + code);
      if (g) return g;
    }
    if (p.hasCmap(1, 0)) {
      const g = p.lookup(1, 0, code);
      if (g) return g;
    }
    return name ? p.gidForName(name) : 0;
  }

  /** The glyph a simple font's code draws exists (in the program, the CharSet, the CharProcs or the viewer's font). */
  private simpleGlyphExists(code: number): boolean {
    if (this.subtype === 'Type3') {
      const procs = this.dict.lookup(PDFName.of('CharProcs'));
      const name = this.nameOfCode(code);
      return !!name && procs instanceof PDFDict && procs.has(PDFName.of(name));
    }
    if (!this.embedded()) return true;
    const p = this.program();
    if (p?.kind === 'truetype') return p.hasOutline(this.trueTypeGid(p, code));
    const name = this.nameOfCode(code);
    if (p?.kind === 'cff') return !!name && p.hasOutline(p.gidForName(name));
    return !!name && !!this.charSet()?.has(name);
  }

  private simpleCode(ch: string): CodeChoice | null {
    for (let code = 0; code < 256; code++) {
      if (this.info.unicode(code) !== ch) continue;
      const w = this.addedWidths.get(code) ?? this.info.width(code);
      if (w > 0 && this.simpleGlyphExists(code)) return { bytes: [code], width: w, added: false };
    }
    return this.addSimple(ch);
  }

  /** Writes a free code for `ch` into the encoding when the font has the glyph. */
  private addSimple(ch: string): CodeChoice | null {
    if (this.subtype === 'Type3' || [...ch].length !== 1) return null;
    const cp = ch.codePointAt(0)!;
    const names = glyphNamesFor(ch);
    let name = '';
    let width = 0; // glyph space (1/1000 em)
    const std = this.stdMetrics();
    if (std) {
      // Width from the font's metrics under any of the letter's names; the name written is one that reads as the letter.
      const w = names.map((n) => std.getWidthOfGlyph(n)).find((v) => typeof v === 'number');
      if (typeof w !== 'number') return null;
      width = w;
      name = names.find((n) => glyphNameToUnicode(n) === ch) ?? '';
    } else if (this.embedded()) {
      const p = this.program();
      if (!p || (p.kind === 'truetype' && this.symbolic())) return null;
      const gid = p.gidForUnicode(cp) || names.map((n) => p.gidForName(n)).find((g) => g > 0) || 0;
      if (!gid || !p.hasOutline(gid)) return null;
      const own = p.nameOf(gid);
      // A name viewers resolve to this glyph: the program's own (CFF charset), or one reading as the letter (TrueType goes name -> Unicode -> cmap).
      name = p.kind === 'cff' && own ? own : own && glyphNameToUnicode(own) === ch ? own : (names.find((n) => glyphNameToUnicode(n) === ch) ?? '');
      if (p.kind === 'truetype' && (!p.hasCmap(3, 1) || p.lookup(3, 1, cp) !== gid) && p.gidForName(name) !== gid) return null;
      width = (p.advance(gid) * 1000) / p.unitsPerEm;
    }
    if (!name || !(width > 0)) return null;
    // A name that does not read as the letter (e.g. Tcommaaccent is Ţ for text extraction) needs a ToUnicode entry.
    if (glyphNameToUnicode(name) !== ch && !this.dict.has(PDFName.of('ToUnicode'))) return null;
    const code = this.freeCode();
    if (code === null) return null;

    const ctx = this.doc.context;
    // Encoding: a private copy with the new /Differences entry (others may share the original).
    const enc = this.dict.lookup(PDFName.of('Encoding'));
    const encDict = enc instanceof PDFDict ? enc.clone(ctx) : ctx.obj({ Type: 'Encoding' });
    if (enc instanceof PDFName) encDict.set(PDFName.of('BaseEncoding'), enc);
    const diffs = encDict.lookup(PDFName.of('Differences'));
    const newDiffs = diffs instanceof PDFArray ? diffs.clone(ctx) : ctx.obj([]);
    newDiffs.push(PDFNumber.of(code));
    newDiffs.push(PDFName.of(name));
    encDict.set(PDFName.of('Differences'), newDiffs);
    this.dict.set(PDFName.of('Encoding'), encDict);
    this.diffNames.set(code, name);
    // Widths (fonts that have them): a private copy covering the code.
    const widths = this.dict.lookup(PDFName.of('Widths'));
    if (widths instanceof PDFArray) {
      const first = num(this.dict.lookup(PDFName.of('FirstChar')));
      const last = num(this.dict.lookup(PDFName.of('LastChar')), first + widths.size() - 1);
      const missing = num(this.descriptor?.lookup(PDFName.of('MissingWidth')));
      const lo = Math.min(first, code);
      const hi = Math.max(last, code);
      const arr: number[] = [];
      for (let c = lo; c <= hi; c++) arr.push(c === code ? Math.round(width * 1000) / 1000 : c >= first && c <= last ? num(widths.lookup(c - first), missing) : missing);
      this.dict.set(PDFName.of('Widths'), ctx.obj(arr));
      this.dict.set(PDFName.of('FirstChar'), PDFNumber.of(lo));
      this.dict.set(PDFName.of('LastChar'), PDFNumber.of(hi));
    }
    const tu = this.toUnicode();
    if (tu) {
      tu.set(code, ch);
      this.setToUnicode(tu);
    }
    this.addedWidths.set(code, width / 1000);
    return { bytes: [code], width: width / 1000, added: true };
  }

  /** A code no glyph of the font uses: zero width (or outside FirstChar..LastChar), no name, no Unicode. Never the space (word spacing applies to it). */
  private freeCode(): number | null {
    const tu = this.toUnicode();
    const widths = this.dict.lookup(PDFName.of('Widths'));
    const first = num(this.dict.lookup(PDFName.of('FirstChar')));
    const usable = (c: number) => c !== 32 && !this.diffNames.has(c) && !tu?.has(c) && !this.addedWidths.has(c);
    if (widths instanceof PDFArray) {
      const last = first + widths.size() - 1;
      for (let c = Math.max(1, first); c <= last; c++) if (usable(c) && num(widths.lookup(c - first)) === 0 && !(c >= 33 && c <= 126)) return c;
      for (let c = last + 1; c < 256; c++) if (usable(c)) return c;
      for (let c = first - 1; c >= 1; c--) if (usable(c)) return c;
      return null;
    }
    // Standard fonts without /Widths: codes the base encoding leaves empty.
    const { codeToName } = standardMaps();
    for (let c = 1; c < 256; c++) if (usable(c) && !codeToName.has(c)) return c;
    return null;
  }

  private cidToGid(): ((cid: number) => number) | null {
    const m = this.descendant?.lookup(PDFName.of('CIDToGIDMap'));
    if (!m || (m instanceof PDFName && m.decodeText() === 'Identity')) return (c) => c;
    const b = streamBytes(this.doc, this.descendant!.get(PDFName.of('CIDToGIDMap')));
    if (!b) return null;
    return (c) => (c * 2 + 1 < b.length ? (b[c * 2] << 8) | b[c * 2 + 1] : 0);
  }

  private cidCode(ch: string): CodeChoice | null {
    const tu = this.toUnicode();
    if (!tu) return null;
    const p = this.program();
    const cff = this.descendant?.lookup(PDFName.of('Subtype')) === PDFName.of('CIDFontType0');
    const toGid = this.cidToGid();
    const exists = (cid: number) => {
      if (!p) return true; // no readable program: the ToUnicode of a subset lists its glyphs
      if (cff) return p.hasOutline(cid);
      return !!toGid && p.hasOutline(toGid(cid));
    };
    for (const [cid, t] of tu) {
      if (t !== ch) continue;
      const w = this.addedWidths.get(cid) ?? this.info.width(cid);
      if (w > 0 && exists(cid)) return { bytes: [cid >> 8, cid & 255], width: w, added: false };
    }
    // A glyph the program has but no code reaches yet.
    if (!p || p.kind !== 'truetype' || cff || !toGid || [...ch].length !== 1) return null;
    const gid = p.gidForUnicode(ch.codePointAt(0)!);
    if (!gid || !p.hasOutline(gid)) return null;
    let cid = -1;
    if (toGid(gid) === gid) cid = gid;
    else for (let c = 0; c < 65536 && cid < 0; c++) if (toGid(c) === gid) cid = c;
    if (cid < 0 || (tu.has(cid) && tu.get(cid) !== ch)) return null;
    const width = (p.advance(gid) * 1000) / p.unitsPerEm;
    if (!(width > 0)) return null;
    tu.set(cid, ch);
    this.setToUnicode(tu);
    const ctx = this.doc.context;
    const w = this.descendant!.lookup(PDFName.of('W'));
    const newW = w instanceof PDFArray ? w.clone(ctx) : ctx.obj([]);
    newW.push(PDFNumber.of(cid));
    newW.push(ctx.obj([Math.round(width * 1000) / 1000]));
    this.descendant!.set(PDFName.of('W'), newW);
    this.addedWidths.set(cid, width / 1000);
    return { bytes: [cid >> 8, cid & 255], width: width / 1000, added: true };
  }
}

