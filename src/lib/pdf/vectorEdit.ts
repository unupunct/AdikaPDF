/**
 * Drawings already on a page (lines, boxes, curves, filled shapes): each
 * painted path with its colours, line width and opacity, in PDF user space,
 * and removing one from the page content so it can become an editable
 * object (move, resize, recolour, change the line width, delete). Pure.
 */
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage } from 'pdf-lib';
import { pageContent, parseContent, resourcesOf, type Instr } from './textRemoval';

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (A: M, B: M): M => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4],
  A[4] * B[1] + A[5] * B[3] + B[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export type PathCmd = { c: 'M' | 'L'; p: [number, number] } | { c: 'C'; p: [number, number, number, number, number, number] } | { c: 'Z' };

export interface VectorPath {
  /** Instruction indices: first construction operator and the painting operator. */
  first: number;
  paint: number;
  /** The path in PDF user space. */
  cmds: PathCmd[];
  /** "#rrggbb", or null when the path is not filled / not stroked. */
  fill: string | null;
  stroke: string | null;
  /** Stroke width in user space. */
  lineWidth: number;
  evenOdd: boolean;
  opacity: number;
  /** Bounds in user space. */
  box: { x0: number; y0: number; x1: number; y1: number };
}

const hex = (c: number[]) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
function colorOf(nums: number[]): string | null {
  if (nums.length === 1) return hex([nums[0], nums[0], nums[0]]);
  if (nums.length === 3) return hex(nums);
  if (nums.length === 4) {
    const [c, m, y, k] = nums;
    return hex([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]);
  }
  return null;
}

/** Every path painted directly on the page, in drawing order (last = on top). Paths with pattern fills are left out. */
export function vectorPaths(doc: PDFDocument, page: PDFPage): VectorPath[] {
  const instrs = parseContent(pageContent(doc, page));
  const res = resourcesOf(page);
  const ext = res?.lookup(PDFName.of('ExtGState'));
  interface GS {
    ctm: M;
    fill: string | null;
    stroke: string | null;
    lw: number;
    ca: number;
    CA: number;
  }
  let gs: GS = { ctm: I, fill: '#000000', stroke: '#000000', lw: 1, ca: 1, CA: 1 };
  const stack: GS[] = [];
  const out: VectorPath[] = [];
  let cmds: PathCmd[] = [];
  let first = -1;
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let inText = false;
  const nums = (ins: Instr) => ins.args.map((a) => (a.k === 'n' ? a.v : NaN));
  const pt = (x: number, y: number) => apply(gs.ctm, x, y);
  const begin = (i: number) => {
    if (first < 0) first = i;
  };
  instrs.forEach((ins, i) => {
    const a = nums(ins);
    switch (ins.op) {
      case 'BT':
        inText = true;
        break;
      case 'ET':
        inText = false;
        break;
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (a.length === 6 && a.every(Number.isFinite)) gs.ctm = mul(a as M, gs.ctm);
        break;
      case 'w':
        if (Number.isFinite(a[0])) gs.lw = a[0];
        break;
      case 'g':
      case 'rg':
      case 'k':
      case 'sc':
      case 'scn':
        gs.fill = ins.args.some((x) => x.k === 'name') ? null : colorOf(a.filter(Number.isFinite));
        break;
      case 'G':
      case 'RG':
      case 'K':
      case 'SC':
      case 'SCN':
        gs.stroke = ins.args.some((x) => x.k === 'name') ? null : colorOf(a.filter(Number.isFinite));
        break;
      case 'cs':
        gs.fill = ins.args[0]?.k === 'name' && ins.args[0].v === 'Pattern' ? null : '#000000';
        break;
      case 'CS':
        gs.stroke = ins.args[0]?.k === 'name' && ins.args[0].v === 'Pattern' ? null : '#000000';
        break;
      case 'gs': {
        const n = ins.args[0]?.k === 'name' ? ins.args[0].v : '';
        const d = ext instanceof PDFDict ? ext.lookup(PDFName.of(n)) : undefined;
        if (d instanceof PDFDict) {
          const ca = d.lookup(PDFName.of('ca'));
          const CA = d.lookup(PDFName.of('CA'));
          const lw = d.lookup(PDFName.of('LW'));
          if (ca instanceof PDFNumber) gs.ca = ca.asNumber();
          if (CA instanceof PDFNumber) gs.CA = CA.asNumber();
          if (lw instanceof PDFNumber) gs.lw = lw.asNumber();
        }
        break;
      }
      case 'm':
        begin(i);
        cur = start = [a[0], a[1]];
        cmds.push({ c: 'M', p: pt(a[0], a[1]) });
        break;
      case 'l':
        begin(i);
        cur = [a[0], a[1]];
        cmds.push({ c: 'L', p: pt(a[0], a[1]) });
        break;
      case 'c':
        begin(i);
        cmds.push({ c: 'C', p: [...pt(a[0], a[1]), ...pt(a[2], a[3]), ...pt(a[4], a[5])] });
        cur = [a[4], a[5]];
        break;
      case 'v':
        begin(i);
        cmds.push({ c: 'C', p: [...pt(cur[0], cur[1]), ...pt(a[0], a[1]), ...pt(a[2], a[3])] });
        cur = [a[2], a[3]];
        break;
      case 'y':
        begin(i);
        cmds.push({ c: 'C', p: [...pt(a[0], a[1]), ...pt(a[2], a[3]), ...pt(a[2], a[3])] });
        cur = [a[2], a[3]];
        break;
      case 'h':
        cmds.push({ c: 'Z' });
        cur = start;
        break;
      case 're': {
        begin(i);
        const [x, y, w, h] = a;
        cmds.push({ c: 'M', p: pt(x, y) }, { c: 'L', p: pt(x + w, y) }, { c: 'L', p: pt(x + w, y + h) }, { c: 'L', p: pt(x, y + h) }, { c: 'Z' });
        cur = start = [x, y];
        break;
      }
      case 'W':
      case 'W*':
        // A clipping path: not a drawing.
        cmds = [];
        first = -2;
        break;
      case 'n':
        cmds = [];
        first = -1;
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*': {
        const op = ins.op;
        if (op === 's' || op === 'b' || op === 'b*') cmds.push({ c: 'Z' });
        const filled = op !== 'S' && op !== 's';
        const stroked = op === 'S' || op === 's' || op.startsWith('B') || op.startsWith('b');
        const fill = filled ? gs.fill : null;
        const stroke = stroked ? gs.stroke : null;
        // Pattern paint (null) cannot be edited as a colour.
        if (first >= 0 && !inText && cmds.length && (!filled || fill) && (!stroked || stroke)) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const c of cmds) if (c.c !== 'Z') for (let k = 0; k < c.p.length; k += 2) (xs.push(c.p[k]), ys.push(c.p[k + 1]));
          const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
          out.push({
            first,
            paint: i,
            cmds,
            fill,
            stroke,
            lineWidth: (gs.lw || 0) * scale,
            evenOdd: op.endsWith('*'),
            opacity: Math.min(filled ? gs.ca : 1, stroked ? gs.CA : 1),
            box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
          });
        }
        cmds = [];
        first = -1;
        break;
      }
    }
  });
  return out;
}

/** Removes a path (from its first construction operator to its painting operator) from the page content. */
export function removePath(doc: PDFDocument, page: PDFPage, path: Pick<VectorPath, 'first' | 'paint'>): void {
  const src = pageContent(doc, page);
  const instrs = parseContent(src);
  const a = instrs[path.first];
  const b = instrs[path.paint];
  if (!a || !b || b.end < a.start) throw new Error('That drawing is no longer on the page.');
  const out = new Uint8Array(src.length - (b.end - a.start));
  out.set(src.subarray(0, a.start), 0);
  out.set(src.subarray(b.end), a.start);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));

}

/** SVG path data for commands mapped by `f` (e.g. into an object's own box). */
export function svgPath(cmds: PathCmd[], f: (x: number, y: number) => [number, number]): string {
  const r = (v: number) => String(Math.round(v * 100) / 100);
  return cmds
    .map((c) => {
      if (c.c === 'Z') return 'Z';
      const p: number[] = [];
      for (let k = 0; k < c.p.length; k += 2) p.push(...f(c.p[k], c.p[k + 1]));
      return `${c.c} ${p.map(r).join(' ')}`;
    })
    .join(' ');
}

/** Parses the absolute M / L / C / Z path data svgPath() writes. */
export function parseSvgPath(d: string): PathCmd[] {
  const out: PathCmd[] = [];
  for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const n = m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : [];
    if (m[1] === 'Z') out.push({ c: 'Z' });
    else if (m[1] === 'C') for (let k = 0; k + 5 < n.length; k += 6) out.push({ c: 'C', p: n.slice(k, k + 6) as [number, number, number, number, number, number] });
    else for (let k = 0; k + 1 < n.length; k += 2) out.push({ c: m[1] as 'M' | 'L', p: [n[k], n[k + 1]] });
  }
  return out;
}
