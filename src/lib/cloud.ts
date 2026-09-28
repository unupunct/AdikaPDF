/**
 * Cloudy border (Acrobat's "Cloud" comment): semicircle-like scallops along
 * the edges of a box, bulging outwards. Shared by the viewer (SVG path) and
 * the PDF exporter (Bézier curves) so both draw the same shape.
 */

/** One scallop: a cubic Bézier from (x0, y0) to (x, y). Box-local coordinates, y down. */
export interface Scallop {
  x0: number;
  y0: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x: number;
  y: number;
}

/** Scallops clockwise round a w × h box; `size` is the target scallop width. */
export function cloudScallops(w: number, h: number, size = 14): Scallop[] {
  const out: Scallop[] = [];
  // Edges clockwise on screen, each with its outward normal.
  const edges: Array<[number, number, number, number, number, number]> = [
    [0, 0, w, 0, 0, -1],
    [w, 0, w, h, 1, 0],
    [w, h, 0, h, 0, 1],
    [0, h, 0, 0, -1, 0],
  ];
  for (const [ax, ay, bx, by, nx, ny] of edges) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.round(len / size));
    const bulge = ((len / n) / 2) * (4 / 3) * 0.75;
    for (let k = 0; k < n; k++) {
      const x0 = ax + ((bx - ax) * k) / n;
      const y0 = ay + ((by - ay) * k) / n;
      const x = ax + ((bx - ax) * (k + 1)) / n;
      const y = ay + ((by - ay) * (k + 1)) / n;
      out.push({ x0, y0, c1x: x0 + nx * bulge, c1y: y0 + ny * bulge, c2x: x + nx * bulge, c2y: y + ny * bulge, x, y });
    }
  }
  return out;
}

/** SVG path data for the cloud (for Konva's Path). */
export function cloudPathData(w: number, h: number, size?: number): string {
  const s = cloudScallops(w, h, size);
  if (!s.length) return '';
  const f = (v: number) => Math.round(v * 100) / 100;
  return `M${f(s[0].x0)} ${f(s[0].y0)} ` + s.map((c) => `C${f(c.c1x)} ${f(c.c1y)} ${f(c.c2x)} ${f(c.c2y)} ${f(c.x)} ${f(c.y)}`).join(' ') + ' Z';
}
