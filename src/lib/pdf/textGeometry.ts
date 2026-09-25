/**
 * Text runs of a page in display space — used by search highlighting and by
 * "Edit text" (click an existing run to replace it).
 */
import type { PageRef } from '@/types';
import { getPdfPage, getTextItems, type TextItem } from './pdfService';
import { totalRotation } from '@/lib/geometry';

export interface TextRun {
  str: string;
  /** Display-space quad corners (scale 1): origin, along-text, up. */
  origin: [number, number];
  /** Unit vector along the text direction in display space. */
  dir: [number, number];
  /** Font height in points. */
  size: number;
  /** Advance width of the whole run in points. */
  width: number;
  fontName: string;
  fontFamily: string | null;
  bold: boolean;
  italic: boolean;
}

export async function pageTextRuns(page: PageRef): Promise<TextRun[]> {
  if (page.kind !== 'source' || !page.sourceId) return [];
  const [pdfPage, items, styles] = await Promise.all([
    getPdfPage(page.sourceId, page.sourceIndex),
    getTextItems(page.sourceId, page.sourceIndex),
    getPdfPage(page.sourceId, page.sourceIndex).then((p) => p.getTextContent().then((c) => c.styles)),
  ]);
  const vp = pdfPage.getViewport({ scale: 1, rotation: totalRotation(page) });
  return items
    .filter((it: TextItem) => it.str.length > 0)
    .map((it: TextItem) => {
      const [a, b, c, d, e, f] = it.transform;
      const o = vp.convertToViewportPoint(e, f);
      const along = vp.convertToViewportPoint(e + a, f + b);
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      const len = Math.hypot(along[0] - o[0], along[1] - o[1]) || 1;
      const style = styles[it.fontName];
      const name = `${it.fontName} ${style?.fontFamily ?? ''}`.toLowerCase();
      return {
        str: it.str,
        origin: [o[0], o[1]] as [number, number],
        dir: [(along[0] - o[0]) / len, (along[1] - o[1]) / len] as [number, number],
        size,
        width: it.width,
        fontName: it.fontName,
        fontFamily: style?.fontFamily ?? null,
        bold: /bold|black|heavy|semibold|demi/.test(name),
        italic: /italic|oblique/.test(name),
      };
    });
}

/** Axis-aligned display rect of chars [from, to) of a run (proportional estimate). */
export function runRect(run: TextRun, from = 0, to = run.str.length): { x: number; y: number; width: number; height: number } {
  const n = Math.max(1, run.str.length);
  const u0 = (run.width * from) / n;
  const u1 = (run.width * to) / n;
  const [dx, dy] = run.dir;
  // "Up" is the direction rotated 90° counter-clockwise on screen (y down).
  const ux = dy;
  const uy = -dx;
  const asc = run.size * 0.92;
  const desc = run.size * 0.24;
  const pts: Array<[number, number]> = [];
  for (const u of [u0, u1]) {
    for (const v of [-desc, asc]) {
      pts.push([run.origin[0] + dx * u + ux * v, run.origin[1] + dy * u + uy * v]);
    }
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Rotation (degrees clockwise) of a run's baseline in display space. */
export function runAngle(run: TextRun): number {
  const deg = (Math.atan2(run.dir[1], run.dir[0]) * 180) / Math.PI;
  return ((Math.round(deg) % 360) + 360) % 360;
}
