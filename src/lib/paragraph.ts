/**
 * Paragraph detection for "Edit text": from the text runs of a page, the
 * lines around a clicked point that belong to the same paragraph (same size,
 * regular line spacing, same column), with the paragraph text rejoined
 * (hyphenated line breaks become whole words again). Horizontal text only;
 * pure (display space, points).
 */
export interface Run {
  str: string;
  origin: [number, number];
  dir: [number, number];
  size: number;
  width: number;
  bold?: boolean;
  italic?: boolean;
  fontName?: string;
  fontFamily?: string | null;
}

export interface Line {
  runs: Run[];
  text: string;
  /** Baseline y, left and right x. */
  baseline: number;
  left: number;
  right: number;
  size: number;
}

export interface Paragraph {
  lines: Line[];
  text: string;
  /** Box of the paragraph: top of the first line to the bottom of the last. */
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  /** Baseline-to-baseline distance divided by the font size (1 for a single line). */
  lineHeight: number;
  /** One rect per line (the letters to replace). */
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  align: 'left' | 'center' | 'right';
}

const ASC = 0.92;
const DESC = 0.24;

/** Groups horizontal runs into lines (top to bottom, left to right). */
export function linesOf(runs: Run[]): Line[] {
  const flat = runs.filter((r) => Math.abs(r.dir[0] - 1) < 0.01 && Math.abs(r.dir[1]) < 0.01 && r.str.length > 0);
  flat.sort((a, b) => a.origin[1] - b.origin[1] || a.origin[0] - b.origin[0]);
  const lines: Line[] = [];
  for (const r of flat) {
    const last = lines[lines.length - 1];
    // Same line: same baseline and no big horizontal gap (another column).
    if (last && Math.abs(r.origin[1] - last.baseline) < r.size * 0.35 && r.origin[0] - last.right < r.size * 1.0 && r.origin[0] >= last.left - 1) {
      const gap = r.origin[0] - last.right;
      last.text += gap > r.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(r.str) ? ` ${r.str}` : r.str;
      last.runs.push(r);
      last.right = Math.max(last.right, r.origin[0] + r.width);
      last.size = Math.max(last.size, r.size);
    } else {
      lines.push({ runs: [r], text: r.str, baseline: r.origin[1], left: r.origin[0], right: r.origin[0] + r.width, size: r.size });
    }
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text.length > 0);
}

const lineRect = (l: Line) => ({ x: l.left, y: l.baseline - l.size * ASC, width: l.right - l.left, height: l.size * (ASC + DESC) });

/** The paragraph containing the point (x, y), or null when there is no text there. */
export function paragraphAt(runs: Run[], x: number, y: number): Paragraph | null {
  const lines = linesOf(runs);
  const hit = lines.findIndex((l) => {
    const r = lineRect(l);
    return x >= r.x - 1 && x <= r.x + r.width + 1 && y >= r.y - 1 && y <= r.y + r.height + 1;
  });
  if (hit < 0) return null;
  const base = lines[hit];
  const sameCol = (a: Line, b: Line) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > Math.min(a.right - a.left, b.right - b.left) * 0.3;
  const sameSize = (a: Line, b: Line) => Math.abs(a.size - b.size) < 0.6;
  // Lines of this column, in order.
  const col = lines.filter((l) => sameCol(l, base) || l === base).sort((a, b) => a.baseline - b.baseline);
  const i = col.indexOf(base);
  let spacing = 0;
  const fits = (a: Line, b: Line) => {
    if (!sameSize(a, b)) return false;
    const d = b.baseline - a.baseline;
    if (d < a.size * 0.95 || d > a.size * 2.2) return false;
    return spacing === 0 || Math.abs(d - spacing) < spacing * 0.15;
  };
  let first = i;
  let last = i;
  const maxRight = () => Math.max(...col.slice(first, last + 1).map((l) => l.right));
  // Down: stop after a clearly short line (the paragraph's last line).
  while (last + 1 < col.length && fits(col[last], col[last + 1])) {
    if (!spacing) spacing = col[last + 1].baseline - col[last].baseline;
    const shortLine = col[last].right < maxRight() - col[last].size * 3;
    if (shortLine && last > first) break;
    last++;
  }
  // Up: the line above belongs here unless it is short (it ends the previous paragraph).
  while (first > 0 && fits(col[first - 1], col[first])) {
    const above = col[first - 1];
    if (!spacing) spacing = col[first].baseline - above.baseline;
    if (above.right < Math.max(maxRight(), above.right) - above.size * 3) break;
    first--;
  }
  const ls = col.slice(first, last + 1);
  let text = '';
  for (const [k, l] of ls.entries()) {
    if (k === 0) text = l.text;
    else if (/[\p{L}]-$/u.test(text) && /^\p{Ll}/u.test(l.text)) text = text.slice(0, -1) + l.text; // hyphenated word
    else text += ` ${l.text}`;
  }
  const rects = ls.map(lineRect);
  const x0 = Math.min(...rects.map((r) => r.x));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const size = base.size;
  const lefts = ls.map((l) => l.left);
  const rights = ls.map((l) => l.right);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const centres = ls.map((l) => (l.left + l.right) / 2);
  const align: Paragraph['align'] = ls.length > 1 && spread(lefts) > size && spread(centres) < size * 0.5 ? 'center' : ls.length > 1 && spread(lefts) > size && spread(rights) < size * 0.5 ? 'right' : 'left';
  return {
    lines: ls,
    text,
    x: x0,
    y: rects[0].y,
    width: x1 - x0,
    height: rects[rects.length - 1].y + rects[rects.length - 1].height - rects[0].y,
    size,
    lineHeight: ls.length > 1 ? spacing / size : 1.2,
    rects,
    align,
  };
}
