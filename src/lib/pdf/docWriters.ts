// PDF -> ODT / RTF / Markdown from the same page layout as the Word export
// (`planDocument`): joined paragraphs with alignment, indents and spacing,
// styled runs (font, size, bold, italic, underline, colour), tables (ruled
// grids with multi-line cells, borders, shading), two-column sections,
// pictures, and running headers/footers with page-number fields.

import JSZip from 'jszip';
import { stripInvalidXmlChars, xmlEscape, type PageText } from './convert';
import {
  cellPieces,
  floatAnchors,
  footerDistance,
  headerDistance,
  mergePieces,
  paraPieces,
  planDocument,
  refLefts,
  runningLines,
  type AnchoredFloat,
  type DocumentPlan,
  type DocxImage,
  type DocxPageGraphics,
  type FieldPiece,
  type Piece,
  type RunStyle,
} from './docx';
import { blockTop, type Block, type Box, type PageLayout, type ParaBlock, type TableBlock } from './wordLayout';

const CELL_PAD = 2;
const tw = (pt: number) => Math.round(pt * 20);
const pt = (v: number) => `${Math.round(v * 100) / 100}pt`;

/** Column widths of a table block (points), as the Word export uses them. */
function tableWidths(b: TableBlock): number[] {
  const n = b.cols.length;
  return b.cols.map((x, k) => Math.max(18, (k + 1 < n ? b.cols[k + 1] : b.right) - x));
}

/** Pieces of a text-aligned table cell (all text cells in column `c` of line `l`). */
function simpleCellPieces(b: TableBlock, lineIndex: number, c: number, defaultFont: string | undefined): Piece[] {
  const l = b.lines[lineIndex];
  const pieces: Piece[] = [];
  l.cells
    .filter((cell) => cell.col === c)
    .forEach((cell, k) => {
      if (k > 0) pieces.push({ text: ' ', style: { bold: false, italic: false, underline: false, size: Math.round(b.fontSize * 2) } });
      pieces.push(...cellPieces(cell, l, b.fontSize, defaultFont));
    });
  return pieces;
}

/** Each segment's streams with the Word-side left edge of every stream. */
function* segmentsOf(layout: PageLayout): Generator<{ si: number; columns: 1 | 2; gap: number; streams: { col: number; refLeft: number; blocks: Block[] }[] }> {
  const lefts = refLefts(layout);
  for (let si = 0; si < layout.segments.length; si++) {
    const seg = layout.segments[si];
    yield { si, columns: seg.columns, gap: seg.gap, streams: seg.streams.map((blocks, col) => ({ col, refLeft: lefts[si][col], blocks })) };
  }
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

/** Escapes text for RTF: ASCII as-is, everything else as \uN? (signed 16-bit, UTF-16 units). */
export function rtfEscape(s: string): string {
  let out = '';
  const clean = stripInvalidXmlChars(s);
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i); // UTF-16 code unit: surrogate pairs become two \u escapes
    if (code === 0x5c || code === 0x7b || code === 0x7d) out += '\\' + clean[i];
    else if (code === 0x09) out += '\\tab ';
    else if (code === 0x0a) out += '\\line ';
    else if (code === 0x0d) continue;
    else if (code >= 0x20 && code < 0x80) out += clean[i];
    else if (code < 0x20) continue;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
    if (i % 64 === 63) s += '\n';
  }
  return s;
}

class RtfTables {
  fonts: string[];
  colors: string[] = [];
  constructor(defaultFont: string) {
    this.fonts = [defaultFont];
  }
  font(name: string | undefined): number {
    if (!name) return 0;
    let i = this.fonts.indexOf(name);
    if (i < 0) i = this.fonts.push(name) - 1;
    return i;
  }
  color(hex6: string): number {
    let i = this.colors.indexOf(hex6);
    if (i < 0) i = this.colors.push(hex6) - 1;
    return i + 1; // index 0 is "auto"
  }
}

function rtfRuns(pieces: (Piece | FieldPiece)[], t: RtfTables): string {
  let out = '';
  const props = (s: RunStyle) =>
    `${s.font ? `\\f${t.font(s.font)}` : ''}\\fs${s.size}${s.bold ? '\\b' : ''}${s.italic ? '\\i' : ''}${s.underline ? '\\ul' : ''}${s.color ? `\\cf${t.color(s.color)}` : ''}`;
  for (const p of pieces) {
    if ('field' in p) out += `{\\field{\\*\\fldinst{${props(p.style)} ${p.field === 'page' ? 'PAGE' : 'NUMPAGES'}}}{\\fldrslt{${props(p.style)} 1}}}`;
    else if (p.tab) out += '\\tab ';
    else out += `{${props(p.style)} ${rtfEscape(p.text)}}`;
  }
  return out;
}

function rtfPict(img: DocxImage, box: Box): string {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const px = (v: number) => Math.max(1, Math.round((v * 96) / 72));
  return `{\\pict\\${img.type === 'png' ? 'pngblip' : 'jpegblip'}\\picw${px(w)}\\pich${px(h)}\\picwgoal${tw(w)}\\pichgoal${tw(h)}\n${hex(img.data)}}`;
}

/** A floating picture as an RTF shape, positioned on the page horizontally and on its paragraph vertically. */
function rtfShape(img: DocxImage, f: AnchoredFloat, anchorTop: number | undefined): string {
  const w = f.box.x1 - f.box.x0;
  const h = f.box.y1 - f.box.y0;
  const top = anchorTop === undefined ? f.box.y0 : f.box.y0 - anchorTop;
  return (
    `{\\shp{\\*\\shpinst\\shpleft${tw(f.box.x0)}\\shptop${tw(top)}\\shpright${tw(f.box.x0 + w)}\\shpbottom${tw(top + h)}` +
    `\\shpfhdr0\\shpbxpage\\shpbxignore${anchorTop === undefined ? '\\shpbypage' : '\\shpbypara'}\\shpbyignore` +
    `\\shpwr${f.wrap ? 2 : 3}\\shpwrk0\\shpfblwtxt${f.behind ? 1 : 0}\\shpz0\\shplockanchor` +
    `{\\sp{\\sn shapeType}{\\sv 75}}{\\sp{\\sn fBehindDocument}{\\sv ${f.behind ? 1 : 0}}}{\\sp{\\sn pib}{\\sv ${rtfPict(img, f.box)}}}}}`
  );
}

const RTF_ALIGN = { left: '\\ql', center: '\\qc', right: '\\qr', justify: '\\qj' } as const;

function rtfPara(b: ParaBlock, t: RtfTables, body: number, defaultFont: string, extra = '', inTable?: { last: boolean }): string {
  let s = '\\pard\\plain';
  if (b.heading) s += `\\s${b.heading}\\outlinelevel${b.heading - 1}`;
  if (inTable) s += '\\intbl';
  s += RTF_ALIGN[b.align];
  s += `\\li${tw(Math.max(-36, b.indentLeft))}\\ri${tw(Math.max(0, b.indentRight))}\\fi${tw(b.firstLine)}\\sb${tw(b.spaceBefore)}\\sa0`;
  if (b.lineSpacing) s += `\\sl${tw(b.lineSpacing)}\\slmult0`;
  for (const tab of b.tabs) s += `${tab.right ? '\\tqr' : ''}\\tx${Math.max(0, tw(tab.pos))}`;
  if (b.shading) s += `\\cbpat${t.color(b.shading)}`;
  s += `\\f0\\fs${Math.round(body * 2)} ${extra}${rtfRuns(mergePieces(paraPieces(b, defaultFont)), t)}`;
  return s + (inTable ? (inTable.last ? '\\cell' : '\\par') : '\\par');
}

function rtfTable(b: TableBlock, refLeft: number, t: RtfTables, body: number, defaultFont: string): string {
  const widths = tableWidths(b);
  const left = b.cols[0] - CELL_PAD - refLeft;
  const brd = b.bordered ? '\\brdrs\\brdrw10' : '\\brdrnone';
  const rows = b.grid ? b.grid.cells.length : b.lines.length;
  let out = b.spaceBefore >= 1 ? `\\pard\\plain\\sb0\\sa0\\sl-${tw(b.spaceBefore)}\\slmult0{\\fs2 }\\par\n` : '';
  for (let r = 0; r < rows; r++) {
    const height = b.grid ? b.grid.rowHeights[r] : b.rowHeight;
    let def = `\\trowd\\trgaph${tw(CELL_PAD)}\\trleft${tw(left)}\\trrh${tw(height)}`;
    let x = left;
    widths.forEach((w, c) => {
      x += w;
      const shade = b.grid?.shading?.[r]?.[c] ?? b.shading;
      def += `\\clbrdrt${brd}\\clbrdrl${brd}\\clbrdrb${brd}\\clbrdrr${brd}${shade ? `\\clcbpat${t.color(shade)}` : ''}\\cellx${tw(x)}`;
    });
    let cells = '';
    widths.forEach((_, c) => {
      if (b.grid) {
        const paras = b.grid.cells[r][c] ?? [];
        if (!paras.length) cells += `\\pard\\plain\\intbl\\f0\\fs${Math.round(body * 2)} \\cell`;
        else paras.forEach((p, k) => (cells += rtfPara(p, t, body, defaultFont, '', { last: k === paras.length - 1 })));
      } else {
        cells += `\\pard\\plain\\intbl\\ql\\sb0\\sa0\\f0\\fs${Math.round(b.fontSize * 2)} ${rtfRuns(mergePieces(simpleCellPieces(b, r, c, defaultFont)), t)}\\cell`;
      }
      cells += '\n';
    });
    out += `${def}\n${cells}${def}\\row\n`;
  }
  return out + '\\pard\\plain\n';
}

function rtfRunningGroup(kind: 'header' | 'footer', plan: DocumentPlan, layout: PageLayout, t: RtfTables, body: number): string {
  const info = kind === 'header' ? plan.running.header : plan.running.footer;
  if (!info) return '';
  const paras = runningLines(info, plan.total, layout.margin, plan.defaultFont).map((r) => {
    let s = `\\pard\\plain${r.align === 'center' ? '\\qc' : r.align === 'right' ? '\\qr' : `\\ql\\li${tw(r.indent)}`}\\sb0\\sa0`;
    for (const tab of r.tabs) s += `${tab.right ? '\\tqr' : ''}\\tx${tw(tab.pos)}`;
    return `${s}\\f0\\fs${Math.round(body * 2)} ${rtfRuns(r.pieces, t)}\\par`;
  });
  return `{\\${kind} ${paras.join('\n')}}\n`;
}

function rtfSectionProps(layout: PageLayout, plan: DocumentPlan): string {
  const m = layout.margin;
  const hy = plan.running.header ? headerDistance(plan.running.header) : 36;
  const fy = plan.running.footer ? footerDistance(plan.running.footer) : 36;
  return (
    `\\pgwsxn${tw(layout.width)}\\pghsxn${tw(layout.height)}\\marglsxn${tw(m.left)}\\margrsxn${tw(m.right)}\\margtsxn${tw(m.top)}\\margbsxn${tw(m.bottom)}` +
    `\\headery${tw(hy)}\\footery${tw(fy)}${layout.width > layout.height ? '\\lndscpsxn' : ''}`
  );
}

/** Rich Text Format document from the page layout. `graphics` (from `collectDocxGraphics`) adds pictures, rules and colours. */
export function exportToRtf(pages: PageText[], title: string, graphics?: DocxPageGraphics[]): string {
  const src = pages.length ? pages : [{ pageNumber: 1, width: 595.28, height: 841.89, lines: [] }];
  const plan = planDocument(src, graphics);
  const t = new RtfTables(plan.defaultFont);
  const body = plan.body;
  const parts: string[] = [];
  let firstSection = true;
  for (const { layout, images, newPage } of plan.pages) {
    const anchors = floatAnchors(layout, images);
    for (const seg of segmentsOf(layout)) {
      const brk = seg.si === 0 && newPage ? '\\sbkpage' : '\\sbknone';
      parts.push(`${firstSection ? '' : '\\sect'}\\sectd${brk}${rtfSectionProps(layout, plan)}${seg.columns === 2 ? `\\cols2\\colsx${tw(seg.gap)}` : '\\cols1'}`);
      if (firstSection) parts.push(rtfRunningGroup('header', plan, layout, t, body) + rtfRunningGroup('footer', plan, layout, t, body));
      firstSection = false;
      if (seg.si === 0 && anchors.loose.length) {
        parts.push(`\\pard\\plain\\sb0\\sa0\\sl-20\\slmult0{\\fs2 ${anchors.loose.map((f) => rtfShape(images[f.index], f, undefined)).join('')}}\\par`);
      }
      for (const stream of seg.streams) {
        if (stream.col === 1) parts.push('\\pard\\plain\\sb0\\sa0\\sl-20\\slmult0{\\fs2 \\column }\\par');
        for (const b of stream.blocks) {
          if (b.kind === 'para') {
            const shapes = (anchors.anchored.get(b) ?? []).map((f) => rtfShape(images[f.index], f, blockTop(b))).join('');
            parts.push(rtfPara(b, t, body, plan.defaultFont, shapes));
          } else if (b.kind === 'table') parts.push(rtfTable(b, stream.refLeft, t, body, plan.defaultFont));
          else if (images[b.index]) parts.push(`\\pard\\plain\\li${tw(Math.max(0, b.indentLeft))}\\sb${tw(b.spaceBefore)}\\sa0 ${rtfPict(images[b.index], b.box)}\\par`);
        }
      }
    }
  }
  const first = plan.pages[0].layout;
  const m0 = first.margin;
  const colorTbl = `{\\colortbl;${t.colors.map((c) => `\\red${parseInt(c.slice(0, 2), 16)}\\green${parseInt(c.slice(2, 4), 16)}\\blue${parseInt(c.slice(4, 6), 16)};`).join('')}}`;
  const fontTbl = `{\\fonttbl${t.fonts.map((f, i) => `{\\f${i}\\fnil\\fcharset0 ${rtfEscape(f)};}`).join('')}}`;
  const bodyFs = Math.round(body * 2);
  const head = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1',
    fontTbl,
    colorTbl,
    `{\\stylesheet{\\s0\\f0\\fs${bodyFs} Normal;}` + [1, 2, 3].map((lv) => `{\\s${lv}\\sbasedon0\\snext0\\outlinelevel${lv - 1}\\f0\\fs${bodyFs} heading ${lv};}`).join('') + '}',
    `{\\info{\\title ${rtfEscape(title)}}{\\doccomm Adika PDF Editor}}`,
    `\\paperw${tw(first.width)}\\paperh${tw(first.height)}\\margl${tw(m0.left)}\\margr${tw(m0.right)}\\margt${tw(m0.top)}\\margb${tw(m0.bottom)}${first.width > first.height ? '\\landscape' : ''}\\viewkind1`,
  ];
  return [...head, ...parts, '}'].join('\n');
}

// ---------------------------------------------------------------------------
// ODT
// ---------------------------------------------------------------------------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escapes text for ODF: runs of spaces -> text:s, tabs -> text:tab, newlines -> text:line-break. */
export function odfText(s: string): string {
  return xmlEscape(s)
    .replace(/\r\n?|\n/g, '<text:line-break/>')
    .replace(/\t/g, '<text:tab/>')
    .replace(/^ /, '<text:s/>')
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
}

/** Named automatic styles, one per distinct definition. */
class StyleSet {
  private byKey = new Map<string, string>();
  readonly defs: string[] = [];
  constructor(private prefix: string) {}
  get(key: string, def: (name: string) => string): string {
    let name = this.byKey.get(key);
    if (!name) {
      name = `${this.prefix}${this.byKey.size + 1}`;
      this.byKey.set(key, name);
      this.defs.push(def(name));
    }
    return name;
  }
}

interface OdfCtx {
  para: StyleSet;
  text: StyleSet;
  misc: StyleSet;
  fonts: Set<string>;
  body: number;
  defaultFont: string;
}

function odfTextStyle(s: RunStyle, ctx: OdfCtx): string {
  if (s.font) ctx.fonts.add(s.font);
  const size = s.size / 2;
  const key = JSON.stringify(s);
  return ctx.text.get(key, (name) => {
    let p = `fo:font-size="${size}pt" style:font-size-asian="${size}pt" style:font-size-complex="${size}pt"`;
    if (s.bold) p += ' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
    if (s.italic) p += ' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';
    if (s.underline) p += ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"';
    if (s.color) p += ` fo:color="#${s.color}"`;
    if (s.font) p += ` style:font-name="${xmlEscape(s.font)}"`;
    return `<style:style style:name="${name}" style:family="text"><style:text-properties ${p}/></style:style>`;
  });
}

function odfRuns(pieces: (Piece | FieldPiece)[], ctx: OdfCtx): string {
  return pieces
    .map((p) => {
      if ('field' in p) {
        const inner = p.field === 'page' ? '<text:page-number text:select-page="current">1</text:page-number>' : '<text:page-count>1</text:page-count>';
        return `<text:span text:style-name="${odfTextStyle(p.style, ctx)}">${inner}</text:span>`;
      }
      if (p.tab) return '<text:tab/>';
      return `<text:span text:style-name="${odfTextStyle(p.style, ctx)}">${odfText(p.text)}</text:span>`;
    })
    .join('');
}

const ODF_ALIGN = { left: 'start', center: 'center', right: 'end', justify: 'justify' } as const;

interface ParaExtras {
  master?: string;
  breakBefore?: 'column';
}

function odfParaStyle(b: ParaBlock, ctx: OdfCtx, extras: ParaExtras = {}): string {
  const parent = b.heading ? `Heading_20_${b.heading}` : 'Standard';
  const key = JSON.stringify([parent, b.align, Math.round(b.indentLeft * 10), Math.round(b.indentRight * 10), Math.round(b.firstLine * 10), Math.round(b.spaceBefore * 10), b.lineSpacing ? Math.round(b.lineSpacing * 10) : 0, b.shading, b.tabs, extras]);
  return ctx.para.get(key, (name) => {
    let p = `fo:text-align="${ODF_ALIGN[b.align]}" fo:margin-left="${pt(Math.max(-36, b.indentLeft))}" fo:margin-right="${pt(Math.max(0, b.indentRight))}" fo:text-indent="${pt(b.firstLine)}" fo:margin-top="${pt(b.spaceBefore)}" fo:margin-bottom="0pt"`;
    if (b.lineSpacing) p += ` style:line-height-at-least="${pt(b.lineSpacing)}"`;
    if (b.shading) p += ` fo:background-color="#${b.shading}"`;
    if (extras.breakBefore) p += ` fo:break-before="${extras.breakBefore}"`;
    const tabs = b.tabs.length ? `<style:tab-stops>${b.tabs.map((t) => `<style:tab-stop style:position="${pt(Math.max(0, t.pos - Math.max(-36, b.indentLeft)))}"${t.right ? ' style:type="right"' : ''}/>`).join('')}</style:tab-stops>` : '';
    return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}"${extras.master ? ` style:master-page-name="${extras.master}"` : ''}><style:paragraph-properties ${p}>${tabs}</style:paragraph-properties></style:style>`;
  });
}

function odfPara(b: ParaBlock, ctx: OdfCtx, frames = '', extras: ParaExtras = {}): string {
  const style = odfParaStyle(b, ctx, extras);
  const runs = frames + odfRuns(mergePieces(paraPieces(b, ctx.defaultFont)), ctx);
  return b.heading ? `<text:h text:style-name="${style}" text:outline-level="${b.heading}">${runs}</text:h>` : `<text:p text:style-name="${style}">${runs}</text:p>`;
}

/** A 1 pt paragraph that carries a page/column break (and the page style) without moving the text. */
function odfBreakPara(ctx: OdfCtx, extras: ParaExtras, content = ''): string {
  const style = ctx.para.get(JSON.stringify(['tiny', extras]), (name) => {
    const brk = extras.breakBefore ? ` fo:break-before="${extras.breakBefore}"` : '';
    return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard"${extras.master ? ` style:master-page-name="${extras.master}"` : ''}><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:line-height="1pt"${brk}/><style:text-properties fo:font-size="1pt"/></style:style>`;
  });
  return `<text:p text:style-name="${style}">${content}</text:p>`;
}

interface OdfPicture {
  path: string;
  img: DocxImage;
}

function odfFrame(pic: OdfPicture, box: Box, ctx: OdfCtx, place: { kind: 'inline' } | { kind: 'float'; f: AnchoredFloat; anchorTop?: number }): string {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const image = `<draw:image xlink:href="${pic.path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`;
  if (place.kind === 'inline') {
    const style = ctx.misc.get('frame-inline', (name) => `<style:style style:name="${name}" style:family="graphic"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>`);
    return `<draw:frame draw:style-name="${style}" text:anchor-type="as-char" svg:width="${pt(w)}" svg:height="${pt(h)}" draw:z-index="0">${image}</draw:frame>`;
  }
  const { f, anchorTop } = place;
  const vrel = anchorTop === undefined ? 'page' : 'paragraph';
  const style = ctx.misc.get(`frame-${f.wrap}-${f.behind}-${vrel}`, (name) => {
    const wrap = f.wrap ? 'style:wrap="parallel" style:number-wrapped-paragraphs="no-limit"' : `style:wrap="run-through" style:run-through="${f.behind ? 'background' : 'foreground'}"`;
    return `<style:style style:name="${name}" style:family="graphic"><style:graphic-properties ${wrap} style:vertical-pos="from-top" style:vertical-rel="${vrel}" style:horizontal-pos="from-left" style:horizontal-rel="page" fo:margin-left="${f.wrap ? '6pt' : '0pt'}" fo:margin-right="${f.wrap ? '6pt' : '0pt'}"/></style:style>`;
  });
  const y = anchorTop === undefined ? box.y0 : box.y0 - anchorTop;
  return `<draw:frame draw:style-name="${style}" text:anchor-type="paragraph" svg:x="${pt(box.x0)}" svg:y="${pt(y)}" svg:width="${pt(w)}" svg:height="${pt(h)}" draw:z-index="${f.behind ? 0 : 1}">${image}</draw:frame>`;
}

let odfTableNo = 0;

function odfTable(b: TableBlock, refLeft: number, ctx: OdfCtx, extras: ParaExtras): string {
  const widths = tableWidths(b);
  const total = widths.reduce((s, w) => s + w, 0);
  const n = ++odfTableNo;
  const tstyle = ctx.misc.get(`table-${n}`, (name) => {
    const brk = extras.master ? ` style:master-page-name="${extras.master}"` : '';
    const col = extras.breakBefore ? ' fo:break-before="column"' : '';
    return `<style:style style:name="${name}" style:family="table"${brk}><style:table-properties style:width="${pt(total)}" fo:margin-left="${pt(b.cols[0] - CELL_PAD - refLeft)}" fo:margin-top="${pt(b.spaceBefore)}" table:align="left"${col}/></style:style>`;
  });
  const cols = widths
    .map((w) => `<table:table-column table:style-name="${ctx.misc.get(`col-${Math.round(w * 100)}`, (name) => `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${pt(w)}"/></style:style>`)}"/>`)
    .join('');
  const cellStyle = (shade?: string) =>
    ctx.misc.get(`cell-${b.bordered}-${shade ?? ''}`, (name) => {
      const border = b.bordered ? 'fo:border="0.5pt solid #000000"' : 'fo:border="none"';
      return `<style:style style:name="${name}" style:family="table-cell"><style:table-cell-properties fo:padding-left="${CELL_PAD}pt" fo:padding-right="${CELL_PAD}pt" fo:padding-top="0pt" fo:padding-bottom="0pt" ${border}${shade ? ` fo:background-color="#${shade}"` : ''}/></style:style>`;
    });
  const rowStyle = (h: number) => ctx.misc.get(`row-${Math.round(h * 10)}`, (name) => `<style:style style:name="${name}" style:family="table-row"><style:table-row-properties style:min-row-height="${pt(h)}"/></style:style>`);
  const cellPara = ctx.para.get('cell-plain', (name) => `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt"/></style:style>`);
  const rows: string[] = [];
  const count = b.grid ? b.grid.cells.length : b.lines.length;
  for (let r = 0; r < count; r++) {
    const cells = widths.map((_, c) => {
      const shade = b.grid?.shading?.[r]?.[c] ?? b.shading;
      let inner: string;
      if (b.grid) {
        const paras = b.grid.cells[r][c] ?? [];
        inner = paras.length ? paras.map((p) => odfPara(p, ctx)).join('') : `<text:p text:style-name="${cellPara}"/>`;
      } else {
        inner = `<text:p text:style-name="${cellPara}">${odfRuns(mergePieces(simpleCellPieces(b, r, c, ctx.defaultFont)), ctx)}</text:p>`;
      }
      return `<table:table-cell table:style-name="${cellStyle(shade)}" office:value-type="string">${inner}</table:table-cell>`;
    });
    rows.push(`<table:table-row table:style-name="${rowStyle(b.grid ? b.grid.rowHeights[r] : b.rowHeight)}">${cells.join('')}</table:table-row>`);
  }
  return `<table:table table:name="Table${n}" table:style-name="${tstyle}">${cols}${rows.join('')}</table:table>`;
}

/** Builds all ODT parts (exported for tests). Picture parts are Uint8Array. */
export function buildOdtParts(pages: PageText[], title: string, graphics?: DocxPageGraphics[]): Map<string, string | Uint8Array> {
  const src = pages.length ? pages : [{ pageNumber: 1, width: 595.28, height: 841.89, lines: [] }];
  const plan = planDocument(src, graphics);
  const ctx: OdfCtx = { para: new StyleSet('P'), text: new StyleSet('T'), misc: new StyleSet('S'), fonts: new Set([plan.defaultFont]), body: plan.body, defaultFont: plan.defaultFont };
  odfTableNo = 0;

  // Page styles: one page layout + master page per distinct page geometry.
  const masters = new Map<string, string>();
  const layoutDefs: string[] = [];
  const masterDefs: string[] = [];
  const hfCtx: OdfCtx = { ...ctx, para: new StyleSet('HP'), text: new StyleSet('HT'), misc: new StyleSet('HS') };
  const headerLines = (kind: 'header' | 'footer', layout: PageLayout) => {
    const info = kind === 'header' ? plan.running.header : plan.running.footer;
    if (!info) return '';
    const paras = runningLines(info, plan.total, layout.margin, plan.defaultFont).map((r) => {
      const style = hfCtx.para.get(JSON.stringify([r.align, Math.round(r.indent), r.tabs]), (name) => {
        const tabs = r.tabs.length ? `<style:tab-stops>${r.tabs.map((t) => `<style:tab-stop style:position="${pt(t.pos - (r.align === 'left' ? r.indent : 0))}"${t.right ? ' style:type="right"' : ''}/>`).join('')}</style:tab-stops>` : '';
        return `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="${r.align === 'center' ? 'center' : r.align === 'right' ? 'end' : 'start'}" fo:margin-left="${pt(r.align === 'left' ? r.indent : 0)}" fo:margin-top="0pt" fo:margin-bottom="0pt">${tabs}</style:paragraph-properties></style:style>`;
      });
      return `<text:p text:style-name="${style}">${odfRuns(r.pieces, hfCtx)}</text:p>`;
    });
    return `<style:${kind}>${paras.join('')}</style:${kind}>`;
  };
  const masterFor = (layout: PageLayout): string => {
    const m = layout.margin;
    const key = [layout.width, layout.height, m.top, m.right, m.bottom, m.left].map((v) => Math.round(v)).join('x');
    let name = masters.get(key);
    if (name) return name;
    const idx = masters.size + 1;
    name = `MP${idx}`;
    masters.set(key, name);
    const hy = plan.running.header ? Math.min(headerDistance(plan.running.header), m.top - 6) : 0;
    const fy = plan.running.footer ? Math.min(footerDistance(plan.running.footer), m.bottom - 6) : 0;
    // The header sits `hy` from the top edge and fills the space down to the body's top margin.
    const headerStyle = plan.running.header ? `<style:header-style><style:header-footer-properties fo:min-height="${pt(Math.max(6, m.top - hy))}" fo:margin-bottom="0pt" style:dynamic-spacing="false"/></style:header-style>` : '<style:header-style/>';
    const footerStyle = plan.running.footer ? `<style:footer-style><style:header-footer-properties fo:min-height="${pt(Math.max(6, m.bottom - fy))}" fo:margin-top="0pt" style:dynamic-spacing="false"/></style:footer-style>` : '<style:footer-style/>';
    layoutDefs.push(
      `<style:page-layout style:name="PL${idx}"><style:page-layout-properties fo:page-width="${pt(layout.width)}" fo:page-height="${pt(layout.height)}" ` +
        `style:print-orientation="${layout.width > layout.height ? 'landscape' : 'portrait'}" fo:margin-top="${pt(plan.running.header ? hy : m.top)}" fo:margin-bottom="${pt(plan.running.footer ? fy : m.bottom)}" ` +
        `fo:margin-left="${pt(m.left)}" fo:margin-right="${pt(m.right)}"/>${headerStyle}${footerStyle}</style:page-layout>`,
    );
    masterDefs.push(`<style:master-page style:name="${name}" style:page-layout-name="PL${idx}">${headerLines('header', layout)}${headerLines('footer', layout)}</style:master-page>`);
    return name;
  };

  const pictures: OdfPicture[] = [];
  const picFor = new Map<DocxImage, OdfPicture>();
  const picture = (img: DocxImage): OdfPicture => {
    let p = picFor.get(img);
    if (!p) {
      p = { path: `Pictures/image${pictures.length + 1}.${img.type === 'png' ? 'png' : 'jpg'}`, img };
      pictures.push(p);
      picFor.set(img, p);
    }
    return p;
  };

  const out: string[] = [];
  let sectionNo = 0;
  for (const { layout, images, newPage } of plan.pages) {
    const anchors = floatAnchors(layout, images);
    const master = masterFor(layout);
    if (newPage) out.push(odfBreakPara(ctx, { master }, anchors.loose.map((f) => odfFrame(picture(images[f.index]), f.box, ctx, { kind: 'float', f })).join('')));
    else if (anchors.loose.length) out.push(odfBreakPara(ctx, {}, anchors.loose.map((f) => odfFrame(picture(images[f.index]), f.box, ctx, { kind: 'float', f })).join('')));
    for (const seg of segmentsOf(layout)) {
      const body: string[] = [];
      for (const stream of seg.streams) {
        if (stream.col === 1) body.push(odfBreakPara(ctx, { breakBefore: 'column' }));
        for (const b of stream.blocks) {
          if (b.kind === 'para') {
            const frames = (anchors.anchored.get(b) ?? []).map((f) => odfFrame(picture(images[f.index]), f.box, ctx, { kind: 'float', f, anchorTop: blockTop(b) })).join('');
            body.push(odfPara(b, ctx, frames));
          } else if (b.kind === 'table') body.push(odfTable(b, stream.refLeft, ctx, {}));
          else if (images[b.index]) {
            const style = ctx.para.get(`img-${Math.round(b.indentLeft)}-${Math.round(b.spaceBefore)}`, (name) => `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="${pt(Math.max(0, b.indentLeft))}" fo:margin-top="${pt(b.spaceBefore)}" fo:margin-bottom="0pt"/></style:style>`);
            body.push(`<text:p text:style-name="${style}">${odfFrame(picture(images[b.index]), b.box, ctx, { kind: 'inline' })}</text:p>`);
          }
        }
      }
      if (seg.columns === 2) {
        const n = ++sectionNo;
        const sstyle = ctx.misc.get(`sect-${Math.round(seg.gap)}`, (name) => `<style:style style:name="${name}" style:family="section"><style:section-properties text:dont-balance-text-columns="true"><style:columns fo:column-count="2" fo:column-gap="${pt(seg.gap)}"/></style:section-properties></style:style>`);
        out.push(`<text:section text:style-name="${sstyle}" text:name="Section${n}">${body.join('')}</text:section>`);
      } else out.push(...body);
    }
  }

  const fontDecls = (fonts: Set<string>) => `<office:font-face-decls>${[...fonts].map((f) => `<style:font-face style:name="${xmlEscape(f)}" svg:font-family="'${xmlEscape(f)}'"/>`).join('')}</office:font-face-decls>`;
  const bodyPt = Math.round(plan.body * 2) / 2;
  for (const f of hfCtx.fonts) ctx.fonts.add(f);
  const styles =
    XML_DECL +
    `<office:document-styles ${ODF_NS} office:version="1.2">` +
    fontDecls(ctx.fonts) +
    '<office:styles>' +
    `<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt"/><style:text-properties style:font-name="${xmlEscape(plan.defaultFont)}" fo:font-size="${bodyPt}pt" style:font-size-asian="${bodyPt}pt" style:font-size-complex="${bodyPt}pt" fo:language="ro" fo:country="RO"/></style:default-style>` +
    '<style:default-style style:family="table"><style:table-properties table:border-model="collapsing"/></style:default-style>' +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    // Headings carry the outline level only: their look comes from the PDF (run styles).
    [1, 2, 3].map((lv) => `<style:style style:name="Heading_20_${lv}" style:display-name="Heading ${lv}" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="${lv}" style:class="text"/>`).join('') +
    '</office:styles>' +
    `<office:automatic-styles>${layoutDefs.join('')}${hfCtx.para.defs.join('')}${hfCtx.text.defs.join('')}</office:automatic-styles>` +
    `<office:master-styles>${masterDefs.join('')}</office:master-styles>` +
    '</office:document-styles>';

  const content =
    XML_DECL +
    `<office:document-content ${ODF_NS} office:version="1.2">` +
    fontDecls(ctx.fonts) +
    `<office:automatic-styles>${ctx.misc.defs.join('')}${ctx.para.defs.join('')}${ctx.text.defs.join('')}</office:automatic-styles>` +
    `<office:body><office:text>${out.join('')}</office:text></office:body>` +
    '</office:document-content>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const meta =
    XML_DECL +
    `<office:document-meta ${ODF_NS} office:version="1.2"><office:meta>` +
    '<meta:generator>Adika PDF Editor</meta:generator>' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date>` +
    `<meta:document-statistic meta:page-count="${src.length}" meta:table-count="${odfTableNo}" meta:image-count="${pictures.length}"/>` +
    '</office:meta></office:document-meta>';

  const manifest =
    XML_DECL +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.path}" manifest:media-type="${p.img.type === 'png' ? 'image/png' : 'image/jpeg'}"/>`).join('') +
    '</manifest:manifest>';

  const parts = new Map<string, string | Uint8Array>([
    ['content.xml', content],
    ['styles.xml', styles],
    ['meta.xml', meta],
    ['META-INF/manifest.xml', manifest],
  ]);
  for (const p of pictures) parts.set(p.path, p.img.data);
  return parts;
}

export const ODT_MIME = 'application/vnd.oasis.opendocument.text';

export async function exportToOdt(pages: PageText[], title: string, graphics?: DocxPageGraphics[]): Promise<Blob> {
  const zip = new JSZip();
  // The mimetype entry must be first and uncompressed (ODF 1.2 part 3, 3.3).
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' });
  for (const [name, data] of buildOdtParts(pages, title, graphics)) zip.file(name, data);
  return zip.generateAsync({ type: 'blob', mimeType: ODT_MIME, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

/** Markdown for pieces: bold / italic runs, tabs as spaces, spaces kept outside the markers. */
function mdRuns(pieces: Piece[]): string {
  return mergePieces(pieces)
    .map((p) => {
      if (p.tab) return '  ';
      const m = /^(\s*)(.*?)(\s*)$/s.exec(p.text)!;
      if (!m[2]) return p.text;
      const mark = p.style.bold && p.style.italic ? '***' : p.style.bold ? '**' : p.style.italic ? '*' : '';
      return `${m[1]}${mark}${mdEscape(m[2])}${mark}${m[3]}`;
    })
    .join('')
    .replace(/\*\*\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markdown from the page layout: wrapped lines joined into paragraphs,
 * headings, bold/italic, bullet lists, tables (ruled tables with their
 * joined cell text). Running headers and footers are left out. `graphics`
 * (from `collectDocxGraphics`) adds ruled tables and bullets drawn as dots.
 */
export function exportToMarkdown(pages: PageText[], graphics?: DocxPageGraphics[]): string {
  const plan = planDocument(pages, graphics);
  const out: string[] = [];
  const noHeading = (b: ParaBlock) => ({ ...b, heading: 0 as const });
  plan.pages.forEach(({ layout, newPage }, k) => {
    if (k > 0 && newPage) out.push('---');
    for (const seg of layout.segments) {
      for (const blocks of seg.streams) {
        for (const b of blocks) {
          if (b.kind === 'para') {
            let pieces = paraPieces(b, plan.defaultFont);
            if (b.bullet && pieces.length && !pieces[0].tab && /^[•●○◦▪▫■□◆◇►▶➢➤✓✔·*–—-]$/.test(pieces[0].text.trim())) {
              pieces = pieces.slice(pieces[1]?.tab ? 2 : 1);
              out.push(`- ${mdRuns(pieces)}`);
            } else if (b.heading) out.push(`${'#'.repeat(b.heading)} ${mdRuns(paraPieces(noHeading(b), plan.defaultFont).map((p) => (p.tab ? p : { ...p, style: { ...p.style, bold: false } })))}`);
            else out.push(mdRuns(pieces));
          } else if (b.kind === 'table') {
            const widths = tableWidths(b);
            const rows: string[][] = b.grid
              ? b.grid.cells.map((row) => widths.map((_, c) => (row[c] ?? []).map((p) => mdRuns(paraPieces(p, plan.defaultFont))).join(' ')))
              : b.lines.map((_, r) => widths.map((__, c) => mdRuns(simpleCellPieces(b, r, c, plan.defaultFont))));
            const cell = (s: string) => s.replace(/\|/g, '\\|');
            out.push(['| ' + rows[0].map(cell).join(' | ') + ' |', '| ' + widths.map(() => '---').join(' | ') + ' |', ...rows.slice(1).map((r) => '| ' + r.map(cell).join(' | ') + ' |')].join('\n'));
          }
        }
      }
    }
  });
  // Consecutive list items stay together; everything else is separated by a blank line.
  let md = '';
  out.forEach((block, i) => {
    if (i > 0) md += block.startsWith('- ') && out[i - 1].startsWith('- ') ? '\n' : '\n\n';
    md += block;
  });
  return md.trim() + '\n';
}

// ---------------------------------------------------------------------------
// Rows (Excel / CSV) and reflowable blocks (EPUB)
// ---------------------------------------------------------------------------

/** Plain text of pieces, split into columns at tabs. */
function pieceColumns(pieces: Piece[]): string[] {
  const cols = [''];
  for (const p of mergePieces(pieces)) {
    if (p.tab) cols.push('');
    else cols[cols.length - 1] += p.text;
  }
  return cols.map((c) => stripInvalidXmlChars(c).replace(/\s+/g, ' ').trim());
}

export interface LayoutRow {
  pageNumber: number;
  cells: string[];
  /** The row belongs to a table (not a paragraph). */
  table: boolean;
}

/**
 * One row per paragraph or table row, in reading order: a table row whose
 * cells wrap over several lines stays one row, and a wrapped paragraph is
 * one cell.
 */
export function layoutRows(pages: PageText[], graphics?: DocxPageGraphics[]): LayoutRow[] {
  const plan = planDocument(pages, graphics);
  const out: LayoutRow[] = [];
  plan.pages.forEach(({ layout }, k) => {
    const pageNumber = pages[k]?.pageNumber ?? k + 1;
    for (const seg of layout.segments)
      for (const blocks of seg.streams)
        for (const b of blocks) {
          if (b.kind === 'para') {
            const cells = pieceColumns(paraPieces(b, plan.defaultFont));
            // A list marker stays with its text ("• Item"), not in a column of its own.
            if (b.bullet && cells.length >= 2 && /^[•●○◦▪▫■□◆◇►▶➢➤✓✔·*–—-]$/.test(cells[0])) cells.splice(0, 2, `${cells[0]} ${cells[1]}`);
            out.push({ pageNumber, cells, table: false });
          }
          else if (b.kind === 'table') {
            const widths = tableWidths(b);
            if (b.grid) for (const row of b.grid.cells) out.push({ pageNumber, table: true, cells: widths.map((_, c) => (row[c] ?? []).map((p) => pieceColumns(paraPieces(p, plan.defaultFont)).join(' ')).join(' ').trim()) });
            else b.lines.forEach((_, r) => out.push({ pageNumber, table: true, cells: widths.map((__, c) => pieceColumns(simpleCellPieces(b, r, c, plan.defaultFont)).join(' ')) }));
          }
        }
  });
  return out;
}

export type ReflowBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; pageNumber: number }
  | { kind: 'para'; runs: { text: string; bold: boolean; italic: boolean }[]; bullet: boolean; pageNumber: number }
  | { kind: 'table'; rows: string[][]; pageNumber: number };

/** Headings, paragraphs (styled runs, bullets) and tables for reflowable formats; running headers/footers left out. */
export function layoutReflow(pages: PageText[], graphics?: DocxPageGraphics[]): ReflowBlock[] {
  const plan = planDocument(pages, graphics);
  const out: ReflowBlock[] = [];
  plan.pages.forEach(({ layout }, k) => {
    const pageNumber = pages[k]?.pageNumber ?? k + 1;
    for (const seg of layout.segments)
      for (const blocks of seg.streams)
        for (const b of blocks) {
          if (b.kind === 'para') {
            let pieces = mergePieces(paraPieces(b, plan.defaultFont));
            const marker = b.bullet && pieces.length && !pieces[0].tab && /^[•●○◦▪▫■□◆◇►▶➢➤✓✔·*–—-]$/.test(pieces[0].text.trim());
            if (marker) pieces = pieces.slice(pieces[1]?.tab ? 2 : 1);
            const runs = pieces.map((p) => (p.tab ? { text: ' ', bold: false, italic: false } : { text: stripInvalidXmlChars(p.text), bold: p.style.bold, italic: p.style.italic }));
            const text = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (b.heading) out.push({ kind: 'heading', level: b.heading, text, pageNumber });
            else out.push({ kind: 'para', runs, bullet: !!marker, pageNumber });
          } else if (b.kind === 'table') {
            const widths = tableWidths(b);
            const rows = b.grid
              ? b.grid.cells.map((row) => widths.map((_, c) => (row[c] ?? []).map((p) => pieceColumns(paraPieces(p, plan.defaultFont)).join(' ')).join(' ').trim()))
              : b.lines.map((_, r) => widths.map((__, c) => pieceColumns(simpleCellPieces(b, r, c, plan.defaultFont)).join(' ')));
            out.push({ kind: 'table', rows, pageNumber });
          }
        }
  });
  return out;
}
