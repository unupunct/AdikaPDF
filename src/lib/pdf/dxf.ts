// DXF (ASCII) → vector PDF.
//
// The drawing's model space is parsed with dxf-parser (plus in-module
// handlers for entities it does not know: HATCH, ATTRIB, LEADER, TRACE,
// ACAD_TABLE and a weight-aware SPLINE), flattened into world-space
// primitives (paths with line/Bezier segments, text runs, points), fitted
// into the chosen paper with margins and written as a single PDF page of real
// vector content. Text is real, searchable text in an embedded font. Each DXF
// layer can become a PDF optional-content group so viewers can toggle layers.
//
// Everything here is browser-compatible and unit-testable in node.

import { pruneTrueType } from './fontEmbed';
import DxfParser from 'dxf-parser';
import type { IBlock, IDxf, IPoint } from 'dxf-parser';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, type PDFFont, type PDFRef } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export interface DxfToPdfOptions {
  /** 'auto' sizes the page to the drawing's aspect ratio (long side 420 mm). */
  paper: 'auto' | 'A4' | 'A3' | 'A2' | 'Letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  marginMm: number;
  /**
   * true: white paper; ACI 7 (white/black) and very light colours print black.
   * false: the drawing keeps its screen colours on a dark page background.
   */
  blackOnWhite: boolean;
  /** Default stroke width in millimetres (entities without a lineweight). */
  lineWeightMm: number;
  /** One PDF optional-content group (toggleable layer) per DXF layer. */
  layers: boolean;
  /** Returns TrueType/OpenType bytes for text (e.g. Noto Sans). */
  loadFont?: () => Promise<Uint8Array>;
}

export interface DxfConvertResult {
  bytes: Uint8Array;
  /** Drawn entities, including those expanded from block references. */
  entities: number;
  /** Entity types that were not drawn (unsupported or broken), with counts. */
  skipped: Record<string, number>;
  /** Layers present in the PDF (optional-content groups when `layers`). */
  layers: string[];
  warnings: string[];
}

export const DXF_DEFAULT_OPTIONS: DxfToPdfOptions = {
  paper: 'auto',
  orientation: 'auto',
  marginMm: 10,
  blackOnWhite: true,
  lineWeightMm: 0.25,
  layers: true,
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Vec {
  x: number;
  y: number;
}
/** Affine matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  // m ∘ n (n applied first)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m: Mat, p: Vec): Vec {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}
function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}
function scale(sx: number, sy: number): Mat {
  return [sx, 0, 0, sy, 0, 0];
}
function linearScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}
const MIRROR_X: Mat = [-1, 0, 0, 1, 0, 0];
const DEG = Math.PI / 180;

type Seg =
  | { k: 'M'; p: Vec }
  | { k: 'L'; p: Vec }
  | { k: 'C'; c1: Vec; c2: Vec; p: Vec }
  | { k: 'Z' };

/** Builds path segments in world coordinates through a local→world matrix. */
class PathBuilder {
  readonly segs: Seg[] = [];
  private cur: Vec | undefined;
  constructor(private readonly m: Mat) {}
  moveTo(p: Vec): void {
    this.segs.push({ k: 'M', p: apply(this.m, p) });
    this.cur = p;
  }
  lineTo(p: Vec): void {
    if (!this.cur) return this.moveTo(p);
    this.segs.push({ k: 'L', p: apply(this.m, p) });
    this.cur = p;
  }
  close(): void {
    this.segs.push({ k: 'Z' });
  }
  /** Elliptical arc C + U cos t + V sin t from t0 to t1 (any direction). */
  ellipseArc(c: Vec, u: Vec, v: Vec, t0: number, t1: number, connect: boolean): void {
    const pt = (t: number): Vec => ({ x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) });
    const dt = (t: number): Vec => ({ x: -u.x * Math.sin(t) + v.x * Math.cos(t), y: -u.y * Math.sin(t) + v.y * Math.cos(t) });
    const sweep = t1 - t0;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const h = sweep / n;
    const k = (4 / 3) * Math.tan(h / 4);
    const start = pt(t0);
    if (connect && this.cur) this.lineTo(start);
    else this.moveTo(start);
    for (let i = 0; i < n; i++) {
      const a = t0 + i * h;
      const b = a + h;
      const p0 = pt(a);
      const p1 = pt(b);
      const d0 = dt(a);
      const d1 = dt(b);
      const c1 = { x: p0.x + k * d0.x, y: p0.y + k * d0.y };
      const c2 = { x: p1.x - k * d1.x, y: p1.y - k * d1.y };
      this.segs.push({ k: 'C', c1: apply(this.m, c1), c2: apply(this.m, c2), p: apply(this.m, p1) });
      this.cur = p1;
    }
  }
  /** Polyline segment p→q with a DXF bulge (tan(θ/4); positive = CCW). */
  bulgeTo(p: Vec, q: Vec, bulge: number): void {
    if (!bulge || Math.abs(bulge) < 1e-9 || (p.x === q.x && p.y === q.y)) return this.lineTo(q);
    const arc = bulgeArc(p, q, bulge);
    this.ellipseArc(arc.c, { x: arc.r, y: 0 }, { x: 0, y: arc.r }, arc.a0, arc.a0 + arc.sweep, true);
  }
}

function bulgeArc(p: Vec, q: Vec, b: number): { c: Vec; r: number; a0: number; sweep: number } {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const f = (1 - b * b) / (4 * b);
  const c = { x: (p.x + q.x) / 2 - f * dy, y: (p.y + q.y) / 2 + f * dx };
  const r = Math.hypot(p.x - c.x, p.y - c.y);
  return { c, r, a0: Math.atan2(p.y - c.y, p.x - c.x), sweep: 4 * Math.atan(b) };
}

/** Samples an elliptical arc into points (used for hatch boundaries). */
function sampleArc(c: Vec, u: Vec, v: Vec, t0: number, t1: number): Vec[] {
  const n = Math.max(2, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 36)));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    out.push({ x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) });
  }
  return out;
}

/** Evaluates a (rational) B-spline into points. */
function evalBSpline(ctrl: Vec[], degree: number, knots: number[] | undefined, weights: number[] | undefined): Vec[] {
  const n = ctrl.length;
  const p = Math.max(1, Math.min(degree || 3, n - 1));
  if (n < 2) return ctrl.slice();
  if (p === 1 && (!weights || weights.every((w) => w === 1))) return ctrl.slice();
  let U = knots && knots.length === n + p + 1 ? knots.slice() : undefined;
  if (!U) {
    // Clamped uniform knot vector.
    U = [];
    for (let i = 0; i <= n + p; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const w = weights && weights.length === n ? weights : undefined;
  const u0 = U[p];
  const u1 = U[n];
  if (!(u1 > u0)) return ctrl.slice();
  const samples = Math.min(2000, Math.max(24, n * 12));
  const out: Vec[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s === samples ? u1 : u0 + ((u1 - u0) * s) / samples;
    let k = p;
    while (k < n - 1 && U[k + 1] <= u) k++;
    // de Boor in homogeneous coordinates
    const d: [number, number, number][] = [];
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const wi = w ? w[i] : 1;
      d.push([ctrl[i].x * wi, ctrl[i].y * wi, wi]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const a = den === 0 ? 0 : (u - U[i]) / den;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const [x, y, ww] = d[p];
    out.push(ww ? { x: x / ww, y: y / ww } : { x, y });
  }
  return out;
}

/** Catmull-Rom through fit points, as cubic Bezier control quadruples. */
function fitPointBeziers(pts: Vec[], closed: boolean): { p0: Vec; c1: Vec; c2: Vec; p1: Vec }[] {
  const n = pts.length;
  const at = (i: number): Vec => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: { p0: Vec; c1: Vec; c2: Vec; p1: Vec }[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    out.push({
      p0: p1,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      p1: p2,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

// AutoCAD Color Index → RGB (same table dxf-parser uses), 6 hex digits each.
const ACI_HEX =
  '000000ff0000ffff0000ff0000ffff0000ffff00ffffffff808080c0c0c0ff0000ff7f7fcc0000cc6666990000994c4c' +
  '7f00007f3f3f4c00004c2626ff3f00ff9f7fcc3300cc7f66992600995f4c7f1f007f4f3f4c13004c2f26ff7f00ffbf7f' +
  'cc6600cc9966994c0099724c7f3f007f5f3f4c26004c3926ffbf00ffdf7fcc9900ccb26699720099854c7f5f007f6f3f' +
  '4c39004c4226ffff00ffff7fcccc00cccc6698980098984c7f7f007f7f3f4c4c004c4c26bfff00dfff7f99cc00b2cc66' +
  '72980085984c5f7f006f7f3f394c00424c267fff00bfff7f66cc0099cc664c980072984c3f7f005f7f3f264c00394c26' +
  '3fff009fff7f33cc007fcc662698005f984c1f7f004f7f3f134c002f4c2600ff007fff7f00cc0066cc660098004c984c' +
  '007f003f7f3f004c00264c2600ff3f7fff9f00cc3366cc7f0098264c985f007f1f3f7f4f004c13264c2f00ff7f7fffbf' +
  '00cc6666cc9900984c4c9872007f3f3f7f5f004c26264c3900ffbf7fffdf00cc9966ccb20098724c9885007f5f3f7f6f' +
  '004c39264c4200ffff7fffff00cccc66cccc0098984c9898007f7f3f7f7f004c4c264c4c00bfff7fdfff0099cc66b2cc' +
  '0072984c8598005f7f3f6f7f00394c26424c007fff7fbfff0066cc6699cc004c984c7298003f7f3f5f7f00264c26394c' +
  '003fff7f9fff0033cc667fcc0026984c5f98001f7f3f4f7f00134c262f4c0000ff7f7fff0000cc6666cc0000984c4c98' +
  '00007f3f3f7f00004c26264c3f00ff9f7fff3300cc7f66cc2600985f4c981f007f4f3f7f13004c2f264c7f00ffbf7fff' +
  '6600cc9966cc4c0098724c983f007f5f3f7f26004c39264cbf00ffdf7fff9900ccb266cc720098854c985f007f6f3f7f' +
  '39004c42264cff00ffff7fffcc00cccc66cc980098984c987f007f7f3f7f4c004c4c264cff00bfff7fdfcc0099cc66b2' +
  '980072984c857f005f7f3f6f4c00394c2642ff007fff7fbfcc0066cc669998004c984c727f003f7f3f5f4c00264c2639' +
  'ff003fff7f9fcc0033cc667f980026984c5f7f001f7f3f4f4c00134c262f3333335b5b5b848484adadadd6d6d6ffffff';
function aciRgb(i: number): number {
  const idx = Math.abs(Math.round(i));
  if (idx < 0 || idx > 255) return 0xffffff;
  return parseInt(ACI_HEX.slice(idx * 6, idx * 6 + 6), 16);
}

interface Colour {
  rgb: number;
  /** ACI 7: white on screen, black on paper. */
  fg: boolean;
}
const FOREGROUND: Colour = { rgb: 0xffffff, fg: true };

function luminance(rgb: number): number {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// Raw DXF scanning (layers with all properties, entity names)
// ---------------------------------------------------------------------------

interface Group {
  code: number;
  value: string | number | boolean;
}

interface LayerInfo {
  name: string;
  colour: Colour;
  off: boolean;
  frozen: boolean;
  plot: boolean;
  lineType?: string;
  lineweight?: number;
  order: number;
}

function decodeDxfString(s: string): string {
  return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\M\+\d[0-9A-Fa-f]{4}/g, '?');
}

interface RawScan {
  layers: Map<string, LayerInfo>;
  entityNames: Set<string>;
  hasSections: boolean;
}

function scanRaw(text: string): RawScan {
  const lines = text.split(/\r\n|\r|\n/);
  const layers = new Map<string, LayerInfo>();
  const entityNames = new Set<string>();
  let section = '';
  let hasSections = false;
  let table = '';
  let layer: Partial<LayerInfo> & { aci?: number; tc?: number } | undefined;
  const flushLayer = () => {
    if (layer?.name !== undefined) {
      const aci = layer.aci ?? 7;
      const colour: Colour = layer.tc !== undefined ? { rgb: layer.tc, fg: false } : { rgb: aciRgb(aci), fg: Math.abs(aci) === 7 };
      layers.set(layer.name.toLowerCase(), {
        name: layer.name,
        colour,
        off: layer.off ?? false,
        frozen: layer.frozen ?? false,
        plot: layer.plot ?? true,
        lineType: layer.lineType,
        lineweight: layer.lineweight,
        order: layers.size,
      });
    }
    layer = undefined;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) break;
    const value = lines[i + 1].trim();
    if (code === 0) {
      if (value === 'SECTION') {
        hasSections = true;
        const nextCode = parseInt(lines[i + 2]?.trim() ?? '', 10);
        section = nextCode === 2 ? (lines[i + 3]?.trim() ?? '') : '';
        continue;
      }
      if (value === 'ENDSEC') {
        flushLayer();
        section = '';
        continue;
      }
      if (section === 'TABLES') {
        if (value === 'TABLE') {
          table = parseInt(lines[i + 2]?.trim() ?? '', 10) === 2 ? (lines[i + 3]?.trim() ?? '') : '';
        } else if (value === 'ENDTAB') {
          flushLayer();
          table = '';
        } else if (table === 'LAYER' && value === 'LAYER') {
          flushLayer();
          layer = {};
        }
      } else if (section === 'ENTITIES' || section === 'BLOCKS') {
        if (!['BLOCK', 'ENDBLK', 'SEQEND', 'VERTEX', 'EOF'].includes(value)) entityNames.add(value);
      }
      continue;
    }
    if (layer && section === 'TABLES' && table === 'LAYER') {
      if (code === 2) layer.name = decodeDxfString(value);
      else if (code === 62) {
        const v = parseInt(value, 10);
        layer.aci = v;
        if (v < 0) layer.off = true;
      } else if (code === 420) layer.tc = parseInt(value, 10);
      else if (code === 70) {
        const v = parseInt(value, 10);
        layer.frozen = (v & 1) !== 0;
      } else if (code === 6) layer.lineType = value;
      else if (code === 370) layer.lineweight = parseInt(value, 10);
      else if (code === 290) layer.plot = value !== '0';
    }
  }
  flushLayer();
  return { layers, entityNames, hasSections };
}

// ---------------------------------------------------------------------------
// Parser extension: raw entities
// ---------------------------------------------------------------------------

interface ScannerLike {
  next(): Group;
  isEOF(): boolean;
}

/** Common entity fields plus every group code, for entities parsed here. */
interface RawEntity {
  type: string;
  raw: Group[];
  layer?: string;
  colorIndex?: number;
  color?: number;
  lineType?: string;
  lineweight?: number;
  lineTypeScale?: number;
  visible?: boolean;
  inPaperSpace?: boolean;
}

function makeRawHandler(name: string): new () => { ForEntityName: string; parseEntity(scanner: ScannerLike, curr: Group): RawEntity } {
  return class {
    ForEntityName = name;
    parseEntity(scanner: ScannerLike, curr: Group): RawEntity {
      const e: RawEntity = { type: String(curr.value), raw: [] };
      let g = scanner.next();
      while (g.code !== 0) {
        switch (g.code) {
          case 8:
            e.layer = String(g.value);
            break;
          case 62:
            e.colorIndex = Number(g.value);
            e.color = Math.abs(Number(g.value)) <= 255 ? aciRgb(Number(g.value)) : undefined;
            break;
          case 420:
            e.color = Number(g.value);
            break;
          case 6:
            e.lineType = String(g.value);
            break;
          case 370:
            e.lineweight = Number(g.value);
            break;
          case 48:
            e.lineTypeScale = Number(g.value);
            break;
          case 60:
            e.visible = Number(g.value) === 0;
            break;
          case 67:
            e.inPaperSpace = Number(g.value) !== 0;
            break;
          default:
            e.raw.push(g);
        }
        if (scanner.isEOF()) break;
        g = scanner.next();
      }
      return e;
    }
  };
}

const BUILTIN = new Set(['3DFACE', 'ARC', 'ATTDEF', 'CIRCLE', 'DIMENSION', 'ELLIPSE', 'INSERT', 'LINE', 'LWPOLYLINE', 'MTEXT', 'POINT', 'POLYLINE', 'SOLID', 'TEXT']);
/** Entities we parse ourselves (SPLINE replaces dxf-parser's, which drops weights). */
const RAW_ALWAYS = ['HATCH', 'SPLINE', 'ATTRIB', 'LEADER', 'TRACE', 'ACAD_TABLE'];

function num(raw: Group[], code: number, def: number): number {
  const g = raw.find((x) => x.code === code);
  const v = g ? Number(g.value) : NaN;
  return Number.isFinite(v) ? v : def;
}
function str(raw: Group[], code: number): string | undefined {
  const g = raw.find((x) => x.code === code);
  return g ? String(g.value) : undefined;
}
function pointOf(raw: Group[], code: number): Vec | undefined {
  const x = raw.find((g) => g.code === code);
  const y = raw.find((g) => g.code === code + 10);
  if (!x || !y) return undefined;
  return { x: Number(x.value), y: Number(y.value) };
}
/** All points of a repeated code pair (x code, x+10 y code), in order. */
function pointsOf(raw: Group[], code: number): Vec[] {
  const out: Vec[] = [];
  for (const g of raw) {
    if (g.code === code) out.push({ x: Number(g.value), y: 0 });
    else if (g.code === code + 10 && out.length) out[out.length - 1].y = Number(g.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

interface StrokeStyle {
  /** Paper stroke width in points. */
  widthPt: number;
  /** Additional world-unit width (polyline width), scaled with the drawing. */
  widthWorld: number;
  /** Dash pattern in world units, with phase. */
  dash?: { array: number[]; phase: number };
}

type Prim =
  | { kind: 'path'; layer: string; colour: Colour; segs: Seg[]; stroke?: StrokeStyle; fill?: 'nonzero' | 'evenodd'; fillTint?: number }
  | { kind: 'text'; layer: string; colour: Colour; str: string; m: Mat; box: [Vec, Vec, Vec, Vec] }
  | { kind: 'point'; layer: string; colour: Colour; p: Vec; widthPt: number };

interface Ctx {
  m: Mat;
  depth: number;
  blockColour?: Colour;
  blockLayer?: string;
  blockLw?: number;
  blockLt?: string;
  stack: string[];
}

const MAX_DEPTH = 16;
const MM_TO_PT = 72 / 25.4;

// Entity views over dxf-parser's objects (its typings mark every field as
// present; real files omit many, so everything is optional here).
interface EntityBase {
  type: string;
  layer?: string;
  colorIndex?: number;
  color?: number;
  lineType?: string;
  lineweight?: number;
  lineTypeScale?: number;
  visible?: boolean;
  inPaperSpace?: boolean;
  raw?: Group[];
}
type P3 = Partial<IPoint>;
interface LineE extends EntityBase {
  vertices?: P3[];
}
interface LwVertex extends P3 {
  bulge?: number;
  startWidth?: number;
  endWidth?: number;
}
interface LwPolyE extends EntityBase {
  vertices?: LwVertex[];
  shape?: boolean;
  width?: number;
  extrusionDirectionZ?: number;
}
interface PolyVertex extends LwVertex {
  splineControlPoint?: boolean;
  threeDPolylineMesh?: boolean;
  polyfaceMeshVertex?: boolean;
  faceA?: number;
  faceB?: number;
  faceC?: number;
  faceD?: number;
}
interface PolyE extends EntityBase {
  vertices?: PolyVertex[];
  shape?: boolean;
  is3dPolygonMesh?: boolean;
  isPolyfaceMesh?: boolean;
  extrusionDirection?: P3;
}
interface CircleE extends EntityBase {
  center?: P3;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  extrusionDirectionZ?: number;
}
interface EllipseE extends EntityBase {
  center?: P3;
  majorAxisEndPoint?: P3;
  axisRatio?: number;
  startAngle?: number;
  endAngle?: number;
}
interface PointE extends EntityBase {
  position?: P3;
}
interface TextE extends EntityBase {
  startPoint?: P3;
  endPoint?: P3;
  textHeight?: number;
  xScale?: number;
  rotation?: number;
  text?: string;
  halign?: number;
  valign?: number;
}
interface MTextE extends EntityBase {
  text?: string;
  position?: P3;
  directionVector?: P3;
  height?: number;
  width?: number;
  rotation?: number;
  attachmentPoint?: number;
}
interface SolidE extends EntityBase {
  points?: P3[];
  vertices?: P3[];
  extrusionDirection?: P3;
}
interface InsertE extends EntityBase {
  name?: string;
  xScale?: number;
  yScale?: number;
  position?: P3;
  rotation?: number;
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  extrusionDirection?: P3;
}
interface DimensionE extends EntityBase {
  block?: string;
}

function v2(p: P3 | undefined): Vec | undefined {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return undefined;
  return { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function percentCodes(s: string): string {
  return s
    .replace(/%%(\d{3})/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%');
}

/** Strips MTEXT inline formatting; returns paragraphs. */
export function mtextToPlain(src: string): string[] {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const c = src[i + 1];
    if (c === undefined) break;
    i++;
    switch (c) {
      case 'P':
      case 'N':
      case 'X':
        out += '\n';
        break;
      case '~':
        out += ' ';
        break;
      case '\\':
      case '{':
      case '}':
        out += c;
        break;
      case 'L':
      case 'l':
      case 'O':
      case 'o':
      case 'K':
      case 'k':
        break;
      case 'S': {
        const end = src.indexOf(';', i + 1);
        const body = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
        out += body.replace(/[\^#]/, '/').replace(/\^/g, '');
        i = end < 0 ? src.length : end;
        break;
      }
      case 'U': {
        const m = /^\+([0-9A-Fa-f]{4})/.exec(src.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[1], 16));
          i += 5;
        } else out += 'U';
        break;
      }
      case 'M':
        i += 6;
        out += '?';
        break;
      case 'f':
      case 'F':
      case 'H':
      case 'h':
      case 'W':
      case 'w':
      case 'Q':
      case 'q':
      case 'T':
      case 't':
      case 'A':
      case 'a':
      case 'C':
      case 'c':
      case 'p': {
        const end = src.indexOf(';', i + 1);
        i = end < 0 ? src.length : end;
        break;
      }
      default:
        out += c;
    }
  }
  return percentCodes(out).replace(/\t/g, ' ').split('\n');
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const PAPER_MM: Record<Exclude<DxfToPdfOptions['paper'], 'auto'>, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  Letter: [215.9, 279.4],
};

const UNIT_NAMES: Record<number, [string, number | undefined]> = {
  0: ['unitless', undefined],
  1: ['inches', 25.4],
  2: ['feet', 304.8],
  3: ['miles', 1609344],
  4: ['millimetres', 1],
  5: ['centimetres', 10],
  6: ['metres', 1000],
  7: ['kilometres', 1e6],
  8: ['microinches', 25.4e-6],
  9: ['mils', 0.0254],
  10: ['yards', 914.4],
  11: ['ångströms', 1e-7],
  12: ['nanometres', 1e-6],
  13: ['microns', 1e-3],
  14: ['decimetres', 100],
  15: ['decametres', 1e4],
  16: ['hectometres', 1e5],
};

/** Decodes DXF bytes: UTF-8 for AutoCAD 2007+ ($ACADVER ≥ AC1021), else $DWGCODEPAGE. */
export function decodeDxf(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  if (head.startsWith('AutoCAD Binary DXF')) {
    throw new Error('Binary DXF files are not supported. Save the drawing as ASCII DXF and try again.');
  }
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head)?.[1];
  if (ver && ver >= 'AC1021') return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d{3,4})/i.exec(head)?.[1];
    try {
      return new TextDecoder(cp ? `windows-${cp}` : 'windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(3);
  const t = s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
}

function pdfText(s: string): PDFString | PDFHexString {
  return /^[\x20-\x7e]*$/.test(s) && !/[()\\]/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s);
}

export async function dxfToPdf(dxfText: string, opts: DxfToPdfOptions): Promise<DxfConvertResult> {
  const text = dxfText.charCodeAt(0) === 0xfeff ? dxfText.slice(1) : dxfText;
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new Error('Binary DXF files are not supported. Save the drawing as ASCII DXF and try again.');
  }
  const scan = scanRaw(text);
  if (!scan.hasSections) throw new Error('This file is not a readable DXF drawing (no DXF sections were found).');

  const parser = new DxfParser();
  type Handler = Parameters<DxfParser['registerEntityHandler']>[0];
  const rawNames = new Set<string>(RAW_ALWAYS);
  for (const n of scan.entityNames) if (!BUILTIN.has(n)) rawNames.add(n);
  // dxf-parser's handler type is not exported; ours is structurally compatible.
  for (const n of rawNames) parser.registerEntityHandler(makeRawHandler(n) as unknown as Handler);

  let dxf: IDxf | null;
  try {
    dxf = parser.parseSync(text);
  } catch (e) {
    throw new Error(`The DXF file could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!dxf) throw new Error('The DXF file could not be read.');

  const warnings: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (t: string) => {
    skipped[t] = (skipped[t] ?? 0) + 1;
  };
  const header = (dxf.header ?? {}) as Record<string, unknown>;
  const hnum = (k: string, d: number): number => {
    const v = header[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const ltScale = hnum('$LTSCALE', 1) || 1;
  const defaultTextHeight = hnum('$TEXTSIZE', 2.5) || 2.5;
  const blocks: Record<string, IBlock> = dxf.blocks ?? {};
  const blockByName = new Map<string, IBlock>();
  for (const [k, b] of Object.entries(blocks)) blockByName.set(k.toLowerCase(), b);
  const lineTypes = new Map<string, { pattern?: number[] }>();
  const ltTable = (dxf.tables?.lineType?.lineTypes ?? {}) as Record<string, { pattern?: unknown[] }>;
  for (const [k, v] of Object.entries(ltTable)) {
    if (k && v) lineTypes.set(k.toLowerCase(), { pattern: (v.pattern ?? []).map((x) => Number(x)).filter((x) => Number.isFinite(x)) });
  }

  // --- Font ----------------------------------------------------------------
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const needsText = [...scan.entityNames].some((n) => ['TEXT', 'MTEXT', 'ATTRIB', 'DIMENSION', 'ACAD_TABLE', 'ATTDEF'].includes(n));
  // `font` measures and encodes; with a custom font it lives in a scratch
  // document and the page gets a glyph-pruned copy (see pruneTrueType).
  let font: PDFFont | undefined;
  let fullFontBytes: Uint8Array | undefined;
  let capRatio = 0.714;
  let descent = 0.25;
  let charset = new Set<number>();
  if (needsText) {
    if (opts.loadFont) {
      try {
        const bytes = await opts.loadFont();
        const scratch = await PDFDocument.create();
        scratch.registerFontkit(fontkit);
        font = await scratch.embedFont(bytes, { subset: false });
        fullFontBytes = bytes;
      } catch (e) {
        warnings.push(`The text font could not be loaded (${e instanceof Error ? e.message : String(e)}); using Helvetica, so some characters may be replaced.`);
      }
    } else {
      warnings.push('No text font was provided; using Helvetica, so characters outside Western European sets are replaced by "?".');
    }
    if (!font) {
      font = await doc.embedFont(StandardFonts.Helvetica);
      capRatio = 0.718;
    }
    charset = new Set(font.getCharacterSet());
    descent = Math.max(0, font.heightAtSize(1) - font.heightAtSize(1, { descender: false }));
  }
  const cleanText = (s: string): string => {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 63;
      out += charset.has(cp) || cp === 32 ? ch : cp < 32 ? ' ' : '?';
    }
    return out;
  };

  // --- Resolution helpers -------------------------------------------------
  const layerOf = (name: string): LayerInfo => {
    const l = scan.layers.get(name.toLowerCase());
    if (l) return l;
    const created: LayerInfo = { name, colour: FOREGROUND, off: false, frozen: false, plot: true, order: scan.layers.size };
    scan.layers.set(name.toLowerCase(), created);
    return created;
  };
  const effLayer = (e: EntityBase, ctx: Ctx): string => {
    const n = e.layer === undefined || e.layer === '' ? '0' : decodeDxfString(String(e.layer));
    return n === '0' && ctx.blockLayer !== undefined ? ctx.blockLayer : n;
  };
  const colourOf = (e: EntityBase, ctx: Ctx, layer: LayerInfo): Colour => {
    const idx = e.colorIndex;
    const col = e.color;
    if (typeof col === 'number' && (idx === undefined || (Math.abs(idx) <= 255 && aciRgb(idx) !== col) || idx === 256)) {
      return { rgb: col & 0xffffff, fg: false };
    }
    if (idx === 0) return ctx.blockColour ?? FOREGROUND;
    if (idx === undefined || idx === 256 || idx > 256 || idx < -256) return layer.colour;
    const a = Math.abs(idx);
    return { rgb: aciRgb(a), fg: a === 7 };
  };
  const lineweightOf = (e: EntityBase, ctx: Ctx, layer: LayerInfo): number => {
    const def = opts.lineWeightMm;
    const lw = e.lineweight;
    const fromLayer = () => (layer.lineweight !== undefined && layer.lineweight >= 0 ? layer.lineweight / 100 : def);
    if (lw === undefined || lw === -2) return fromLayer();
    if (lw === -1) return ctx.blockLw ?? fromLayer();
    if (lw < 0) return def;
    return lw / 100;
  };
  const missingLt = new Set<string>();
  const dashOf = (e: EntityBase, ctx: Ctx, layer: LayerInfo): StrokeStyle['dash'] => {
    let name = e.lineType;
    if (!name || name.toUpperCase() === 'BYLAYER') name = layer.lineType;
    else if (name.toUpperCase() === 'BYBLOCK') name = ctx.blockLt ?? layer.lineType;
    if (!name || name.toUpperCase() === 'CONTINUOUS' || name.toUpperCase() === 'BYLAYER' || name.toUpperCase() === 'BYBLOCK') return undefined;
    const lt = lineTypes.get(name.toLowerCase());
    if (!lt) {
      missingLt.add(name);
      return undefined;
    }
    const pat = lt.pattern ?? [];
    if (!pat.length) return undefined;
    const f = ltScale * (e.lineTypeScale || 1) * linearScale(ctx.m);
    // Merge into alternating on/off runs.
    const runs: { on: boolean; len: number }[] = [];
    for (const v of pat) {
      const on = v >= 0;
      const len = Math.abs(v) * f;
      const last = runs[runs.length - 1];
      if (last && last.on === on) last.len += len;
      else runs.push({ on, len });
    }
    let phase = 0;
    if (runs.length && !runs[0].on) {
      const g = runs.shift();
      if (g) {
        runs.push(g);
        const total = runs.reduce((s, r) => s + r.len, 0);
        phase = total - g.len;
      }
    }
    if (runs.length > 1 && runs[runs.length - 1].on) {
      const last = runs.pop();
      if (last) {
        runs[0].len += last.len;
        phase += last.len;
      }
    }
    if (runs.length < 2) return undefined;
    return { array: runs.map((r) => r.len), phase };
  };

  // --- Primitive collection -----------------------------------------------
  const prims: Prim[] = [];
  let drawn = 0;
  let hidden = 0;
  let paperSpace = 0;
  let depthHits = 0;
  let patternHatches = 0;
  let gradientHatches = 0;
  const errors = new Map<string, string>();

  const strokeFor = (e: EntityBase, ctx: Ctx, layer: LayerInfo, widthWorld = 0): StrokeStyle => ({
    widthPt: lineweightOf(e, ctx, layer) * MM_TO_PT,
    widthWorld: widthWorld * linearScale(ctx.m),
    dash: dashOf(e, ctx, layer),
  });

  const pushPath = (e: EntityBase, ctx: Ctx, layerName: string, layer: LayerInfo, pb: PathBuilder, extra: { fill?: 'nonzero' | 'evenodd'; noStroke?: boolean; widthWorld?: number; tint?: number } = {}) => {
    if (!pb.segs.length) return false;
    prims.push({
      kind: 'path',
      layer: layerName,
      colour: colourOf(e, ctx, layer),
      segs: pb.segs,
      stroke: extra.noStroke ? undefined : strokeFor(e, ctx, layer, extra.widthWorld ?? 0),
      fill: extra.fill,
      fillTint: extra.tint,
    });
    return true;
  };

  const pushText = (e: EntityBase, ctx: Ctx, layerName: string, layer: LayerInfo, str: string, local: Mat) => {
    if (!font) return false;
    const clean = cleanText(str).replace(/\s+$/, '');
    if (!clean.trim()) return false;
    const w = font.widthOfTextAtSize(clean, 1);
    const m = mul(ctx.m, local);
    const box: [Vec, Vec, Vec, Vec] = [
      apply(m, { x: 0, y: -descent }),
      apply(m, { x: w, y: -descent }),
      apply(m, { x: w, y: capRatio }),
      apply(m, { x: 0, y: capRatio }),
    ];
    prims.push({ kind: 'text', layer: layerName, colour: colourOf(e, ctx, layer), str: clean, m, box });
    return true;
  };

  const textWidth = (s: string): number => (font ? font.widthOfTextAtSize(cleanText(s), 1) : s.length * 0.6);

  const withOcs = (ctx: Ctx, extrusionZ: number | undefined): Mat => (typeof extrusionZ === 'number' && extrusionZ < 0 ? mul(ctx.m, MIRROR_X) : ctx.m);

  const renderBlock = (name: string, local: Mat, e: EntityBase, ctx: Ctx, layerName: string, layer: LayerInfo) => {
    const block = blockByName.get(name.toLowerCase());
    if (!block) return false;
    if (ctx.depth >= MAX_DEPTH || ctx.stack.includes(name.toLowerCase())) {
      depthHits++;
      return true;
    }
    const base = v2(block.position) ?? { x: 0, y: 0 };
    const child: Ctx = {
      m: mul(local, translate(-base.x, -base.y)),
      depth: ctx.depth + 1,
      blockColour: colourOf(e, ctx, layer),
      blockLayer: layerName,
      blockLw: lineweightOf(e, ctx, layer),
      blockLt: e.lineType && e.lineType.toUpperCase() !== 'BYBLOCK' ? (e.lineType.toUpperCase() === 'BYLAYER' ? layer.lineType : e.lineType) : ctx.blockLt,
      stack: [...ctx.stack, name.toLowerCase()],
    };
    for (const be of block.entities ?? []) emit(be as unknown as EntityBase, child);
    return true;
  };

  const hatchPaths = (raw: Group[]): Vec[][] => {
    const paths: Vec[][] = [];
    let i = raw.findIndex((g) => g.code === 91);
    if (i < 0) return paths;
    const nPaths = Number(raw[i].value);
    i++;
    const readFields = (codes: number[]): Map<number, number> => {
      const got = new Map<number, number>();
      while (i < raw.length && codes.includes(raw[i].code) && !got.has(raw[i].code)) {
        got.set(raw[i].code, Number(raw[i].value));
        i++;
      }
      return got;
    };
    for (let p = 0; p < nPaths; p++) {
      while (i < raw.length && raw[i].code !== 92) {
        if ([75, 76, 98, 450].includes(raw[i].code)) return paths;
        i++;
      }
      if (i >= raw.length) break;
      const flags = Number(raw[i].value);
      i++;
      const pts: Vec[] = [];
      const addPts = (seg: Vec[]) => {
        if (!seg.length) return;
        if (pts.length) {
          const last = pts[pts.length - 1];
          const d0 = Math.hypot(seg[0].x - last.x, seg[0].y - last.y);
          const d1 = Math.hypot(seg[seg.length - 1].x - last.x, seg[seg.length - 1].y - last.y);
          if (d1 < d0 * 0.5) seg = seg.slice().reverse();
        }
        pts.push(...seg);
      };
      if (flags & 2) {
        const f = readFields([72, 73, 93]);
        const hasBulge = (f.get(72) ?? 0) !== 0;
        const verts: { x: number; y: number; b: number }[] = [];
        while (i < raw.length && [10, 20, 42].includes(raw[i].code)) {
          const g = raw[i];
          if (g.code === 10) verts.push({ x: Number(g.value), y: 0, b: 0 });
          else if (g.code === 20 && verts.length) verts[verts.length - 1].y = Number(g.value);
          else if (g.code === 42 && verts.length && hasBulge) verts[verts.length - 1].b = Number(g.value);
          i++;
        }
        for (let k = 0; k < verts.length; k++) {
          const a = verts[k];
          if (k === 0) pts.push({ x: a.x, y: a.y });
          const b = verts[(k + 1) % verts.length];
          if (k === verts.length - 1 && !(hasBulge && a.b)) break;
          if (a.b) {
            const arc = bulgeArc(a, b, a.b);
            pts.push(...sampleArc(arc.c, { x: arc.r, y: 0 }, { x: 0, y: arc.r }, arc.a0, arc.a0 + arc.sweep).slice(1));
          } else if (k < verts.length - 1) pts.push({ x: b.x, y: b.y });
        }
      } else {
        const f = readFields([93]);
        const nEdges = f.get(93) ?? 0;
        for (let k = 0; k < nEdges; k++) {
          if (i >= raw.length || raw[i].code !== 72) break;
          const type = Number(raw[i].value);
          i++;
          if (type === 1) {
            const g = readFields([10, 20, 11, 21]);
            addPts([
              { x: g.get(10) ?? 0, y: g.get(20) ?? 0 },
              { x: g.get(11) ?? 0, y: g.get(21) ?? 0 },
            ]);
          } else if (type === 2) {
            const g = readFields([10, 20, 40, 50, 51, 73]);
            const c = { x: g.get(10) ?? 0, y: g.get(20) ?? 0 };
            const r = g.get(40) ?? 0;
            const ccw = (g.get(73) ?? 1) !== 0;
            let a0 = (g.get(50) ?? 0) * DEG;
            let a1 = (g.get(51) ?? 360) * DEG;
            if (!ccw) {
              a0 = -a0;
              a1 = -a1;
              if (a1 > a0) a1 -= 2 * Math.PI;
            } else if (a1 < a0) a1 += 2 * Math.PI;
            addPts(sampleArc(c, { x: r, y: 0 }, { x: 0, y: r }, a0, a1));
          } else if (type === 3) {
            const g = readFields([10, 20, 11, 21, 40, 50, 51, 73]);
            const c = { x: g.get(10) ?? 0, y: g.get(20) ?? 0 };
            const u = { x: g.get(11) ?? 1, y: g.get(21) ?? 0 };
            const ratio = g.get(40) ?? 1;
            const v = { x: -u.y * ratio, y: u.x * ratio };
            const ccw = (g.get(73) ?? 1) !== 0;
            const param = (deg: number) => Math.atan2(Math.sin(deg * DEG) / (ratio || 1), Math.cos(deg * DEG));
            let a0 = param(g.get(50) ?? 0);
            let a1 = (g.get(51) ?? 360) === 360 ? a0 + 2 * Math.PI : param(g.get(51) ?? 360);
            if (!ccw) {
              a0 = -a0;
              a1 = -a1;
              if (a1 > a0) a1 -= 2 * Math.PI;
            } else if (a1 <= a0) a1 += 2 * Math.PI;
            addPts(sampleArc(c, u, v, a0, a1));
          } else if (type === 4) {
            const h = readFields([94, 73, 74, 95, 96]);
            const deg = h.get(94) ?? 3;
            const knots: number[] = [];
            while (i < raw.length && raw[i].code === 40) knots.push(Number(raw[i++].value));
            const ctrl: Vec[] = [];
            const weights: number[] = [];
            while (i < raw.length && [10, 20, 42].includes(raw[i].code)) {
              const g = raw[i++];
              if (g.code === 10) ctrl.push({ x: Number(g.value), y: 0 });
              else if (g.code === 20 && ctrl.length) ctrl[ctrl.length - 1].y = Number(g.value);
              else if (g.code === 42) weights.push(Number(g.value));
            }
            while (i < raw.length && [97, 11, 21, 12, 22, 13, 23].includes(raw[i].code)) i++;
            addPts(evalBSpline(ctrl, deg, knots, weights.length === ctrl.length ? weights : undefined));
          } else {
            break;
          }
        }
      }
      while (i < raw.length && (raw[i].code === 97 || raw[i].code === 330)) i++;
      if (pts.length >= 3) paths.push(pts);
    }
    return paths;
  };

  function emit(e: EntityBase, ctx: Ctx): void {
    const type = String(e.type ?? 'UNKNOWN').toUpperCase();
    if (e.inPaperSpace) {
      paperSpace++;
      return;
    }
    if (e.visible === false) return;
    const layerName = effLayer(e, ctx);
    const layer = layerOf(layerName);
    if (layer.off || layer.frozen || !layer.plot || layerName.toLowerCase() === 'defpoints') {
      if (type !== 'INSERT' || layer.frozen) {
        hidden++;
        return;
      }
      // An INSERT on an off layer still shows block content on other layers.
    }
    try {
      if (renderEntity(type, e, ctx, layerName, layer) === true) {
        if (type !== 'INSERT' && type !== 'DIMENSION' && type !== 'ACAD_TABLE') drawn++;
      }
    } catch (err) {
      skip(type);
      if (!errors.has(type)) errors.set(type, err instanceof Error ? err.message : String(err));
    }
  }

  /** true: drawn; false: counted as skipped; null: handled, nothing to draw. */
  function renderEntity(type: string, e: EntityBase, ctx: Ctx, layerName: string, layer: LayerInfo): boolean | null {
    const raw = e.raw ?? [];
    switch (type) {
      case 'LINE': {
        const le = e as LineE;
        const a = v2(le.vertices?.[0]);
        const b = v2(le.vertices?.[1]);
        if (!a || !b) return fail(type);
        const pb = new PathBuilder(ctx.m);
        pb.moveTo(a);
        pb.lineTo(b);
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'LWPOLYLINE': {
        const pe = e as LwPolyE;
        const verts = (pe.vertices ?? []).filter((v) => typeof v.x === 'number' && typeof v.y === 'number');
        if (verts.length < 2) return verts.length === 1 ? pointPrim(e, ctx, layerName, layer, v2(verts[0])) : fail(type);
        let width = pe.width ?? 0;
        if (!width) {
          const w0 = verts[0].startWidth ?? 0;
          if (w0 > 0 && verts.every((v) => (v.startWidth ?? 0) === w0 && (v.endWidth ?? w0) === w0)) width = w0;
        }
        const pb = new PathBuilder(withOcs(ctx, pe.extrusionDirectionZ));
        polyPath(pb, verts, !!pe.shape);
        return pushPath(e, ctx, layerName, layer, pb, { widthWorld: width });
      }
      case 'POLYLINE': {
        const pe = e as PolyE;
        const all = pe.vertices ?? [];
        const m = withOcs(ctx, pe.extrusionDirection?.z);
        if (pe.isPolyfaceMesh) {
          const pos = all.filter((v) => v.threeDPolylineMesh && v.polyfaceMeshVertex);
          const faces = all.filter((v) => v.polyfaceMeshVertex && !v.threeDPolylineMesh);
          const pb = new PathBuilder(m);
          for (const f of faces) {
            const idx = [f.faceA, f.faceB, f.faceC, f.faceD].filter((x): x is number => typeof x === 'number' && x !== 0);
            const pts = idx.map((k) => v2(pos[Math.abs(k) - 1])).filter((p): p is Vec => !!p);
            if (pts.length < 2) continue;
            pb.moveTo(pts[0]);
            for (const p of pts.slice(1)) pb.lineTo(p);
            pb.close();
          }
          return pushPath(e, ctx, layerName, layer, pb) || fail(type);
        }
        if (pe.is3dPolygonMesh) return fail('POLYLINE (polygon mesh)');
        const verts = all.filter((v) => !v.splineControlPoint && typeof v.x === 'number' && typeof v.y === 'number');
        if (verts.length < 2) return verts.length === 1 ? pointPrim(e, ctx, layerName, layer, v2(verts[0])) : fail(type);
        const pb = new PathBuilder(m);
        polyPath(pb, verts, !!pe.shape);
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'CIRCLE': {
        const ce = e as CircleE;
        const c = v2(ce.center);
        const r = ce.radius;
        if (!c || typeof r !== 'number' || !(r > 0)) return fail(type);
        const pb = new PathBuilder(withOcs(ctx, ce.extrusionDirectionZ));
        pb.ellipseArc(c, { x: r, y: 0 }, { x: 0, y: r }, 0, 2 * Math.PI, false);
        pb.close();
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'ARC': {
        const ae = e as CircleE;
        const c = v2(ae.center);
        const r = ae.radius;
        if (!c || typeof r !== 'number' || !(r > 0)) return fail(type);
        const a0 = ae.startAngle ?? 0;
        let a1 = ae.endAngle ?? 2 * Math.PI;
        while (a1 <= a0) a1 += 2 * Math.PI;
        const pb = new PathBuilder(withOcs(ctx, ae.extrusionDirectionZ));
        pb.ellipseArc(c, { x: r, y: 0 }, { x: 0, y: r }, a0, a1, false);
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'ELLIPSE': {
        const ee = e as EllipseE;
        const c = v2(ee.center);
        const u = v2(ee.majorAxisEndPoint);
        if (!c || !u) return fail(type);
        const k = ee.axisRatio ?? 1;
        const v = { x: -u.y * k, y: u.x * k };
        const t0 = ee.startAngle ?? 0;
        let t1 = ee.endAngle ?? 2 * Math.PI;
        while (t1 <= t0) t1 += 2 * Math.PI;
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
        const pb = new PathBuilder(ctx.m);
        pb.ellipseArc(c, u, v, t0, t1, false);
        if (full) pb.close();
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'SPLINE': {
        const flags = num(raw, 70, 0);
        const closed = (flags & 1) !== 0;
        const deg = num(raw, 71, 3);
        const knots = raw.filter((g) => g.code === 40).map((g) => Number(g.value));
        const weights = raw.filter((g) => g.code === 41).map((g) => Number(g.value));
        const ctrl = pointsOf(raw, 10);
        const fit = pointsOf(raw, 11);
        const pb = new PathBuilder(ctx.m);
        if (ctrl.length >= 2) {
          const pts = evalBSpline(ctrl, deg, knots, weights.length === ctrl.length ? weights : undefined);
          pb.moveTo(pts[0]);
          for (const p of pts.slice(1)) pb.lineTo(p);
        } else if (fit.length >= 2) {
          const bz = fitPointBeziers(fit, closed);
          pb.moveTo(bz[0].p0);
          for (const b of bz) pb.segs.push({ k: 'C', c1: apply(ctx.m, b.c1), c2: apply(ctx.m, b.c2), p: apply(ctx.m, b.p1) });
        } else return fail(type);
        if (closed) pb.close();
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'POINT': {
        return pointPrim(e, ctx, layerName, layer, v2((e as PointE).position));
      }
      case 'TEXT':
      case 'ATTRIB':
      case 'ATTDEF': {
        if (type === 'ATTDEF' && ctx.depth > 0) return null; // definitions are not shown in references
        let te = e as TextE;
        if (type === 'ATTRIB') {
          if ((num(raw, 70, 0) & 1) !== 0) return null; // invisible attribute
          te = {
            ...e,
            startPoint: pointOf(raw, 10),
            endPoint: pointOf(raw, 11),
            textHeight: num(raw, 40, 0),
            xScale: num(raw, 41, 1),
            rotation: num(raw, 50, 0),
            text: str(raw, 1),
            halign: num(raw, 72, 0),
            valign: num(raw, 74, 0),
          };
        } else if (type === 'ATTDEF') {
          const ad = e as TextE & { tag?: string; horizontalJustification?: number; verticalJustification?: number; scale?: number };
          te = { ...ad, text: ad.tag ?? ad.text, halign: ad.horizontalJustification, valign: ad.verticalJustification, xScale: ad.scale };
        }
        const s = percentCodes(decodeDxfString(te.text ?? ''));
        const p0 = v2(te.startPoint);
        if (!p0) return fail(type);
        const h = te.textHeight && te.textHeight > 0 ? te.textHeight : defaultTextHeight;
        let fs = h / capRatio;
        let xs = te.xScale && te.xScale > 0 ? te.xScale : 1;
        let rot = (te.rotation ?? 0) * DEG;
        const ha = te.halign ?? 0;
        const va = te.valign ?? 0;
        const w1 = textWidth(s);
        let anchor = p0;
        let dx = 0;
        let dy = 0;
        const p1 = v2(te.endPoint);
        if ((ha === 3 || ha === 5) && p1 && w1 > 0) {
          const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          if (len > 0) {
            rot = Math.atan2(p1.y - p0.y, p1.x - p0.x);
            if (ha === 3) fs = len / (w1 * xs);
            else xs = len / (w1 * fs);
          }
        } else if (ha !== 0 || va !== 0) {
          anchor = p1 ?? p0;
          if (ha === 1 || ha === 4) dx = -w1 / 2;
          else if (ha === 2) dx = -w1;
          if (ha === 4 && va === 0) dy = -capRatio / 2;
          else if (va === 1) dy = descent;
          else if (va === 2) dy = -capRatio / 2;
          else if (va === 3) dy = -capRatio;
        }
        const local = mul(mul(mul(translate(anchor.x, anchor.y), rotate(rot)), scale(fs * xs, fs)), translate(dx, dy));
        return pushText(e, ctx, layerName, layer, s, local);
      }
      case 'MTEXT': {
        const me = e as MTextE;
        const pos = v2(me.position);
        if (!pos) return fail(type);
        const h = me.height && me.height > 0 ? me.height : defaultTextHeight;
        const fs = h / capRatio;
        const dir = v2(me.directionVector);
        const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : (me.rotation ?? 0) * DEG;
        const paragraphs = mtextToPlain(decodeDxfString(me.text ?? ''));
        // Greedy word wrap to the reference width (in font-size units).
        const wrapW = me.width && me.width > 0 ? me.width / fs : 0;
        const lines: string[] = [];
        for (const para of paragraphs) {
          if (!wrapW) {
            lines.push(para);
            continue;
          }
          let cur = '';
          for (const word of para.split(/(\s+)/)) {
            const next = cur + word;
            if (cur.trim() && textWidth(next.trimEnd()) > wrapW * 1.001) {
              lines.push(cur.trimEnd());
              cur = word.trimStart();
            } else cur = next;
          }
          lines.push(cur);
        }
        const ap = me.attachmentPoint && me.attachmentPoint >= 1 && me.attachmentPoint <= 9 ? me.attachmentPoint : 1;
        const row = Math.floor((ap - 1) / 3);
        const col = (ap - 1) % 3;
        const spacing = 5 / 3; // AutoCAD default line spacing, in text heights
        const blockH = ((lines.length - 1) * spacing + 1) * capRatio;
        const firstBaseline = row === 0 ? -capRatio : row === 1 ? blockH / 2 - capRatio : blockH - capRatio;
        let any = false;
        lines.forEach((line, n) => {
          if (!line.trim()) return;
          const w = textWidth(line);
          const dx = col === 0 ? 0 : col === 1 ? -w / 2 : -w;
          const dy = firstBaseline - n * spacing * capRatio;
          const local = mul(mul(mul(translate(pos.x, pos.y), rotate(rot)), scale(fs, fs)), translate(dx, dy));
          if (pushText(e, ctx, layerName, layer, line, local)) any = true;
        });
        return any ? true : !lines.some((l) => l.trim()) ? null : fail(type);
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        const se = e as SolidE;
        let pts: Vec[];
        let m = ctx.m;
        if (type === '3DFACE') pts = (se.vertices ?? []).map(v2).filter((p): p is Vec => !!p);
        else {
          const src = type === 'TRACE' ? [pointOf(raw, 10), pointOf(raw, 11), pointOf(raw, 12), pointOf(raw, 13)] : (se.points ?? []).map(v2);
          const [a, b, c, d] = src;
          pts = [a, b, d ?? c, c].filter((p): p is Vec => !!p);
          const ez = type === 'TRACE' ? num(raw, 230, 1) : se.extrusionDirection?.z;
          m = withOcs(ctx, ez);
        }
        // Drop a duplicated last vertex (triangles).
        const uniq = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
        if (uniq.length > 1 && uniq[0].x === uniq[uniq.length - 1].x && uniq[0].y === uniq[uniq.length - 1].y) uniq.pop();
        if (uniq.length < 3) return fail(type);
        const pb = new PathBuilder(m);
        pb.moveTo(uniq[0]);
        for (const p of uniq.slice(1)) pb.lineTo(p);
        pb.close();
        return pushPath(e, ctx, layerName, layer, pb, { fill: 'nonzero', noStroke: type !== '3DFACE' });
      }
      case 'HATCH': {
        const paths = hatchPaths(raw);
        if (!paths.length) return fail(type);
        const solid = (num(raw, 70, 0) & 1) !== 0 || (str(raw, 2) ?? '').toUpperCase() === 'SOLID';
        const gradient = num(raw, 450, 0) !== 0;
        const pb = new PathBuilder(withOcs(ctx, num(raw, 230, 1)));
        for (const pts of paths) {
          pb.moveTo(pts[0]);
          for (const p of pts.slice(1)) pb.lineTo(p);
          pb.close();
        }
        if (gradient) gradientHatches++;
        if (solid || gradient) return pushPath(e, ctx, layerName, layer, pb, { fill: 'evenodd', noStroke: true });
        patternHatches++;
        return pushPath(e, ctx, layerName, layer, pb, { fill: 'evenodd', tint: 0.18 });
      }
      case 'LEADER': {
        const pts = pointsOf(raw, 10);
        if (pts.length < 2) return fail(type);
        const pb = new PathBuilder(ctx.m);
        pb.moveTo(pts[0]);
        for (const p of pts.slice(1)) pb.lineTo(p);
        return pushPath(e, ctx, layerName, layer, pb);
      }
      case 'INSERT': {
        const ie = e as InsertE;
        const name = ie.name ?? '';
        if (!blockByName.has(name.toLowerCase())) return fail('INSERT (missing block)');
        const pos = v2(ie.position) ?? { x: 0, y: 0 };
        const sx = typeof ie.xScale === 'number' && ie.xScale !== 0 ? ie.xScale : 1;
        const sy = typeof ie.yScale === 'number' && ie.yScale !== 0 ? ie.yScale : 1;
        const rot = (ie.rotation ?? 0) * DEG;
        const cols = Math.max(1, Math.min(1000, Math.floor(ie.columnCount ?? 1) || 1));
        const rows = Math.max(1, Math.min(1000, Math.floor(ie.rowCount ?? 1) || 1));
        const cs = ie.columnSpacing ?? 0;
        const rs = ie.rowSpacing ?? 0;
        const base = mul(mul(withOcs(ctx, ie.extrusionDirection?.z), translate(pos.x, pos.y)), rotate(rot));
        const total = Math.min(cols * rows, 100000);
        let n = 0;
        for (let r = 0; r < rows && n < total; r++) {
          for (let c = 0; c < cols && n < total; c++, n++) {
            const local = mul(mul(base, translate(c * cs, r * rs)), scale(sx, sy));
            renderBlock(name, local, e, ctx, layerName, layer);
          }
        }
        return true;
      }
      case 'DIMENSION': {
        const de = e as DimensionE;
        if (!de.block || !blockByName.has(de.block.toLowerCase())) return fail('DIMENSION (no block)');
        return renderBlock(de.block, ctx.m, e, ctx, layerName, layer);
      }
      case 'ACAD_TABLE': {
        const name = str(raw, 2);
        if (!name || !blockByName.has(name.toLowerCase())) return fail(type);
        const pos = pointOf(raw, 10) ?? { x: 0, y: 0 };
        return renderBlock(name, mul(ctx.m, translate(pos.x, pos.y)), e, ctx, layerName, layer);
      }
      default:
        return fail(type);
    }
  }

  function fail(type: string): false {
    skip(type);
    return false;
  }

  function pointPrim(e: EntityBase, ctx: Ctx, layerName: string, layer: LayerInfo, p: Vec | undefined): boolean {
    if (!p) return fail(String(e.type));
    prims.push({ kind: 'point', layer: layerName, colour: colourOf(e, ctx, layer), p: apply(ctx.m, p), widthPt: Math.max(1.2, lineweightOf(e, ctx, layer) * MM_TO_PT * 2) });
    return true;
  }

  function polyPath(pb: PathBuilder, verts: LwVertex[], closed: boolean): void {
    const pts = verts.map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 }));
    pb.moveTo(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) pb.bulgeTo(pts[i], pts[i + 1], verts[i].bulge ?? 0);
    if (closed) {
      const last = pts.length - 1;
      if (verts[last].bulge) pb.bulgeTo(pts[last], pts[0], verts[last].bulge ?? 0);
      pb.close();
    }
  }

  const root: Ctx = { m: IDENTITY, depth: 0, stack: [] };
  for (const e of dxf.entities ?? []) emit(e as unknown as EntityBase, root);

  // --- Bounds ---------------------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (p: Vec) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const pr of prims) {
    if (pr.kind === 'path') {
      for (const s of pr.segs) {
        if (s.k === 'Z') continue;
        grow(s.p);
        if (s.k === 'C') {
          grow(s.c1);
          grow(s.c2);
        }
      }
    } else if (pr.kind === 'text') pr.box.forEach(grow);
    else grow(pr.p);
  }
  const empty = !(maxX >= minX && maxY >= minY);
  if (empty) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
    warnings.push('The drawing has no visible model-space entities; the page is blank.');
  }
  let bw = maxX - minX;
  let bh = maxY - minY;
  const eps = Math.max(bw, bh, 1e-9) * 1e-3;
  if (bw < eps) {
    minX -= eps / 2;
    bw = eps;
  }
  if (bh < eps) {
    minY -= eps / 2;
    bh = eps;
  }

  // --- Page ------------------------------------------------------------------
  const margin = Math.max(0, opts.marginMm) * MM_TO_PT;
  let pw: number;
  let ph: number;
  let paperName: string;
  if (opts.paper === 'auto') {
    const longPt = 420 * MM_TO_PT;
    const inner = longPt - 2 * margin;
    // Fit the drawing's aspect ratio; orientation only matters for squares.
    const ratio = bw / bh;
    if (ratio > 1 || (ratio === 1 && opts.orientation !== 'portrait')) {
      pw = longPt;
      ph = Math.max(inner / ratio, 10 * MM_TO_PT) + 2 * margin;
    } else {
      ph = longPt;
      pw = Math.max(inner * ratio, 10 * MM_TO_PT) + 2 * margin;
    }
    paperName = 'a page fitted to the drawing';
  } else {
    const [a, b] = PAPER_MM[opts.paper];
    const land = opts.orientation === 'auto' ? bw > bh : opts.orientation === 'landscape';
    pw = (land ? b : a) * MM_TO_PT;
    ph = (land ? a : b) * MM_TO_PT;
    paperName = `${opts.paper} ${land ? 'landscape' : 'portrait'}`;
  }
  const availW = Math.max(10, pw - 2 * margin);
  const availH = Math.max(10, ph - 2 * margin);
  const s = Math.min(availW / bw, availH / bh);
  const ox = (pw - bw * s) / 2 - minX * s;
  const oy = (ph - bh * s) / 2 - minY * s;
  const P: Mat = [s, 0, 0, s, ox, oy];

  // --- Output font -----------------------------------------------------------
  // pdf-lib's own subsetting corrupts Noto Sans glyph data, so the full font is
  // embedded with unused glyph outlines removed (glyph ids stay unchanged).
  let outFont: PDFFont | undefined;
  const textPrims = prims.filter((x): x is Extract<Prim, { kind: 'text' }> => x.kind === 'text');
  if (font && textPrims.length) {
    if (fullFontBytes) {
      const gids = new Set<number>();
      for (const t of textPrims) {
        const hex = font.encodeText(t.str).toString().replace(/[<>]/g, '');
        for (let i = 0; i + 4 <= hex.length; i += 4) gids.add(parseInt(hex.slice(i, i + 4), 16));
      }
      let bytes = fullFontBytes;
      try {
        bytes = pruneTrueType(fullFontBytes, gids);
      } catch {
        bytes = fullFontBytes;
      }
      outFont = await doc.embedFont(bytes, { subset: false });
    } else outFont = font;
  }

  // --- Content ----------------------------------------------------------------
  const layerOrder: string[] = [];
  const groups = new Map<string, string[]>();
  const state = new Map<string, { stroke?: string; fill?: string; w?: string; dash?: string }>();
  const colourOps = (c: Colour, tint = 0): string => {
    let rgb = c.rgb;
    if (opts.blackOnWhite) {
      if (c.fg || luminance(rgb) > 0.85) rgb = 0;
    } else if (c.fg) rgb = 0xffffff;
    let r = ((rgb >> 16) & 255) / 255;
    let g = ((rgb >> 8) & 255) / 255;
    let b = (rgb & 255) / 255;
    if (tint) {
      const bg = opts.blackOnWhite ? 1 : 0.1;
      r = bg + (r - bg) * tint;
      g = bg + (g - bg) * tint;
      b = bg + (b - bg) * tint;
    }
    return `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
  };
  const pt = (p: Vec) => {
    const q = apply(P, p);
    return `${fmt(q.x)} ${fmt(q.y)}`;
  };
  for (const pr of prims) {
    let ops = groups.get(pr.layer);
    if (!ops) {
      ops = [];
      groups.set(pr.layer, ops);
      layerOrder.push(pr.layer);
      state.set(pr.layer, {});
    }
    const st = state.get(pr.layer) ?? {};
    const setStroke = (c: string) => {
      if (st.stroke !== c) ops.push(`${c} RG`);
      st.stroke = c;
    };
    const setFill = (c: string) => {
      if (st.fill !== c) ops.push(`${c} rg`);
      st.fill = c;
    };
    const setWidth = (w: number) => {
      const f = fmt(Math.max(0.05, w));
      if (st.w !== f) ops.push(`${f} w`);
      st.w = f;
    };
    const setDash = (d: string) => {
      if (st.dash !== d) ops.push(`${d} d`);
      st.dash = d;
    };
    if (pr.kind === 'path') {
      const path: string[] = [];
      for (const sg of pr.segs) {
        if (sg.k === 'M') path.push(`${pt(sg.p)} m`);
        else if (sg.k === 'L') path.push(`${pt(sg.p)} l`);
        else if (sg.k === 'C') path.push(`${pt(sg.c1)} ${pt(sg.c2)} ${pt(sg.p)} c`);
        else path.push('h');
      }
      if (path.join(' ').includes('NaN')) continue;
      if (pr.fill) setFill(colourOps(pr.colour, pr.fillTint ?? 0));
      if (pr.stroke) {
        setStroke(colourOps(pr.colour));
        setWidth(Math.max(pr.stroke.widthPt, pr.stroke.widthWorld * s));
        let dash = '[] 0';
        if (pr.stroke.dash) {
          const arr = pr.stroke.dash.array.map((x) => x * s);
          const total = arr.reduce((a, b) => a + b, 0);
          // Too dense to see (or degenerate) → continuous.
          if (total > 1.5 && arr.some((x) => x > 0)) dash = `[${arr.map(fmt).join(' ')}] ${fmt(pr.stroke.dash.phase * s)}`;
        }
        setDash(dash);
      }
      const paint = pr.fill && pr.stroke ? (pr.fill === 'evenodd' ? 'B*' : 'B') : pr.fill ? (pr.fill === 'evenodd' ? 'f*' : 'f') : 'S';
      ops.push(`${path.join(' ')} ${paint}`);
    } else if (pr.kind === 'text') {
      setFill(colourOps(pr.colour));
      const m = mul(P, pr.m);
      if (!outFont) continue;
      ops.push(`BT /F0 1 Tf ${m.map(fmt).join(' ')} Tm ${outFont.encodeText(pr.str).toString()} Tj ET`);
    } else {
      setStroke(colourOps(pr.colour));
      setWidth(pr.widthPt);
      setDash('[] 0');
      const p = pt(pr.p);
      ops.push(`${p} m ${p} l S`);
    }
  }

  const page = doc.addPage([pw, ph]);
  const ctx = doc.context;
  const out: string[] = ['1 J 1 j'];
  if (!opts.blackOnWhite) out.push(`q 0.1 0.1 0.1 rg 0 0 ${fmt(pw)} ${fmt(ph)} re f Q`);
  const layerNames = layerOrder.map((l) => layerOf(l).name);
  const ocgRefs: PDFRef[] = [];
  const props: Record<string, PDFRef> = {};
  layerOrder.forEach((l, i) => {
    const ops = groups.get(l) ?? [];
    if (opts.layers) {
      const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: pdfText(layerNames[i]) }));
      ocgRefs.push(ref);
      props[`OC${i}`] = ref;
      out.push(`/OC /OC${i} BDC`, 'q', ...ops, 'Q', 'EMC');
    } else {
      out.push('q', ...ops, 'Q');
    }
  });
  const content = new TextEncoder().encode(out.join('\n') + '\n');
  page.node.addContentStream(ctx.register(ctx.flateStream(content)));
  if (outFont) page.node.setFontDictionary(PDFName.of('F0'), outFont.ref);
  if (opts.layers && ocgRefs.length) {
    const { Resources } = page.node.normalizedEntries();
    Resources.set(PDFName.of('Properties'), ctx.obj(props));
    // Acrobat's layer panel lists /Order; keep the DXF layer-table order.
    const ordered = ocgRefs
      .map((ref, i) => ({ ref, order: layerOf(layerOrder[i]).order }))
      .sort((a, b) => a.order - b.order)
      .map((x) => x.ref);
    doc.catalog.set(
      PDFName.of('OCProperties'),
      ctx.obj({
        OCGs: ocgRefs,
        D: { Name: PDFString.of('Layers'), Order: ordered, ON: ocgRefs, OFF: [] },
      }),
    );
  }
  doc.setProducer('Adika PDF Editor');
  doc.setCreator('Adika PDF Editor (DXF import)');

  // --- Warnings -----------------------------------------------------------------
  const units = hnum('$INSUNITS', 0);
  const unit = UNIT_NAMES[units];
  if (!empty) {
    if (unit?.[1]) {
      const paperMmPerUnit = (s * 25.4) / 72;
      const ratio = unit[1] / paperMmPerUnit;
      const txt = ratio >= 1 ? `1:${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}` : `${(1 / ratio).toFixed(1)}:1`;
      warnings.push(`Drawing units are ${unit[0]} ($INSUNITS ${units}); fitted to ${paperName} at about ${txt} (not a standard plot scale).`);
    } else {
      warnings.push(`Drawing units are not set ($INSUNITS ${units}); the drawing was scaled to fit ${paperName}.`);
    }
  }
  if (hidden) warnings.push(`${hidden} entit${hidden === 1 ? 'y is' : 'ies are'} on hidden, frozen or non-plotting layers and were not drawn.`);
  if (paperSpace) warnings.push(`${paperSpace} paper-space entit${paperSpace === 1 ? 'y was' : 'ies were'} ignored; only model space is converted.`);
  if (patternHatches) warnings.push(`${patternHatches} pattern hatch(es) are shown as a light fill with an outline (patterns are not drawn).`);
  if (gradientHatches) warnings.push(`${gradientHatches} gradient hatch(es) are shown as a solid fill.`);
  if (missingLt.size) warnings.push(`Line type(s) ${[...missingLt].slice(0, 8).join(', ')} are not defined in the file; drawn as continuous lines.`);
  if (depthHits) warnings.push(`${depthHits} block reference(s) were not expanded (nesting deeper than ${MAX_DEPTH} levels or self-referencing).`);
  for (const [t, msg] of errors) warnings.push(`Some ${t} entities could not be drawn: ${msg}`);
  const skippedTypes = Object.entries(skipped);
  if (skippedTypes.length) {
    warnings.push(`Not drawn: ${skippedTypes.map(([t, n]) => `${n} × ${t}`).join(', ')}.`);
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, entities: drawn, skipped, layers: layerNames, warnings };
}

export { pruneTrueType };
