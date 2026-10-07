/**
 * The objects in effect in a revision of a PDF, found the way viewers find
 * them: from the revision's startxref through its cross-reference sections
 * (tables and streams, /XRefStm and /Prev). pdf-lib instead parses every
 * object in file order and keeps the last copy, which an incremental update
 * can exploit (the real change, then an unreferenced copy of the original
 * object). Signature verification compares revisions through these views.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from 'pdf-lib';

export type XrefEntry = { kind: 'n'; offset: number; gen: number } | { kind: 'c'; stream: number; index: number } | { kind: 'f' };

export interface RevisionView {
  /** End of the revision (exclusive). */
  end: number;
  context: PDFContext;
  catalog: PDFDict;
  rootRef: PDFRef | null;
  /** Objects in effect, by object number. */
  entries: Map<number, XrefEntry>;
  /** Byte offsets every cross-reference section of the chain names (older copies too), and the sections themselves. */
  knownOffsets: Set<number>;
  /** Object number -> [start, end) of its definition in the file (uncompressed objects in effect). */
  spans: Map<number, [number, number]>;
  /** Inconsistencies (cross-reference entries pointing at other objects…). */
  problems: string[];
}

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => isWs(c) || c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0x25;

function skipWs(b: Uint8Array, p: number): number {
  for (;;) {
    while (p < b.length && isWs(b[p])) p++;
    if (b[p] !== 0x25) return p; // % comment
    while (p < b.length && b[p] !== 0x0a && b[p] !== 0x0d) p++;
  }
}

function token(b: Uint8Array, p: number): { tok: string; end: number } {
  p = skipWs(b, p);
  let e = p;
  while (e < b.length && !isDelim(b[e])) e++;
  let tok = '';
  for (let i = p; i < e; i++) tok += String.fromCharCode(b[i]);
  return { tok, end: e };
}

function lastIndexOfAscii(b: Uint8Array, s: string, before: number): number {
  outer: for (let i = Math.min(before, b.length) - s.length; i >= 0; i--) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** The startxref offset of the revision ending at `end`. */
export function startxrefBefore(b: Uint8Array, end: number): number {
  const at = lastIndexOfAscii(b, 'startxref', end);
  if (at < 0) throw new Error('No startxref.');
  const t = token(b, at + 9);
  if (!/^\d+$/.test(t.tok)) throw new Error('Malformed startxref.');
  return Number(t.tok);
}

/** Byte positions where a revision ends (after %%EOF and its end-of-line). */
export function isRevisionEnd(b: Uint8Array, end: number): boolean {
  let p = end;
  if (p > 0 && b[p - 1] === 0x0a) p--;
  if (p > 0 && b[p - 1] === 0x0d) p--;
  if (p < 5) return false;
  return b[p - 5] === 0x25 && b[p - 4] === 0x25 && b[p - 3] === 0x45 && b[p - 2] === 0x4f && b[p - 1] === 0x46;
}

type Parsed = { obj: PDFObject; end: number };

function parserOffset(p: PDFObjectParser): number {
  return (p as unknown as { bytes: { offset(): number } }).bytes.offset();
}

/** Parses "N G obj … endobj" at `offset`. */
function parseIndirect(b: Uint8Array, offset: number, ctx: PDFContext): Parsed & { num: number; gen: number } {
  const n = token(b, offset);
  const g = token(b, n.end);
  const k = token(b, g.end);
  if (!/^\d+$/.test(n.tok) || !/^\d+$/.test(g.tok) || k.tok !== 'obj') throw new Error(`No object at offset ${offset}.`);
  const body = skipWs(b, k.end);
  const parser = PDFObjectParser.forBytes(b.subarray(body), ctx);
  const obj = parser.parseObject();
  let end = body + parserOffset(parser);
  const e = token(b, end);
  if (e.tok === 'endobj') end = e.end;
  return { obj, end, num: Number(n.tok), gen: Number(g.tok) };
}

interface Section {
  entries: Array<[number, XrefEntry]>;
  trailer: PDFDict;
}

function parseTable(b: Uint8Array, offset: number, ctx: PDFContext): Section {
  let p = token(b, offset).end; // "xref"
  const entries: Array<[number, XrefEntry]> = [];
  for (;;) {
    const first = token(b, p);
    if (first.tok === 'trailer') {
      p = first.end;
      break;
    }
    const count = token(b, first.end);
    if (!/^\d+$/.test(first.tok) || !/^\d+$/.test(count.tok)) throw new Error('Malformed cross-reference table.');
    p = count.end;
    const start = Number(first.tok);
    const n = Number(count.tok);
    if (n > 10_000_000) throw new Error('Cross-reference table too large.');
    for (let i = 0; i < n; i++) {
      const off = token(b, p);
      const gen = token(b, off.end);
      const type = token(b, gen.end);
      p = type.end;
      if (type.tok === 'n') entries.push([start + i, { kind: 'n', offset: Number(off.tok), gen: Number(gen.tok) }]);
      else if (type.tok === 'f') entries.push([start + i, { kind: 'f' }]);
      else throw new Error('Malformed cross-reference entry.');
    }
  }
  const trailer = PDFObjectParser.forBytes(b.subarray(skipWs(b, p)), ctx).parseObject();
  if (!(trailer instanceof PDFDict)) throw new Error('Missing trailer dictionary.');
  return { entries, trailer };
}

function parseXrefStream(b: Uint8Array, offset: number, ctx: PDFContext): Section {
  const { obj } = parseIndirect(b, offset, ctx);
  if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Type')) !== PDFName.of('XRef')) throw new Error('No cross-reference stream at the startxref offset.');
  const data = decodePDFRawStream(obj).decode();
  const num = (v: unknown) => (v instanceof PDFNumber ? v.asNumber() : 0);
  const wArr = obj.dict.get(PDFName.of('W'));
  if (!(wArr instanceof PDFArray) || wArr.size() !== 3) throw new Error('Malformed cross-reference stream.');
  const w = [0, 1, 2].map((i) => num(wArr.get(i)));
  const idxArr = obj.dict.get(PDFName.of('Index'));
  const index = idxArr instanceof PDFArray ? idxArr.asArray().map(num) : [0, num(obj.dict.get(PDFName.of('Size')))];
  const entries: Array<[number, XrefEntry]> = [];
  const read = (p: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + data[p + i];
    return v;
  };
  let p = 0;
  const row = w[0] + w[1] + w[2];
  for (let s = 0; s + 1 < index.length; s += 2) {
    for (let i = 0; i < index[s + 1]; i++) {
      if (p + row > data.length) throw new Error('Cross-reference stream is truncated.');
      const type = w[0] ? read(p, w[0]) : 1;
      const f2 = read(p + w[0], w[1]);
      const f3 = read(p + w[0] + w[1], w[2]);
      p += row;
      const n = index[s] + i;
      if (type === 1) entries.push([n, { kind: 'n', offset: f2, gen: f3 }]);
      else if (type === 2) entries.push([n, { kind: 'c', stream: f2, index: f3 }]);
      else if (type === 0) entries.push([n, { kind: 'f' }]);
    }
  }
  return { entries, trailer: obj.dict };
}

function parseSection(b: Uint8Array, offset: number, ctx: PDFContext): Section {
  if (offset < 0 || offset >= b.length) throw new Error('Cross-reference offset outside the file.');
  return token(b, offset).tok === 'xref' ? parseTable(b, offset, ctx) : parseXrefStream(b, offset, ctx);
}

/**
 * Loads the revision that ends at `end` (default: the whole file): follows
 * the cross-reference chain from its startxref and parses exactly the
 * objects it names. Throws when the chain cannot be read.
 */
export function loadRevision(bytes: Uint8Array, end = bytes.length): RevisionView {
  const ctx = PDFContext.create();
  const entries = new Map<number, XrefEntry>();
  const knownOffsets = new Set<number>();
  const problems: string[] = [];
  let trailer: PDFDict | null = null;
  const queue = [startxrefBefore(bytes, end)];
  const visited = new Set<number>();
  while (queue.length) {
    const off = queue.shift()!;
    if (visited.has(off)) {
      problems.push('The cross-reference sections form a loop.');
      break;
    }
    if (visited.size > 1000) throw new Error('Too many cross-reference sections.');
    visited.add(off);
    knownOffsets.add(off).add(skipWs(bytes, off));
    const sec = parseSection(bytes, off, ctx);
    trailer ??= sec.trailer;
    const merged = new Map<number, XrefEntry>(sec.entries);
    // Hybrid file: the stream supplies what the table leaves free.
    const stm = sec.trailer.get(PDFName.of('XRefStm'));
    if (stm instanceof PDFNumber && !visited.has(stm.asNumber())) {
      visited.add(stm.asNumber());
      knownOffsets.add(stm.asNumber());
      for (const [n, e] of parseXrefStream(bytes, stm.asNumber(), ctx).entries) {
        const t = merged.get(n);
        if (!t || t.kind === 'f') merged.set(n, e);
      }
    }
    for (const [n, e] of merged) {
      if (e.kind === 'n') knownOffsets.add(e.offset).add(skipWs(bytes, e.offset));
      if (!entries.has(n)) entries.set(n, e);
    }
    const prev = sec.trailer.get(PDFName.of('Prev'));
    if (prev instanceof PDFNumber) queue.push(prev.asNumber());
  }
  if (!trailer) throw new Error('No trailer.');

  const spans = new Map<number, [number, number]>();
  const objStreams = new Map<number, Array<[number, number]>>();
  for (const [n, e] of entries) {
    if (e.kind === 'n') {
      try {
        const p = parseIndirect(bytes, e.offset, ctx);
        if (p.num !== n || p.gen !== e.gen) {
          problems.push(`The cross-reference entry of object ${n} points at object ${p.num}.`);
          continue;
        }
        ctx.assign(PDFRef.of(n, e.gen), p.obj);
        spans.set(n, [e.offset, p.end]);
      } catch {
        problems.push(`Object ${n} could not be read.`);
      }
    } else if (e.kind === 'c') {
      const list = objStreams.get(e.stream) ?? [];
      list.push([n, e.index]);
      objStreams.set(e.stream, list);
    }
  }
  for (const [sn, wanted] of objStreams) {
    try {
      const se = entries.get(sn);
      const stream = se?.kind === 'n' ? ctx.lookup(PDFRef.of(sn, se.gen)) : undefined;
      if (!(stream instanceof PDFRawStream)) throw new Error('missing');
      const data = decodePDFRawStream(stream).decode();
      const count = (stream.dict.get(PDFName.of('N')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const first = (stream.dict.get(PDFName.of('First')) as PDFNumber | undefined)?.asNumber() ?? 0;
      const header: Array<[number, number]> = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        const a = token(data, p);
        const o = token(data, a.end);
        p = o.end;
        header.push([Number(a.tok), Number(o.tok)]);
      }
      for (const [n, i] of wanted) {
        const h = header[i];
        if (!h || h[0] !== n) {
          problems.push(`The cross-reference entry of object ${n} points at another object in its object stream.`);
          continue;
        }
        const obj = PDFObjectParser.forBytes(data.subarray(first + h[1]), ctx).parseObject();
        ctx.assign(PDFRef.of(n, 0), obj);
      }
    } catch {
      problems.push(`Object stream ${sn} could not be read.`);
    }
  }

  const root = trailer.get(PDFName.of('Root'));
  const rootRef = root instanceof PDFRef ? root : null;
  const catalog = rootRef ? ctx.lookup(rootRef) : undefined;
  if (!(catalog instanceof PDFDict)) throw new Error('The document catalog is missing.');
  ctx.trailerInfo.Root = rootRef ?? undefined;
  return { end, context: ctx, catalog, rootRef, entries, knownOffsets, spans, problems };
}

/**
 * Object headers ("N G obj") in bytes [from, view.end) that no cross-reference
 * section of the chain names: copies a viewer ignores but a last-copy-wins
 * parser would take. Headers inside named objects (stream data) are skipped.
 */
export function unreferencedObjects(bytes: Uint8Array, from: number, view: RevisionView): number[] {
  const ctx = PDFContext.create();
  const spans: Array<[number, number]> = [];
  for (const off of view.knownOffsets) {
    if (off < from || off >= view.end) continue;
    try {
      spans.push([off, parseIndirect(bytes, off, ctx).end]);
    } catch {
      /* a cross-reference table, or unreadable */
    }
  }
  const inside = (p: number) => spans.some(([s, e]) => p > s && p < e);
  const text = new TextDecoder('latin1').decode(bytes.subarray(from, view.end));
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![0-9])(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+obj(?![A-Za-z])/g)) {
    const p = from + m.index!;
    if (view.knownOffsets.has(p) || inside(p)) continue;
    out.push(p);
  }
  return out;
}
