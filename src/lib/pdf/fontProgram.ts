/**
 * Reads the glyphs of a font program embedded in a PDF (FontFile2 TrueType,
 * FontFile3 OpenType) or of an installed / bundled font: which glyphs have
 * outlines, the cmap and post glyph names, advance widths and the vertical
 * metrics used to size fallback letters. Subset fonts in PDFs often lack
 * tables (no cmap, no name), so the TrueType tables are read directly;
 * CFF-flavoured OpenType goes through fontkit.
 */
import fontkit from '@pdf-lib/fontkit';

export interface FontProgram {
  kind: 'truetype' | 'cff';
  numGlyphs: number;
  unitsPerEm: number;
  /** The glyph draws something (a subset keeps the ids of dropped glyphs, with empty outlines). */
  hasOutline: (gid: number) => boolean;
  /** Advance width in font units. */
  advance: (gid: number) => number;
  /** Glyph id of a cmap subtable entry (0 = none): `(3,1)` Unicode, `(3,0)` symbol, `(1,0)` Mac. */
  lookup: (platform: number, encoding: number, code: number) => number;
  hasCmap: (platform: number, encoding: number) => boolean;
  /** Glyph id for a Unicode code point through the best Unicode cmap (0 = none). */
  gidForUnicode: (cp: number) => number;
  gidForName: (name: string) => number;
  nameOf: (gid: number) => string;
  /** Cap height / x-height as a fraction of the em (0 = unknown). */
  capHeight: number;
  xHeight: number;
  /** OS/2 embedding permissions. */
  fsType: number;
}

interface Table {
  off: number;
  len: number;
}

/** Table directory of an sfnt (TrueType / OpenType) font. */
export function sfntTables(b: Uint8Array, dirOffset = 0): Map<string, Table> | null {
  if (b.length < dirOffset + 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(dirOffset);
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return null;
  const n = dv.getUint16(dirOffset + 4);
  const tables = new Map<string, Table>();
  for (let i = 0; i < n; i++) {
    const e = dirOffset + 12 + i * 16;
    if (e + 16 > b.length) return null;
    const tag = String.fromCharCode(b[e], b[e + 1], b[e + 2], b[e + 3]);
    const off = dv.getUint32(e + 8);
    const len = dv.getUint32(e + 12);
    if (off + len <= b.length) tables.set(tag, { off, len });
  }
  return tables;
}

/** One font of a .ttc / .otc collection as a standalone font file. */
export function fontFromCollection(b: Uint8Array, index: number): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || dv.getUint32(0) !== 0x74746366) return b; // 'ttcf'
  const count = dv.getUint32(8);
  if (index >= count) throw new Error('No such font in the collection');
  const dir = dv.getUint32(12 + index * 4);
  const tables = sfntTables(b, dir);
  if (!tables) throw new Error('Unreadable font collection');
  const order = [...tables.keys()];
  const tags = [...order].sort();
  let size = 12 + tags.length * 16;
  for (const t of tags) size += (tables.get(t)!.len + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  out.set(b.subarray(dir, dir + 12));
  ov.setUint16(4, tags.length);
  let off = 12 + tags.length * 16;
  tags.forEach((tag, i) => {
    const t = tables.get(tag)!;
    const e = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[e + k] = tag.charCodeAt(k);
    // Same checksum as in the collection's own directory entry.
    const src = dir + 12 + order.indexOf(tag) * 16;
    ov.setUint32(e + 4, dv.getUint32(src + 4));
    ov.setUint32(e + 8, off);
    ov.setUint32(e + 12, t.len);
    out.set(b.subarray(t.off, t.off + t.len), off);
    off += (t.len + 3) & ~3;
  });
  return out;
}

type Cmap = (code: number) => number;

function readCmapSubtable(dv: DataView, at: number): Cmap | null {
  const format = dv.getUint16(at);
  if (format === 0) {
    return (c) => (c >= 0 && c < 256 ? dv.getUint8(at + 6 + c) : 0);
  }
  if (format === 4) {
    const segX2 = dv.getUint16(at + 6);
    const ends = at + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (c) => {
      for (let s = 0; s < segX2; s += 2) {
        const end = dv.getUint16(ends + s);
        if (c > end) continue;
        const start = dv.getUint16(starts + s);
        if (c < start) return 0;
        const delta = dv.getInt16(deltas + s);
        const ro = dv.getUint16(ranges + s);
        if (!ro) return (c + delta) & 0xffff;
        const g = dv.getUint16(ranges + s + ro + (c - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  if (format === 6) {
    const first = dv.getUint16(at + 6);
    const count = dv.getUint16(at + 8);
    return (c) => (c >= first && c < first + count ? dv.getUint16(at + 10 + (c - first) * 2) : 0);
  }
  if (format === 12) {
    const groups = dv.getUint32(at + 12);
    return (c) => {
      for (let g = 0; g < groups; g++) {
        const e = at + 16 + g * 12;
        const s = dv.getUint32(e);
        const end = dv.getUint32(e + 4);
        if (c >= s && c <= end) return dv.getUint32(e + 8) + (c - s);
      }
      return 0;
    };
  }
  return null;
}

/** Standard Macintosh glyph order (post table format 1 / indexes < 258 of format 2). */
const MAC_NAMES =
  '.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat'.split(
    ' ',
  );

function postNames(dv: DataView, t: Table, numGlyphs: number): string[] {
  const format = dv.getUint32(t.off);
  if (format === 0x00010000) return MAC_NAMES.slice(0, numGlyphs);
  if (format !== 0x00020000 || t.len < 34) return [];
  const n = dv.getUint16(t.off + 32);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(dv.getUint16(t.off + 34 + i * 2));
  const extra: string[] = [];
  let p = t.off + 34 + n * 2;
  const end = t.off + t.len;
  while (p < end) {
    const len = dv.getUint8(p);
    let s = '';
    for (let k = 1; k <= len && p + k < end; k++) s += String.fromCharCode(dv.getUint8(p + k));
    extra.push(s);
    p += len + 1;
  }
  return idx.map((i) => (i < 258 ? MAC_NAMES[i] : (extra[i - 258] ?? '')));
}

function trueTypeProgram(b: Uint8Array, tables: Map<string, Table>): FontProgram | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp || !loca || !glyf) return null;
  const unitsPerEm = dv.getUint16(head.off + 18) || 1000;
  const longLoca = dv.getInt16(head.off + 50) === 1;
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const locaAt = (g: number) => {
    const o = longLoca ? loca.off + g * 4 : loca.off + g * 2;
    if (o + (longLoca ? 4 : 2) > loca.off + loca.len) return 0;
    return longLoca ? dv.getUint32(o) : dv.getUint16(o) * 2;
  };
  const hasOutline = (g: number): boolean => {
    if (g <= 0 || g >= numGlyphs) return false;
    const a = locaAt(g);
    const len = locaAt(g + 1) - a;
    if (len < 10) return false;
    const contours = dv.getInt16(glyf.off + a);
    return contours !== 0;
  };
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const numH = hhea ? dv.getUint16(hhea.off + 34) : 0;
  const advance = (g: number) => {
    if (!hmtx || !numH) return 0;
    const i = Math.min(g, numH - 1);
    return i * 4 + 2 <= hmtx.len ? dv.getUint16(hmtx.off + i * 4) : 0;
  };
  const subtables = new Map<string, Cmap>();
  const cmap = tables.get('cmap');
  if (cmap) {
    const n = dv.getUint16(cmap.off + 2);
    for (let i = 0; i < n; i++) {
      const e = cmap.off + 4 + i * 8;
      const key = `${dv.getUint16(e)},${dv.getUint16(e + 2)}`;
      if (subtables.has(key)) continue;
      try {
        const st = readCmapSubtable(dv, cmap.off + dv.getUint32(e + 4));
        if (st) subtables.set(key, st);
      } catch {
        /* damaged subtable */
      }
    }
  }
  const lookup = (p: number, e: number, c: number) => {
    try {
      return subtables.get(`${p},${e}`)?.(c) ?? 0;
    } catch {
      return 0;
    }
  };
  const gidForUnicode = (cp: number) => lookup(3, 10, cp) || lookup(3, 1, cp) || lookup(0, 4, cp) || lookup(0, 3, cp);
  let names: string[] | null = null;
  const allNames = () => {
    if (!names) {
      const post = tables.get('post');
      try {
        names = post ? postNames(dv, post, numGlyphs) : [];
      } catch {
        names = [];
      }
    }
    return names;
  };
  const os2 = tables.get('OS/2');
  const os2Version = os2 ? dv.getUint16(os2.off) : 0;
  const fsType = os2 && os2.len >= 10 ? dv.getUint16(os2.off + 8) : 0;
  const capHeight = os2 && os2Version >= 2 && os2.len >= 90 ? dv.getInt16(os2.off + 88) / unitsPerEm : 0;
  const xHeight = os2 && os2Version >= 2 && os2.len >= 88 ? dv.getInt16(os2.off + 86) / unitsPerEm : 0;
  return {
    kind: 'truetype',
    numGlyphs,
    unitsPerEm,
    hasOutline,
    advance,
    lookup,
    hasCmap: (p, e) => subtables.has(`${p},${e}`),
    gidForUnicode,
    gidForName: (name) => Math.max(0, allNames().indexOf(name)),
    nameOf: (g) => allNames()[g] ?? '',
    capHeight: capHeight > 0 ? capHeight : 0,
    xHeight: xHeight > 0 ? xHeight : 0,
    fsType,
  };
}

interface FkGlyph {
  id: number;
  name: string;
  advanceWidth: number;
  path: { commands: unknown[] };
}
interface FkFont {
  numGlyphs: number;
  unitsPerEm: number;
  capHeight: number;
  xHeight: number;
  getGlyph: (id: number) => FkGlyph;
  glyphForCodePoint: (cp: number) => FkGlyph;
  'OS/2'?: { fsType?: Record<string, boolean> };
}

function cffProgram(b: Uint8Array): FontProgram | null {
  let f: FkFont;
  try {
    f = fontkit.create(b) as unknown as FkFont;
    if (!f.numGlyphs) return null;
  } catch {
    return null;
  }
  const safe = <T,>(fn: () => T, dflt: T): T => {
    try {
      return fn();
    } catch {
      return dflt;
    }
  };
  let byName: Map<string, number> | null = null;
  const names = () => {
    if (!byName) {
      byName = new Map();
      for (let g = 0; g < f.numGlyphs; g++) {
        const n = safe(() => f.getGlyph(g).name, '');
        if (n && !byName.has(n)) byName.set(n, g);
      }
    }
    return byName;
  };
  const tables = sfntTables(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const os2 = tables?.get('OS/2');
  const upem = f.unitsPerEm || 1000;
  return {
    kind: 'cff',
    numGlyphs: f.numGlyphs,
    unitsPerEm: upem,
    hasOutline: (g) => g > 0 && g < f.numGlyphs && safe(() => f.getGlyph(g).path.commands.length > 0, false),
    advance: (g) => safe(() => f.getGlyph(g).advanceWidth, 0),
    lookup: (p, e, c) => (p === 3 && (e === 1 || e === 10) ? safe(() => f.glyphForCodePoint(c).id, 0) : 0),
    hasCmap: (p, e) => p === 3 && (e === 1 || e === 10),
    gidForUnicode: (cp) => safe(() => f.glyphForCodePoint(cp).id, 0),
    gidForName: (n) => names().get(n) ?? 0,
    nameOf: (g) => safe(() => f.getGlyph(g).name, ''),
    capHeight: f.capHeight > 0 ? f.capHeight / upem : 0,
    xHeight: f.xHeight > 0 ? f.xHeight / upem : 0,
    fsType: os2 && os2.len >= 10 ? dv.getUint16(os2.off + 8) : 0,
  };
}

/** Parses a TrueType or OpenType font program; null for anything else (bare CFF, Type 1). */
export function readFontProgram(b: Uint8Array): FontProgram | null {
  const tables = sfntTables(b);
  if (!tables) return null;
  try {
    if (tables.has('glyf')) return trueTypeProgram(b, tables);
    if (tables.has('CFF ')) return cffProgram(b);
  } catch {
    return null;
  }
  return null;
}

/** Embedding permission of OS/2 fsType: restricted-licence fonts (and bitmap-only ones) may not be embedded. */
export function embeddingAllowed(fsType: number): boolean {
  if ((fsType & 0x000f) === 0x0002) return false;
  return (fsType & 0x0200) === 0;
}
