/**
 * Rich text of comment text boxes (PDF FreeText /RC, XHTML with CSS styles,
 * and its default style /DS): parsed into styled runs, laid out line by line
 * for the editor canvas and the appearance stream, and written back.
 */
import { fontMetrics, type FontVariant } from './fonts';
import { canvasMeasure, layoutText, TEXT_PADDING, type Measure } from './textLayout';
import { escapeXmlAttr, escapeXmlText, isEl, localName, parseXml, type XEl, type XNode } from './xml';
import type { FontFamily, TextAlign, TextObject, TextRun } from '@/types';

/** A run's style with nothing left unset. */
export interface RunStyle {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  size: number;
}

type Box = Pick<TextObject, 'text' | 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color'> & { runs?: TextRun[] };

const STYLE_KEYS = ['bold', 'italic', 'underline', 'strike', 'color', 'size', 'family'] as const;

export function boxStyle(o: Pick<TextObject, 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color'>): RunStyle {
  return { family: o.fontFamily, bold: o.bold, italic: o.italic, underline: false, strike: false, color: o.color.toLowerCase(), size: o.fontSize };
}

export function resolveRun(base: RunStyle, r: TextRun): RunStyle {
  return {
    family: r.family ?? base.family,
    bold: r.bold ?? base.bold,
    italic: r.italic ?? base.italic,
    underline: r.underline ?? base.underline,
    strike: r.strike ?? base.strike,
    color: (r.color ?? base.color).toLowerCase(),
    size: r.size ?? base.size,
  };
}

export const variantOf = (s: Pick<RunStyle, 'family' | 'bold' | 'italic'>): FontVariant => ({ family: s.family, bold: s.bold, italic: s.italic });

export const plainText = (runs: TextRun[]) => runs.map((r) => r.text).join('');

/** The runs of a text box, or null when it has none (or they no longer match its text). */
export function richRuns(o: Box): TextRun[] | null {
  return o.runs?.length && plainText(o.runs) === o.text ? o.runs : null;
}

/**
 * Runs as overrides of `base`: adjacent runs with the same style merged,
 * empty ones dropped. Undefined when nothing differs from the box.
 */
export function compactRuns(styled: Array<{ text: string; style: RunStyle }>, base: RunStyle): TextRun[] | undefined {
  const out: TextRun[] = [];
  let plain = true;
  for (const { text, style } of styled) {
    if (!text) continue;
    const r: TextRun = { text };
    for (const k of STYLE_KEYS) if (style[k] !== base[k]) (r as unknown as Record<string, unknown>)[k] = style[k];
    if (Object.keys(r).length > 1) plain = false;
    const prev = out[out.length - 1];
    if (prev && STYLE_KEYS.every((k) => prev[k] === r[k])) prev.text += text;
    else out.push(r);
  }
  return plain ? undefined : out;
}

// ------------------------------------------------------------------ CSS

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function cssColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((c) => hex2(c.endsWith('%') ? (parseFloat(c) * 255) / 100 : parseFloat(c))).join('')}`;
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', navy: '#000080', maroon: '#800000', purple: '#800080', orange: '#ffa500' };
  return named[s] ?? null;
}

export function familyOf(css: string): FontFamily {
  const s = css.toLowerCase();
  if (/courier|mono/.test(s)) return 'mono';
  if (/sans/.test(s)) return 'sans';
  if (/times|serif|georgia|minion|garamond|cambria|roman/.test(s)) return 'serif';
  return 'sans';
}

const sizeOf = (v: string): number | null => {
  const m = /^([\d.]+)\s*(pt|px)?$/i.exec(v.trim());
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

type Partial_ = Partial<RunStyle> & { align?: TextAlign };

/** CSS declarations ("font-weight:bold; color:#f00") as a partial style. */
export function parseCss(css: string): Partial_ {
  const out: Partial_ = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    switch (prop) {
      case 'font-weight':
        out.bold = val === 'bold' || val === 'bolder' || Number(val) >= 600;
        break;
      case 'font-style':
        out.italic = val === 'italic' || val === 'oblique';
        break;
      case 'font-size': {
        const n = sizeOf(val);
        if (n) out.size = n;
        break;
      }
      case 'font-family':
        out.family = familyOf(val);
        break;
      case 'color': {
        const c = cssColor(val);
        if (c) out.color = c;
        break;
      }
      case 'text-decoration':
      case 'text-decoration-line':
        out.underline = /underline/.test(val);
        out.strike = /line-through/.test(val);
        break;
      case 'text-align':
        if (val === 'center' || val === 'right' || val === 'left') out.align = val;
        break;
      case 'font': {
        // "font: italic bold 12pt Helvetica,sans-serif" (Acrobat writes "font: Helvetica,sans-serif 12.0pt").
        const family: string[] = [];
        for (const t of val.split(/\s+(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/)) {
          const low = t.toLowerCase();
          if (low === 'italic' || low === 'oblique') out.italic = true;
          else if (low === 'bold' || low === 'bolder' || /^[6-9]00$/.test(low)) out.bold = true;
          else if (low === 'normal' || /^[1-5]00$/.test(low)) continue;
          else if (sizeOf(low.split('/')[0])) out.size = sizeOf(low.split('/')[0])!;
          else family.push(t);
        }
        if (family.length) out.family = familyOf(family.join(' '));
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ /RC → runs

export interface ParsedRichText {
  /** The box style (from /DS and the body's style). */
  base: RunStyle;
  align: TextAlign | null;
  text: string;
  runs: TextRun[] | undefined;
}

/** Parses /RC (and /DS) of a FreeText; null when it is not readable XHTML. */
export function parseRichText(rc: string, ds: string, fallback: RunStyle): ParsedRichText | null {
  let body: XEl;
  try {
    body = parseXml(rc);
  } catch {
    return null;
  }
  if (localName(body.name) !== 'body') {
    const inner = body.children.find((c): c is XEl => isEl(c) && localName(c.name) === 'body');
    if (!inner) return null;
    body = inner;
  }
  const def = parseCss(ds);
  const top = parseCss(attrOf(body, 'style'));
  let align: TextAlign | null = top.align ?? def.align ?? null;
  const base: RunStyle = { ...fallback, ...strip(def), ...strip(top) };
  const styled: Array<{ text: string; style: RunStyle }> = [];
  const push = (text: string, style: RunStyle) => {
    if (text) styled.push({ text, style });
  };
  const endsWithBreak = () => {
    const last = styled[styled.length - 1];
    return !last || last.text.endsWith('\n');
  };
  let blocks = 0;
  const walk = (n: XNode, style: RunStyle, inBlock: boolean) => {
    if (typeof n === 'string') {
      // Whitespace between paragraphs is layout, not text.
      if (!inBlock && !n.trim()) return;
      push(n.replace(/\r\n?/g, '\n'), style);
      return;
    }
    const tag = localName(n.name).toLowerCase();
    const own = parseCss(attrOf(n, 'style'));
    if ((tag === 'p' || tag === 'div') && own.align && !align) align = own.align;
    let s: RunStyle = { ...style, ...strip(own) };
    if (tag === 'b' || tag === 'strong') s = { ...s, bold: true };
    if (tag === 'i' || tag === 'em') s = { ...s, italic: true };
    if (tag === 'u') s = { ...s, underline: true };
    if (tag === 's' || tag === 'strike' || tag === 'del') s = { ...s, strike: true };
    if (tag === 'font') {
      const c = cssColor(attrOf(n, 'color'));
      if (c) s = { ...s, color: c };
      const face = attrOf(n, 'face');
      if (face) s = { ...s, family: familyOf(face) };
    }
    if (tag === 'br') {
      push('\n', s);
      return;
    }
    if (tag === 'p' || tag === 'div') {
      if (blocks++ > 0 || (styled.length && !endsWithBreak())) push('\n', s);
      const start = styled.length;
      n.children.forEach((c) => walk(c, s, true));
      // A line break that ends a paragraph does not start another line.
      const last = styled[styled.length - 1];
      if (styled.length > start && last.text.endsWith('\n')) {
        last.text = last.text.slice(0, -1);
        if (!last.text) styled.pop();
      }
      return;
    }
    n.children.forEach((c) => walk(c, s, inBlock || tag !== 'body'));
  };
  body.children.forEach((c) => walk(c, base, false));
  const text = styled.map((r) => r.text).join('');
  return { base, align, text, runs: compactRuns(styled, base) };
}

function attrOf(el: XEl, name: string): string {
  return el.attrs.find(([k]) => localName(k) === name)?.[1] ?? '';
}

function strip(p: Partial_): Partial<RunStyle> {
  const { align: _a, ...rest } = p;
  return rest;
}

// ------------------------------------------------------------------ runs → /RC, /DS

const cssFamily: Record<FontFamily, string> = { sans: 'Helvetica,sans-serif', serif: 'Times,serif', mono: 'Courier,monospace' };
const num = (n: number) => String(Math.round(n * 100) / 100);

function styleCss(s: RunStyle): string {
  const deco = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  return `font-size:${num(s.size)}pt;font-weight:${s.bold ? 'bold' : 'normal'};font-style:${s.italic ? 'italic' : 'normal'};font-family:${cssFamily[s.family]};color:${s.color};text-decoration:${deco}`;
}

/** /DS: the default style of the box. */
export function defaultStyleString(o: Pick<TextObject, 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color' | 'align'>): string {
  const s = boxStyle(o);
  return `font: ${cssFamily[s.family]} ${num(s.size)}pt; font-weight:${s.bold ? 'bold' : 'normal'}; font-style:${s.italic ? 'italic' : 'normal'}; text-align:${o.align}; color:${s.color}`;
}

/** /RC: the runs as XHTML, one paragraph per line, every span with its full style. */
export function richTextXml(o: Pick<TextObject, 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color' | 'align'>, runs: TextRun[]): string {
  const base = boxStyle(o);
  const paras: string[][] = [[]];
  for (const r of runs) {
    const css = escapeXmlAttr(styleCss(resolveRun(base, r)));
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) paras.push([]);
      if (part) paras[paras.length - 1].push(`<span style="${css}">${escapeXmlText(part)}</span>`);
    });
  }
  const body = paras.map((p) => (p.length ? `<p dir="ltr">${p.join('')}</p>` : '<p dir="ltr"/>')).join('');
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" ' +
    `style="${escapeXmlAttr(`${styleCss(base)};text-align:${o.align}`)}">${body}</body>`
  );
}

// ------------------------------------------------------------------ layout

export interface RichSegment {
  text: string;
  /** From the line's left edge. */
  x: number;
  width: number;
  style: RunStyle;
}

export interface RichLine {
  x: number;
  /** Baseline from the top of the box (y down). */
  baseline: number;
  width: number;
  segments: RichSegment[];
}

export interface RichLayout {
  lines: RichLine[];
  contentHeight: number;
}

export type MeasureFor = (v: FontVariant, size: number) => Measure;

const sameStyle = (a: RunStyle, b: RunStyle) => STYLE_KEYS.every((k) => a[k] === b[k]);

/**
 * Word-wrapped lines of styled runs: each line as tall as its largest letters
 * (× lineHeight), aligned like plain text boxes.
 */
export function layoutRich(
  o: Pick<TextObject, 'width' | 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color' | 'align' | 'lineHeight'>,
  runs: TextRun[],
  measureFor: MeasureFor = canvasMeasure,
): RichLayout {
  const base = boxStyle(o);
  const inner = Math.max(1, o.width - TEXT_PADDING * 2);
  const measures = new Map<string, Measure>();
  const widthOf = (t: string, s: RunStyle) => {
    const k = `${s.family}${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}${s.size}`;
    let m = measures.get(k);
    if (!m) measures.set(k, (m = measureFor(variantOf(s), s.size)));
    return m(t);
  };
  type Piece = { text: string; style: RunStyle };
  // Paragraphs of tokens (words and spaces), each token a list of styled pieces.
  const paragraphs: Array<{ tokens: Piece[][]; style: RunStyle }> = [{ tokens: [], style: base }];
  for (const r of runs) {
    const style = resolveRun(base, r);
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) paragraphs.push({ tokens: [], style });
      const para = paragraphs[paragraphs.length - 1];
      if (!para.tokens.length && !part) para.style = style;
      for (const t of part.split(/(\s+)/)) {
        if (!t) continue;
        const prev = para.tokens[para.tokens.length - 1];
        const prevWs = prev ? /^\s+$/.test(prev[prev.length - 1].text) : true;
        const ws = /^\s+$/.test(t);
        // A word split between runs stays one token.
        if (prev && !ws && !prevWs && prev.length && !/\s$/.test(prev[prev.length - 1].text)) prev.push({ text: t, style });
        else para.tokens.push([{ text: t, style }]);
      }
    });
  }
  const tokenWidth = (tok: Piece[]) => tok.reduce((w, p) => w + widthOf(p.text, p.style), 0);
  const rows: Array<{ pieces: Piece[]; emptyStyle: RunStyle }> = [];
  for (const para of paragraphs) {
    let line: Piece[][] = [];
    let w = 0;
    const flush = () => {
      while (line.length && /^\s+$/.test(line[line.length - 1][0].text)) line.pop();
      rows.push({ pieces: line.flat(), emptyStyle: para.style });
      line = [];
      w = 0;
    };
    let wrapped = false;
    for (const tok of para.tokens) {
      const ws = /^\s+$/.test(tok[0].text);
      const tw = tokenWidth(tok);
      if (ws && !line.length && wrapped) continue; // no leading space after a wrap
      if (line.length && w + tw > inner) {
        flush();
        wrapped = true;
        if (ws) continue;
      }
      if (!ws && tw > inner) {
        // A word longer than the line: broken by letters.
        let cur: Piece[] = [];
        let cw = 0;
        for (const p of tok)
          for (const ch of p.text) {
            const chw = widthOf(ch, p.style);
            if (cw + chw > inner && cw > 0) {
              line.push(cur);
              flush();
              wrapped = true;
              cur = [];
              cw = 0;
            }
            const last = cur[cur.length - 1];
            if (last && last.style === p.style) last.text += ch;
            else cur.push({ text: ch, style: p.style });
            cw += chw;
          }
        line.push(cur);
        w = cw;
        continue;
      }
      line.push(tok);
      w += tw;
    }
    flush();
  }
  const lines: RichLine[] = [];
  let top = TEXT_PADDING;
  for (const row of rows) {
    const segs: RichSegment[] = [];
    let x = 0;
    for (const p of row.pieces) {
      const pw = widthOf(p.text, p.style);
      const last = segs[segs.length - 1];
      if (last && sameStyle(last.style, p.style)) {
        last.text += p.text;
        last.width += pw;
      } else segs.push({ text: p.text, x, width: pw, style: p.style });
      x += pw;
    }
    const styles = segs.length ? segs.map((s) => s.style) : [row.emptyStyle];
    const size = Math.max(...styles.map((s) => s.size));
    const ascent = Math.max(...styles.map((s) => fontMetrics(variantOf(s)).ascent * s.size));
    const descent = Math.max(...styles.map((s) => fontMetrics(variantOf(s)).descent * s.size));
    const lh = size * o.lineHeight;
    const baseline = top + (lh - (ascent + descent)) / 2 + ascent;
    const width = x;
    const lx = TEXT_PADDING + (o.align === 'center' ? (inner - width) / 2 : o.align === 'right' ? inner - width : 0);
    lines.push({ x: lx, baseline, width, segments: segs });
    top += lh;
  }
  return { lines, contentHeight: top + TEXT_PADDING };
}

/** Height a text box needs for its text (styled runs or plain). */
export function textContentHeight(o: TextObject): number {
  const runs = richRuns(o);
  return runs ? layoutRich(o, runs).contentHeight : layoutText(o).contentHeight;
}

/** Every font variant the runs use, with the text drawn in it. */
export function runVariants(o: Pick<TextObject, 'fontFamily' | 'bold' | 'italic' | 'fontSize' | 'color'>, runs: TextRun[]): Map<string, { variant: FontVariant; text: string }> {
  const base = boxStyle(o);
  const out = new Map<string, { variant: FontVariant; text: string }>();
  for (const r of runs) {
    const v = variantOf(resolveRun(base, r));
    const k = `${v.family}-${v.bold}-${v.italic}`;
    const hit = out.get(k);
    if (hit) hit.text += r.text;
    else out.set(k, { variant: v, text: r.text });
  }
  return out;
}
