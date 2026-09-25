/**
 * Shared text layout for text boxes. The editor canvas and the PDF exporter
 * both call `layoutText`, with the same measuring function, so line breaks
 * and baselines are identical on screen and on paper.
 */
import { canvasFont, fontMetrics, type FontVariant } from './fonts';
import type { TextAlign, TextObject } from '@/types';

export const TEXT_PADDING = 2;

export type Measure = (text: string) => number;

export interface LaidOutLine {
  text: string;
  /** Left edge of the line in the box's local space. */
  x: number;
  /** Baseline, measured from the top of the box (y down). */
  baseline: number;
  width: number;
}

export interface TextLayout {
  lines: LaidOutLine[];
  /** Height the box needs to show every line. */
  contentHeight: number;
  lineHeightPx: number;
}

let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    measureCtx = ctx;
  }
  return measureCtx;
}

/** Width measurer in points for a font variant/size (kerning off, like pdf-lib). */
export function canvasMeasure(v: FontVariant, size: number): Measure {
  const ctx = context();
  // Measure at a large size and scale down: avoids integer px rounding.
  const probe = 100;
  return (text: string) => {
    ctx.font = canvasFont(v, probe);
    if ('fontKerning' in ctx) ctx.fontKerning = 'none';
    return (ctx.measureText(text).width * size) / probe;
  };
}

/** Greedy word wrap; words longer than the line are broken by characters. */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    const tokens = paragraph.split(/(\s+)/).filter((t) => t.length > 0);
    let line = '';
    for (const token of tokens) {
      const candidate = line + token;
      if (measure(candidate.trimEnd()) <= maxWidth || line === '') {
        if (line === '' && measure(token) > maxWidth && !/^\s+$/.test(token)) {
          // Hard-break an over-long word.
          let chunk = '';
          for (const ch of token) {
            if (measure(chunk + ch) > maxWidth && chunk !== '') {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(token) ? '' : token;
        if (measure(line) > maxWidth) {
          let chunk = '';
          for (const ch of line) {
            if (measure(chunk + ch) > maxWidth && chunk !== '') {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        }
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function layoutText(
  obj: Pick<TextObject, 'text' | 'width' | 'fontSize' | 'lineHeight' | 'align' | 'fontFamily' | 'bold' | 'italic'>,
  measure: Measure = canvasMeasure({ family: obj.fontFamily, bold: obj.bold, italic: obj.italic }, obj.fontSize),
): TextLayout {
  const variant = { family: obj.fontFamily, bold: obj.bold, italic: obj.italic };
  const { ascent, descent } = fontMetrics(variant);
  const inner = Math.max(1, obj.width - TEXT_PADDING * 2);
  const lineHeightPx = obj.fontSize * obj.lineHeight;
  const glyphHeight = (ascent + descent) * obj.fontSize;
  const rows = wrapText(obj.text, inner, measure);
  const lines = rows.map((text, i) => {
    const width = measure(text);
    const top = TEXT_PADDING + i * lineHeightPx;
    const baseline = top + (lineHeightPx - glyphHeight) / 2 + ascent * obj.fontSize;
    return { text, width, baseline, x: alignX(obj.align, width, inner) + TEXT_PADDING };
  });
  return { lines, lineHeightPx, contentHeight: rows.length * lineHeightPx + TEXT_PADDING * 2 };
}

function alignX(align: TextAlign, width: number, inner: number): number {
  if (align === 'center') return (inner - width) / 2;
  if (align === 'right') return inner - width;
  return 0;
}
