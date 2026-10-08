/**
 * Glyph-level text engine for page content streams.
 *
 * `analyzePageText` interprets a page's content stream and returns every
 * glyph drawn directly on the page with its Unicode text and its exact box in
 * PDF user space. `removeGlyphs` rewrites the content stream so the glyphs
 * whose centre lies inside the given boxes are gone (the letters are really
 * deleted, not covered): the rest of the line keeps its position because each
 * removed glyph becomes a TJ spacing number of the same width.
 *
 * Used by find & replace and by redaction. Whatever the engine cannot handle
 * safely (text inside Form XObjects, fonts it cannot measure, vertical text,
 * images or shadings under a redaction, form fields) is reported so the caller
 * can fall back (rasterise the page, or cover the text).
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { Font as StdFont } from '@pdf-lib/standard-fonts';
import { STD_ALIASES, glyphNameToUnicode, parseToUnicode, standardMaps, streamBytes } from './fontEncoding';

export { parseToUnicode };

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
/** Row-vector convention: apply A, then B. */
function mul(A: M, B: M): M {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}
function apply(m: M, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** Axis-aligned box in PDF user space. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(m: M, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function boxesOverlap(a: Box, b: Box, eps = 0.01): boolean {
  return a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps;
}

function coveredFraction(g: Box, b: Box): number {
  const w = Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0);
  const h = Math.min(g.y1, b.y1) - Math.max(g.y0, b.y0);
  const area = (g.x1 - g.x0) * (g.y1 - g.y0);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

function inside(b: Box, x: number, y: number): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

// ------------------------------------------------------------------ lexer

type Val =
  | { k: 'n'; v: number }
  | { k: 'name'; v: string }
  | { k: 's'; v: Uint8Array }
  | { k: 'a'; v: Val[] }
  | { k: 'other' };

export interface Instr {
  op: string;
  args: Val[];
  /** Byte range of the whole instruction (operands + operator) in the source. */
  start: number;
  end: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(c: number) {
  return !WS.has(c) && !DELIM.has(c);
}

/** Splits a content stream into instructions. Throws on malformed input. */
export function parseContent(src: Uint8Array): Instr[] {
  const out: Instr[] = [];
  let i = 0;
  const n = src.length;
  let args: Val[] = [];
  let argStart = -1;
  // Array nesting: values collected into the innermost open array.
  const arrays: Val[][] = [];
  let dictDepth = 0;

  const push = (v: Val, at: number) => {
    if (argStart < 0) argStart = at;
    if (dictDepth > 0) return; // dict contents (e.g. BDC properties) are opaque
    if (arrays.length) arrays[arrays.length - 1].push(v);
    else args.push(v);
  };

  const skipWs = () => {
    for (;;) {
      while (i < n && WS.has(src[i])) i++;
      if (i < n && src[i] === 0x25) {
        while (i < n && src[i] !== 10 && src[i] !== 13) i++;
        continue;
      }
      break;
    }
  };

  while (true) {
    skipWs();
    if (i >= n) break;
    const at = i;
    const c = src[i];
    if (c === 0x28) {
      // literal string
      i++;
      let depth = 1;
      const bytes: number[] = [];
      while (i < n) {
        const b = src[i++];
        if (b === 0x5c) {
          const e = src[i++];
          if (e === 0x6e) bytes.push(10);
          else if (e === 0x72) bytes.push(13);
          else if (e === 0x74) bytes.push(9);
          else if (e === 0x62) bytes.push(8);
          else if (e === 0x66) bytes.push(12);
          else if (e === 13) {
            if (src[i] === 10) i++;
          } else if (e === 10) {
            /* line continuation */
          } else if (e >= 0x30 && e <= 0x37) {
            let v = e - 0x30;
            for (let k = 0; k < 2 && src[i] >= 0x30 && src[i] <= 0x37; k++) v = v * 8 + (src[i++] - 0x30);
            bytes.push(v & 0xff);
          } else bytes.push(e);
        } else if (b === 0x28) {
          depth++;
          bytes.push(b);
        } else if (b === 0x29) {
          if (--depth === 0) break;
          bytes.push(b);
        } else bytes.push(b);
      }
      if (depth !== 0) throw new Error('unterminated string');
      push({ k: 's', v: new Uint8Array(bytes) }, at);
    } else if (c === 0x3c && src[i + 1] === 0x3c) {
      i += 2;
      if (argStart < 0) argStart = at;
      dictDepth++;
    } else if (c === 0x3e && src[i + 1] === 0x3e) {
      i += 2;
      dictDepth = Math.max(0, dictDepth - 1);
      if (dictDepth === 0) push({ k: 'other' }, at);
    } else if (c === 0x3c) {
      i++;
      let hex = '';
      while (i < n && src[i] !== 0x3e) {
        const ch = src[i++];
        if (!WS.has(ch)) hex += String.fromCharCode(ch);
      }
      i++;
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
      push({ k: 's', v: bytes }, at);
    } else if (c === 0x5b) {
      i++;
      if (argStart < 0) argStart = at;
      if (dictDepth === 0) arrays.push([]);
    } else if (c === 0x5d) {
      i++;
      if (dictDepth === 0) {
        const arr = arrays.pop();
        if (!arr) throw new Error('unbalanced ]');
        push({ k: 'a', v: arr }, at);
      }
    } else if (c === 0x2f) {
      i++;
      let name = '';
      while (i < n && isRegular(src[i])) name += String.fromCharCode(src[i++]);
      push({ k: 'name', v: name.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) }, at);
    } else if (c === 0x7b || c === 0x7d) {
      i++;
      push({ k: 'other' }, at);
    } else {
      let word = '';
      while (i < n && isRegular(src[i])) word += String.fromCharCode(src[i++]);
      if (!word) {
        i++; // stray delimiter
        continue;
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ k: 'n', v: Number(word) }, at);
      else if (word === 'true' || word === 'false' || word === 'null') push({ k: 'other' }, at);
      else if (arrays.length || dictDepth) push({ k: 'other' }, at);
      else if (word === 'BI') {
        // Inline image: skip its dictionary and binary data up to EI.
        const start = argStart < 0 ? at : argStart;
        const id = indexOfWord(src, 'ID', i);
        if (id < 0) throw new Error('inline image without ID');
        let j = id + 3;
        let end = -1;
        for (; j < n - 1; j++) {
          if (src[j] === 0x45 && src[j + 1] === 0x49 && WS.has(src[j - 1]) && (j + 2 >= n || WS.has(src[j + 2]) || DELIM.has(src[j + 2]))) {
            end = j + 2;
            break;
          }
        }
        if (end < 0) throw new Error('inline image without EI');
        i = end;
        out.push({ op: 'BI', args: [], start, end });
        args = [];
        argStart = -1;
      } else {
        out.push({ op: word, args, start: argStart < 0 ? at : argStart, end: i });
        args = [];
        argStart = -1;
      }
    }
  }
  return out;
}

function indexOfWord(src: Uint8Array, word: string, from: number): number {
  const a = word.charCodeAt(0);
  const b = word.charCodeAt(1);
  for (let j = from; j < src.length - 1; j++) {
    if (src[j] === a && src[j + 1] === b && (j === 0 || WS.has(src[j - 1])) && (j + 2 >= src.length || WS.has(src[j + 2]))) return j;
  }
  return -1;
}

// ------------------------------------------------------------------ fonts

export interface FontInfo {
  twoByte: boolean;
  /** Advance width in text-space units per unit font size (em). */
  width: (code: number) => number;
  unicode: (code: number) => string;
  /** Measurable: widths known and horizontal writing. */
  ok: boolean;
  baseName: string;
  /** Type3: the glyph's box in text space per unit font size [x0, y0, x1, y1] (others use a fixed em band). */
  glyphBox?: (code: number) => [number, number, number, number] | null;
}

function num(v: unknown, dflt = 0): number {
  return v instanceof PDFNumber ? v.asNumber() : dflt;
}

function loadFont(doc: PDFDocument, fontObj: unknown): FontInfo {
  const bad: FontInfo = { twoByte: false, width: () => 0, unicode: () => '', ok: false, baseName: '' };
  const d = fontObj instanceof PDFRef ? doc.context.lookup(fontObj) : fontObj;
  if (!(d instanceof PDFDict)) return bad;
  const subtype = d.lookup(PDFName.of('Subtype'));
  const baseFont = d.lookup(PDFName.of('BaseFont'));
  const baseName = baseFont instanceof PDFName ? baseFont.decodeText().replace(/^[A-Z]{6}\+/, '') : '';
  const toUniBytes = streamBytes(doc, d.get(PDFName.of('ToUnicode')));
  const toUni = toUniBytes ? parseToUnicode(new TextDecoder('latin1').decode(toUniBytes)) : null;

  if (subtype === PDFName.of('Type0')) {
    const enc = d.lookup(PDFName.of('Encoding'));
    const encName = enc instanceof PDFName ? enc.decodeText() : '';
    if (encName !== 'Identity-H') return { ...bad, twoByte: true, baseName };
    const descs = d.lookup(PDFName.of('DescendantFonts'));
    const desc = descs instanceof PDFArray ? descs.lookup(0) : null;
    if (!(desc instanceof PDFDict)) return { ...bad, twoByte: true, baseName };
    const dw = num(desc.lookup(PDFName.of('DW')), 1000);
    const widths = new Map<number, number>();
    const w = desc.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) {
      for (let k = 0; k < w.size(); ) {
        const first = num(w.lookup(k));
        const next = w.lookup(k + 1);
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j++) widths.set(first + j, num(next.lookup(j)));
          k += 2;
        } else {
          const last = num(next);
          const width = num(w.lookup(k + 2));
          for (let c = first; c <= last && c - first < 0x10000; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    return {
      twoByte: true,
      width: (c) => (widths.get(c) ?? dw) / 1000,
      unicode: (c) => toUni?.get(c) ?? '',
      ok: true,
      baseName,
    };
  }

  // Simple fonts: Type1, MMType1, TrueType, Type3.
  const isType3 = subtype === PDFName.of('Type3');
  let scale = 0.001;
  let glyphBox: FontInfo['glyphBox'];
  if (isType3) {
    const fmArr = d.lookup(PDFName.of('FontMatrix'));
    if (!(fmArr instanceof PDFArray) || fmArr.size() < 6) return { ...bad, baseName };
    const fm = Array.from({ length: 6 }, (_, k) => num(fmArr.lookup(k))) as M;
    scale = fm[0];
    glyphBox = type3GlyphBoxes(doc, d, fm);
  }
  const first = num(d.lookup(PDFName.of('FirstChar')));
  const widthsArr = d.lookup(PDFName.of('Widths'));
  const desc = d.lookup(PDFName.of('FontDescriptor'));
  const missing = desc instanceof PDFDict ? num(desc.lookup(PDFName.of('MissingWidth'))) : 0;

  // Encoding: code -> glyph name (for standard-14 widths and Unicode).
  const { codeToName, codeToUni } = standardMaps();
  const names = new Map<number, string>(codeToName);
  const enc = d.lookup(PDFName.of('Encoding'));
  if (enc instanceof PDFDict) {
    const diffs = enc.lookup(PDFName.of('Differences'));
    if (diffs instanceof PDFArray) {
      let c = 0;
      for (let k = 0; k < diffs.size(); k++) {
        const v = diffs.lookup(k);
        if (v instanceof PDFNumber) c = v.asNumber();
        else if (v instanceof PDFName) names.set(c++, v.decodeText());
      }
    }
  }
  const unicode = (c: number) => {
    const t = toUni?.get(c);
    if (t !== undefined) return t;
    const name = names.get(c);
    if (name && name !== codeToName.get(c)) return glyphNameToUnicode(name);
    return codeToUni.get(c) ?? (c >= 32 && c < 127 ? String.fromCharCode(c) : '');
  };

  if (widthsArr instanceof PDFArray) {
    const ws: number[] = [];
    for (let k = 0; k < widthsArr.size(); k++) ws.push(num(widthsArr.lookup(k), missing));
    return { twoByte: false, width: (c) => (ws[c - first] ?? missing) * scale, unicode, ok: true, baseName, glyphBox };
  }
  const std = STD_ALIASES[baseName.toLowerCase().replace(/\s+/g, '')];
  if (std && !isType3) {
    const metrics = StdFont.load(std);
    return {
      twoByte: false,
      width: (c) => {
        const name = names.get(c);
        const w = name ? metrics.getWidthOfGlyph(name) : undefined;
        return (typeof w === 'number' ? w : 500) / 1000;
      },
      unicode,
      ok: true,
      baseName,
    };
  }
  return { ...bad, unicode, baseName };
}

/**
 * Glyph boxes of a Type3 font in text space: the FontBBox through the full
 * FontMatrix, or each glyph's own d1 box when the FontBBox is all zeros.
 */
function type3GlyphBoxes(doc: PDFDocument, d: PDFDict, fm: M): FontInfo['glyphBox'] {
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => {
    const b = boxOf(fm, x0, y0, x1, y1);
    return [b.x0, b.y0, b.x1, b.y1];
  };
  const bb = d.lookup(PDFName.of('FontBBox'));
  const fb = bb instanceof PDFArray && bb.size() === 4 ? Array.from({ length: 4 }, (_, k) => num(bb.lookup(k))) : null;
  if (fb && fb[2] - fb[0] > 0 && fb[3] - fb[1] > 0) {
    const whole = box(fb[0], fb[1], fb[2], fb[3]);
    return () => whole;
  }
  // Code -> glyph name (Differences) -> CharProcs stream -> "wx wy llx lly urx ury d1".
  const names = new Map<number, string>();
  const enc = d.lookup(PDFName.of('Encoding'));
  const diffs = enc instanceof PDFDict ? enc.lookup(PDFName.of('Differences')) : undefined;
  if (diffs instanceof PDFArray) {
    let c = 0;
    for (let k = 0; k < diffs.size(); k++) {
      const v = diffs.lookup(k);
      if (v instanceof PDFNumber) c = v.asNumber();
      else if (v instanceof PDFName) names.set(c++, v.decodeText());
    }
  }
  const procs = d.lookup(PDFName.of('CharProcs'));
  const cache = new Map<number, [number, number, number, number] | null>();
  return (code) => {
    if (cache.has(code)) return cache.get(code)!;
    let out: [number, number, number, number] | null = null;
    const name = names.get(code);
    const bytes = name && procs instanceof PDFDict ? streamBytes(doc, procs.get(PDFName.of(name))) : null;
    if (bytes) {
      try {
        const d1 = parseContent(bytes).find((i) => i.op === 'd1' || i.op === 'd0');
        const v = d1?.args.map((a) => (a.k === 'n' ? a.v : 0)) ?? [];
        if (d1?.op === 'd1' && v.length === 6 && v[4] > v[2] && v[5] > v[3]) out = box(v[2], v[3], v[4], v[5]);
      } catch {
        /* unreadable glyph procedure: fixed band */
      }
    }
    cache.set(code, out);
    return out;
  };
}

// ------------------------------------------------------------------ interpreter

export interface Glyph {
  /** Unicode text of the glyph ('' when unknown). */
  text: string;
  /** Box in PDF user space (em box: descent 0.2, ascent 0.8). */
  box: Box;
  /** Glyph centre, used to decide removal. */
  cx: number;
  cy: number;
  /** Baseline start and direction in user space; font size in points. */
  origin: [number, number];
  dir: [number, number];
  size: number;
  advance: number;
  font: string;
  /** Fill colour as #rrggbb (DeviceGray / RGB / CMYK; other colour spaces read as their components). */
  color: string;
  /** TJ spacing units per point of user space at this glyph (to move following text). */
  k: number;
  /** Text state at this glyph, used to write replacement text in the same font. */
  run: GlyphRun;
  /** Text rendering mode (3 = invisible, e.g. the text layer of a scan). */
  mode?: number;
}

export interface GlyphRun {
  /** Font resource name (Tf operand). */
  key: string;
  font: FontInfo;
  bytes: number[];
  fs: number;
  Tc: number;
  Tw: number;
  Th: number;
  /** Scale of text space to user space along the line. */
  s: number;
  /** Index into Interpretation.shows. */
  show: number;
}

interface Piece {
  kind: 'glyph' | 'num';
  bytes?: number[];
  /** For glyphs: TJ number that replaces it (same advance). */
  asNum?: number;
  glyph?: number;
  v?: number;
}

interface Show {
  instr: number;
  prefix: string;
  pieces: Piece[];
  /** The text position was set (BT, Td, TD, Tm, T*, ', ") since the previous show: shifts do not carry over. */
  positioned: boolean;
}

interface Region {
  /** 'vector': curves or multi-point shapes (ink, outlined text), not plain lines and rectangles. */
  kind: 'image' | 'form' | 'shading' | 'unmeasurable-text' | 'vector';
  box: Box | null;
}

/** A marked-content sequence (BMC / BDC … EMC). */
interface Mark {
  instr: number;
  tag: string;
  mcid: number | null;
  /** Its properties carry text of their own (/ActualText, /Alt, /E). */
  text: boolean;
}

interface Interpretation {
  instrs: Instr[];
  glyphs: Glyph[];
  /** Per glyph: the marked-content sequences it is drawn in (indexes into `marks`). */
  glyphMarks: number[][];
  marks: Mark[];
  shows: Show[];
  regions: Region[];
  src: Uint8Array;
}

export function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = page.node.get(PDFName.of('Contents'));
  const target = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  if (target instanceof PDFArray) {
    for (let k = 0; k < target.size(); k++) {
      const b = streamBytes(doc, target.get(k));
      if (b) parts.push(b);
    }
  } else {
    const b = streamBytes(doc, target);
    if (b) parts.push(b);
  }
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

export function resourcesOf(page: PDFPage): PDFDict | undefined {
  let node: PDFDict | undefined = page.node;
  for (let depth = 0; node && depth < 32; depth++) {
    const r = node.lookup(PDFName.of('Resources'));
    if (r instanceof PDFDict) return r;
    const parent: unknown = node.lookup(PDFName.of('Parent'));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

function interpret(doc: PDFDocument, page: PDFPage): Interpretation {
  const src = pageContent(doc, page);
  const instrs = parseContent(src);
  const res = resourcesOf(page);
  const fontDict = res?.lookup(PDFName.of('Font'));
  const xobjDict = res?.lookup(PDFName.of('XObject'));
  const propsDict = res?.lookup(PDFName.of('Properties'));
  const fontCache = new Map<string, FontInfo>();
  const glyphs: Glyph[] = [];
  const glyphMarks: number[][] = [];
  const marks: Mark[] = [];
  const openMarks: number[] = [];
  const shows: Show[] = [];
  const regions: Region[] = [];
  const latin1 = new TextDecoder('latin1');
  const TEXT_KEYS = /\/(?:ActualText|Alt|E)(?![A-Za-z0-9])/;

  interface GS {
    ctm: M;
    font: FontInfo | null;
    fontKey: string;
    fs: number;
    Tc: number;
    Tw: number;
    Th: number;
    TL: number;
    Ts: number;
    fill: string;
    Tr: number;
  }
  let gs: GS = { ctm: I, font: null, fontKey: '', fs: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, fill: '#000000', Tr: 0 };
  const stack: GS[] = [];
  let Tm: M = I;
  // Current path: user-space points and whether it is more than lines / rectangles.
  let pathPts: Array<[number, number]> = [];
  let subPts = 0;
  let complex = false;
  const addPt = (x: number, y: number) => pathPts.push(apply(gs.ctm, x, y));
  const endPath = (painted: boolean) => {
    if (painted && complex && pathPts.length) {
      const xs = pathPts.map((p) => p[0]);
      const ys = pathPts.map((p) => p[1]);
      regions.push({ kind: 'vector', box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } });
    }
    pathPts = [];
    subPts = 0;
    complex = false;
  };
  let Tlm: M = I;
  let positioned = true;
  const nums = (a: Val[]) => a.map((v) => (v.k === 'n' ? v.v : 0));

  const show = (instrIndex: number, prefix: string, items: Val[]) => {
    const f = gs.font;
    const s: Show = { instr: instrIndex, prefix, pieces: [], positioned: positioned || prefix !== '' };
    positioned = false;
    if (!f || !f.ok || gs.fs === 0) {
      // Text we cannot measure could extend anywhere along its line: treat it as
      // overlapping every area, so callers fall back instead of missing letters.
      regions.push({ kind: 'unmeasurable-text', box: null });
      return;
    }
    for (const it of items) {
      if (it.k === 'n') {
        s.pieces.push({ kind: 'num', v: it.v });
        const tx = (-it.v / 1000) * gs.fs * gs.Th;
        Tm = mul([1, 0, 0, 1, tx, 0], Tm);
        continue;
      }
      if (it.k !== 's') continue;
      const bytes = it.v;
      const step = f.twoByte ? 2 : 1;
      for (let k = 0; k + step - 1 < bytes.length; k += step) {
        const code = f.twoByte ? (bytes[k] << 8) | bytes[k + 1] : bytes[k];
        const w0 = f.width(code);
        const isSpace = !f.twoByte && code === 32;
        const trm = mul(mul([gs.fs * gs.Th, 0, 0, gs.fs, 0, gs.Ts], Tm), gs.ctm);
        const gb = f.glyphBox?.(code) ?? null;
        const [cx, cy] = gb ? apply(trm, (gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2) : apply(trm, w0 / 2, 0.3);
        const o = apply(trm, 0, 0);
        const e = apply(trm, 1, 0);
        const len = Math.hypot(e[0] - o[0], e[1] - o[1]) || 1;
        const up = apply(trm, 0, 1);
        const advance = (w0 * gs.fs + gs.Tc + (isSpace ? gs.Tw : 0)) * gs.Th;
        glyphs.push({
          text: f.unicode(code),
          box: gb ? boxOf(trm, gb[0], gb[1], gb[2], gb[3]) : boxOf(trm, 0, -0.2, Math.max(w0, 0.001), 0.8),

          cx,
          cy,
          origin: o,
          dir: [(e[0] - o[0]) / len, (e[1] - o[1]) / len],
          size: Math.hypot(up[0] - o[0], up[1] - o[1]),
          advance: advance * Math.hypot(mul(Tm, gs.ctm)[0], mul(Tm, gs.ctm)[1]),
          font: f.baseName,
          color: gs.fill,
          mode: gs.Tr,
          k: 1000 / (gs.fs * gs.Th * (Math.hypot(mul(Tm, gs.ctm)[0], mul(Tm, gs.ctm)[1]) || 1)),
          run: { key: gs.fontKey, font: f, bytes: Array.from(bytes.subarray(k, k + step)), fs: gs.fs, Tc: gs.Tc, Tw: gs.Tw, Th: gs.Th, s: Math.hypot(mul(Tm, gs.ctm)[0], mul(Tm, gs.ctm)[1]) || 1, show: shows.length },
        });
        glyphMarks.push(openMarks.slice());
        s.pieces.push({
          kind: 'glyph',
          bytes: Array.from(bytes.subarray(k, k + step)),
          asNum: (-(w0 * gs.fs + gs.Tc + (isSpace ? gs.Tw : 0)) * 1000) / gs.fs,
          glyph: glyphs.length - 1,
        });
        Tm = mul([1, 0, 0, 1, advance, 0], Tm);
      }
    }
    shows.push(s);
  };

  const nextLine = () => {
    Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm);
    Tm = Tlm;
  };

  instrs.forEach((ins, idx) => {
    const a = ins.args;
    switch (ins.op) {
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm': {
        const v = nums(a);
        if (v.length === 6) gs.ctm = mul(v as M, gs.ctm);
        break;
      }
      case 'g':
      case 'rg':
      case 'k':
      case 'sc':
      case 'scn': {
        const v = a.filter((x) => x.k === 'n').map((x) => (x as { v: number }).v);
        const c = v.length === 1 ? [v[0], v[0], v[0]] : v.length === 3 ? v : v.length === 4 ? [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])] : null;
        if (c) gs.fill = '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
        break;
      }
      case 'BT':
        Tm = I;
        Tlm = I;
        positioned = true;
        break;
      case 'Tf': {
        const name = a[0]?.k === 'name' ? a[0].v : '';
        let f = fontCache.get(name);
        if (!f) {
          f = loadFont(doc, fontDict instanceof PDFDict ? fontDict.get(PDFName.of(name)) : undefined);
          fontCache.set(name, f);
        }
        gs.font = f;
        gs.fontKey = name;
        gs.fs = a[1]?.k === 'n' ? a[1].v : 0;
        break;
      }
      case 'Tc':
        gs.Tc = nums(a)[0] ?? 0;
        break;
      case 'Tw':
        gs.Tw = nums(a)[0] ?? 0;
        break;
      case 'Tz':
        gs.Th = (nums(a)[0] ?? 100) / 100;
        break;
      case 'TL':
        gs.TL = nums(a)[0] ?? 0;
        break;
      case 'Tr':
        gs.Tr = nums(a)[0] ?? 0;
        break;
      case 'Ts':
        gs.Ts = nums(a)[0] ?? 0;
        break;
      case 'Td':
      case 'TD': {
        const [tx, ty] = nums(a);
        if (ins.op === 'TD') gs.TL = -ty;
        Tlm = mul([1, 0, 0, 1, tx ?? 0, ty ?? 0], Tlm);
        Tm = Tlm;
        positioned = true;
        break;
      }
      case 'Tm': {
        const v = nums(a);
        if (v.length === 6) {
          Tlm = v as M;
          Tm = Tlm;
        }
        positioned = true;
        break;
      }
      case 'T*':
        nextLine();
        positioned = true;
        break;
      case 'Tj':
        show(idx, '', a.slice(0, 1));
        break;
      case "'":
        nextLine();
        show(idx, 'T*', a.slice(0, 1));
        break;
      case '"': {
        const [aw, ac] = nums(a);
        gs.Tw = aw ?? 0;
        gs.Tc = ac ?? 0;
        nextLine();
        show(idx, `${fmtNum(aw ?? 0)} Tw ${fmtNum(ac ?? 0)} Tc T*`, a.slice(2, 3));
        break;
      }
      case 'TJ':
        show(idx, '', a[0]?.k === 'a' ? a[0].v : []);
        break;
      case 'Do': {
        const name = a[0]?.k === 'name' ? a[0].v : '';
        const xo = xobjDict instanceof PDFDict ? xobjDict.lookup(PDFName.of(name)) : undefined;
        if (!(xo instanceof PDFStream)) break;
        const st = xo.dict.lookup(PDFName.of('Subtype'));
        if (st === PDFName.of('Image')) regions.push({ kind: 'image', box: boxOf(gs.ctm, 0, 0, 1, 1) });
        else if (st === PDFName.of('Form')) {
          const bb = xo.dict.lookup(PDFName.of('BBox'));
          const mx = xo.dict.lookup(PDFName.of('Matrix'));
          const fm: M = mx instanceof PDFArray && mx.size() === 6 ? (Array.from({ length: 6 }, (_, k) => num(mx.lookup(k))) as M) : I;
          const b = bb instanceof PDFArray && bb.size() === 4 ? Array.from({ length: 4 }, (_, k) => num(bb.lookup(k))) : null;
          regions.push({ kind: 'form', box: b ? boxOf(mul(fm, gs.ctm), b[0], b[1], b[2], b[3]) : null });
        }
        break;
      }
      case 'BI':
        regions.push({ kind: 'image', box: boxOf(gs.ctm, 0, 0, 1, 1) });
        break;
      case 'm': {
        const [x, y] = nums(a);
        addPt(x ?? 0, y ?? 0);
        subPts = 1;
        break;
      }
      case 'l': {
        const [x, y] = nums(a);
        addPt(x ?? 0, y ?? 0);
        // A single segment is a rule; a polyline may be a drawn shape.
        if (++subPts > 2) complex = true;
        break;
      }
      case 'c':
      case 'v':
      case 'y': {
        const v = nums(a);
        for (let k = 0; k + 1 < v.length; k += 2) addPt(v[k], v[k + 1]);
        complex = true;
        break;
      }
      case 're': {
        const [x, y, w, h] = nums(a);
        addPt(x ?? 0, y ?? 0);
        addPt((x ?? 0) + (w ?? 0), (y ?? 0) + (h ?? 0));
        break;
      }
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        endPath(true);
        break;
      case 'n':
        endPath(false);
        break;
      case 'sh':
        regions.push({ kind: 'shading', box: null });
        break;
      case 'BMC':
      case 'BDC': {
        const tag = a[0]?.k === 'name' ? a[0].v : '';
        let mcid: number | null = null;
        let text = false;
        if (ins.op === 'BDC') {
          if (a[1]?.k === 'name') {
            // Named properties from the page resources (/OC layers are left alone).
            const p = propsDict instanceof PDFDict ? propsDict.lookup(PDFName.of(a[1].v)) : undefined;
            if (p instanceof PDFDict && tag !== 'OC') {
              const id = p.lookup(PDFName.of('MCID'));
              mcid = id instanceof PDFNumber ? id.asNumber() : null;
              text = ['ActualText', 'Alt', 'E'].some((k) => p.has(PDFName.of(k)));
            }
          } else {
            const raw = latin1.decode(src.subarray(ins.start, ins.end));
            const m = /\/MCID\s+(\d+)/.exec(raw);
            mcid = m ? Number(m[1]) : null;
            text = TEXT_KEYS.test(raw);
          }
        }
        marks.push({ instr: idx, tag, mcid, text });
        openMarks.push(marks.length - 1);
        break;
      }
      case 'EMC':
        openMarks.pop();
        break;
    }
  });
  return { instrs, glyphs, glyphMarks, marks, shows, regions, src };
}

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

// ------------------------------------------------------------------ public API

export interface PageText {
  glyphs: Glyph[];
  /** Page text built from the glyphs (spaces and newlines inferred). */
  text: string;
  /** For every UTF-16 unit of `text`: index into `glyphs` or -1 for inferred separators. */
  map: number[];
  /** Text also drawn inside Form XObjects or with fonts the engine cannot measure. */
  partial: boolean;
}

export function analyzePageText(doc: PDFDocument, page: PDFPage): PageText {
  let it: Interpretation;
  try {
    it = interpret(doc, page);
  } catch {
    return { glyphs: [], text: '', map: [], partial: true };
  }
  let text = '';
  const map: number[] = [];
  let prev: Glyph | null = null;
  it.glyphs.forEach((g, i) => {
    if (prev) {
      // Distance of this glyph's origin from the end of the previous one, in the text direction.
      const ex = prev.origin[0] + prev.dir[0] * prev.advance;
      const ey = prev.origin[1] + prev.dir[1] * prev.advance;
      const dx = g.origin[0] - ex;
      const dy = g.origin[1] - ey;
      const along = dx * prev.dir[0] + dy * prev.dir[1];
      const across = Math.abs(-dx * prev.dir[1] + dy * prev.dir[0]);
      const sep = across > prev.size * 0.5 ? '\n' : along > prev.size * 0.2 || along < -prev.size ? ' ' : '';
      if (sep && !/\s$/.test(text) && !/^\s/.test(g.text)) {
        text += sep;
        map.push(-1);
      }
    }
    // Ligature glyphs (ﬁ, ﬂ, ﬀ…) read as their letters so "firma" finds "ﬁrma".
    const t = (g.text || '�').replace(/[ﬀ-ﬆ]/g, (c) => c.normalize('NFKC'));
    text += t;
    for (let k = 0; k < t.length; k++) map.push(i);
    prev = g;
  });
  const partial = it.regions.some((r) => r.kind === 'form' || r.kind === 'unmeasurable-text');
  return { glyphs: it.glyphs, text, map, partial };
}

export interface RemovalResult {
  ok: boolean;
  /** Why the page could not be cleaned safely (caller falls back). */
  reason?: string;
  removedGlyphs: number;
  removedAnnots: number;
  /** An image lies under one of the boxes (a replacement still needs a cover). */
  coversImage: boolean;
  /** Per edit: how far its start moved along the line because of earlier edits on the same line. */
  editShifts: number[];
  /** Per edit: horizontal scale for the new text so it fits (1 = as is). */
  editScales: number[];
  /** Per edit: the new text was written into the page in the document's own font (do not draw it again). */
  editNative: boolean[];
  /** Marked-content ids of the removed letters (their structure elements' alternate text must go too). */
  mcids: number[];
  /** Annotations taken off the page (with their popups). */
  removedAnnotRefs: string[];
}

/** A replacement of the letters in `boxes` by text `newWidth` points wide: the rest of the line makes room. */
export interface LineEdit {
  boxes: Box[];
  newWidth: number;
  /** The new text: written in the document's own font when all its letters are available. */
  text?: string;
  /** Restyled text: its fill colour (#rrggbb) instead of the original one. */
  color?: string;
  /** Restyled text: size relative to the original letters (1.2 = 20% larger). */
  sizeRatio?: number;
}

/**
 * Deletes the glyphs whose centre is inside one of `boxes` (PDF user space).
 * `redact`: fails when anything else could still show or hold the content
 * under the boxes (images, forms, shadings, unmeasurable text, form fields)
 * and removes overlapping annotations. `replace`: removes the letters it can
 * and reports what it could not.
 */
export function removeGlyphs(doc: PDFDocument, page: PDFPage, boxes: Box[], mode: 'redact' | 'replace', edits: LineEdit[] = []): RemovalResult {
  const fail = (reason: string): RemovalResult => ({ ok: false, reason, removedGlyphs: 0, removedAnnots: 0, coversImage: false, editShifts: edits.map(() => 0), editScales: edits.map(() => 1), editNative: edits.map(() => false), mcids: [], removedAnnotRefs: [] });
  if (!boxes.length) return { ...fail(''), ok: true, reason: undefined };
  let it: Interpretation;
  try {
    it = interpret(doc, page);
  } catch (e) {
    return fail(`content stream not understood (${e instanceof Error ? e.message : String(e)})`);
  }
  const hits = (b: Box | null) => (b ? boxes.some((x) => boxesOverlap(x, b)) : true);
  let coversImage = false;
  for (const r of it.regions) {
    if (!hits(r.box)) continue;
    if (r.kind === 'image') {
      coversImage = true;
      if (mode === 'redact') return fail('an image lies under the redaction');
    } else if (r.kind === 'vector') {
      if (mode === 'redact') return fail('a drawing (curves or shapes) lies under the redaction');
    } else if (r.kind === 'shading') {
      if (mode === 'redact') return fail('a shading lies under the redaction');
    } else if (r.kind === 'form') {
      return fail('text in a form XObject lies under the area');
    } else if (r.kind === 'unmeasurable-text') {
      return fail('text in a font that cannot be measured lies near the area');
    }
  }

  const remove = new Set<number>();
  it.glyphs.forEach((g, i) => {
    // Replace: the letter's centre is in the area. Redact: also any letter at least 20% covered.
    if (boxes.some((b) => inside(b, g.cx, g.cy) || (mode === 'redact' && coveredFraction(g.box, b) >= 0.2))) remove.add(i);
  });

  const crop = page.getCropBox();
  const bounds = { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height };
  const natives = mode === 'replace' ? edits.map((e) => nativeText(it, remove, e)) : edits.map(() => null);
  let effective = edits.map((e, i) => (natives[i] ? { ...e, newWidth: natives[i]!.width } : e));
  let { shift, scales: editScales } = mode === 'replace' ? lineShifts(it.glyphs, remove, effective, bounds) : { shift: new Map<number, number>(), scales: edits.map(() => 1) };
  if (natives.some((n, i) => n && editScales[i] < 1)) {
    // The document's font would need condensing: draw those in the app's font instead.
    natives.forEach((n, i) => {
      if (n && editScales[i] < 1) natives[i] = null;
    });
    effective = edits.map((e, i) => (natives[i] ? { ...e, newWidth: natives[i]!.width } : e));
    ({ shift, scales: editScales } = lineShifts(it.glyphs, remove, effective, bounds));
  }
  const editNative = natives.map((n) => !!n);
  // First removed glyph of each native edit -> what to write there.
  const inserts = new Map<number, Native>();
  natives.forEach((n) => n && inserts.set(n.first, n));
  const editShifts = edits.map((e) => {
    const first = it.glyphs.findIndex((g, i) => remove.has(i) && e.boxes.some((b) => inside(b, g.cx, g.cy)));
    return first >= 0 ? (shift.get(first) ?? 0) : 0;
  });

  // Annotations over the area (redaction only).
  let removedAnnots = 0;
  const removedAnnotRefs: string[] = [];
  if (mode === 'redact') {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) {
      const keep: unknown[] = [];
      const dropped = new Set<string>();
      for (let k = 0; k < annots.size(); k++) {
        const ref = annots.get(k);
        const a = annots.lookup(k);
        if (!(a instanceof PDFDict)) {
          keep.push(ref);
          continue;
        }
        const rect = a.lookup(PDFName.of('Rect'));
        const r = rect instanceof PDFArray && rect.size() === 4 ? Array.from({ length: 4 }, (_, j) => num(rect.lookup(j))) : null;
        const box = r ? { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) } : null;
        if (box && hits(box) && a.lookup(PDFName.of('Subtype')) !== PDFName.of('Popup')) {
          if (a.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) return fail('a form field lies under the redaction');
          dropped.add(String(ref));
          removedAnnots++;
        } else keep.push(ref);
      }
      if (removedAnnots) {
        // Popups of removed annotations go too.
        const final = keep.filter((ref) => {
          const a = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
          const parent: unknown = a instanceof PDFDict ? a.get(PDFName.of('Parent')) : undefined;
          return !(parent && dropped.has(String(parent)));
        });
        for (const ref of keep) if (!final.includes(ref)) dropped.add(String(ref));
        page.node.set(PDFName.of('Annots'), doc.context.obj(final as never[]));
        removedAnnotRefs.push(...dropped);
      }
    }
  }

  // Marked content holding removed letters: its /ActualText, /Alt and /E would still tell them.
  const hitMarks = new Set<number>();
  for (const i of remove) for (const m of it.glyphMarks[i]) hitMarks.add(m);
  const mcids = [...new Set([...hitMarks].map((m) => it.marks[m].mcid).filter((v): v is number => v !== null))];
  const byInstr = new Map<number, string>();
  for (const m of hitMarks) {
    const mark = it.marks[m];
    if (mark.text) byInstr.set(mark.instr, mark.mcid !== null ? `${pdfName(mark.tag)} <</MCID ${mark.mcid}>> BDC` : `${pdfName(mark.tag)} BMC`);
  }
  if (mode === 'redact' && (remove.size || removedAnnots)) {
    // The page's thumbnail and private application data still show the old page.
    page.node.delete(PDFName.of('Thumb'));
    page.node.delete(PDFName.of('PieceInfo'));
  }

  if (remove.size || byInstr.size) {
    // Walk the text flow: `acc` is how far the current text position has been moved.
    let acc = 0;
    for (const s of it.shows) {
      if (s.positioned) acc = 0;
      const r = rewriteShow(s, remove, shift, it.glyphs, acc, inserts);
      acc = r.acc;
      if (r.changed) byInstr.set(s.instr, r.text);
    }
    const parts: string[] = [];
    const chunks: Uint8Array[] = [];
    let last = 0;
    const flushText = () => {
      if (parts.length) chunks.push(new TextEncoder().encode(parts.join('')));
      parts.length = 0;
    };
    it.instrs.forEach((ins, idx) => {
      const s = byInstr.get(idx);
      if (!s) return;
      chunks.push(it.src.subarray(last, ins.start));
      parts.push(s);
      flushText();
      last = ins.end;
    });
    chunks.push(it.src.subarray(last));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    const stream = doc.context.flateStream(out);
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  }
  return { ok: true, removedGlyphs: remove.size, removedAnnots, coversImage, editShifts, editScales, editNative, mcids, removedAnnotRefs };
}

/**
 * Deletes the glyphs `pick` selects (wherever they are), keeping the rest of
 * the text in place. Returns how many were removed; -1 when the page content
 * could not be read.
 */
export function removeGlyphsWhere(doc: PDFDocument, page: PDFPage, pick: (g: Glyph) => boolean): number {
  let it: Interpretation;
  try {
    it = interpret(doc, page);
  } catch {
    return -1;
  }
  const remove = new Set<number>();
  it.glyphs.forEach((g, i) => pick(g) && remove.add(i));
  if (!remove.size) return 0;
  const byInstr = new Map<number, string>();
  let acc = 0;
  for (const s of it.shows) {
    if (s.positioned) acc = 0;
    const r = rewriteShow(s, remove, new Map(), it.glyphs, acc, new Map());
    acc = r.acc;
    if (r.changed) byInstr.set(s.instr, r.text);
  }
  writeContent(doc, page, it, byInstr);
  return remove.size;
}

function writeContent(doc: PDFDocument, page: PDFPage, it: Interpretation, byInstr: Map<number, string>): void {
  const chunks: Uint8Array[] = [];
  let last = 0;
  it.instrs.forEach((ins, idx) => {
    const s = byInstr.get(idx);
    if (!s) return;
    chunks.push(it.src.subarray(last, ins.start), new TextEncoder().encode(s));
    last = ins.end;
  });
  chunks.push(it.src.subarray(last));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
}

/** A name as written in a content stream. */

function pdfName(name: string): string {
  return `/${(name || 'Span').replace(/[^!-~]|[()<>[\]{}/%#]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
}


/**
 * How far each glyph after a replacement must move so the new text fits:
 * the rest of the line moves by the width difference; when the new text is
 * longer, the word spaces after it absorb up to half their width each, so a
 * justified line keeps its right edge. The line may grow up to the next
 * column (table cell) or the page margin; beyond that the replacement is
 * condensed (down to 70% width) and `scales` says by how much.
 */
function lineShifts(glyphs: Glyph[], remove: Set<number>, edits: LineEdit[], bounds: Box): { shift: Map<number, number>; scales: number[] } {
  const shift = new Map<number, number>();
  const scales = edits.map(() => 1);
  // Distance from point o along direction d to the page edge.
  const toEdge = (o: [number, number], d: [number, number]) => {
    let t = Infinity;
    if (d[0] > 1e-6) t = Math.min(t, (bounds.x1 - o[0]) / d[0]);
    if (d[0] < -1e-6) t = Math.min(t, (bounds.x0 - o[0]) / d[0]);
    if (d[1] > 1e-6) t = Math.min(t, (bounds.y1 - o[1]) / d[1]);
    if (d[1] < -1e-6) t = Math.min(t, (bounds.y0 - o[1]) / d[1]);
    return t;
  };
  edits.forEach((e, ei) => {
    const R: number[] = [];
    glyphs.forEach((g, i) => {
      if (remove.has(i) && e.boxes.some((b) => inside(b, g.cx, g.cy))) R.push(i);
    });
    if (!R.length || !Number.isFinite(e.newWidth)) return;
    const first = glyphs[R[0]];
    const last = glyphs[R[R.length - 1]];
    const [dx, dy] = first.dir;
    const along = (g: Glyph) => (g.origin[0] - first.origin[0]) * dx + (g.origin[1] - first.origin[1]) * dy;
    const across = (g: Glyph) => Math.abs(-(g.origin[0] - first.origin[0]) * dy + (g.origin[1] - first.origin[1]) * dx);
    const onLine = glyphs
      .map((g, i) => ({ g, i, a: along(g) }))
      .filter((x) => x.g.dir[0] * dx + x.g.dir[1] * dy > 0.99 && across(x.g) < first.size * 0.3);
    const spanEnd = along(last) + last.advance;
    const after = onLine.filter((x) => !R.includes(x.i) && x.a >= spanEnd - first.size * 0.05).sort((p, q) => p.a - q.a);
    const run: typeof after = [];
    let prevEnd = spanEnd;
    for (const x of after) {
      if (x.a - prevEnd > first.size) break; // column gap
      run.push(x);
      prevEnd = Math.max(prevEnd, x.a + x.g.advance);
    }
    const lineEnd = prevEnd;
    const spaces = run.filter((x) => /^\s$/.test(x.g.text) && !remove.has(x.i));
    const cap = spaces.reduce((sum, x) => sum + x.g.advance * 0.5, 0);
    // How far the line may reach: the next column, or the page edge minus a margin like the line's own.
    const next = after[run.length];
    const lineStart = onLine.reduce((m, x) => (x.a < m.a ? x : m), { a: 0, g: first, i: R[0] });
    const startPt: [number, number] = [first.origin[0] + dx * lineStart.a, first.origin[1] + dy * lineStart.a];
    const margin = Math.max(18, Math.min(72, toEdge(startPt, [-dx, -dy])));
    const limit = Math.max(lineEnd, Math.min(toEdge(first.origin, [dx, dy]) - margin, next ? next.a - first.size * 0.4 : Infinity));
    let width = e.newWidth;
    const endFor = (w: number) => lineEnd + (w - spanEnd) - Math.max(0, Math.min(w - spanEnd, cap));
    if (width > 0 && endFor(width) > limit + 0.1) {
      const fits = limit - lineEnd + spanEnd + cap;
      scales[ei] = Math.max(0.7, Math.min(1, fits / width));
      width *= scales[ei];
    }
    const delta = width - spanEnd;
    if (Math.abs(delta) < 0.3) return;
    const perSpace = delta > 0 && spaces.length ? Math.min(delta, cap) / spaces.length : 0;
    let s = delta;
    for (const x of run) {
      shift.set(x.i, (shift.get(x.i) ?? 0) + s);
      if (perSpace && /^\s$/.test(x.g.text) && !remove.has(x.i)) s -= perSpace;
    }
  });
  return { shift, scales };
}

interface Native {
  first: number;
  last: number;
  /** Restyled: the fill colour to write the letters in, and the colour to restore after them. */
  color?: { rgb: string; restore: string };
  /** Restyled: font resource and size to write the letters with, and the size to restore. */
  font?: { key: string; fs: number; restore: number };
  /** Hex glyph codes, or TJ spacing numbers (for spaces the font never drew). */
  items: Array<string | number>;
  /** New text width and the width of the removed span, user space. */
  width: number;
  span: number;
}

/**
 * The new text of an edit encoded in the font of the letters it replaces,
 * using only glyphs that font already draws on this page (subset fonts hold
 * nothing else). Null when a letter is missing or the span mixes fonts.
 */
function nativeText(it: Interpretation, remove: Set<number>, e: LineEdit): Native | null {
  if (e.text === undefined) return null;
  const R: number[] = [];
  it.glyphs.forEach((g, i) => {
    if (remove.has(i) && e.boxes.some((b) => inside(b, g.cx, g.cy))) R.push(i);
  });
  if (!R.length) return null;
  const ref = it.glyphs[R[0]].run;
  if (R.some((i) => it.glyphs[i].run.key !== ref.key || Math.abs(it.glyphs[i].run.fs - ref.fs) > 1e-3)) return null;
  const enc = new Map<string, number[]>();
  for (const g of it.glyphs) if (g.run.key === ref.key && g.text && [...g.text].length === 1 && !enc.has(g.text)) enc.set(g.text, g.run.bytes);
  const items: Array<string | number> = [];
  let width = 0;
  const ratio = e.sizeRatio && Math.abs(e.sizeRatio - 1) > 1e-3 ? e.sizeRatio : 1;
  const fs = ref.fs * ratio;
  for (const ch of e.text) {
    const bytes = enc.get(ch);
    if (bytes) {
      const code = ref.font.twoByte ? (bytes[0] << 8) | bytes[1] : bytes[0];
      const isSpace = !ref.font.twoByte && code === 32;
      items.push(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
      width += (ref.font.width(code) * fs + ref.Tc + (isSpace ? ref.Tw : 0)) * ref.Th * ref.s;
    } else if (/\s/.test(ch)) {
      // A word space the font never drew: move by a quarter em.
      items.push(-250);
      width += 0.25 * fs * ref.Th * ref.s;
    } else return null;
  }
  const first = it.glyphs[R[0]];
  const last = it.glyphs[R[R.length - 1]];
  const span = (last.origin[0] - first.origin[0]) * first.dir[0] + (last.origin[1] - first.origin[1]) * first.dir[1] + last.advance;
  // Restyled letters: their own colour and size, the original ones restored after them.
  const restyle: Pick<Native, 'color' | 'font'> = {};
  const orig = first.color;
  if (e.color && /^#[0-9a-f]{6}$/i.test(e.color) && e.color.toLowerCase() !== orig.toLowerCase()) restyle.color = { rgb: rgbOp(e.color), restore: rgbOp(orig) };
  if (ratio !== 1) restyle.font = { key: ref.key, fs, restore: ref.fs };
  return { first: R[0], last: R[R.length - 1], items, width, span, ...restyle };
}

/** "#rrggbb" -> "r g b rg". */
function rgbOp(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => fmtNum(Math.round((v / 255) * 1000) / 1000)).join(' ')} rg`;
}

function rewriteShow(s: Show, remove: Set<number>, shift: Map<number, number>, glyphs: Glyph[], accIn: number, inserts: Map<number, Native>): { text: string; changed: boolean; acc: number } {
  let acc = accIn;
  let changed = false;
  let items: string[] = [];
  // Whole operators before the current TJ array: restyled letters get their own colour / size.
  const ops: string[] = [];
  const closeArray = () => {
    if (items.length) ops.push(`[${items.join(' ')}] TJ`);
    items = [];
  };
  let hex = '';
  let pending = 0;
  const flushHex = () => {
    if (hex) items.push(`<${hex}>`);
    hex = '';
  };
  const flushNum = () => {
    if (pending) items.push(fmtNum(Math.round(pending * 1000) / 1000));
    pending = 0;
  };
  for (const p of s.pieces) {
    const ins = p.kind === 'glyph' ? inserts.get(p.glyph!) : undefined;
    if (ins) {
      // Write the new letters, then step back by their width: the removed
      // letters that follow keep their spacing, so the rest of the text flow
      // stays where it was and the line shift moves it as for any replacement.
      flushHex();
      flushNum();
      const restyled = !!(ins.color || ins.font);
      if (restyled) {
        closeArray();
        if (ins.color) ops.push(ins.color.rgb);
        if (ins.font) ops.push(`/${ins.font.key} ${fmtNum(Math.round(ins.font.fs * 1000) / 1000)} Tf`);
      }
      for (const item of ins.items) {
        if (typeof item === 'number') pending += item;
        else {
          flushNum();
          hex += item;
        }
      }
      flushHex();
      if (restyled) {
        flushNum();
        closeArray();
        if (ins.font) ops.push(`/${ins.font.key} ${fmtNum(Math.round(ins.font.restore * 1000) / 1000)} Tf`);
        if (ins.color) ops.push(ins.color.restore);
      }
      pending += ins.width * glyphs[p.glyph!].k;
      changed = true;
    }
    if (p.kind === 'num') {
      flushHex();
      pending += p.v!;
    } else if (remove.has(p.glyph!)) {
      flushHex();
      pending += p.asNum!;
      changed = true;
    } else {
      const d = shift.get(p.glyph!) ?? 0;
      if (Math.abs(d - acc) > 1e-4) {
        flushHex();
        pending += -(d - acc) * glyphs[p.glyph!].k;
        acc = d;
        changed = true;
      }
      flushNum();
      hex += p.bytes!.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  flushHex();
  flushNum();
  closeArray();
  if (!ops.length) ops.push('[] TJ');
  return { text: `${s.prefix ? `${s.prefix} ` : ''}${ops.join(' ')}`, changed, acc };
}

