/**
 * A light walker over a content stream that tracks marked content: every
 * painting operation (text, paths, images, shadings, Form XObjects) with its
 * box in user space, the marked-content id (MCID) it belongs to and whether
 * it is inside an Artifact. Used by the PDF/UA checker (untagged content,
 * artifacts inside tagged content) and the reading-order editor (boxes of
 * tagged items, wrapping untagged content into new sequences). Pure (pdf-lib).
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFDocument, type PDFPage } from 'pdf-lib';
import { pageContent, parseContent, resourcesOf, shownText, type Box, type Instr, type ShownText } from './textRemoval';

export type PaintKind = 'text' | 'path' | 'image' | 'shading' | 'form';

export interface PaintOp {
  /** Instruction index. */
  instr: number;
  kind: PaintKind;
  box: Box | null;
  /** Nearest enclosing marked-content id (null: none). */
  mcid: number | null;
  /** Inside an /Artifact sequence. */
  artifact: boolean;
  /** Text: its Unicode text (when the font can be read) and font resource name. */
  text?: string;
  font?: string;
  /** Text rendering mode 3 (e.g. the OCR layer of a scan). */
  invisible?: boolean;
  /** Form XObject: its resource name; it carries tags of its own / is all artifact. */
  name?: string;
  formTagged?: boolean;
  formArtifact?: boolean;
}

/** A marked-content sequence (BMC / BDC … EMC). */
export interface McSeq {
  /** Instruction of the BMC / BDC and of its EMC (-1 when never closed). */
  open: number;
  close: number;
  tag: string;
  mcid: number | null;
  /** Some enclosing sequence has an MCID / is an Artifact. */
  inTagged: boolean;
  inArtifact: boolean;
}

export interface ContentWalk {
  src: Uint8Array;
  instrs: Instr[];
  ops: PaintOp[];
  seqs: McSeq[];
  /** Depth before each instruction (n + 1 entries): q/Q, marked content, BT/ET. */
  qd: Int32Array;
  md: Int32Array;
  bd: Int32Array;
  /** Font resource names used by text, and whether any of it is visible. */
  fonts: Map<string, boolean>;
}

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
const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const boxOfPts = (pts: Array<[number, number]>): Box | null => {
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const boxOf = (m: M, x0: number, y0: number, x1: number, y1: number) => boxOfPts([apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)])!;
const num = (v: unknown, d = 0) => (v instanceof PDFNumber ? v.asNumber() : d);

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const latin1 = new TextDecoder('latin1');

function deref(doc: PDFDocument, v: unknown): unknown {
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

/** The MCID of a BDC (inline properties or a named /Properties entry). */
function mcidOf(ins: Instr, src: Uint8Array, props: unknown, doc: PDFDocument): number | null {
  if (ins.op !== 'BDC') return null;
  const a = ins.args;
  if (a[1]?.k === 'name') {
    const p = props instanceof PDFDict ? deref(doc, props.get(PDFName.of(a[1].v))) : undefined;
    if (p instanceof PDFDict) {
      const id = p.lookup(PDFName.of('MCID'));
      return id instanceof PDFNumber ? id.asNumber() : null;
    }
    return null;
  }
  const m = /\/MCID\s+(\d+)/.exec(latin1.decode(src.subarray(ins.start, ins.end)));
  return m ? Number(m[1]) : null;
}

/** Whether a Form XObject's own content has tags (MCIDs) or is entirely artifact. */
function formMarks(s: PDFRawStream): { tagged: boolean; artifact: boolean } {
  try {
    const src = decodePDFRawStream(s).decode();
    const raw = latin1.decode(src);
    if (s.dict.has(PDFName.of('StructParents')) || /\/MCID\s+\d+/.test(raw)) return { tagged: true, artifact: false };
    const ins = parseContent(src);
    const stack: string[] = [];
    let paints = 0;
    let outside = 0;
    for (const i of ins) {
      if (i.op === 'BMC' || i.op === 'BDC') stack.push(i.args[0]?.k === 'name' ? i.args[0].v : '');
      else if (i.op === 'EMC') stack.pop();
      else if (PATH_PAINT.has(i.op) || i.op === 'Tj' || i.op === 'TJ' || i.op === "'" || i.op === '"' || i.op === 'Do' || i.op === 'sh' || i.op === 'BI') {
        paints++;
        if (!stack.includes('Artifact')) outside++;
      }
    }
    return { tagged: false, artifact: paints > 0 && outside === 0 };
  } catch {
    return { tagged: false, artifact: false };
  }
}

export function walkContent(doc: PDFDocument, src: Uint8Array, resources: PDFDict | undefined, shown?: Map<number, ShownText>): ContentWalk {
  const instrs = parseContent(src);
  const n = instrs.length;
  const fontDict = resources?.lookup(PDFName.of('Font'));
  const xobjDict = resources?.lookup(PDFName.of('XObject'));
  const props = resources?.lookup(PDFName.of('Properties'));
  const qd = new Int32Array(n + 1);
  const md = new Int32Array(n + 1);
  const bd = new Int32Array(n + 1);
  const ops: PaintOp[] = [];
  const seqs: McSeq[] = [];
  const open: number[] = [];
  const fonts = new Map<string, boolean>();
  const formCache = new Map<string, { tagged: boolean; artifact: boolean }>();

  let ctm: M = I;
  const stack: Array<{ ctm: M; fs: number; font: string; Tr: number; TL: number }> = [];
  let fs = 0;
  let font = '';
  let Tr = 0;
  let TL = 0;
  let Tm: M = I;
  let Tlm: M = I;
  let path: Array<[number, number]> = [];
  let q = 0;
  let bt = 0;

  const state = () => {
    let mcid: number | null = null;
    let artifact = false;
    for (let k = open.length - 1; k >= 0; k--) {
      const s = seqs[open[k]];
      if (mcid === null && s.mcid !== null) mcid = s.mcid;
      if (s.tag === 'Artifact') artifact = true;
    }
    return { mcid, artifact };
  };
  const push = (op: Omit<PaintOp, 'mcid' | 'artifact'>) => ops.push({ ...op, ...state() });
  const estimateText = (k: number): Box | null => {
    const ins = instrs[k];
    let len = 0;
    for (const a of ins.args) len += a.k === 's' ? a.v.length : a.k === 'a' ? a.v.reduce((s, x) => s + (x.k === 's' ? x.v.length : 0), 0) : 0;
    const f = fontDict instanceof PDFDict ? deref(doc, fontDict.get(PDFName.of(font))) : undefined;
    const two = f instanceof PDFDict && f.lookup(PDFName.of('Subtype')) === PDFName.of('Type0');
    const w = (two ? len / 2 : len) * 0.5;
    if (!fs) return null;
    return boxOf(mul(mul([fs, 0, 0, fs, 0, 0], Tm), ctm), 0, -0.2, Math.max(w, 0.1), 0.8);
  };

  for (let k = 0; k < n; k++) {
    qd[k] = q;
    md[k] = open.length;
    bd[k] = bt;
    const ins = instrs[k];
    const a = ins.args;
    const v = a.map((x) => (x.k === 'n' ? x.v : 0));
    switch (ins.op) {
      case 'q':
        stack.push({ ctm, fs, font, Tr, TL });
        q++;
        break;
      case 'Q': {
        const g = stack.pop();
        if (g) ({ ctm, fs, font, Tr, TL } = g);
        q = Math.max(0, q - 1);
        break;
      }
      case 'cm':
        if (v.length === 6) ctm = mul(v as M, ctm);
        break;
      case 'BT':
        bt++;
        Tm = Tlm = I;
        break;
      case 'ET':
        bt = Math.max(0, bt - 1);
        break;
      case 'Tf':
        font = a[0]?.k === 'name' ? a[0].v : '';
        fs = v[1] ?? 0;
        break;
      case 'Tr':
        Tr = v[0] ?? 0;
        break;
      case 'TL':
        TL = v[0] ?? 0;
        break;
      case 'Td':
      case 'TD':
        if (ins.op === 'TD') TL = -(v[1] ?? 0);
        Tm = Tlm = mul([1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0], Tlm);
        break;
      case 'Tm':
        if (v.length === 6) Tm = Tlm = v as M;
        break;
      case 'T*':
        Tm = Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm);
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (ins.op === "'" || ins.op === '"') Tm = Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm);
        const st = shown?.get(k);
        const invisible = (st?.mode ?? Tr) === 3;
        if (font) fonts.set(font, (fonts.get(font) ?? false) || !invisible);
        push({ instr: k, kind: 'text', box: st?.box ?? estimateText(k), text: st?.text ?? '', font, invisible });
        break;
      }
      case 'm':
      case 'l':
        path.push(apply(ctm, v[0] ?? 0, v[1] ?? 0));
        break;
      case 'c':
      case 'v':
      case 'y':
        for (let j = 0; j + 1 < v.length; j += 2) path.push(apply(ctm, v[j], v[j + 1]));
        break;
      case 're': {
        const [x, y, w, h] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0];
        path.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h));
        break;
      }
      case 'n':
        path = [];
        break;
      case 'sh':
        push({ instr: k, kind: 'shading', box: null });
        break;
      case 'BI':
        push({ instr: k, kind: 'image', box: boxOf(ctm, 0, 0, 1, 1) });
        break;
      case 'Do': {
        const name = a[0]?.k === 'name' ? a[0].v : '';
        const xo = xobjDict instanceof PDFDict ? deref(doc, xobjDict.get(PDFName.of(name))) : undefined;
        if (!(xo instanceof PDFStream)) break;
        const st = xo.dict.lookup(PDFName.of('Subtype'));
        if (st === PDFName.of('Image')) push({ instr: k, kind: 'image', box: boxOf(ctm, 0, 0, 1, 1), name });
        else if (st === PDFName.of('Form')) {
          const bb = xo.dict.lookup(PDFName.of('BBox'));
          const mx = xo.dict.lookup(PDFName.of('Matrix'));
          const fm: M = mx instanceof PDFArray && mx.size() === 6 ? (Array.from({ length: 6 }, (_, j) => num(mx.lookup(j))) as M) : I;
          const b = bb instanceof PDFArray && bb.size() === 4 ? Array.from({ length: 4 }, (_, j) => num(bb.lookup(j))) : null;
          let fm2 = formCache.get(name);
          if (!fm2) {
            fm2 = xo instanceof PDFRawStream ? formMarks(xo) : { tagged: false, artifact: false };
            formCache.set(name, fm2);
          }
          push({ instr: k, kind: 'form', box: b ? boxOf(mul(fm, ctm), b[0], b[1], b[2], b[3]) : null, name, formTagged: fm2.tagged, formArtifact: fm2.artifact });
        }
        break;
      }
      case 'BMC':
      case 'BDC': {
        const tag = a[0]?.k === 'name' ? a[0].v : '';
        const outer = state();
        const inTagged = outer.mcid !== null;
        seqs.push({ open: k, close: -1, tag, mcid: mcidOf(ins, src, props, doc), inTagged, inArtifact: outer.artifact });
        open.push(seqs.length - 1);
        break;
      }
      case 'EMC': {
        const s = open.pop();
        if (s !== undefined) seqs[s].close = k;
        break;
      }
      default:
        if (PATH_PAINT.has(ins.op)) {
          push({ instr: k, kind: 'path', box: boxOfPts(path) });
          path = [];
        }
    }
  }
  qd[n] = q;
  md[n] = open.length;
  bd[n] = bt;
  return { src, instrs, ops, seqs, qd, md, bd, fonts };
}

const pageCache = new WeakMap<PDFPage, ContentWalk>();

/** The page's content walked (cached per page object; call `forgetWalk` after rewriting the content). */
export function walkPage(doc: PDFDocument, page: PDFPage): ContentWalk {
  const hit = pageCache.get(page);
  if (hit) return hit;
  const w = walkContent(doc, pageContent(doc, page), resourcesOf(page), shownText(doc, page));
  pageCache.set(page, w);
  return w;
}

export function forgetWalk(page: PDFPage): void {
  pageCache.delete(page);
}

/** Content that is neither tagged (inside an MCID) nor an artifact. */
export function isUntagged(op: PaintOp): boolean {
  if (op.mcid !== null || op.artifact) return false;
  if (op.kind === 'form' && (op.formTagged || op.formArtifact)) return false;
  return true;
}

/** Boxes and text of each MCID on the page. */
export function mcidContent(w: ContentWalk): Map<number, { box: Box | null; text: string; kinds: Set<PaintKind> }> {
  const out = new Map<number, { box: Box | null; text: string; kinds: Set<PaintKind> }>();
  for (const s of w.seqs) if (s.mcid !== null && !out.has(s.mcid)) out.set(s.mcid, { box: null, text: '', kinds: new Set() });
  for (const op of w.ops) {
    if (op.mcid === null) continue;
    const c = out.get(op.mcid)!;
    c.box = unionBox(c.box, op.box);
    if (op.text) c.text += op.text;
    c.kinds.add(op.kind);
  }
  return out;
}

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*']);
const isPaintOp = (op: string) => PATH_PAINT.has(op) || op === 'Tj' || op === 'TJ' || op === "'" || op === '"' || op === 'Do' || op === 'sh' || op === 'BI';

/**
 * Instruction ranges [first, lastExclusive) around the given painting
 * operations that can be wrapped in a marked-content sequence: each keeps the
 * q/Q, marked-content and BT/ET depths, never splits a path object and holds
 * no other painting. Neighbouring operations share a range when they can.
 */
export function wrappableRanges(w: ContentWalk, ops: PaintOp[]): Array<[number, number]> {
  const n = w.instrs.length;
  const want = new Set(ops.map((o) => o.instr));
  // Inside a path object before instruction k (between its construction and its painting).
  const inPath = new Uint8Array(n + 1);
  let open = false;
  for (let k = 0; k < n; k++) {
    inPath[k] = open ? 1 : 0;
    const op = w.instrs[k].op;
    if (op === 'm' || op === 're') open = true;
    else if (PATH_PAINT.has(op) || op === 'n') open = false;
  }
  const out: Array<[number, number]> = [];
  const covered = new Set<number>();
  for (const p of [...want].sort((x, y) => x - y)) {
    if (covered.has(p)) continue;
    let a = p;
    if (PATH_PAINT.has(w.instrs[p].op)) while (a > 0 && PATH_BUILD.has(w.instrs[a - 1].op)) a--;
    if (w.bd[p] > 0) {
      // A whole text object of wanted text starts at its BT.
      let t = p;
      while (t > 0 && !(w.instrs[t].op === 'BT' && w.bd[t] === w.bd[p] - 1)) t--;
      let et = t + 1;
      while (et < n && !(w.instrs[et].op === 'ET' && w.bd[et + 1] === w.bd[t])) et++;
      let ok = w.instrs[t].op === 'BT';
      for (let k = t; ok && k <= Math.min(et, n - 1); k++) if (isPaintOp(w.instrs[k].op) && !want.has(k)) ok = false;
      for (let k = t; ok && k <= p; k++) if (w.md[k] !== w.md[t] || w.qd[k] !== w.qd[t]) ok = false;
      if (ok) a = t;
    }
    let best = -1;
    for (let e = a; e < n; e++) {
      const op = w.instrs[e].op;
      if (isPaintOp(op) && !want.has(e)) break;
      if (w.qd[e + 1] < w.qd[a] || w.md[e + 1] < w.md[a] || w.bd[e + 1] < w.bd[a]) break;
      if (e >= p && w.qd[e + 1] === w.qd[a] && w.md[e + 1] === w.md[a] && w.bd[e + 1] === w.bd[a] && !inPath[e + 1]) best = e + 1;
    }
    if (best > a) {
      out.push([a, best]);
      for (let k = a; k < best; k++) if (want.has(k)) covered.add(k);
    }
  }
  return out;
}

/** Inserts text at byte offsets of the source (stable for equal offsets: `order` first). */
export function spliceContent(src: Uint8Array, edits: Array<{ at: number; text: string; order?: number; end?: number }>): Uint8Array {
  const enc = new TextEncoder();
  const list = [...edits].sort((x, y) => x.at - y.at || (x.order ?? 0) - (y.order ?? 0));
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const e of list) {
    if (e.at < pos) continue;
    parts.push(src.subarray(pos, e.at), enc.encode(e.text));
    pos = e.end ?? e.at;
  }
  parts.push(src.subarray(pos));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Replaces the page's content with one new stream. */
export function setPageContent(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
  forgetWalk(page);
}
