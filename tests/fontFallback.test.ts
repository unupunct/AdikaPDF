import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzePageText, removeGlyphs, type Box, type LineEdit, type PageText } from '@/lib/pdf/textRemoval';
import { attachFallbacks, matchInstalled, parseBaseName, planFallback, type FallbackSources } from '@/lib/pdf/fontFallback';
import { embeddingAllowed, fontFromCollection, readFontProgram } from '@/lib/pdf/fontProgram';
import { embedFontForText } from '@/lib/pdf/fontEmbed';
import { writeToUnicode } from '@/lib/pdf/fontEncoding';
import { buildPdf, type FontFallbackNote } from '@/lib/pdf/exportPdf';
import { findTextMatches, queryFinder } from '@/lib/pdf/textSearch';
import type { FontStyle } from '@/lib/pdf/fontCodes';
import type { FontVariant } from '@/lib/fonts';
import type { SystemFont } from '@/lib/platform';
import type { PageRef, SourceDoc, TextObject } from '@/types';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function notoBytes(v: FontVariant): Uint8Array {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`)));
}
const SANS = notoBytes({ family: 'sans', bold: false, italic: false });
const ARIAL = 'C:/Windows/Fonts/arial.ttf';
const LIBERATION = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

/** Page text as a reader copies it: items of one line joined, lines with spaces. */
async function pdfjsText(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  const c = await (await (await task.promise).getPage(1)).getTextContent();
  return c.items
    .map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : ''))
    .join('')
    .replace(/[ \t]+/g, ' ');
}

function boxesOf(t: PageText, word: string): Box[] {
  const at = t.text.indexOf(word);
  expect(at, `"${word}" in "${t.text}"`).toBeGreaterThanOrEqual(0);
  const idx = new Set(t.map.slice(at, at + word.length).filter((i) => i >= 0));
  return [...idx].map((i) => t.glyphs[i].box);
}

/** A document drawing `text` in a Type0 font: the whole program, or pruned to the letters used (as subset fonts are). */
async function cidDoc(text: string, fontBytes: Uint8Array, prune: boolean): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = prune ? await embedFontForText(doc, fontBytes, [text]) : await doc.embedFont(fontBytes, { subset: false });
  const p = doc.addPage([595, 842]);
  p.drawText(text, { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  return PDFDocument.load(await doc.save());
}

/** A simple TrueType font (WinAnsi, /Widths 32-126) over `program`, the way Word writes them. */
async function trueTypeDoc(text: string, program: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const fk = fontkit.create(SANS);
  const widths: number[] = [];
  for (let c = 32; c <= 126; c++) widths.push(Math.round((fk.glyphForCodePoint(c).advanceWidth * 1000) / fk.unitsPerEm));
  const ctx = doc.context;
  const ff = ctx.register(ctx.flateStream(program, { Length1: program.length }));
  const fd = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+NotoSans-Regular', Flags: 32, FontBBox: [-621, -389, 2800, 1067], ItalicAngle: 0, Ascent: 1069, Descent: -293, CapHeight: 714, XHeight: 536, StemV: 80, FontFile2: ff }));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+NotoSans-Regular', FirstChar: 32, LastChar: 126, Widths: widths, Encoding: 'WinAnsiEncoding', FontDescriptor: fd }));
  const page = doc.addPage([595, 842]);
  page.node.setFontDictionary(PDFName.of('F1'), font);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`BT /F1 12 Tf 50 700 Td (${text}) Tj ET`)));
  return PDFDocument.load(await doc.save());
}

function sources(over: Partial<FallbackSources> & { notoCalls?: FontVariant[] } = {}): FallbackSources {
  return {
    installed: async () => [],
    readInstalled: async (p) => new Uint8Array(readFileSync(p)),
    liberationSans: async (bold, italic) => {
      const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
      return new Uint8Array(readFileSync(join(LIBERATION, `LiberationSans-${style}.ttf`)));
    },
    noto: async (v) => {
      over.notoCalls?.push(v);
      return notoBytes(v);
    },
    ...over,
  };
}

function sysFont(f: Partial<SystemFont>): SystemFont {
  return { path: '', index: 0, family: '', subfamily: 'Regular', typoFamily: '', typoSubfamily: '', fullName: '', postscript: '', weight: 400, italic: false, bold: false, fsType: 0, ...f };
}

/** Edits `word` -> `next` on page 1 the way saving does: fallbacks first, then the engine. */
async function edit(doc: PDFDocument, word: string, next: string, src: FallbackSources | null, extra: Partial<LineEdit> = {}) {
  const page = doc.getPage(0);
  const t = analyzePageText(doc, page);
  const edits: LineEdit[] = [{ boxes: boxesOf(t, word), newWidth: next.length * 6, text: next, ...extra }];
  if (src) await attachFallbacks(doc, [{ page, edits }], src);
  const res = removeGlyphs(doc, page, edits[0].boxes, 'replace', edits);
  const bytes = await doc.save();
  return { res, edits, bytes, after: await PDFDocument.load(bytes) };
}

/** Letters of the first line keep their order and never overlap. */
function expectNoOverlaps(doc: PDFDocument) {
  const t = analyzePageText(doc, doc.getPage(0));
  const line = t.glyphs.filter((g) => Math.abs(g.origin[1] - 700) < 1).sort((a, b) => a.origin[0] - b.origin[0]);
  for (let i = 1; i < line.length; i++) expect(line[i].origin[0], `${line[i - 1].text}${line[i].text}`).toBeGreaterThanOrEqual(line[i - 1].origin[0] + line[i - 1].advance - 0.05);
  return line;
}

function pageFonts(page: PDFPage): string[] {
  const res = page.node.Resources();
  const fonts = res?.lookup(PDFName.of('Font'));
  return fonts instanceof PDFDict ? fonts.keys().map((k) => k.decodeText()) : [];
}

describe("letters the document's font has but does not map", () => {
  it('Type0: a glyph of the embedded program gets a ToUnicode and width entry', async () => {
    const doc = await cidDoc('Contract semnat de Stefan Ionescu', SANS, false);
    // A ToUnicode that lists only the glyphs drawn (as most PDF producers write it).
    const t = analyzePageText(doc, doc.getPage(0));
    const type0 = doc.context.lookup(doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).values()[0], PDFDict);
    const drawn = new Map(t.glyphs.map((g) => [(g.run.bytes[0] << 8) | g.run.bytes[1], g.text]));
    type0.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(writeToUnicode(drawn, true))));
    const { res, bytes, after } = await edit(doc, 'Stefan', 'Ștefan', null);
    expect(res.editNative).toEqual([true]);
    expect(res.editFonts[0]).toEqual({ added: 'Ș', fallback: [] });
    expect(pageFonts(after.getPage(0))).toHaveLength(1);
    expect(await pdfjsText(bytes)).toContain('Contract semnat de Ștefan Ionescu');
    const line = expectNoOverlaps(after);
    expect(line.map((g) => g.text).join('')).toContain('Ștefan');
  });

  it('simple TrueType: a free code is added to /Differences and /Widths', async () => {
    const doc = await trueTypeDoc('Semnat de Stefan Ionescu', SANS);
    const { res, bytes, after } = await edit(doc, 'Stefan', 'Ștefan', null);
    expect(res.editNative).toEqual([true]);
    expect(res.editFonts[0]?.added).toBe('Ș');
    const font = after.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
    const diffs = font.lookup(PDFName.of('Encoding'), PDFDict).lookup(PDFName.of('Differences'), PDFArray);
    const code = diffs.lookup(0, PDFNumber).asNumber();
    expect(code === 32 || (code >= 33 && code <= 126)).toBe(false);
    expect(font.lookup(PDFName.of('Encoding'), PDFDict).lookup(PDFName.of('BaseEncoding'))).toBe(PDFName.of('WinAnsiEncoding'));
    expect(font.lookup(PDFName.of('LastChar'), PDFNumber).asNumber()).toBeGreaterThanOrEqual(code);
    expect(await pdfjsText(bytes)).toContain('Semnat de Ștefan Ionescu');
    expectNoOverlaps(after);
  });

  it('standard font (not embedded): € by its WinAnsi code, Ț by a /Differences name with its metrics', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('Total 100 EUR achitat', { x: 50, y: 700, size: 12, font });
    const loaded = await PDFDocument.load(await doc.save());
    const { res, bytes, after } = await edit(loaded, 'EUR', '€ Ț', null);
    expect(res.editNative).toEqual([true]);
    expect(res.editFonts[0]?.added).toBe('Ț');
    expect(await pdfjsText(bytes)).toContain('Total 100 € Ț achitat');
    expectNoOverlaps(after);
  });

  it('does not use an empty glyph slot of a pruned subset', async () => {
    const doc = await cidDoc('Semnat de Stefan Ionescu', SANS, true);
    const { res } = await edit(doc, 'Stefan', 'Ștefan', null);
    expect(res.editNative).toEqual([false]); // nothing to draw Ș with: Adika's font draws the edit
  });
});

describe('fallback fonts for missing letters', () => {
  it('draws only the missing letters in the same typeface installed in Windows', async () => {
    const doc = await cidDoc('Semnat de Stefan Ionescu', SANS, true);
    const src = sources({ installed: async () => [sysFont({ path: 'noto.ttf', family: 'Noto Sans', fullName: 'Noto Sans Regular', postscript: 'NotoSans-Regular' })], readInstalled: async () => SANS });
    const { res, bytes, after } = await edit(doc, 'Stefan', 'Ștefan', src);
    expect(res.editNative).toEqual([true]);
    expect(res.editFonts[0]).toEqual({ added: '', fallback: [{ font: 'Noto Sans Regular', installed: true, chars: 'Ș' }] });
    expect(pageFonts(after.getPage(0))).toHaveLength(2);
    // Same font: same size; ToUnicode of the fallback reads the letter.
    expect(new TextDecoder('latin1').decode(analyzeContent(after))).toMatch(/\/AdkFb1 12 Tf/);
    expect(await pdfjsText(bytes)).toContain('Semnat de Ștefan Ionescu');
    const line = expectNoOverlaps(after);
    // The rest of the line moved by the width difference only (Ș is as wide as S in Noto Sans).
    const sx = line.find((g) => g.text === 'Ș')!;
    const i = line.find((g) => g.text === 'I')!;
    expect(i.origin[0] - sx.origin[0]).toBeCloseTo(sx.advance + widthOf(line, sx, i), 0);
  });

  it('uses Arial from C:\\Windows\\Fonts for an ArialMT subset (when installed)', async (ctx) => {
    if (!existsSync(ARIAL)) ctx.skip();
    const arial = new Uint8Array(readFileSync(ARIAL));
    const doc = await cidDoc('Semnat de Stefan Ionescu', arial, true);
    const src = sources({ installed: async () => [sysFont({ path: ARIAL, family: 'Arial', fullName: 'Arial', postscript: 'ArialMT' })] });
    const { res, bytes, edits } = await edit(doc, 'Stefan', 'Ștefan ț', src);
    expect(res.editFonts[0]?.fallback).toEqual([{ font: 'Arial', installed: true, chars: 'Șț' }]);
    expect(edits[0].fallbacks?.[0].sizeRatio).toBe(1);
    expect(await pdfjsText(bytes)).toContain('Semnat de Ștefan ț Ionescu');
  });

  it('works on a renumbered (fontkit) subset of Arial too (when installed)', async (ctx) => {
    if (!existsSync(ARIAL)) ctx.skip();
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const font = await d.embedFont(readFileSync(ARIAL), { subset: true });
    d.addPage([595, 842]).drawText('Semnat de Stefan Ionescu, Bucuresti', { x: 50, y: 700, size: 12, font });
    const doc = await PDFDocument.load(await d.save());
    const src = sources({ installed: async () => [sysFont({ path: ARIAL, family: 'Arial', fullName: 'Arial', postscript: 'ArialMT' })] });
    const { res, bytes, after } = await edit(doc, 'Stefan', 'Ștefan', src);
    expect(res.editFonts[0]?.fallback).toEqual([{ font: 'Arial', installed: true, chars: 'Ș' }]);
    expect(await pdfjsText(bytes)).toContain('Semnat de Ștefan Ionescu, Bucuresti');
    expectNoOverlaps(after);
  });

  it('falls back to Noto in the style of the original font (serif, italic from the descriptor flags)', async () => {
    const doc = await cidDoc('Semnat de Stefan Ionescu', SANS, true);
    // An anonymous font name: only /Flags tell the style.
    const type0 = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).values()[0];
    const t0 = doc.context.lookup(type0, PDFDict);
    t0.set(PDFName.of('BaseFont'), PDFName.of('ABCDEF+F1'));
    const cid = t0.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    cid.lookup(PDFName.of('FontDescriptor'), PDFDict).set(PDFName.of('Flags'), PDFNumber.of(2 | 32 | 64));
    const notoCalls: FontVariant[] = [];
    const { res, bytes } = await edit(doc, 'Stefan', 'Ștefan', sources({ notoCalls }));
    expect(notoCalls).toEqual([{ family: 'serif', bold: false, italic: true }]);
    expect(res.editFonts[0]?.fallback).toEqual([{ font: 'Noto Serif', installed: false, chars: 'Ș' }]);
    expect(await pdfjsText(bytes)).toContain('Ștefan Ionescu');
  });

  it('chooses Liberation Sans for Arial / Helvetica and Noto Sans Mono for Courier', async () => {
    const style = (baseName: string, more: Partial<FontStyle> = {}): FontStyle => ({ baseName, bold: false, italic: false, serif: false, mono: false, capHeight: 0.716, xHeight: 0.519, ...more });
    const helv = await planFallback(style('ABCDEF+Helvetica-Bold', { bold: true }), 'ț€', sources());
    expect(helv.faces.map((f) => f.label)).toEqual(['Liberation Sans']);
    expect(helv.faces[0].id).toContain('true:false');
    const cour = await planFallback(style('CourierNewPSMT', { mono: true }), 'ț', sources());
    expect(cour.faces.map((f) => f.label)).toEqual(['Noto Sans Mono']);
    const times = await planFallback(style('TimesNewRomanPS-BoldItalicMT', { serif: true }), 'ț', sources());
    expect(times.faces[0].id).toBe('open:noto:serif:true:true');
  });

  it('scales fallback letters to the original cap height', async () => {
    const doc = await cidDoc('Semnat de Stefan Ionescu', SANS, true);
    const type0 = doc.context.lookup(doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).values()[0], PDFDict);
    const fd = type0.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'), PDFDict);
    // A font with taller capitals than Noto Sans (714): fallback letters grow, within 15%.
    fd.set(PDFName.of('CapHeight'), PDFNumber.of(770));
    const { edits, bytes } = await edit(doc, 'Stefan', 'Ștefan', sources());
    expect(edits[0].fallbacks?.[0].sizeRatio).toBeCloseTo(770 / 714, 2);
    expect(await pdfjsText(bytes)).toContain('Ștefan Ionescu');
  });

  it('restyled text: fallback letters take the new colour and size, the original is restored', async () => {
    const doc = await cidDoc('Semnat de Stefan Ionescu', SANS, true);
    const { res, bytes, after } = await edit(doc, 'Stefan', 'Ștefan', sources(), { color: '#ff0000', sizeRatio: 1.5 });
    expect(res.editNative).toEqual([true]);
    const content = new TextDecoder('latin1').decode(analyzeContent(after));
    expect(content).toMatch(/1 0 0 rg[^]*\/AdkFb1 18 Tf[^]*0 0 0 rg/);
    expect(await pdfjsText(bytes)).toContain('Ștefan');
  });
});

describe('licences and font files', () => {
  /** Noto Sans with OS/2 fsType set (2 = restricted licence embedding). */
  function withFsType(fsType: number): Uint8Array {
    const b = SANS.slice();
    const dv = new DataView(b.buffer);
    for (let i = 0; i < dv.getUint16(4); i++) {
      const e = 12 + i * 16;
      if (String.fromCharCode(b[e], b[e + 1], b[e + 2], b[e + 3]) === 'OS/2') dv.setUint16(dv.getUint32(e + 8) + 8, fsType);
    }
    return b;
  }

  it('never embeds an installed font whose licence restricts embedding', async () => {
    expect(embeddingAllowed(0)).toBe(true);
    expect(embeddingAllowed(4)).toBe(true);
    expect(embeddingAllowed(8)).toBe(true);
    expect(embeddingAllowed(2)).toBe(false);
    expect(embeddingAllowed(0x200)).toBe(false);
    const style: FontStyle = { baseName: 'NotoSans-Regular', bold: false, italic: false, serif: false, mono: false, capHeight: 0, xHeight: 0 };
    let reads = 0;
    // The index says restricted: not even read.
    const a = await planFallback(style, 'Ș', sources({ installed: async () => [sysFont({ path: 'r.ttf', family: 'Noto Sans', fullName: 'Restricted Sans', postscript: 'NotoSans-Regular', fsType: 2 })], readInstalled: async () => (reads++, SANS) }));
    expect(reads).toBe(0);
    expect(a.restricted).toEqual(['Restricted Sans']);
    expect(a.faces.map((f) => [f.label, f.installed])).toEqual([['Noto Sans', false]]);
    // The file itself says restricted (stale index): read, then refused.
    const b = await planFallback(style, 'Ș', sources({ installed: async () => [sysFont({ path: 'r2.ttf', family: 'Noto Sans', fullName: 'Restricted Sans 2', postscript: 'NotoSans-Regular' })], readInstalled: async () => withFsType(2) }));
    expect(b.restricted).toEqual(['Restricted Sans 2']);
    expect(b.faces.every((f) => !f.installed)).toBe(true);
    // No-subsetting fonts are embedded whole.
    const c = await planFallback(style, 'Ș', sources({ installed: async () => [sysFont({ path: 'ns.ttf', family: 'Noto Sans', fullName: 'Whole Sans', postscript: 'NotoSans-Regular' })], readInstalled: async () => withFsType(0x100) }));
    expect(c.faces[0]).toMatchObject({ label: 'Whole Sans', installed: true, prune: false });
  });

  it('matches PDF base names to installed fonts', () => {
    expect(parseBaseName('ABCDEF+Arial-BoldItalicMT')).toEqual({ ps: 'Arial-BoldItalicMT', family: 'arial', bold: true, italic: true });
    expect(parseBaseName('TimesNewRomanPSMT')).toMatchObject({ family: 'timesnewroman', bold: false });
    expect(parseBaseName('Arial,Bold')).toMatchObject({ family: 'arial', bold: true, italic: false });
    expect(parseBaseName('NotoSans-Regular-8412')).toMatchObject({ ps: 'NotoSans-Regular', family: 'notosans' });
    expect(parseBaseName('CalibriBold')).toMatchObject({ family: 'calibri', bold: true });
    const fonts = [
      sysFont({ path: 'arial.ttf', family: 'Arial', postscript: 'ArialMT' }),
      sysFont({ path: 'arialbd.ttf', family: 'Arial', subfamily: 'Bold', postscript: 'Arial-BoldMT', weight: 700, bold: true }),
      sysFont({ path: 'ariblk.ttf', family: 'Arial Black', postscript: 'Arial-Black', weight: 900, bold: true }),
      sysFont({ path: 'times.ttf', family: 'Times New Roman', postscript: 'TimesNewRomanPSMT' }),
      sysFont({ path: 'segoeuib.ttf', family: 'Segoe UI', subfamily: 'Bold', postscript: 'SegoeUI-Bold', weight: 700, bold: true }),
      sysFont({ path: 'cour.ttf', family: 'Courier New', postscript: 'CourierNewPSMT' }),
    ];
    const s = (baseName: string, bold = false): FontStyle => ({ baseName, bold, italic: false, serif: false, mono: false, capHeight: 0, xHeight: 0 });
    expect(matchInstalled(fonts, s('ABCDEF+Arial-BoldMT', true))[0].path).toBe('arialbd.ttf');
    expect(matchInstalled(fonts, s('Arial,Bold', true))[0].path).toBe('arialbd.ttf');
    expect(matchInstalled(fonts, s('ABCDEF+ArialMT'))[0].path).toBe('arial.ttf');
    expect(matchInstalled(fonts, s('Helvetica'))[0].path).toBe('arial.ttf');
    expect(matchInstalled(fonts, s('Times-Roman'))[0].path).toBe('times.ttf');
    expect(matchInstalled(fonts, s('Courier'))[0].path).toBe('cour.ttf');
    expect(matchInstalled(fonts, s('ABCDEF+SegoeUI-Bold', true))[0].path).toBe('segoeuib.ttf');
    expect(matchInstalled(fonts, s('Garamond'))).toEqual([]);
  });

  it('reads one font out of a .ttc collection', () => {
    const ttc = 'C:/Windows/Fonts/cambria.ttc';
    if (!existsSync(ttc)) return;
    const one = fontFromCollection(new Uint8Array(readFileSync(ttc)), 0);
    const p = readFontProgram(one)!;
    expect(p.gidForUnicode('ț'.codePointAt(0)!)).toBeGreaterThan(0);
    expect(fontkit.create(one).postscriptName).toBe('Cambria');
  });
});

describe('Find & replace and Edit text through the exporter', () => {
  it('replaces with a missing letter in the document font plus the fallback, and reports it', async () => {
    const doc = await cidDoc('Client: Stefan Ionescu, Bucuresti', SANS, true);
    const src: SourceDoc = { id: 's', name: 's.pdf', bytes: await doc.save() } as SourceDoc;
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 };
    const [m] = await findTextMatches([ref], { s: src }, queryFinder('Bucuresti'));
    const t: TextObject = { id: 't', type: 'text', pageId: ref.id, x: m.origin[0] - 2, y: m.origin[1] - 11, width: 120, height: 16, rotation: 0, opacity: 1, text: 'București', fontFamily: m.family, bold: m.bold, italic: m.italic, fontSize: 12, color: m.color, align: 'left', lineHeight: 1.25, background: null, replaces: m.rects };
    const notes: FontFallbackNote[] = [];
    const out = await buildPdf(
      { sources: { s: src }, pages: [ref], objects: [t], fieldValues: {} },
      { loadFont: async (v) => notoBytes(v), measure: (_v, size) => (s) => s.length * size * 0.5, fallbackFonts: sources(), onFontFallback: (n) => notes.push(...n) },
    );
    expect(notes).toEqual([{ objectId: 't', text: 'București', fallback: [{ font: 'Noto Sans', installed: false, chars: 'ș' }] }]);
    const text = await pdfjsText(out);
    expect(text).toContain('Client: Stefan Ionescu, București');
    expect(text.match(/Bucure/g)).toHaveLength(1); // written once, in the page content
    expectNoOverlaps(await PDFDocument.load(out));
  });

  it('without fallback fonts the edit is drawn in Adika’s font as before', async () => {
    const doc = await cidDoc('Client: Stefan Ionescu, Bucuresti', SANS, true);
    const src: SourceDoc = { id: 's', name: 's.pdf', bytes: await doc.save() } as SourceDoc;
    const ref: PageRef = { id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 };
    const [m] = await findTextMatches([ref], { s: src }, queryFinder('Bucuresti'));
    const t: TextObject = { id: 't', type: 'text', pageId: ref.id, x: m.origin[0] - 2, y: m.origin[1] - 11, width: 120, height: 16, rotation: 0, opacity: 1, text: 'București', fontFamily: m.family, bold: m.bold, italic: m.italic, fontSize: 12, color: m.color, align: 'left', lineHeight: 1.25, background: null, replaces: m.rects };
    const notes: FontFallbackNote[] = [];
    const out = await buildPdf({ sources: { s: src }, pages: [ref], objects: [t], fieldValues: {} }, { loadFont: async (v) => notoBytes(v), measure: (_v, size) => (s) => s.length * size * 0.5, fallbackFonts: null, onFontFallback: (n) => notes.push(...n) });
    expect(notes).toEqual([]);
    expect(await pdfjsText(out)).toContain('București');
  });
});

function analyzeContent(doc: PDFDocument): Uint8Array {
  const page = doc.getPage(0);
  const c = page.node.Contents();
  const parts = c instanceof PDFArray ? c.asArray() : [c];
  const chunks = parts.map((r) => {
    const s = doc.context.lookup(r as never) as unknown as { getContents(): Uint8Array; dict: PDFDict };
    const raw = s.getContents();
    return s.dict.has(PDFName.of('Filter')) ? inflate(raw) : raw;
  });
  return Uint8Array.from(chunks.flatMap((c) => [...c, 10]));
}

function inflate(b: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(b));
}

/** Sum of advances between two glyphs of a line (exclusive of `to`), after `from`. */
function widthOf(line: ReturnType<typeof expectNoOverlaps>, from: (typeof line)[number], to: (typeof line)[number]): number {
  let w = 0;
  for (const g of line) if (g.origin[0] > from.origin[0] && g.origin[0] < to.origin[0]) w += g.advance;
  return w;
}
