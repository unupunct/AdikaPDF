/**
 * Fonts for letters a PDF's own (subset) font lacks, when text is edited or
 * replaced. In order of preference:
 * 1. the same typeface installed in Windows, matched by PostScript name
 *    ("ArialMT", "Arial-BoldMT", "TimesNewRomanPSMT") or by family and style
 *    read from the installed fonts' name tables, with a few metric twins
 *    (Helvetica -> Arial, Times -> Times New Roman, Courier -> Courier New);
 *    fonts whose licence forbids embedding (OS/2 fsType) are skipped;
 * 2. Liberation Sans (shipped with pdf.js, metric-compatible with Arial and
 *    Helvetica) for those families;
 * 3. Noto Sans / Serif / Sans Mono in the original's weight and slant.
 * Only the missing letters are drawn in the fallback font, scaled so its cap
 * height (x-height for lowercase-only letters) matches the original.
 */
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontVariant } from '@/lib/fonts';
import type { SystemFont } from '@/lib/platform';
import { embedFontForText } from './fontEmbed';
import { embeddingAllowed, fontFromCollection, readFontProgram, type FontProgram } from './fontProgram';
import type { FontStyle } from './fontCodes';
import { lettersToSupply, type FallbackFont, type LineEdit } from './textRemoval';

export interface FallbackSources {
  /** Fonts installed in Windows (empty elsewhere). */
  installed: () => Promise<SystemFont[]>;
  readInstalled: (path: string) => Promise<Uint8Array>;
  /** Liberation Sans in a style; null when unavailable. */
  liberationSans: (bold: boolean, italic: boolean) => Promise<Uint8Array | null>;
  /** Adika's bundled Noto fonts. */
  noto: (v: FontVariant) => Promise<Uint8Array>;
}

export interface FallbackFace {
  id: string;
  /** Font name shown to the user. */
  label: string;
  installed: boolean;
  bytes: Uint8Array;
  program: FontProgram;
  /** The licence allows subsetting (otherwise the whole font is embedded). */
  prune: boolean;
}

export interface FallbackPlan {
  /** Faces to try, in order; together they cover the letters they can. */
  faces: FallbackFace[];
  /** Installed fonts that matched but may not be embedded (licence). */
  restricted: string[];
}

export function defaultFallbackSources(loadFont: (v: FontVariant) => Promise<Uint8Array>): FallbackSources {
  return {
    installed: async () => (await import('@/lib/platform')).systemFonts().catch(() => []),
    readInstalled: async (path) => (await import('@/lib/platform')).readSystemFont(path),
    liberationSans: async (bold, italic) => {
      const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
      try {
        const url = new URL(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/LiberationSans-${style}.ttf`, document.baseURI).href;
        const r = await fetch(url);
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
    noto: loadFont,
  };
}

// ---------------------------------------------------------------- matching installed fonts

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Families that look (and measure) the same as a PDF base font. */
const TWINS: Record<string, string[]> = {
  helvetica: ['arial', 'liberationsans', 'arimo'],
  arial: ['liberationsans', 'arimo'],
  arimo: ['arial', 'liberationsans'],
  liberationsans: ['arial', 'arimo'],
  times: ['timesnewroman', 'liberationserif', 'tinos'],
  timesroman: ['timesnewroman', 'liberationserif', 'tinos'],
  timesnewroman: ['liberationserif', 'tinos'],
  courier: ['couriernew', 'liberationmono', 'cousine'],
  couriernew: ['liberationmono', 'cousine'],
  calibri: ['carlito'],
  cambria: ['caladea'],
};

/** "ABCDEF+Arial-BoldItalicMT" -> family "arial", bold, italic. */
export function parseBaseName(base: string): { ps: string; family: string; bold: boolean; italic: boolean } {
  // Subset prefix "ABCDEF+"; pdf-lib's random suffix "-1234".
  const ps = base.replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '').trim();
  const cut = ps.search(/[-,]/);
  let fam = cut > 0 ? ps.slice(0, cut) : ps;
  let sty = cut > 0 ? ps.slice(cut + 1) : '';
  // Style words glued to the name ("CalibriBold", "Segoe UI Bold").
  const glued = /^(.*?)[\s_]*((?:Semi|Demi|Extra|Ultra)?(?:Bold|Black|Heavy|Medium|Light|Italic|Oblique|Regular|Roman|Book)(?:[\s_]*(?:Italic|Oblique))?)$/.exec(fam);
  if (!sty && glued && glued[1].length > 2) {
    fam = glued[1];
    sty = glued[2];
  }
  fam = fam.replace(/(PSMT|PS|MT)$/, '');
  sty = sty.replace(/(PSMT|PS|MT)$/, '');
  return { ps, family: norm(fam), bold: /bold|black|heavy|semibold|demi/i.test(sty), italic: /italic|oblique|kursiv/i.test(sty) };
}

function faceStyle(f: SystemFont): { bold: boolean; italic: boolean } {
  const sub = `${f.typoSubfamily} ${f.subfamily}`;
  return { bold: f.bold || f.weight >= 600 || /bold|black|heavy/i.test(sub), italic: f.italic || /italic|oblique/i.test(sub) };
}

/** Installed fonts that can stand in for the PDF font, best first. */
export function matchInstalled(fonts: SystemFont[], style: FontStyle): SystemFont[] {
  const want = parseBaseName(style.baseName);
  const bold = style.bold || want.bold;
  const italic = style.italic || want.italic;
  const twins = TWINS[want.family] ?? [];
  const scored: Array<{ f: SystemFont; score: number }> = [];
  for (const f of fonts) {
    let score = 0;
    if (f.postscript && norm(f.postscript) === norm(want.ps)) score = 100;
    else {
      const fs = faceStyle(f);
      if (fs.bold !== bold || fs.italic !== italic) continue;
      const fams = [f.typoFamily, f.family].filter(Boolean).map(norm);
      if (want.family && fams.includes(want.family)) score = 80 - (f.typoFamily && norm(f.typoFamily) !== norm(f.family) && fams[0] !== want.family ? 5 : 0);
      else if (fams.some((x) => twins.includes(x))) score = 60 - twins.indexOf(fams.find((x) => twins.includes(x))!);
      // Regular weight (400) for regular text, 700 for bold: other weights only after them.
      if (score) score -= Math.abs(f.weight - (bold ? 700 : 400)) / 100;
    }
    if (score > 0) scored.push({ f, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.f);
}

// ---------------------------------------------------------------- planning

const faceCache = new Map<string, Promise<FallbackFace | null>>();

function makeFace(id: string, label: string, installed: boolean, bytes: Uint8Array): FallbackFace | null {
  const program = readFontProgram(bytes);
  if (!program) return null;
  return { id, label, installed, bytes, program, prune: (program.fsType & 0x0100) === 0 };
}

function cached(id: string, load: () => Promise<FallbackFace | null>): Promise<FallbackFace | null> {
  let p = faceCache.get(id);
  if (!p) {
    p = load().catch(() => null);
    faceCache.set(id, p);
  }
  return p;
}

export function faceHas(face: FallbackFace, ch: string): boolean {
  const g = face.program.gidForUnicode(ch.codePointAt(0) ?? 0);
  return g > 0 && face.program.hasOutline(g);
}

/** Fallback faces for `chars` of a font with `style`. */
export async function planFallback(style: FontStyle, chars: string, src: FallbackSources): Promise<FallbackPlan> {
  const faces: FallbackFace[] = [];
  const restricted: string[] = [];
  let left = [...new Set(chars)];
  const take = (face: FallbackFace | null) => {
    if (!face || !left.length) return;
    const covered = left.filter((ch) => faceHas(face, ch));
    if (!covered.length) return;
    faces.push(face);
    left = left.filter((ch) => !covered.includes(ch));
  };
  // 1. Installed in Windows.
  const installed = matchInstalled(await src.installed().catch(() => []), style).slice(0, 4);
  for (const f of installed) {
    if (!left.length) break;
    if (!embeddingAllowed(f.fsType)) {
      restricted.push(f.fullName || f.family);
      continue;
    }
    const face = await cached(`installed:${f.path}#${f.index}`, async () => {
      const raw = await src.readInstalled(f.path);
      return makeFace(`installed:${f.path}#${f.index}`, f.fullName || f.family, true, fontFromCollection(raw, f.index));
    });
    // The file's own OS/2 table decides, should the index be stale.
    if (face && !embeddingAllowed(face.program.fsType)) {
      restricted.push(face.label);
      continue;
    }
    take(face);
  }
  // 2. Metric-compatible open font.
  const want = parseBaseName(style.baseName);
  const bold = style.bold || want.bold;
  const italic = style.italic || want.italic;
  if (left.length && ['arial', 'helvetica', 'arimo', 'liberationsans', 'nimbussans', 'helveticaneue'].includes(want.family)) {
    const id = `open:liberation-sans:${bold}:${italic}`;
    take(await cached(id, async () => {
      const b = await src.liberationSans(bold, italic);
      return b ? makeFace(id, 'Liberation Sans', false, b) : null;
    }));
  }
  // 3. Noto in the matching style.
  if (left.length) {
    const family = style.mono ? 'mono' : style.serif ? 'serif' : 'sans';
    const v: FontVariant = { family, bold, italic: italic && family !== 'mono' };
    const id = `open:noto:${family}:${v.bold}:${v.italic}`;
    take(await cached(id, async () => makeFace(id, family === 'mono' ? 'Noto Sans Mono' : family === 'serif' ? 'Noto Serif' : 'Noto Sans', false, await src.noto(v))));
  }
  return { faces, restricted };
}

/** Size of fallback letters relative to the original: same cap height (x-height when all are lowercase), within ±15%. */
export function fallbackSizeRatio(style: FontStyle, face: FallbackFace, chars: string): number {
  const lower = [...chars].every((c) => c !== c.toUpperCase() && c === c.toLowerCase());
  const p = face.program;
  const r = lower && style.xHeight > 0 && p.xHeight > 0 ? style.xHeight / p.xHeight : style.capHeight > 0 && p.capHeight > 0 ? style.capHeight / p.capHeight : 1;
  if (!Number.isFinite(r) || Math.abs(r - 1) < 0.02) return 1;
  return Math.max(0.85, Math.min(1.15, r));
}

/**
 * Prepares fallback fonts for the edits of the given pages: finds the
 * letters each edit's document font cannot draw, picks fonts for them,
 * embeds those (only the glyphs needed) and sets `LineEdit.fallbacks`.
 */
export async function attachFallbacks(doc: PDFDocument, pages: Array<{ page: PDFPage; edits: LineEdit[] }>, src: FallbackSources): Promise<void> {
  const needs = pages.map(({ page, edits }) => lettersToSupply(doc, page, edits));
  // One plan per document font style, for all its missing letters.
  const byStyle = new Map<string, { style: FontStyle; chars: string }>();
  const keyOf = (s: FontStyle) => [s.baseName, s.bold, s.italic, s.serif, s.mono].join('|');
  for (const list of needs) {
    for (const n of list) {
      if (!n) continue;
      const k = keyOf(n.style);
      const cur = byStyle.get(k) ?? { style: n.style, chars: '' };
      for (const ch of n.chars) if (!cur.chars.includes(ch)) cur.chars += ch;
      byStyle.set(k, cur);
    }
  }
  if (!byStyle.size) return;
  const plans = new Map<string, FallbackPlan>();
  for (const [k, { style, chars }] of byStyle) plans.set(k, await planFallback(style, chars, src));
  // Each face embedded once, with every letter it draws anywhere.
  const faceChars = new Map<string, { face: FallbackFace; chars: string }>();
  for (const [k, plan] of plans) {
    let left = byStyle.get(k)!.chars;
    for (const face of plan.faces) {
      const mine = [...left].filter((ch) => faceHas(face, ch)).join('');
      left = [...left].filter((ch) => !mine.includes(ch)).join('');
      const cur = faceChars.get(face.id) ?? { face, chars: '' };
      cur.chars += mine;
      faceChars.set(face.id, cur);
    }
  }
  doc.registerFontkit(fontkit);
  const embedded = new Map<string, PDFFont>();
  for (const [id, { face, chars }] of faceChars) {
    if (chars) embedded.set(id, await embedFontForText(doc, face.bytes, [chars], { prune: face.prune }));
  }
  needs.forEach((list, pi) =>
    list.forEach((n, ei) => {
      if (!n) return;
      const plan = plans.get(keyOf(n.style));
      const fonts: FallbackFont[] = [];
      for (const face of plan?.faces ?? []) {
        const font = embedded.get(face.id);
        if (!font) continue;
        const mine = [...n.chars].filter((ch) => faceHas(face, ch)).join('');
        fonts.push({
          ref: font.ref,
          label: face.label,
          installed: face.installed,
          // Only letters embedded with outlines (the font is pruned to them).
          has: (ch) => faceChars.get(face.id)!.chars.includes(ch),
          hex: (ch) => font.encodeText(ch).toString().replace(/[<>]/g, ''),
          width: (ch) => font.widthOfTextAtSize(ch, 1),
          sizeRatio: fallbackSizeRatio(n.style, face, mine || n.chars),
        });
      }
      if (fonts.length) pages[pi].edits[ei].fallbacks = fonts;
    }),
  );
}
