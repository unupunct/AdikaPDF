/**
 * XPS / OpenXPS (.xps, .oxps) to vector PDF converter.
 *
 * Runs fully offline, in the browser and under Node (vitest): no DOM, no Node
 * APIs. The package is read with jszip, the XAML-like FixedPage markup with a
 * small built-in XML parser, and the PDF is written with pdf-lib.
 *
 * Output model
 *  - Every FixedPage becomes a PDF page of Width x Height (1/96 in) * 0.75 pt.
 *    The content stream starts with a y-flipping CTM so everything below is
 *    emitted in XPS page coordinates.
 *  - Canvas / Path / Glyphs are translated to PDF operators one to one
 *    (q/cm/clip/fill/stroke), so the result is real vector output.
 *  - Glyphs are drawn by glyph index with the package's own (de-obfuscated)
 *    fonts, embedded as Type0 / Identity-H fonts (TrueType fonts subset with
 *    fontkit) with a ToUnicode CMap built from UnicodeString + cluster maps,
 *    and positioned with the exact advances from Indices through TJ. Text is
 *    therefore both visually exact and extractable / searchable.
 *  - Brushes: solid colours, ImageBrush (PNG, JPEG, TIFF), VisualBrush,
 *    Linear/RadialGradientBrush as real PDF shadings (varying stop alpha via a
 *    luminosity soft mask).
 *  - FixedPage.NavigateUri becomes link annotations (external URIs and
 *    internal named targets).
 *
 * A bad element never aborts the conversion: it is skipped and a warning is
 * recorded. Only a file that is not an XPS package throws.
 */
import JSZip from 'jszip';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFFont,
} from 'pdf-lib';

export interface XpsConvertResult {
  bytes: Uint8Array;
  pages: number;
  warnings: string[];
}

export interface XpsConvertOptions {
  onProgress?: (done: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Minimal XML parser (elements + attributes; text content is irrelevant here)
// ---------------------------------------------------------------------------

export interface XNode {
  /** Local element name (namespace prefix stripped), e.g. "Path", "Path.Fill". */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Part name the node was loaded from, when it differs from the page. */
  base?: string;
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
    return String.fromCodePoint(cp);
  });
}

const localName = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  const n = xml.length;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt);
      const nm = localName(xml.slice(lt + 2, e < 0 ? n : e).trim());
      // Pop to the matching element (tolerates sloppy markup).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === nm) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    // Start tag: find its end, honouring quoted attribute values.
    let j = lt + 1;
    let q: string | null = null;
    for (; j < n; j++) {
      const c = xml[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    let body = xml.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = /^[^\s/>]+/.exec(body);
    if (!m) {
      i = j + 1;
      continue;
    }
    const node: XNode = { name: localName(m[0]), attrs: {}, children: [] };
    attrRe.lastIndex = m[0].length;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(body))) {
      node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root;
}

function rootElement(doc: XNode): XNode | undefined {
  return doc.children[0];
}

function attrLocal(node: XNode, local: string): string | undefined {
  if (node.attrs[local] !== undefined) return node.attrs[local];
  for (const k of Object.keys(node.attrs)) if (localName(k) === local) return node.attrs[k];
  return undefined;
}

function decodeText(bytes: Uint8Array): string {
  let enc = 'utf-8';
  let off = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    enc = 'utf-16le';
    off = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    enc = 'utf-16be';
    off = 2;
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    off = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0x3c && bytes[1] === 0) {
    enc = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] === 0x3c) {
    enc = 'utf-16be';
  }
  return new TextDecoder(enc).decode(bytes.subarray(off));
}

// ---------------------------------------------------------------------------
// Package access (OPC part names, piece parts)
// ---------------------------------------------------------------------------

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Canonical key for a part name: no leading slash, %-decoded, lower case, ./.. resolved. */
function partKey(name: string): string {
  const segs: string[] = [];
  for (const s of safeDecode(name).replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  return segs.join('/').toLowerCase();
}

/** Resolve a URI reference against the part that contains it. Returns a part key. */
function resolvePart(base: string, target: string): string {
  let t = target.trim();
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  const qm = t.indexOf('?');
  if (qm >= 0) t = t.slice(0, qm);
  t = t.replace(/^pack:\/\/[^/]*\//i, '/');
  if (t.startsWith('/')) return partKey(t);
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return partKey(dir + t);
}

class Package {
  private parts = new Map<string, JSZip.JSZipObject[]>();
  private cache = new Map<string, Promise<Uint8Array | null>>();
  contentTypes = new Map<string, string>();
  defaultTypes = new Map<string, string>();

  constructor(zip: JSZip) {
    const pieces = new Map<string, { idx: number; obj: JSZip.JSZipObject }[]>();
    zip.forEach((path, obj) => {
      if (obj.dir) return;
      const m = /^(.*)\/\[(\d+)\](\.last)?\.piece$/i.exec(path);
      if (m) {
        const k = partKey(m[1]);
        const arr = pieces.get(k) ?? [];
        arr.push({ idx: parseInt(m[2], 10), obj });
        pieces.set(k, arr);
      } else {
        this.parts.set(partKey(path), [obj]);
      }
    });
    for (const [k, arr] of pieces) {
      arr.sort((a, b) => a.idx - b.idx);
      this.parts.set(
        k,
        arr.map((p) => p.obj),
      );
    }
  }

  has(key: string): boolean {
    return this.parts.has(key);
  }

  keys(): string[] {
    return [...this.parts.keys()];
  }

  bytes(key: string): Promise<Uint8Array | null> {
    let p = this.cache.get(key);
    if (!p) {
      const objs = this.parts.get(key);
      p = objs
        ? Promise.all(objs.map((o) => o.async('uint8array'))).then((chunks) => {
            if (chunks.length === 1) {
              const c = chunks[0];
              // Detach views into the archive buffer (decoders use .buffer).
              return c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice();
            }
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              out.set(c, off);
              off += c.length;
            }
            return out;
          })
        : Promise.resolve(null);
      this.cache.set(key, p);
    }
    return p;
  }

  async xml(key: string): Promise<XNode | null> {
    const b = await this.bytes(key);
    if (!b) return null;
    return parseXml(decodeText(b));
  }

  async loadContentTypes(): Promise<void> {
    const doc = await this.xml(partKey('[Content_Types].xml'));
    const types = doc && rootElement(doc);
    if (!types) return;
    for (const c of types.children) {
      if (c.name === 'Default' && c.attrs.Extension && c.attrs.ContentType)
        this.defaultTypes.set(c.attrs.Extension.toLowerCase(), c.attrs.ContentType.toLowerCase());
      if (c.name === 'Override' && c.attrs.PartName && c.attrs.ContentType)
        this.contentTypes.set(partKey(c.attrs.PartName), c.attrs.ContentType.toLowerCase());
    }
  }

  contentType(key: string): string {
    const o = this.contentTypes.get(key);
    if (o) return o;
    const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : '';
    return this.defaultTypes.get(ext) ?? '';
  }

  /** Relationships of a part: [{type, target(part key)}]. */
  async rels(key: string): Promise<{ type: string; target: string; external: boolean }[]> {
    const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    const file = key.slice(dir.length);
    const relsKey = key === '' ? '_rels/.rels' : `${dir}_rels/${file}.rels`;
    const doc = await this.xml(relsKey);
    const r = doc && rootElement(doc);
    if (!r) return [];
    return r.children
      .filter((c) => c.name === 'Relationship')
      .map((c) => ({
        type: c.attrs.Type ?? '',
        external: (c.attrs.TargetMode ?? '').toLowerCase() === 'external',
        target: resolvePart(key === '' ? '' : key, c.attrs.Target ?? ''),
      }));
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Affine matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f (PDF / XPS order). */
type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];

/** Composite that applies `inner` first, then `outer`. */
function mul(inner: M, outer: M): M {
  const [a, b, c, d, e, f] = inner;
  const [A, B, C, D, E, F] = outer;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}
function apply(m: M, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function invert(m: M): M | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const isIdent = (m: M) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

type BBox = [number, number, number, number];
function bboxTransform(b: BBox, m: M): BBox {
  const pts = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  if (Object.is(r, -0) || r === 0) return '0';
  return String(r);
}
const fm = (m: M) => m.map(fmt).join(' ');

function nums(s: string | undefined): number[] {
  if (!s) return [];
  const out: number[] = [];
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(parseFloat(m[0]));
  return out;
}
function num(s: string | undefined, def: number): number {
  if (s === undefined || s === '') return def;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : def;
}
function parseMatrix(s: string | undefined): M | null {
  const v = nums(s);
  if (v.length < 6) return null;
  return [v[0], v[1], v[2], v[3], v[4], v[5]];
}

/** Collects path operators in XPS space, applying an optional geometry transform. */
class PathBuilder {
  ops: string[] = [];
  bbox: BBox | null = null;
  private hasFigure = false;
  constructor(private t: M | null) {}
  private pt(x: number, y: number): string {
    const [X, Y] = this.t ? apply(this.t, x, y) : [x, y];
    if (!this.bbox) this.bbox = [X, Y, X, Y];
    else {
      if (X < this.bbox[0]) this.bbox[0] = X;
      if (Y < this.bbox[1]) this.bbox[1] = Y;
      if (X > this.bbox[2]) this.bbox[2] = X;
      if (Y > this.bbox[3]) this.bbox[3] = Y;
    }
    return `${fmt(X)} ${fmt(Y)}`;
  }
  move(x: number, y: number) {
    this.hasFigure = true;
    this.ops.push(`${this.pt(x, y)} m`);
  }
  line(x: number, y: number) {
    this.ops.push(`${this.pt(x, y)} l`);
  }
  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.ops.push(`${this.pt(x1, y1)} ${this.pt(x2, y2)} ${this.pt(x, y)} c`);
  }
  close() {
    if (this.hasFigure) this.ops.push('h');
  }
  get empty() {
    return !this.hasFigure;
  }
}

/** SVG/XPS elliptical arc to cubic Beziers. */
function arcTo(
  pb: PathBuilder,
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  angleDeg: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
) {
  if (x0 === x && y0 === y) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) {
    pb.line(x, y);
    return;
  }
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num1 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = den ? Math.sqrt(Math.max(0, num1 / den)) : 0;
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  let t = t1;
  const P = (tt: number): [number, number] => {
    const ex = rx * Math.cos(tt);
    const ey = ry * Math.sin(tt);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const D = (tt: number): [number, number] => {
    const ex = -rx * Math.sin(tt);
    const ey = ry * Math.cos(tt);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  for (let s = 0; s < segs; s++) {
    const t2 = t + delta;
    const p1 = P(t);
    const d1 = D(t);
    const p2 = s === segs - 1 ? ([x, y] as [number, number]) : P(t2);
    const d2 = D(t2);
    pb.cubic(p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]);
    t = t2;
  }
}

interface Geometry {
  ops: string;
  evenOdd: boolean;
  bbox: BBox | null;
  empty: boolean;
}

/** Parse XPS abbreviated geometry syntax ("F1 M 0,0 L 10,0 ..."). */
function parseAbbreviated(data: string, pb: PathBuilder): { evenOdd: boolean } {
  const toks = data.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let evenOdd = true;
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: [number, number] | null = null; // second control of previous cubic
  let cmd = '';
  const isNum = (t: string | undefined) => t !== undefined && !/^[A-Za-z]$/.test(t);
  const n = () => parseFloat(toks[i++]);
  let open = false;
  while (i < toks.length) {
    if (!isNum(toks[i])) {
      cmd = toks[i++];
      if (cmd === 'F' || cmd === 'f') {
        const v = isNum(toks[i]) ? n() : 0;
        evenOdd = v !== 1;
        continue;
      }
      if (cmd === 'Z' || cmd === 'z') {
        pb.close();
        cx = sx;
        cy = sy;
        lastCtrl = null;
        open = false;
        continue;
      }
    }
    if (!isNum(toks[i])) {
      if (i < toks.length && !/^[MmLlHhVvCcQqSsAaZzFf]$/.test(toks[i])) i++; // unknown token
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ensureOpen = () => {
      if (!open) {
        pb.move(cx, cy);
        sx = cx;
        sy = cy;
        open = true;
      }
    };
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = n() + (rel ? cx : 0);
        const y = n() + (rel ? cy : 0);
        pb.move(x, y);
        cx = sx = x;
        cy = sy = y;
        open = true;
        cmd = rel ? 'l' : 'L';
        lastCtrl = null;
        break;
      }
      case 'L': {
        ensureOpen();
        const x = n() + (rel ? cx : 0);
        const y = n() + (rel ? cy : 0);
        pb.line(x, y);
        cx = x;
        cy = y;
        lastCtrl = null;
        break;
      }
      case 'H': {
        ensureOpen();
        const x = n() + (rel ? cx : 0);
        pb.line(x, cy);
        cx = x;
        lastCtrl = null;
        break;
      }
      case 'V': {
        ensureOpen();
        const y = n() + (rel ? cy : 0);
        pb.line(cx, y);
        cy = y;
        lastCtrl = null;
        break;
      }
      case 'C': {
        ensureOpen();
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1 = n() + ox;
        const y1 = n() + oy;
        const x2 = n() + ox;
        const y2 = n() + oy;
        const x = n() + ox;
        const y = n() + oy;
        pb.cubic(x1, y1, x2, y2, x, y);
        lastCtrl = [x2, y2];
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        ensureOpen();
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1 = lastCtrl ? 2 * cx - lastCtrl[0] : cx;
        const y1 = lastCtrl ? 2 * cy - lastCtrl[1] : cy;
        const x2 = n() + ox;
        const y2 = n() + oy;
        const x = n() + ox;
        const y = n() + oy;
        pb.cubic(x1, y1, x2, y2, x, y);
        lastCtrl = [x2, y2];
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        ensureOpen();
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const qx = n() + ox;
        const qy = n() + oy;
        const x = n() + ox;
        const y = n() + oy;
        pb.cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        cx = x;
        cy = y;
        lastCtrl = null;
        break;
      }
      case 'A': {
        ensureOpen();
        const rx = n();
        const ry = n();
        const rot = n();
        const large = n() !== 0;
        const sweep = n() !== 0;
        const x = n() + (rel ? cx : 0);
        const y = n() + (rel ? cy : 0);
        arcTo(pb, cx, cy, rx, ry, rot, large, sweep, x, y);
        cx = x;
        cy = y;
        lastCtrl = null;
        break;
      }
      default:
        i++; // numbers without a known command
    }
    if (toks.length && i > toks.length) break;
  }
  return { evenOdd };
}

function points(s: string | undefined): [number, number][] {
  const v = nums(s);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k], v[k + 1]]);
  return out;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const lin2srgb = (c: number) => {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

function parseColor(s: string | undefined, warn: (m: string) => void): Rgba | null {
  if (!s) return null;
  const t = s.trim();
  if (t.startsWith('#')) {
    const h = t.slice(1);
    const v = (k: number) => parseInt(h.slice(k, k + 2), 16) / 255;
    const v1 = (k: number) => parseInt(h[k] + h[k], 16) / 255;
    if (/^[0-9a-f]{8}$/i.test(h)) return { a: v(0), r: v(2), g: v(4), b: v(6) };
    if (/^[0-9a-f]{6}$/i.test(h)) return { a: 1, r: v(0), g: v(2), b: v(4) };
    if (/^[0-9a-f]{4}$/i.test(h)) return { a: v1(0), r: v1(1), g: v1(2), b: v1(3) };
    if (/^[0-9a-f]{3}$/i.test(h)) return { a: 1, r: v1(0), g: v1(1), b: v1(2) };
    return null;
  }
  if (/^sc#/i.test(t)) {
    const v = nums(t.slice(3));
    if (v.length >= 4) return { a: Math.max(0, Math.min(1, v[0])), r: lin2srgb(v[1]), g: lin2srgb(v[2]), b: lin2srgb(v[3]) };
    if (v.length === 3) return { a: 1, r: lin2srgb(v[0]), g: lin2srgb(v[1]), b: lin2srgb(v[2]) };
    return null;
  }
  if (/^ContextColor\s/i.test(t)) {
    const rest = t.replace(/^ContextColor\s+\S+\s*/i, '');
    const v = nums(rest);
    warn('ContextColor (ICC profile colour) approximated as device colour');
    const a = v.length ? Math.max(0, Math.min(1, v[0])) : 1;
    const c = v.slice(1);
    if (c.length === 3) return { a, r: c[0], g: c[1], b: c[2] };
    if (c.length === 4) {
      const [C, Mg, Y, K] = c;
      return { a, r: (1 - C) * (1 - K), g: (1 - Mg) * (1 - K), b: (1 - Y) * (1 - K) };
    }
    if (c.length >= 1) return { a, r: 1 - c[0], g: 1 - c[0], b: 1 - c[0] };
    return { a, r: 0, g: 0, b: 0 };
  }
  // Named colours are not part of XPS, but be lenient with the basics.
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    red: [1, 0, 0],
    green: [0, 0.5, 0],
    blue: [0, 0, 1],
    transparent: [0, 0, 0],
  };
  const nm = named[t.toLowerCase()];
  if (nm) return { r: nm[0], g: nm[1], b: nm[2], a: t.toLowerCase() === 'transparent' ? 0 : 1 };
  return null;
}

const rgbOp = (c: Rgba, stroke: boolean) => `${fmt(c.r)} ${fmt(c.g)} ${fmt(c.b)} ${stroke ? 'RG' : 'rg'}`;

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type FkFont = ReturnType<typeof fontkit.create>;

interface CidFont {
  kind: 'cid';
  ref: PDFRef;
  font: FkFont;
  upem: number;
  /** Subset (glyf/loca) on finalize; false for CFF fonts, embedded whole. */
  subset: boolean;
  /** Member index when the font part is a TrueType collection. */
  ttcIndex: number;
  /** Original glyph ids drawn with this font. */
  used: Set<number>;
  cff: boolean;
  bytes: Uint8Array;
  /** pdf gid -> width (1000/em units) */
  widths: Map<number, number>;
  /** pdf gid -> unicode text */
  toUni: Map<number, string>;
  psName: string;
}
interface StdFont {
  kind: 'std';
  font: PDFFont;
}
type LoadedFont = CidFont | StdFont;

function looksLikeFont(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || tag === 'true' || tag === 'OTTO' || tag === 'ttcf';
}

/** XPS 1.0 §9.1.7.3 / ECMA-388: XOR the first 32 bytes with the GUID from the part name. */
export function deobfuscateFont(bytes: Uint8Array, partName: string): Uint8Array | null {
  const file = partName.slice(partName.lastIndexOf('/') + 1);
  const hex = file.replace(/\.[^.]*$/, '').replace(/[{}-]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || bytes.length < 32) return null;
  // The key is the GUID's bytes in reverse order of its string form.
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(30 - i * 2, 2), 16);
  const out = bytes.slice();
  for (let i = 0; i < 32; i++) out[i] ^= key[i % 16];
  return out;
}

function toUtf16Hex(s: string): string {
  let h = '';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0');
  return h;
}
const hex4 = (n: number) => n.toString(16).padStart(4, '0');

function buildToUnicode(map: Map<number, string>): string {
  const entries = [...map.entries()].filter(([, s]) => s.length > 0).sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [g, s] of chunk) body += `<${hex4(g)}> <${toUtf16Hex(s)}>\n`;
    body += 'endbfchar\n';
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

/**
 * Minimal TrueType subsetter for PDF embedding (CIDToGIDMap /Identity).
 * Glyph ids are kept: unused glyphs become empty entries in glyf/loca,
 * composite glyph components are kept. Only the tables a PDF consumer needs
 * are written (no cmap/name/post/GSUB...). `ttcIndex` >= 0 selects a member
 * of a TrueType collection, producing a standalone font.
 */
export function subsetTrueType(bytes: Uint8Array, used: Set<number>, ttcIndex = -1): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dirOff = 0;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'ttcf') {
    const n = dv.getUint32(8);
    const idx = Math.max(0, Math.min(n - 1, ttcIndex < 0 ? 0 : ttcIndex));
    dirOff = dv.getUint32(12 + idx * 4);
  }
  const numTables = dv.getUint16(dirOff + 4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const r = dirOff + 12 + i * 16;
    const tag = String.fromCharCode(bytes[r], bytes[r + 1], bytes[r + 2], bytes[r + 3]);
    tables.set(tag, { off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) });
  }
  const need = (t: string) => {
    const v = tables.get(t);
    if (!v || v.off + v.len > bytes.length) throw new Error(`missing ${t} table`);
    return v;
  };
  const head = need('head');
  const maxp = need('maxp');
  const loca = need('loca');
  const glyf = need('glyf');
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const longLoca = dv.getInt16(head.off + 50) === 1;
  const locaAt = (g: number) => (longLoca ? dv.getUint32(loca.off + g * 4) : dv.getUint16(loca.off + g * 2) * 2);
  const glyphRange = (g: number): [number, number] => {
    const a = locaAt(g);
    const b = locaAt(g + 1);
    return [glyf.off + a, Math.max(0, b - a)];
  };
  // Closure over composite components.
  const keep = new Set<number>();
  const stack = [...used].filter((g) => g >= 0 && g < numGlyphs);
  stack.push(0);
  while (stack.length) {
    const g = stack.pop()!;
    if (keep.has(g)) continue;
    keep.add(g);
    const [off, len] = glyphRange(g);
    if (len < 10 || off + len > bytes.length) continue;
    if (dv.getInt16(off) >= 0) continue;
    let p = off + 10;
    for (let guard = 0; guard < 1000 && p + 4 <= off + len; guard++) {
      const flags = dv.getUint16(p);
      const comp = dv.getUint16(p + 2);
      if (comp < numGlyphs) stack.push(comp);
      p += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
  }
  // New glyf + long loca.
  let glyfLen = 0;
  for (const g of keep) glyfLen += (glyphRange(g)[1] + 3) & ~3;
  const newGlyf = new Uint8Array(glyfLen);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const lv = new DataView(newLoca.buffer);
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    lv.setUint32(g * 4, pos);
    if (!keep.has(g)) continue;
    const [off, len] = glyphRange(g);
    if (len && off + len <= bytes.length) {
      newGlyf.set(bytes.subarray(off, off + len), pos);
      pos += (len + 3) & ~3;
    }
  }
  lv.setUint32(numGlyphs * 4, pos);
  const newHead = bytes.slice(head.off, head.off + head.len);
  const hv = new DataView(newHead.buffer);
  hv.setUint32(8, 0); // checkSumAdjustment
  hv.setInt16(50, 1); // indexToLocFormat: long
  const out = new Map<string, Uint8Array>();
  for (const t of ['OS/2', 'cvt ', 'fpgm', 'hhea', 'hmtx', 'maxp', 'prep']) {
    const v = tables.get(t);
    if (v && v.off + v.len <= bytes.length) out.set(t, bytes.subarray(v.off, v.off + v.len));
  }
  out.set('head', newHead);
  out.set('loca', newLoca);
  out.set('glyf', newGlyf.subarray(0, pos));
  const tags = [...out.keys()].sort();
  const n = tags.length;
  let total = 12 + n * 16;
  for (const t of tags) total += (out.get(t)!.length + 3) & ~3;
  const file = new Uint8Array(total);
  const fv = new DataView(file.buffer);
  fv.setUint32(0, 0x00010000);
  fv.setUint16(4, n);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  fv.setUint16(6, (1 << es) * 16);
  fv.setUint16(8, es);
  fv.setUint16(10, n * 16 - (1 << es) * 16);
  let off = 12 + n * 16;
  const checksum = (d: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = ((d[i] << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0)) >>> 0;
      sum = (sum + v) >>> 0;
    }
    return sum;
  };
  tags.forEach((t, i) => {
    const d = out.get(t)!;
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) file[r + k] = t.charCodeAt(k);
    fv.setUint32(r + 4, checksum(d));
    fv.setUint32(r + 8, off);
    fv.setUint32(r + 12, d.length);
    file.set(d, off);
    off += (d.length + 3) & ~3;
  });
  const headRec = tags.indexOf('head');
  const headOff = fv.getUint32(12 + headRec * 16 + 8);
  fv.setUint32(headOff + 8, (0xb1b0afba - checksum(file)) >>> 0);
  return file;
}

function subsetTag(i: number): string {
  let s = '';
  let n = i + 7919;
  for (let k = 0; k < 6; k++) {
    s += String.fromCharCode(65 + (n % 26));
    n = Math.floor(n / 26) + k * 3;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

interface ResScope {
  map: Map<string, XNode>;
  parent: ResScope | null;
}

interface Ctx {
  res: ResScope | null;
  opacity: number;
  /** local -> page (XPS px) */
  ctm: M;
  base: string;
}

interface ImageInfo {
  ref: PDFRef;
  pxW: number;
  pxH: number;
  dpiX: number;
  dpiY: number;
}

interface PendingLink {
  page: number;
  rect: [number, number, number, number];
  uri: string;
  base: string;
}

interface Stop {
  offset: number;
  c: Rgba;
}

class PageOut {
  ops: string[] = [];
  names = new Map<string, string>(); // resource key -> name
  counters: Record<string, number> = {};
  resDicts = new Map<string, PDFDict>();
  constructor(
    public doc: PDFDocument,
    public resources: PDFDict,
  ) {}
  push(...s: string[]) {
    this.ops.push(...s);
  }
  /** Register a resource in the page's /Resources /<kind> dict; returns its name. */
  res(kind: 'Font' | 'XObject' | 'ExtGState' | 'Shading', key: string, ref: PDFRef, prefix: string): string {
    const k = `${kind}:${key}`;
    const have = this.names.get(k);
    if (have) return have;
    let d = this.resDicts.get(kind);
    if (!d) {
      const existing = this.resources.get(PDFName.of(kind));
      d = existing instanceof PDFDict ? existing : this.doc.context.obj({});
      this.resources.set(PDFName.of(kind), d);
      this.resDicts.set(kind, d);
    }
    const n = (this.counters[prefix] = (this.counters[prefix] ?? 0) + 1);
    const name = `${prefix}${n}`;
    d.set(PDFName.of(name), ref);
    this.names.set(k, name);
    return name;
  }
}

class Converter {
  doc!: PDFDocument;
  warnings = new Map<string, number>();
  fonts = new Map<string, Promise<LoadedFont>>();
  cidFonts: CidFont[] = [];
  images = new Map<string, Promise<ImageInfo | null>>();
  dicts = new Map<string, Promise<Map<string, XNode> | null>>();
  gsCache = new Map<string, PDFRef>();
  stdFont: Promise<PDFFont> | null = null;
  links: PendingLink[] = [];
  names = new Map<string, number>(); // link target name -> page index
  pageRefs: PDFRef[] = [];
  out!: PageOut;
  pageIndex = 0;
  pageH = 0;
  uid = 0;

  constructor(public pkg: Package) {}

  warn(msg: string) {
    this.warnings.set(msg, (this.warnings.get(msg) ?? 0) + 1);
  }

  // ----- structure --------------------------------------------------------

  async findPages(): Promise<{ key: string; w?: number; h?: number }[]> {
    const pages: { key: string; w?: number; h?: number }[] = [];
    const rootRels = await this.pkg.rels('');
    let startKeys = rootRels.filter((r) => /\/fixedrepresentation$/i.test(r.type)).map((r) => r.target);
    if (!startKeys.length) startKeys = this.pkg.keys().filter((k) => k.endsWith('.fdseq'));
    if (!startKeys.length) startKeys = this.pkg.keys().filter((k) => k.endsWith('.fdoc'));
    const visitDoc = async (key: string) => {
      const x = await this.pkg.xml(key);
      const r = x && rootElement(x);
      if (!r) {
        this.warn(`Missing document part ${key}`);
        return;
      }
      if (r.name === 'FixedDocumentSequence') {
        for (const d of r.children) if (d.name === 'DocumentReference' && d.attrs.Source) await visitDoc(resolvePart(key, d.attrs.Source));
      } else if (r.name === 'FixedDocument') {
        for (const pc of r.children) {
          if (pc.name !== 'PageContent' || !pc.attrs.Source) continue;
          const idx = pages.length;
          pages.push({ key: resolvePart(key, pc.attrs.Source), w: num(pc.attrs.Width, NaN), h: num(pc.attrs.Height, NaN) });
          for (const lt of pc.children) {
            if (lt.name !== 'PageContent.LinkTargets') continue;
            for (const t of lt.children) if (t.attrs.Name && !this.names.has(t.attrs.Name)) this.names.set(t.attrs.Name, idx);
          }
        }
      } else if (r.name === 'FixedPage') {
        pages.push({ key });
      }
    };
    for (const k of startKeys) await visitDoc(k);
    if (!pages.length) {
      // Last resort: loose FixedPage parts in name order.
      const fp = this.pkg
        .keys()
        .filter((k) => k.endsWith('.fpage'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const k of fp) pages.push({ key: k });
    }
    return pages;
  }

  // ----- resources --------------------------------------------------------

  async loadResourceScope(holder: XNode | undefined, parent: ResScope | null, base: string): Promise<ResScope | null> {
    if (!holder) return parent;
    const map = new Map<string, XNode>();
    for (const rd of holder.children) {
      if (rd.name !== 'ResourceDictionary') continue;
      if (rd.attrs.Source) {
        const remote = await this.loadDict(resolvePart(rd.base ?? base, rd.attrs.Source));
        if (remote) for (const [k, v] of remote) map.set(k, v);
      }
      for (const c of rd.children) {
        const key = attrLocal(c, 'Key');
        if (key) map.set(key, c);
      }
    }
    return map.size ? { map, parent } : parent;
  }

  loadDict(key: string): Promise<Map<string, XNode> | null> {
    let p = this.dicts.get(key);
    if (!p) {
      p = (async () => {
        const x = await this.pkg.xml(key);
        const r = x && rootElement(x);
        if (!r || r.name !== 'ResourceDictionary') {
          this.warn(`Resource dictionary ${key} missing or invalid`);
          return null;
        }
        const tag = (n: XNode) => {
          n.base = key;
          n.children.forEach(tag);
        };
        tag(r);
        const map = new Map<string, XNode>();
        if (r.attrs.Source) {
          const nested = await this.loadDict(resolvePart(key, r.attrs.Source));
          if (nested) for (const [k, v] of nested) map.set(k, v);
        }
        for (const c of r.children) {
          const k = attrLocal(c, 'Key');
          if (k) map.set(k, c);
        }
        return map;
      })();
      this.dicts.set(key, p);
    }
    return p;
  }

  lookup(ctx: Ctx, key: string): XNode | undefined {
    for (let s = ctx.res; s; s = s.parent) {
      const v = s.map.get(key);
      if (v) return v;
    }
    this.warn(`StaticResource "${key}" not found`);
    return undefined;
  }

  /** Attribute or property-element value; resolves {StaticResource key}. */
  prop(node: XNode, name: string, ctx: Ctx): string | XNode | undefined {
    const a = node.attrs[name];
    if (a !== undefined) {
      const m = /^\s*\{\s*StaticResource\s+([^}]+?)\s*\}\s*$/.exec(a);
      if (m) return this.lookup(ctx, m[1]);
      return a;
    }
    const pe = node.children.find((c) => c.name === `${node.name}.${name}`);
    return pe?.children[0];
  }

  transformOf(v: string | XNode | undefined, ctx: Ctx): M | null {
    if (v === undefined) return null;
    if (typeof v === 'string') return parseMatrix(v);
    if (v.name === 'MatrixTransform') {
      const m = this.prop(v, 'Matrix', ctx);
      return typeof m === 'string' ? parseMatrix(m) : null;
    }
    this.warn(`Unsupported transform ${v.name}`);
    return null;
  }

  // ----- geometry ---------------------------------------------------------

  geometry(v: string | XNode | undefined, ctx: Ctx): Geometry | null {
    if (v === undefined) return null;
    if (typeof v === 'string') {
      const pb = new PathBuilder(null);
      const { evenOdd } = parseAbbreviated(v, pb);
      return { ops: pb.ops.join('\n'), evenOdd, bbox: pb.bbox, empty: pb.empty };
    }
    if (v.name !== 'PathGeometry') {
      this.warn(`Unsupported geometry ${v.name}`);
      return null;
    }
    const t = this.transformOf(this.prop(v, 'Transform', ctx), ctx);
    const pb = new PathBuilder(t && !isIdent(t) ? t : null);
    let evenOdd = (v.attrs.FillRule ?? 'EvenOdd').toLowerCase() !== 'nonzero';
    const figs = this.prop(v, 'Figures', ctx);
    if (typeof figs === 'string') {
      const r = parseAbbreviated(figs, pb);
      if (v.attrs.FillRule === undefined) evenOdd = r.evenOdd;
    }
    for (const f of v.children) {
      if (f.name !== 'PathFigure') continue;
      const sp = points(f.attrs.StartPoint)[0] ?? [0, 0];
      let [cx, cy] = sp;
      pb.move(cx, cy);
      for (const s of f.children) {
        switch (s.name) {
          case 'LineSegment':
          case 'PolyLineSegment':
            for (const p of points(s.attrs.Points ?? s.attrs.Point)) {
              pb.line(p[0], p[1]);
              [cx, cy] = p;
            }
            break;
          case 'BezierSegment':
          case 'PolyBezierSegment': {
            const p =
              s.name === 'BezierSegment'
                ? [...points(s.attrs.Point1), ...points(s.attrs.Point2), ...points(s.attrs.Point3)]
                : points(s.attrs.Points);
            for (let k = 0; k + 2 < p.length; k += 3) {
              pb.cubic(p[k][0], p[k][1], p[k + 1][0], p[k + 1][1], p[k + 2][0], p[k + 2][1]);
              [cx, cy] = p[k + 2];
            }
            break;
          }
          case 'QuadraticBezierSegment':
          case 'PolyQuadraticBezierSegment': {
            const p =
              s.name === 'QuadraticBezierSegment' ? [...points(s.attrs.Point1), ...points(s.attrs.Point2)] : points(s.attrs.Points);
            for (let k = 0; k + 1 < p.length; k += 2) {
              const [qx, qy] = p[k];
              const [x, y] = p[k + 1];
              pb.cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
              cx = x;
              cy = y;
            }
            break;
          }
          case 'ArcSegment': {
            const p = points(s.attrs.Point)[0];
            const sz = points(s.attrs.Size)[0] ?? [0, 0];
            if (!p) break;
            arcTo(
              pb,
              cx,
              cy,
              sz[0],
              sz[1],
              num(s.attrs.RotationAngle, 0),
              (s.attrs.IsLargeArc ?? '').toLowerCase() === 'true',
              (s.attrs.SweepDirection ?? '').toLowerCase() === 'clockwise',
              p[0],
              p[1],
            );
            [cx, cy] = p;
            break;
          }
          default:
            this.warn(`Unsupported path segment ${s.name}`);
        }
      }
      if ((f.attrs.IsClosed ?? '').toLowerCase() === 'true') {
        pb.close();
        [cx, cy] = sp;
      }
    }
    return { ops: pb.ops.join('\n'), evenOdd, bbox: pb.bbox, empty: pb.empty };
  }

  // ----- graphics state ---------------------------------------------------

  gs(fill: number, stroke: number, smask?: PDFRef): string {
    const f = Math.round(Math.max(0, Math.min(1, fill)) * 1000) / 1000;
    const s = Math.round(Math.max(0, Math.min(1, stroke)) * 1000) / 1000;
    const key = smask ? `m${smask.objectNumber}` : `${f}/${s}`;
    let ref = this.gsCache.get(key);
    if (!ref) {
      const d: Record<string, unknown> = { Type: 'ExtGState' };
      if (smask) {
        d.SMask = smask;
      } else {
        d.ca = f;
        d.CA = s;
      }
      ref = this.doc.context.register(this.doc.context.obj(d as never));
      this.gsCache.set(key, ref);
    }
    return `/${this.out.res('ExtGState', key, ref, 'G')} gs`;
  }

  // ----- fonts -----------------------------------------------------------

  getFont(key: string, fragment: string): Promise<LoadedFont> {
    const k = `${key}#${fragment}`;
    let p = this.fonts.get(k);
    if (!p) {
      p = this.loadFont(key, fragment).catch(async (e: unknown) => {
        this.warn(`Font ${key} could not be used (${e instanceof Error ? e.message : String(e)}); Helvetica substituted`);
        return { kind: 'std', font: await this.helvetica() } as StdFont;
      });
      this.fonts.set(k, p);
    }
    return p;
  }

  helvetica(): Promise<PDFFont> {
    if (!this.stdFont) this.stdFont = this.doc.embedFont(StandardFonts.Helvetica);
    return this.stdFont;
  }

  async loadFont(key: string, fragment: string): Promise<LoadedFont> {
    const raw = await this.pkg.bytes(key);
    if (!raw) throw new Error('font part missing');
    const ct = this.pkg.contentType(key);
    let bytes: Uint8Array = raw.slice();
    const obf = key.endsWith('.odttf') || ct.includes('obfuscated');
    if (obf || !looksLikeFont(raw)) {
      const d = deobfuscateFont(raw, key);
      if (d && looksLikeFont(d)) bytes = d;
      else if (!looksLikeFont(raw)) throw new Error('not a TrueType/OpenType font');
    }
    let font = fontkit.create(bytes) as FkFont & { fonts?: FkFont[] };
    let ttcIndex = -1;
    if (Array.isArray(font.fonts)) {
      ttcIndex = Math.min(Math.max(0, parseInt(fragment || '0', 10) || 0), font.fonts.length - 1);
      const member = font.fonts[ttcIndex];
      if (!member) throw new Error('empty font collection');
      font = member;
    }
    const f = font as unknown as {
      unitsPerEm: number;
      cff?: unknown;
      postscriptName: string | null;
      numGlyphs: number;
    };
    const cff = !!f.cff;
    if (cff && ttcIndex >= 0) throw new Error('CFF font inside a collection');
    const ps = (f.postscriptName || 'XpsFont').replace(/[^A-Za-z0-9_-]/g, '') || 'XpsFont';
    const entry: CidFont = {
      kind: 'cid',
      ref: this.doc.context.nextRef(),
      font,
      upem: f.unitsPerEm || 1000,
      subset: !cff,
      ttcIndex,
      used: new Set([0]),
      cff,
      bytes,
      widths: new Map(),
      toUni: new Map(),
      psName: ps,
    };
    this.cidFonts.push(entry);
    return entry;
  }

  /**
   * Record a glyph as used and return the glyph id to write (glyph ids are
   * kept unchanged by the subsetter), or null for an invalid glyph.
   */
  useGlyph(f: CidFont, gid: number): number | null {
    if (f.used.has(gid) && f.widths.has(gid)) return gid;
    const numGlyphs = (f.font as unknown as { numGlyphs: number }).numGlyphs;
    if (!Number.isInteger(gid) || gid < 0 || gid > 0xffff || (numGlyphs && gid >= numGlyphs)) return null;
    try {
      const glyph = f.font.getGlyph(gid);
      const w = Math.round(((glyph.advanceWidth ?? 0) * 1000 * 100) / f.upem) / 100;
      f.used.add(gid);
      f.widths.set(gid, w);
      return gid;
    } catch {
      return null;
    }
  }

  async finalizeFonts() {
    const ctx = this.doc.context;
    let tagN = 0;
    for (const f of this.cidFonts) {
      try {
        let fontBytes = f.bytes;
        if (f.subset) {
          try {
            fontBytes = subsetTrueType(f.bytes, f.used, f.ttcIndex);
          } catch (e) {
            if (f.ttcIndex >= 0) throw e;
            this.warn(`Font ${f.psName} embedded without subsetting (${e instanceof Error ? e.message : String(e)})`);
            f.subset = false;
          }
        }
        const ff = f.cff
          ? ctx.flateStream(fontBytes, { Subtype: 'OpenType' })
          : ctx.flateStream(fontBytes, { Length1: fontBytes.length });
        const ffRef = ctx.register(ff);
        const fk = f.font as unknown as {
          bbox: { minX: number; minY: number; maxX: number; maxY: number };
          ascent: number;
          descent: number;
          capHeight: number;
          italicAngle: number;
        };
        const sc = 1000 / f.upem;
        const name = `${f.subset ? subsetTag(tagN++) + '+' : ''}${f.psName}`;
        const desc = ctx.obj({
          Type: 'FontDescriptor',
          FontName: name,
          Flags: 4,
          FontBBox: [
            Math.round((fk.bbox?.minX ?? 0) * sc),
            Math.round((fk.bbox?.minY ?? -200) * sc),
            Math.round((fk.bbox?.maxX ?? 1000) * sc),
            Math.round((fk.bbox?.maxY ?? 800) * sc),
          ],
          ItalicAngle: fk.italicAngle || 0,
          Ascent: Math.round((fk.ascent ?? 800) * sc),
          Descent: Math.round((fk.descent ?? -200) * sc),
          CapHeight: Math.round((fk.capHeight || fk.ascent || 700) * sc),
          StemV: 80,
        });
        desc.set(PDFName.of(f.cff ? 'FontFile3' : 'FontFile2'), ffRef);
        const descRef = ctx.register(desc);
        const w: unknown[] = [];
        for (const [g, wd] of [...f.widths.entries()].sort((a, b) => a[0] - b[0])) w.push(g, [wd]);
        const cid = ctx.obj({
          Type: 'Font',
          Subtype: f.cff ? 'CIDFontType0' : 'CIDFontType2',
          BaseFont: name,
          CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
          FontDescriptor: descRef,
          W: w as never,
          DW: 0,
        });
        if (!f.cff) cid.set(PDFName.of('CIDToGIDMap'), PDFName.of('Identity'));
        const cidRef = ctx.register(cid);
        const tu = ctx.register(ctx.flateStream(buildToUnicode(f.toUni)));
        ctx.assign(
          f.ref,
          ctx.obj({
            Type: 'Font',
            Subtype: 'Type0',
            BaseFont: name,
            Encoding: 'Identity-H',
            DescendantFonts: [cidRef],
            ToUnicode: tu,
          }),
        );
      } catch (e) {
        this.warn(`Embedding font ${f.psName} failed (${e instanceof Error ? e.message : String(e)})`);
        // Keep the reference valid so pages still open.
        ctx.assign(f.ref, ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
      }
    }
  }

  // ----- images ----------------------------------------------------------

  getImage(key: string): Promise<ImageInfo | null> {
    let p = this.images.get(key);
    if (!p) {
      p = this.loadImage(key).catch((e: unknown) => {
        this.warn(`Image ${key} could not be decoded (${e instanceof Error ? e.message : String(e)})`);
        return null;
      });
      this.images.set(key, p);
    }
    return p;
  }

  async loadImage(key: string): Promise<ImageInfo | null> {
    const b = await this.pkg.bytes(key);
    if (!b) {
      this.warn(`Image part ${key} missing`);
      return null;
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const img = await this.doc.embedPng(b);
      const dpi = pngDpi(b);
      return { ref: img.ref, pxW: img.width, pxH: img.height, dpiX: dpi[0], dpiY: dpi[1] };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      const img = await this.doc.embedJpg(b);
      const dpi = jpegDpi(b);
      return { ref: img.ref, pxW: img.width, pxH: img.height, dpiX: dpi[0], dpiY: dpi[1] };
    }
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) {
      return this.loadTiff(b);
    }
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0xbc) {
      this.warn('JPEG XR / HD Photo images are not supported; image skipped');
      return null;
    }
    this.warn(`Unknown image format in ${key}; image skipped`);
    return null;
  }

  async loadTiff(b: Uint8Array): Promise<ImageInfo | null> {
    const mod = (await import('utif')) as unknown as { default?: unknown };
    const UTIF = (mod.default ?? mod) as {
      decode(buf: ArrayBuffer): Array<Record<string, unknown> & { width: number; height: number }>;
      decodeImage(buf: ArrayBuffer, ifd: unknown): void;
      toRGBA8(ifd: unknown): Uint8Array;
    };
    const buf = b.slice().buffer;
    const ifds = UTIF.decode(buf);
    const ifd = ifds[0];
    if (!ifd) throw new Error('empty TIFF');
    UTIF.decodeImage(buf, ifd);
    const w = ifd.width;
    const h = ifd.height;
    if (!w || !h) throw new Error('TIFF without image data');
    const rgba = UTIF.toRGBA8(ifd);
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    let hasAlpha = false;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      rgb[i * 3] = rgba[j];
      rgb[i * 3 + 1] = rgba[j + 1];
      rgb[i * 3 + 2] = rgba[j + 2];
      alpha[i] = rgba[j + 3];
      if (rgba[j + 3] !== 255) hasAlpha = true;
    }
    const ctx = this.doc.context;
    const dict: Record<string, unknown> = {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    };
    if (hasAlpha) {
      dict.SMask = ctx.register(
        ctx.flateStream(alpha, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
      );
    }
    const ref = ctx.register(ctx.flateStream(rgb, dict as never));
    const res = (t: string) => {
      const v = ifd[t] as number[] | undefined;
      return v && v.length ? v[0] : 0;
    };
    const unit = res('t296') || 2;
    const toDpi = (v: number) => (!v ? 96 : unit === 3 ? v * 2.54 : v);
    return { ref, pxW: w, pxH: h, dpiX: toDpi(res('t282')), dpiY: toDpi(res('t283')) };
  }

  // ----- brushes ----------------------------------------------------------

  /** Solid colour of a brush for contexts that cannot paint complex brushes. */
  approxColor(brush: XNode, ctx: Ctx): Rgba | null {
    const op = num(brush.attrs.Opacity, 1);
    if (brush.name === 'SolidColorBrush') {
      const c = parseColor(this.strProp(brush, 'Color', ctx), (m) => this.warn(m));
      return c ? { ...c, a: c.a * op } : null;
    }
    if (brush.name === 'LinearGradientBrush' || brush.name === 'RadialGradientBrush') {
      const stops = this.stops(brush);
      if (!stops.length) return null;
      const avg = stops.reduce((a, s) => ({ r: a.r + s.c.r, g: a.g + s.c.g, b: a.b + s.c.b, a: a.a + s.c.a }), { r: 0, g: 0, b: 0, a: 0 });
      const n = stops.length;
      return { r: avg.r / n, g: avg.g / n, b: avg.b / n, a: (avg.a / n) * op };
    }
    return { r: 0.5, g: 0.5, b: 0.5, a: op };
  }

  strProp(node: XNode, name: string, ctx: Ctx): string | undefined {
    const v = this.prop(node, name, ctx);
    return typeof v === 'string' ? v : undefined;
  }

  brushOf(v: string | XNode | undefined, ctx: Ctx): { solid?: Rgba; node?: XNode } | null {
    if (v === undefined) return null;
    if (typeof v === 'string') {
      const c = parseColor(v, (m) => this.warn(m));
      if (!c) {
        this.warn(`Unrecognised colour "${v}"`);
        return null;
      }
      return { solid: c };
    }
    if (v.name === 'SolidColorBrush') {
      const c = parseColor(this.strProp(v, 'Color', ctx), (m) => this.warn(m));
      if (!c) return null;
      return { solid: { ...c, a: c.a * num(v.attrs.Opacity, 1) } };
    }
    return { node: v };
  }

  stops(brush: XNode): Stop[] {
    const holder = brush.children.find((c) => c.name === `${brush.name}.GradientStops`);
    const list = holder ? holder.children : brush.children.filter((c) => c.name === 'GradientStop');
    const out: Stop[] = [];
    for (const s of list) {
      if (s.name !== 'GradientStop') continue;
      const c = parseColor(s.attrs.Color, (m) => this.warn(m));
      if (c) out.push({ offset: num(s.attrs.Offset, 0), c });
    }
    out.sort((a, b) => a.offset - b.offset);
    return out;
  }

  /** PDF function (type 3 stitching of type 2) over [0,1] for a colour/alpha ramp. */
  rampFunction(stops: Stop[], pick: (c: Rgba) => number[]): unknown {
    const s = stops.map((x) => ({ offset: Math.max(0, Math.min(1, x.offset)), c: x.c }));
    if (s[0].offset > 0) s.unshift({ offset: 0, c: s[0].c });
    if (s[s.length - 1].offset < 1) s.push({ offset: 1, c: s[s.length - 1].c });
    const fns: unknown[] = [];
    const bounds: number[] = [];
    const encode: number[] = [];
    for (let i = 0; i + 1 < s.length; i++) {
      fns.push({ FunctionType: 2, Domain: [0, 1], C0: pick(s[i].c), C1: pick(s[i + 1].c), N: 1 });
      if (i > 0) bounds.push(s[i].offset);
      encode.push(0, 1);
    }
    if (fns.length === 1) return fns[0];
    return { FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode };
  }

  /**
   * Paint a non-solid brush into the current clip. `bbox` is the area to cover
   * in local coordinates. Must be called inside q/Q with the clip already set.
   */
  async paintBrush(brush: XNode, ctx: Ctx, bbox: BBox | null, opacity: number): Promise<void> {
    const op = opacity * num(brush.attrs.Opacity, 1);
    if (op <= 0) return;
    const bt = this.transformOf(this.prop(brush, 'Transform', ctx), ctx) ?? IDENT;
    switch (brush.name) {
      case 'SolidColorBrush': {
        const c = this.approxColor(brush, ctx);
        if (!c || !bbox) return;
        const a = c.a * opacity;
        if (a < 1) this.out.push(this.gs(a, a));
        this.out.push(`${rgbOp(c, false)}\n${fmt(bbox[0])} ${fmt(bbox[1])} ${fmt(bbox[2] - bbox[0])} ${fmt(bbox[3] - bbox[1])} re f`);
        return;
      }
      case 'LinearGradientBrush':
      case 'RadialGradientBrush':
        return this.paintGradient(brush, bt, op, bbox);
      case 'ImageBrush': {
        const src = this.strProp(brush, 'ImageSource', ctx);
        if (!src) {
          this.warn('ImageBrush without ImageSource skipped');
          return;
        }
        let uri = src.trim();
        const ccb = /^\{\s*ColorConvertedBitmap\s+(\S+)/i.exec(uri);
        if (ccb) {
          uri = ccb[1];
          this.warn('ColorConvertedBitmap: colour profile ignored');
        }
        const img = await this.getImage(resolvePart(brush.base ?? ctx.base, uri));
        if (!img) return;
        const iw = (img.pxW * 96) / (img.dpiX || 96);
        const ih = (img.pxH * 96) / (img.dpiY || 96);
        const name = this.out.res('XObject', `img${img.ref.objectNumber}`, img.ref, 'I');
        await this.paintTiles(brush, ctx, bt, op, bbox, async () => {
          this.out.push(`q ${fmt(iw)} 0 0 ${fmt(-ih)} 0 ${fmt(ih)} cm /${name} Do Q`);
        });
        return;
      }
      case 'VisualBrush': {
        const vis = this.prop(brush, 'Visual', ctx);
        if (!vis || typeof vis === 'string') {
          this.warn('VisualBrush without Visual skipped');
          return;
        }
        await this.paintTiles(brush, ctx, bt, op, bbox, async (tctx) => {
          await this.renderElement(vis, tctx);
        });
        return;
      }
      default:
        this.warn(`Unsupported brush ${brush.name}`);
    }
  }

  /** ImageBrush/VisualBrush Viewbox->Viewport mapping with TileMode. */
  async paintTiles(
    brush: XNode,
    ctx: Ctx,
    bt: M,
    op: number,
    bbox: BBox | null,
    draw: (ctx: Ctx) => Promise<void>,
  ): Promise<void> {
    const vb = nums(brush.attrs.Viewbox);
    const vp = nums(brush.attrs.Viewport);
    if (vb.length < 4 || vp.length < 4 || !vb[2] || !vb[3] || !vp[2] || !vp[3]) {
      this.warn(`${brush.name} with an empty Viewbox/Viewport skipped`);
      return;
    }
    const sx = vp[2] / vb[2];
    const sy = vp[3] / vb[3];
    const map: M = [sx, 0, 0, sy, vp[0] - vb[0] * sx, vp[1] - vb[1] * sy];
    const mode = (brush.attrs.TileMode ?? 'None').toLowerCase();
    this.out.push('q');
    if (op < 1) this.out.push(this.gs(op, op));
    if (!isIdent(bt)) this.out.push(`${fm(bt)} cm`);
    const brushCtm = mul(bt, ctx.ctm);
    const tiles: { i: number; j: number }[] = [];
    if (mode === 'none' || !bbox) tiles.push({ i: 0, j: 0 });
    else {
      const inv = invert(bt);
      const area = inv ? bboxTransform(bbox, inv) : bbox;
      const i0 = Math.floor((area[0] - vp[0]) / vp[2]);
      const i1 = Math.ceil((area[2] - vp[0]) / vp[2]);
      const j0 = Math.floor((area[1] - vp[1]) / vp[3]);
      const j1 = Math.ceil((area[3] - vp[1]) / vp[3]);
      if ((i1 - i0) * (j1 - j0) > 4000) {
        this.warn(`${brush.name} tiling too dense; drawn once`);
        tiles.push({ i: 0, j: 0 });
      } else for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) tiles.push({ i, j });
    }
    const flipX = mode === 'flipx' || mode === 'flipxy';
    const flipY = mode === 'flipy' || mode === 'flipxy';
    for (const { i, j } of tiles) {
      let tm: M = [1, 0, 0, 1, i * vp[2], j * vp[3]];
      if (flipX && i % 2 !== 0) tm = mul([-1, 0, 0, 1, 2 * vp[0] + vp[2], 0], tm);
      if (flipY && j % 2 !== 0) tm = mul([1, 0, 0, -1, 0, 2 * vp[1] + vp[3]], tm);
      this.out.push('q');
      if (!isIdent(tm)) this.out.push(`${fm(tm)} cm`);
      this.out.push(`${fmt(vp[0])} ${fmt(vp[1])} ${fmt(vp[2])} ${fmt(vp[3])} re W n`);
      this.out.push(`${fm(map)} cm`);
      await draw({ ...ctx, opacity: 1, ctm: mul(map, mul(tm, brushCtm)) });
      this.out.push('Q');
    }
    this.out.push('Q');
  }

  async paintGradient(brush: XNode, bt: M, op: number, bbox: BBox | null): Promise<void> {
    const stops = this.stops(brush);
    if (!stops.length) {
      this.warn(`${brush.name} without GradientStops skipped`);
      return;
    }
    const spread = (brush.attrs.SpreadMethod ?? 'Pad').toLowerCase();
    if (spread !== 'pad') this.warn(`Gradient SpreadMethod=${brush.attrs.SpreadMethod} approximated as Pad`);
    const cctx = this.doc.context;
    let shadingDict: Record<string, unknown>;
    let pre: M = IDENT;
    const linear = brush.name === 'LinearGradientBrush';
    let coords: number[];
    if (linear) {
      const s = points(brush.attrs.StartPoint)[0] ?? [0, 0];
      const e = points(brush.attrs.EndPoint)[0] ?? [1, 0];
      coords = [s[0], s[1], e[0], e[1]];
      if (s[0] === e[0] && s[1] === e[1]) {
        // Degenerate: paint the last stop.
        stops.splice(0, stops.length - 1);
      }
    } else {
      const c = points(brush.attrs.Center)[0] ?? [0, 0];
      const o = points(brush.attrs.GradientOrigin)[0] ?? c;
      const rx = num(brush.attrs.RadiusX, 0);
      const ry = num(brush.attrs.RadiusY, 0);
      if (!rx || !ry) {
        stops.splice(0, stops.length - 1);
        coords = [0, 0, 0, 0, 0, 1];
      } else {
        pre = [rx, 0, 0, ry, c[0], c[1]];
        coords = [(o[0] - c[0]) / rx, (o[1] - c[1]) / ry, 0, 0, 0, 1];
      }
    }
    const areaCover = (m: M) => {
      // Rectangle in shading space covering bbox, used when a single colour is painted.
      const inv = invert(m);
      const b = bbox ? (inv ? bboxTransform(bbox, inv) : bbox) : [-1e4, -1e4, 1e4, 1e4];
      return `${fmt(b[0])} ${fmt(b[1])} ${fmt(b[2] - b[0])} ${fmt(b[3] - b[1])} re f`;
    };
    const alphas = stops.map((s) => s.c.a);
    const uniformA = alphas.every((a) => Math.abs(a - alphas[0]) < 1e-3);
    this.out.push('q');
    if (!isIdent(bt)) this.out.push(`${fm(bt)} cm`);
    if (stops.length === 1) {
      const a = stops[0].c.a * op;
      if (a < 1) this.out.push(this.gs(a, a));
      this.out.push(rgbOp(stops[0].c, false));
      this.out.push(areaCover(bt));
      this.out.push('Q');
      return;
    }
    shadingDict = {
      ShadingType: linear ? 2 : 3,
      ColorSpace: 'DeviceRGB',
      Coords: coords,
      Function: this.rampFunction(stops, (c) => [c.r, c.g, c.b]),
      Extend: [true, true],
    };
    const shRef = cctx.register(cctx.obj(shadingDict as never));
    const shName = this.out.res('Shading', `sh${shRef.objectNumber}`, shRef, 'Sh');
    if (uniformA) {
      const a = alphas[0] * op;
      if (a < 1) this.out.push(this.gs(a, a));
    } else {
      // Luminosity soft mask carrying the stop alphas (times the opacity).
      const maskSh = cctx.register(
        cctx.obj({
          ShadingType: linear ? 2 : 3,
          ColorSpace: 'DeviceGray',
          Coords: coords,
          Function: this.rampFunction(stops, (c) => [c.a * op]),
          Extend: [true, true],
        } as never),
      );
      const form = cctx.flateStream(`${isIdent(pre) ? '' : fm(pre) + ' cm '}/S0 sh`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [-1e5, -1e5, 1e5, 1e5],
        Group: { Type: 'Group', S: 'Transparency', CS: 'DeviceGray' },
        Resources: { Shading: { S0: maskSh } },
      } as never);
      const formRef = cctx.register(form);
      const smask = cctx.register(cctx.obj({ Type: 'Mask', S: 'Luminosity', G: formRef } as never));
      this.out.push(this.gs(1, 1, smask));
    }
    if (!isIdent(pre)) this.out.push(`${fm(pre)} cm`);
    this.out.push(`/${shName} sh`);
    this.out.push('Q');
  }

  // ----- elements ----------------------------------------------------------

  async renderChildren(parent: XNode, ctx: Ctx): Promise<void> {
    for (const c of parent.children) {
      if (c.name.includes('.')) continue; // property element
      await this.renderElement(c, ctx);
    }
  }

  async renderElement(node: XNode, ctx: Ctx): Promise<void> {
    const mark = this.out.ops.length;
    try {
      switch (node.name) {
        case 'Canvas':
          await this.renderCanvas(node, ctx);
          break;
        case 'Path':
          await this.renderPath(node, ctx);
          break;
        case 'Glyphs':
          await this.renderGlyphs(node, ctx);
          break;
        case 'AlternateContent': {
          const pick = node.children.find((c) => c.name === 'Fallback') ?? node.children.find((c) => c.name === 'Choice');
          if (pick) await this.renderChildren(pick, ctx);
          break;
        }
        default:
          this.warn(`Unsupported element ${node.name} skipped`);
      }
    } catch (e) {
      // Drop whatever the element emitted (keeps q/Q balanced) and go on.
      this.out.ops.length = mark;
      this.warn(`${node.name} skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Common prologue: q, RenderTransform, Clip. Returns the element context or null when fully clipped. */
  begin(node: XNode, ctx: Ctx): Ctx | null {
    const t = this.transformOf(this.prop(node, 'RenderTransform', ctx), ctx);
    this.out.push('q');
    let ctm = ctx.ctm;
    if (t && !isIdent(t)) {
      this.out.push(`${fm(t)} cm`);
      ctm = mul(t, ctm);
    }
    const clipV = this.prop(node, 'Clip', ctx);
    if (clipV !== undefined) {
      const g = this.geometry(clipV, { ...ctx, ctm });
      if (!g || g.empty) {
        this.out.push('Q');
        return null;
      }
      this.out.push(g.ops, g.evenOdd ? 'W* n' : 'W n');
    }
    let opacity = ctx.opacity * num(node.attrs.Opacity, 1);
    const mask = this.prop(node, 'OpacityMask', ctx);
    if (mask !== undefined) {
      const b = this.brushOf(mask, ctx);
      if (b?.solid) opacity *= b.solid.a;
      else this.warn('OpacityMask with a non-solid brush ignored');
    }
    const name = node.attrs.Name;
    if (name && !this.names.has(name)) this.names.set(name, this.pageIndex);
    return { ...ctx, ctm, opacity };
  }

  async renderCanvas(node: XNode, ctx: Ctx): Promise<void> {
    // A Canvas' own resources are visible to its own properties too.
    const res = await this.loadResourceScope(
      node.children.find((c) => c.name === 'Canvas.Resources'),
      ctx.res,
      node.base ?? ctx.base,
    );
    const c0 = this.begin(node, { ...ctx, res });
    if (!c0) return;
    if (c0.opacity <= 0) {
      this.out.push('Q');
      return;
    }
    await this.renderChildren(node, c0);
    this.out.push('Q');
  }

  addLink(node: XNode, ctx: Ctx, bbox: BBox | null) {
    const uri = node.attrs['FixedPage.NavigateUri'];
    if (!uri || !bbox) return;
    const b = bboxTransform(bbox, ctx.ctm);
    const rect: [number, number, number, number] = [b[0] * 0.75, (this.pageH - b[3]) * 0.75, b[2] * 0.75, (this.pageH - b[1]) * 0.75];
    this.links.push({ page: this.pageIndex, rect, uri, base: node.base ?? ctx.base });
  }

  async renderPath(node: XNode, ctx: Ctx): Promise<void> {
    const geo = this.geometry(this.prop(node, 'Data', ctx), ctx);
    if (!geo || geo.empty) return;
    const c = this.begin(node, ctx);
    if (!c) return;
    const fill = this.brushOf(this.prop(node, 'Fill', ctx), c);
    const stroke = this.brushOf(this.prop(node, 'Stroke', ctx), c);
    const op = c.opacity;
    if (op > 0 && fill) {
      if (fill.solid) {
        const a = fill.solid.a * op;
        if (a > 0) {
          this.out.push('q');
          if (a < 1) this.out.push(this.gs(a, a));
          this.out.push(rgbOp(fill.solid, false), geo.ops, geo.evenOdd ? 'f*' : 'f', 'Q');
        }
      } else if (fill.node) {
        this.out.push('q', geo.ops, geo.evenOdd ? 'W* n' : 'W n');
        await this.paintBrush(fill.node, c, geo.bbox, op);
        this.out.push('Q');
      }
    }
    const thick = num(this.strProp(node, 'StrokeThickness', c), 1);
    if (op > 0 && stroke && thick > 0) {
      let col = stroke.solid;
      if (!col && stroke.node) {
        col = this.approxColor(stroke.node, c) ?? undefined;
        this.warn(`Stroke with ${stroke.node.name} approximated by a solid colour`);
      }
      if (col && col.a * op > 0) {
        const a = col.a * op;
        const cap = (s: string | undefined) => {
          switch ((s ?? 'Flat').toLowerCase()) {
            case 'round':
            case 'triangle':
              return 1;
            case 'square':
              return 2;
            default:
              return 0;
          }
        };
        const join = (() => {
          switch ((node.attrs.StrokeLineJoin ?? 'Miter').toLowerCase()) {
            case 'round':
              return 1;
            case 'bevel':
              return 2;
            default:
              return 0;
          }
        })();
        const parts = ['q'];
        if (a < 1) parts.push(this.gs(a, a));
        parts.push(rgbOp(col, true), `${fmt(thick)} w`, `${cap(node.attrs.StrokeStartLineCap)} J`, `${join} j`);
        parts.push(`${fmt(Math.max(1, num(node.attrs.StrokeMiterLimit, 10)))} M`);
        const dashes = nums(node.attrs.StrokeDashArray).map((d) => Math.max(0, d * thick));
        if (dashes.length && dashes.some((d) => d > 0)) {
          const dc = node.attrs.StrokeDashCap;
          if (dc) parts.push(`${cap(dc)} J`);
          parts.push(`[${dashes.map(fmt).join(' ')}] ${fmt(num(node.attrs.StrokeDashOffset, 0) * thick)} d`);
        }
        parts.push(geo.ops, 'S', 'Q');
        this.out.push(...parts);
      }
    }
    this.addLink(node, c, geo.bbox);
    this.out.push('Q');
  }

  async renderGlyphs(node: XNode, ctx: Ctx): Promise<void> {
    const em = num(node.attrs.FontRenderingEmSize, 0);
    const fontUri = node.attrs.FontUri;
    let text = node.attrs.UnicodeString ?? '';
    if (text.startsWith('{}')) text = text.slice(2);
    const indices = node.attrs.Indices ?? '';
    if (!em || (!text && !indices)) return;
    const c = this.begin(node, ctx);
    if (!c) return;
    let font: LoadedFont;
    if (!fontUri) {
      this.warn('Glyphs without FontUri drawn with Helvetica');
      font = { kind: 'std', font: await this.helvetica() };
    } else {
      const hash = fontUri.indexOf('#');
      font = await this.getFont(resolvePart(node.base ?? ctx.base, fontUri), hash >= 0 ? fontUri.slice(hash + 1) : '');
    }
    const ox = num(node.attrs.OriginX, 0);
    const oy = num(node.attrs.OriginY, 0);
    const rtl = num(node.attrs.BidiLevel, 0) % 2 === 1;
    if (node.attrs.IsSideways?.toLowerCase() === 'true') this.warn('Sideways glyphs drawn horizontally');
    const sim = (node.attrs.StyleSimulations ?? 'None').toLowerCase();
    const bold = sim.includes('bold');
    const italic = sim.includes('italic');

    // ---- layout: glyph records with advances (1/100 em) and offsets
    interface Rec {
      gid?: number; // original gid (cid fonts)
      text: string; // text of the cluster (first glyph only)
      adv?: number;
      u: number;
      v: number;
    }
    const entries = indices.length
      ? indices.split(';').map((e) => {
          let cl: [number, number] | null = null;
          let rest = e.trim();
          const m = /^\((\d+)(?::(\d+))?\)/.exec(rest);
          if (m) {
            cl = [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 1];
            rest = rest.slice(m[0].length);
          }
          const f = rest.split(',');
          const g = f[0]?.trim();
          return {
            cl,
            gid: g ? parseInt(g, 10) : undefined,
            adv: f[1]?.trim() ? parseFloat(f[1]) : undefined,
            u: f[2]?.trim() ? parseFloat(f[2]) : 0,
            v: f[3]?.trim() ? parseFloat(f[3]) : 0,
          };
        })
      : [];
    const recs: Rec[] = [];
    let ci = 0;
    let gi = 0;
    while (ci < text.length || gi < entries.length) {
      const e = entries[gi];
      let m: number;
      let n: number;
      if (e?.cl) [m, n] = e.cl;
      else {
        const hi = text.charCodeAt(ci);
        m = ci < text.length ? (hi >= 0xd800 && hi <= 0xdbff && ci + 1 < text.length ? 2 : 1) : 0;
        n = 1;
      }
      const cluster = text.slice(ci, ci + m);
      if (gi >= entries.length && ci >= text.length) break;
      for (let k = 0; k < Math.max(n, 1); k++) {
        const en = entries[gi + k];
        recs.push({
          gid: en?.gid !== undefined && Number.isFinite(en.gid) ? en.gid : undefined,
          text: k === 0 ? cluster : '',
          adv: en?.adv !== undefined && Number.isFinite(en.adv) ? en.adv : undefined,
          u: en?.u || 0,
          v: en?.v || 0,
        });
      }
      ci += m;
      gi += Math.max(n, 1);
      if (m === 0 && n === 0) break;
    }

    // ---- encode against the font
    interface Out {
      hex: string | null; // null = invisible advance only
      w: number; // natural width, 1000/em
      adv: number; // wanted advance, 1000/em
      u: number;
      v: number;
    }
    const outs: Out[] = [];
    let fontName: string;
    if (font.kind === 'cid') {
      const f = font;
      fontName = this.out.res('Font', `cid${f.ref.objectNumber}`, f.ref, 'F');
      for (const r of recs) {
        let gid = r.gid;
        if (gid === undefined && r.text) {
          const cp = r.text.codePointAt(0)!;
          try {
            const g = f.font.glyphForCodePoint(cp);
            gid = g && g.id ? g.id : undefined;
          } catch {
            gid = undefined;
          }
        }
        const pg = gid !== undefined ? this.useGlyph(f, gid) : null;
        if (pg === null) {
          outs.push({ hex: null, w: 0, adv: (r.adv ?? 0) * 10, u: 0, v: 0 });
          continue;
        }
        if (r.text && !f.toUni.has(pg)) f.toUni.set(pg, r.text);
        const w = f.widths.get(pg) ?? 0;
        outs.push({ hex: hex4(pg), w, adv: r.adv !== undefined ? r.adv * 10 : w, u: r.u * 10, v: r.v * 10 });
      }
    } else {
      const pf = font.font;
      fontName = this.out.res('Font', `std${pf.ref.objectNumber}`, pf.ref, 'F');
      for (const r of recs) {
        let hex: string | null = null;
        let w = 0;
        if (r.text) {
          try {
            hex = (pf.encodeText(r.text) as PDFHexString).toString().replace(/[<>]/g, '');
            w = pf.widthOfTextAtSize(r.text, 1000);
          } catch {
            hex = null;
          }
        }
        if (!hex) outs.push({ hex: null, w: 0, adv: (r.adv ?? 0) * 10, u: 0, v: 0 });
        else outs.push({ hex, w, adv: r.adv !== undefined ? r.adv * 10 : w, u: r.u * 10, v: r.v * 10 });
      }
    }
    const total = outs.reduce((s, o) => s + o.adv, 0);
    const bbox: BBox = rtl ? [ox - (total * em) / 1000, oy - em, ox, oy + em * 0.3] : [ox, oy - em, ox + (total * em) / 1000, oy + em * 0.3];

    // ---- paint
    const fillV = this.prop(node, 'Fill', c);
    const fill = this.brushOf(fillV, c);
    let mode = 0; // fill
    let color: Rgba | undefined;
    let complex: XNode | undefined;
    if (!fill) mode = 3;
    else if (fill.solid) color = fill.solid;
    else if (fill.node) {
      complex = fill.node;
      mode = 7;
    }
    const alpha = (color?.a ?? 1) * c.opacity;
    if (alpha <= 0 && !complex) mode = 3; // keep searchable, invisible
    if (bold && mode !== 3) mode = mode === 7 ? 6 : 2;
    const skew = italic ? em * 0.35 : 0;
    const parts: string[] = [];
    if (color && mode !== 3) {
      if (alpha < 1) parts.push(this.gs(alpha, alpha));
      parts.push(rgbOp(color, false));
      if (bold) parts.push(rgbOp(color, true));
    }
    if (bold) parts.push(`${fmt(em * 0.02)} w 1 j`);
    parts.push('BT', `/${fontName} 1 Tf`, `${mode} Tr`);
    const perGlyph = rtl || outs.some((o) => o.u || o.v);
    if (!perGlyph) {
      parts.push(`${fmt(em)} 0 ${fmt(skew)} ${fmt(-em)} ${fmt(ox)} ${fmt(oy)} Tm`);
      const items: string[] = [];
      let hexRun = '';
      let pendingAdj = 0;
      for (const o of outs) {
        if (o.hex !== null) {
          if (Math.abs(pendingAdj) > 0.005) {
            if (hexRun) items.push(`<${hexRun}>`);
            hexRun = '';
            items.push(fmt(pendingAdj));
            pendingAdj = 0;
          }
          hexRun += o.hex;
          pendingAdj += o.w - o.adv;
        } else pendingAdj -= o.adv;
      }
      if (hexRun) items.push(`<${hexRun}>`);
      if (items.length) parts.push(`[${items.join(' ')}] TJ`);
    } else {
      let x = ox;
      for (const o of outs) {
        const step = (o.adv * em) / 1000;
        if (rtl) x -= step;
        if (o.hex !== null) {
          const gx = x + ((rtl ? -o.u : o.u) * em) / 1000;
          const gy = oy - (o.v * em) / 1000;
          parts.push(`${fmt(em)} 0 ${fmt(skew)} ${fmt(-em)} ${fmt(gx)} ${fmt(gy)} Tm <${o.hex}> Tj`);
        }
        if (!rtl) x += step;
      }
    }
    parts.push('ET');
    this.out.push(...parts);
    if (complex) {
      await this.paintBrush(complex, c, bbox, c.opacity);
    }
    this.addLink(node, c, bbox);
    this.out.push('Q');
  }

  // ----- pages ------------------------------------------------------------

  async renderPage(key: string, hint: { w?: number; h?: number }): Promise<void> {
    const x = await this.pkg.xml(key);
    const fp = x && rootElement(x);
    let w = 816;
    let h = 1056;
    if (!fp || fp.name !== 'FixedPage') {
      this.warn(`Page ${key} missing or invalid; blank page inserted`);
      if (hint.w && hint.h && Number.isFinite(hint.w) && Number.isFinite(hint.h)) {
        w = hint.w;
        h = hint.h;
      }
      this.pageRefs.push(this.doc.addPage([w * 0.75, h * 0.75]).ref);
      return;
    }
    w = num(fp.attrs.Width, hint.w && Number.isFinite(hint.w) ? hint.w : 816);
    h = num(fp.attrs.Height, hint.h && Number.isFinite(hint.h) ? hint.h : 1056);
    if (!(w > 0) || !(h > 0)) {
      this.warn(`Page ${key} has an invalid size; Letter used`);
      w = 816;
      h = 1056;
    }
    const page = this.doc.addPage([w * 0.75, h * 0.75]);
    this.pageRefs.push(page.ref);
    page.node.normalize();
    let resources = page.node.Resources();
    if (!resources) {
      resources = this.doc.context.obj({});
      page.node.set(PDFName.of('Resources'), resources);
    }
    this.out = new PageOut(this.doc, resources);
    this.pageH = h;
    this.out.push(`q 0.75 0 0 -0.75 0 ${fmt(h * 0.75)} cm`);
    const res = await this.loadResourceScope(
      fp.children.find((c) => c.name === 'FixedPage.Resources'),
      null,
      key,
    );
    await this.renderChildren(fp, { res, opacity: 1, ctm: IDENT, base: key });
    this.out.push('Q');
    const stream = this.doc.context.flateStream(this.out.ops.join('\n'));
    page.node.set(PDFName.of('Contents'), this.doc.context.register(stream));
  }

  finalizeLinks() {
    const ctx = this.doc.context;
    for (const l of this.links) {
      try {
        const annot: Record<string, unknown> = {
          Type: 'Annot',
          Subtype: 'Link',
          Rect: l.rect,
          Border: [0, 0, 0],
        };
        const uri = l.uri.trim();
        if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^pack:/i.test(uri)) {
          annot.A = { Type: 'Action', S: 'URI', URI: PDFString.of(uri) };
        } else {
          const hash = uri.indexOf('#');
          const frag = hash >= 0 ? safeDecode(uri.slice(hash + 1)) : '';
          let target = frag ? this.names.get(frag) : undefined;
          if (target === undefined && /^\d+$/.test(frag)) target = parseInt(frag, 10) - 1;
          if (target === undefined || target < 0 || target >= this.pageRefs.length) {
            this.warn(`Link target "${uri}" not found; link dropped`);
            continue;
          }
          annot.Dest = [this.pageRefs[target], 'Fit'];
        }
        const ref = ctx.register(ctx.obj(annot as never));
        const page = this.doc.getPage(l.page);
        page.node.addAnnot(ref);
      } catch {
        this.warn('Hyperlink could not be created');
      }
    }
  }

  async metadata() {
    try {
      const rels = await this.pkg.rels('');
      const core = rels.find((r) => /core-properties$/i.test(r.type));
      // The XML parser drops text content, so read the few fields from the raw part.
      const raw = core && (await this.pkg.bytes(core.target));
      if (!raw) return;
      const s = decodeText(raw);
      const pick = (tag: string) => {
        const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)</(?:\\w+:)?${tag}>`).exec(s);
        return m ? decodeEntities(m[1]).trim() : '';
      };
      const title = pick('title');
      const author = pick('creator');
      const subject = pick('subject');
      if (title) this.doc.setTitle(title);
      if (author) this.doc.setAuthor(author);
      if (subject) this.doc.setSubject(subject);
    } catch {
      /* metadata is optional */
    }
  }
}

function pngDpi(b: Uint8Array): [number, number] {
  let p = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'pHYs' && len >= 9) {
      const x = dv.getUint32(p + 8);
      const y = dv.getUint32(p + 12);
      if (b[p + 16] === 1 && x && y) return [x * 0.0254, y * 0.0254];
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  return [96, 96];
}

function jpegDpi(b: Uint8Array): [number, number] {
  // JFIF APP0: FF E0 len "JFIF\0" ver(2) units(1) Xdensity(2) Ydensity(2)
  if (b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    const units = b[13];
    const x = (b[14] << 8) | b[15];
    const y = (b[16] << 8) | b[17];
    if (x && y) {
      if (units === 1) return [x, y];
      if (units === 2) return [x * 2.54, y * 2.54];
    }
  }
  return [96, 96];
}

/**
 * Convert an XPS or OpenXPS document to PDF.
 * Throws only when the input is not an XPS package; every other problem is
 * reported in `warnings`.
 */
export async function xpsToPdf(xps: Uint8Array, opts?: XpsConvertOptions): Promise<XpsConvertResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(xps);
  } catch {
    throw new Error('Not an XPS package: the file is not a ZIP container');
  }
  const pkg = new Package(zip);
  await pkg.loadContentTypes();
  const conv = new Converter(pkg);
  const pages = await conv.findPages();
  if (!pages.length) throw new Error('Not an XPS package: no FixedDocumentSequence or FixedPage found');

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setProducer('Adika PDF Editor (XPS converter)');
  doc.setCreator('Adika PDF Editor');
  conv.doc = doc;
  await conv.metadata();

  opts?.onProgress?.(0, pages.length);
  for (let i = 0; i < pages.length; i++) {
    conv.pageIndex = i;
    try {
      await conv.renderPage(pages[i].key, pages[i]);
    } catch (e) {
      conv.warn(`Page ${i + 1} failed (${e instanceof Error ? e.message : String(e)}); blank page inserted`);
      while (doc.getPageCount() > i + 1) doc.removePage(doc.getPageCount() - 1);
      if (doc.getPageCount() < i + 1) {
        const p = doc.addPage([612, 792]);
        conv.pageRefs[i] = p.ref;
      } else {
        const p = doc.getPage(i);
        p.node.set(PDFName.of('Contents'), PDFArray.withContext(doc.context));
      }
    }
    opts?.onProgress?.(i + 1, pages.length);
  }
  await conv.finalizeFonts();
  conv.finalizeLinks();
  const bytes = await doc.save({ useObjectStreams: true });
  const warnings = [...conv.warnings.entries()].map(([m, n]) => (n > 1 ? `${m} (x${n})` : m));
  return { bytes, pages: doc.getPageCount(), warnings };
}
