/**
 * Damaged-PDF recovery ("repair"), in the spirit of MuPDF's / Foxit's repair mode.
 *
 * pdf.js already rebuilds a broken cross-reference table by itself, so this
 * module is only meant for files pdf.js still refuses (or opens with missing
 * pages): truncated downloads, a lost catalog / page tree, object streams that
 * pdf.js cannot reach, garbage spliced into the file, and so on.
 *
 * How it works — no xref or trailer is trusted:
 *  1. Scan the raw bytes for every `N G obj` header and parse each object on
 *     its own, bounded by the next header (missing `endobj`, CR/LF variants,
 *     garbage between objects and a truncated last object are all tolerated).
 *     Complete object streams (`/Type /ObjStm`) are expanded. When an object
 *     number occurs more than once, the copy furthest into the file wins
 *     (incremental-update semantics).
 *  2. Every `/Type /Page` dict (or an untyped dict with /Contents + /MediaBox)
 *     is a recovered page. If the original page tree is still reachable its
 *     order is kept, otherwise pages go in object-number order.
 *  3. A fresh /Pages root and /Catalog are built, inherited attributes are
 *     copied down onto each page, dangling content streams are dropped, and the
 *     result is serialised with pdf-lib's writer (classic xref, no object streams).
 *
 * Browser-compatible: only pdf-lib and plain typed arrays, no Node APIs.
 */
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFWriter,
  decodePDFRawStream,
} from 'pdf-lib';

export interface RepairResult {
  /** The rebuilt PDF. */
  bytes: Uint8Array;
  /** Number of pages in the rebuilt document. */
  pagesRecovered: number;
  /** Human-readable lines for the UI. */
  notes: string[];
}

/** Largest object number allowed by the PDF spec (ISO 32000, Annex C). */
const MAX_OBJECT_NUMBER = 8_388_607;
/** Hard cap on indirect-object headers considered, so pathological inputs stay bounded. */
const MAX_OBJECTS = 2_000_000;
/** Cap on objects taken from one object stream. */
const MAX_OBJSTM_OBJECTS = 100_000;
/** How far after `trailer` we look for its dictionary. */
const TRAILER_WINDOW = 64 * 1024;
/** Depth limit when walking /Parent chains or page trees. */
const MAX_TREE_DEPTH = 256;
/** Default MediaBox (A4 portrait, in points). */
const A4: [number, number, number, number] = [0, 0, 595.28, 841.89];

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
/** Catalog entries carried over from a surviving original catalog. */
const CATALOG_KEYS = [
  'Outlines',
  'Names',
  'Dests',
  'AcroForm',
  'PageLabels',
  'ViewerPreferences',
  'PageMode',
  'PageLayout',
  'Lang',
  'Metadata',
  'OCProperties',
  'MarkInfo',
] as const;

const N = (s: string): PDFName => PDFName.of(s);

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function isWhite(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
}
function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}
function isDelimiter(b: number): boolean {
  // ( ) < > [ ] { } / %
  return (
    b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b ||
    b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25
  );
}

/** True when the bytes carry a `%PDF-` signature within the first 1024 bytes. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= end; i++) {
    if (
      bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

interface ObjHeader {
  num: number;
  gen: number;
  /** Offset of the first digit of the object number. */
  start: number;
  /** Offset just after the `obj` keyword. */
  body: number;
}

interface Scan {
  headers: ObjHeader[];
  /** Offsets just after each `trailer` keyword. */
  trailers: number[];
}

/**
 * One linear pass over the file collecting `N G obj` headers and `trailer`
 * keywords. Walks backwards from each `obj` so `endobj` never matches.
 */
function scanFile(bytes: Uint8Array): Scan {
  const headers: ObjHeader[] = [];
  const trailers: number[] = [];
  const len = bytes.length;
  for (let i = 0; i + 2 < len; i++) {
    const b = bytes[i];
    if (b === 0x6f /* o */) {
      if (bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue;
      const after = i + 3 < len ? bytes[i + 3] : 0x20;
      if (!isWhite(after) && !isDelimiter(after)) continue;
      const h = headerBefore(bytes, i);
      if (h) {
        headers.push({ ...h, body: i + 3 });
        if (headers.length >= MAX_OBJECTS) break;
      }
    } else if (b === 0x74 /* t */) {
      if (
        i + 6 < len && bytes[i + 1] === 0x72 && bytes[i + 2] === 0x61 && bytes[i + 3] === 0x69 &&
        bytes[i + 4] === 0x6c && bytes[i + 5] === 0x65 && bytes[i + 6] === 0x72 &&
        (i === 0 || !isRegularLetter(bytes[i - 1]))
      ) {
        trailers.push(i + 7);
      }
    }
  }
  return { headers, trailers };
}

function isRegularLetter(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/** Parse `<num> <ws> <gen> <ws>* obj` backwards from the `obj` keyword at `objAt`. */
function headerBefore(bytes: Uint8Array, objAt: number): { num: number; gen: number; start: number } | null {
  let p = objAt - 1;
  while (p >= 0 && isWhite(bytes[p]) && objAt - p < 32) p--;
  const genEnd = p + 1;
  while (p >= 0 && isDigit(bytes[p]) && genEnd - p <= 5) p--;
  const genStart = p + 1;
  if (genStart === genEnd || (p >= 0 && isDigit(bytes[p]))) return null;
  if (p < 0 || !isWhite(bytes[p])) return null;
  while (p >= 0 && isWhite(bytes[p]) && genStart - p < 32) p--;
  const numEnd = p + 1;
  while (p >= 0 && isDigit(bytes[p]) && numEnd - p <= 7) p--;
  const numStart = p + 1;
  if (numStart === numEnd || (p >= 0 && isDigit(bytes[p]))) return null;
  // Anything but a regular letter may precede the number (newline, `>`, garbage…).
  if (p >= 0 && isRegularLetter(bytes[p])) return null;
  const num = readInt(bytes, numStart, numEnd);
  const gen = readInt(bytes, genStart, genEnd);
  if (num <= 0 || num > MAX_OBJECT_NUMBER || gen > 65535) return null;
  return { num, gen, start: numStart };
}

function readInt(bytes: Uint8Array, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 10 + (bytes[i] - 0x30);
  return v;
}

// ---------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------

/**
 * pdf-lib's PDFObjectParser keeps its byte stream protected; we only need the
 * current offset after a parse to know where an object ended.
 */
interface ParserWithOffset {
  parseObject(): PDFObject;
  bytes: { offset(): number };
}

function makeParser(bytes: Uint8Array, context: PDFContext): ParserWithOffset {
  // Narrow cast: expose the protected `bytes` ByteStream (see ParserWithOffset).
  return PDFObjectParser.forBytes(bytes, context, true) as unknown as ParserWithOffset;
}

interface Parsed {
  obj: PDFObject;
  /** Absolute offset where the parse stopped. */
  end: number;
}

type ParseOutcome = { ok: true; value: Parsed } | { ok: false; truncatedStream: boolean };

function parseAt(bytes: Uint8Array, from: number, to: number, context: PDFContext): ParseOutcome {
  const parser = makeParser(bytes.subarray(from, to), context);
  try {
    const obj = parser.parseObject();
    return { ok: true, value: { obj, end: from + parser.bytes.offset() } };
  } catch {
    return { ok: false, truncatedStream: hasStreamKeyword(bytes, from, to) };
  }
}

/** Does `stream` occur in the range (i.e. did we probably fail inside stream data)? */
function hasStreamKeyword(bytes: Uint8Array, from: number, to: number): boolean {
  const limit = Math.min(to, from + 64 * 1024) - 6;
  for (let i = from; i <= limit; i++) {
    if (
      bytes[i] === 0x73 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x72 &&
      bytes[i + 3] === 0x65 && bytes[i + 4] === 0x61 && bytes[i + 5] === 0x6d
    ) {
      return true;
    }
  }
  return false;
}

function directLength(obj: PDFObject): number | undefined {
  if (!(obj instanceof PDFRawStream)) return undefined;
  const len = obj.dict.get(N('Length'));
  return len instanceof PDFNumber ? len.asNumber() : undefined;
}

interface Entry {
  gen: number;
  offset: number;
  obj: PDFObject;
}

interface Collected {
  entries: Map<number, Entry>;
  damaged: number;
  truncatedStreams: number;
  objStmExpanded: number;
  objStmLost: number;
}

function firstHeaderAtOrAfter(headers: ObjHeader[], pos: number, fromIdx: number): number {
  let lo = fromIdx;
  let hi = headers.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (headers[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function collectObjects(bytes: Uint8Array, headers: ObjHeader[], context: PDFContext): Collected {
  const entries = new Map<number, Entry>();
  let damaged = 0;
  let truncatedStreams = 0;
  let consumedTo = 0;
  const objStms: { offset: number; stream: PDFRawStream }[] = [];

  const put = (num: number, e: Entry): void => {
    const prev = entries.get(num);
    if (!prev || prev.offset <= e.offset) entries.set(num, e);
  };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h.start < consumedTo) continue; // lies inside the previous object's stream data
    let segEnd = i + 1 < headers.length ? headers[i + 1].start : bytes.length;
    let outcome = parseAt(bytes, h.body, segEnd, context);

    // A header-like sequence inside stream data may have cut the segment short:
    // retry once with the declared /Length as the guide.
    const needsRetry =
      (!outcome.ok && outcome.truncatedStream && segEnd < bytes.length) ||
      (outcome.ok &&
        outcome.value.obj instanceof PDFRawStream &&
        (directLength(outcome.value.obj) ?? 0) > outcome.value.obj.contents.length &&
        segEnd < bytes.length);
    if (needsRetry) {
      const declared = peekDeclaredLength(bytes, h.body, segEnd, context);
      if (declared !== undefined && declared > 0) {
        const target = Math.min(bytes.length, h.body + declared);
        const j = firstHeaderAtOrAfter(headers, target, i + 1);
        const widerEnd = j < headers.length ? headers[j].start : bytes.length;
        if (widerEnd > segEnd) {
          const retry = parseAt(bytes, h.body, widerEnd, context);
          if (retry.ok) {
            outcome = retry;
            segEnd = widerEnd;
          }
        }
      }
    }

    if (!outcome.ok) {
      if (outcome.truncatedStream) truncatedStreams++;
      else damaged++;
      continue;
    }
    const { obj, end } = outcome.value;
    consumedTo = Math.max(consumedTo, Math.min(end, segEnd));
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.get(N('Type'));
      if (type === N('ObjStm')) {
        objStms.push({ offset: h.start, stream: obj });
        continue;
      }
    }
    put(h.num, { gen: h.gen, offset: h.start, obj });
  }

  let objStmExpanded = 0;
  let objStmLost = 0;
  for (const { offset, stream } of objStms) {
    const got = expandObjectStream(stream, context);
    if (got === null) {
      objStmLost++;
      continue;
    }
    objStmExpanded++;
    for (const [num, obj] of got) put(num, { gen: 0, offset, obj });
  }

  return { entries, damaged, truncatedStreams, objStmExpanded, objStmLost };
}

/** Reads a direct /Length out of a stream dict without needing the stream data. */
function peekDeclaredLength(bytes: Uint8Array, from: number, to: number, context: PDFContext): number | undefined {
  // Parse only the dictionary: cut the input right before `stream`.
  const limit = Math.min(to, from + 64 * 1024);
  for (let i = from; i + 6 <= limit; i++) {
    if (
      bytes[i] === 0x73 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x72 &&
      bytes[i + 3] === 0x65 && bytes[i + 4] === 0x61 && bytes[i + 5] === 0x6d
    ) {
      const r = parseAt(bytes, from, i, context);
      if (r.ok && r.value.obj instanceof PDFDict) {
        const len = r.value.obj.get(N('Length'));
        if (len instanceof PDFNumber) return len.asNumber() + (i - from) + 16;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Expands a complete object stream; returns null when it cannot be decoded at all. */
function expandObjectStream(stream: PDFRawStream, context: PDFContext): Map<number, PDFObject> | null {
  let data: Uint8Array;
  try {
    data = decodePDFRawStream(stream).decode();
  } catch {
    return null;
  }
  const first = stream.dict.get(N('First'));
  const count = stream.dict.get(N('N'));
  if (!(first instanceof PDFNumber) || !(count instanceof PDFNumber)) return null;
  const firstOffset = first.asNumber();
  const n = Math.min(count.asNumber(), MAX_OBJSTM_OBJECTS);
  if (firstOffset < 0 || firstOffset > data.length) return null;

  // Header: pairs of "objNum offset".
  const ints: number[] = [];
  let p = 0;
  while (ints.length < n * 2 && p < firstOffset) {
    while (p < firstOffset && !isDigit(data[p])) p++;
    const s = p;
    while (p < firstOffset && isDigit(data[p])) p++;
    if (p > s) ints.push(readInt(data, s, p));
  }
  const pairs: { num: number; off: number }[] = [];
  for (let k = 0; k + 1 < ints.length; k += 2) pairs.push({ num: ints[k], off: ints[k + 1] });

  const out = new Map<number, PDFObject>();
  for (let k = 0; k < pairs.length; k++) {
    const from = firstOffset + pairs[k].off;
    const to = k + 1 < pairs.length ? firstOffset + pairs[k + 1].off : data.length;
    if (from >= data.length || to <= from || pairs[k].num <= 0 || pairs[k].num > MAX_OBJECT_NUMBER) continue;
    const r = parseAt(data, from, to, context);
    if (r.ok) out.set(pairs[k].num, r.value.obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trailer / encryption
// ---------------------------------------------------------------------------

interface TrailerInfo {
  root?: PDFRef;
  info?: PDFRef;
  encrypted: boolean;
}

function readTrailers(bytes: Uint8Array, scan: Scan, collected: Collected, context: PDFContext): TrailerInfo {
  const found: { offset: number; dict: PDFDict }[] = [];
  for (const at of scan.trailers) {
    let p = at;
    while (p < bytes.length && isWhite(bytes[p])) p++;
    if (bytes[p] !== 0x3c || bytes[p + 1] !== 0x3c) continue;
    const r = parseAt(bytes, p, Math.min(bytes.length, p + TRAILER_WINDOW), context);
    if (r.ok && r.value.obj instanceof PDFDict) found.push({ offset: at, dict: r.value.obj });
  }
  for (const [, e] of collected.entries) {
    if (e.obj instanceof PDFRawStream && e.obj.dict.get(N('Type')) === N('XRef')) {
      found.push({ offset: e.offset, dict: e.obj.dict });
    }
  }
  found.sort((a, b) => a.offset - b.offset);

  const info: TrailerInfo = { encrypted: false };
  for (const { dict } of found) {
    const root = dict.get(N('Root'));
    const inf = dict.get(N('Info'));
    if (root instanceof PDFRef) info.root = root;
    if (inf instanceof PDFRef) info.info = inf;
    if (dict.get(N('Encrypt')) !== undefined) info.encrypted = true;
  }
  if (!info.encrypted) {
    // The trailer may be gone while the encryption dictionary survived.
    for (const [, e] of collected.entries) {
      if (
        e.obj instanceof PDFDict &&
        e.obj.get(N('Filter')) === N('Standard') &&
        e.obj.get(N('O')) !== undefined &&
        e.obj.get(N('U')) !== undefined
      ) {
        info.encrypted = true;
        break;
      }
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Page recovery
// ---------------------------------------------------------------------------

function typeOf(obj: PDFObject | undefined): PDFName | undefined {
  if (!(obj instanceof PDFDict)) return undefined;
  const t = obj.get(N('Type'));
  return t instanceof PDFName ? t : undefined;
}

function isPageDict(obj: PDFObject | undefined): obj is PDFDict {
  if (!(obj instanceof PDFDict)) return false;
  const t = typeOf(obj);
  if (t === N('Page')) return true;
  if (t === N('Pages') || obj.get(N('Kids')) !== undefined) return false;
  if (t !== undefined && t !== N('Page')) return false;
  return obj.get(N('Contents')) !== undefined && obj.get(N('MediaBox')) !== undefined;
}

function isPagesNode(obj: PDFObject | undefined): obj is PDFDict {
  return obj instanceof PDFDict && (typeOf(obj) === N('Pages') || (typeOf(obj) === undefined && obj.get(N('Kids')) instanceof PDFArray));
}

type Inherited = Partial<Record<(typeof INHERITABLE)[number], PDFObject>>;

function withInherited(node: PDFDict, parent: Inherited): Inherited {
  const out: Inherited = { ...parent };
  for (const key of INHERITABLE) {
    const v = node.get(N(key));
    if (v !== undefined && resolves(node.context, v)) out[key] = v;
  }
  return out;
}

function resolves(context: PDFContext, v: PDFObject): boolean {
  return !(v instanceof PDFRef) || context.lookup(v) !== undefined;
}

interface TreeWalk {
  ordered: { ref: PDFRef; inherited: Inherited }[];
  expectedCount?: number;
}

/** Walk a surviving page tree, keeping its order and inherited attributes. */
function walkPageTree(context: PDFContext, rootRef: PDFRef): TreeWalk {
  const root = context.lookup(rootRef);
  const walk: TreeWalk = { ordered: [] };
  if (!isPagesNode(root)) return walk;
  const count = root.get(N('Count'));
  if (count instanceof PDFNumber) walk.expectedCount = count.asNumber();
  const seen = new Set<string>([rootRef.toString()]);
  const visit = (node: PDFDict, inh: Inherited, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    const kids = node.get(N('Kids'));
    const kidsArr = kids instanceof PDFRef ? context.lookup(kids) : kids;
    if (!(kidsArr instanceof PDFArray)) return;
    const here = withInherited(node, inh);
    for (let i = 0; i < kidsArr.size(); i++) {
      const kidRef = kidsArr.get(i);
      if (!(kidRef instanceof PDFRef) || seen.has(kidRef.toString())) continue;
      seen.add(kidRef.toString());
      const kid = context.lookup(kidRef);
      if (isPagesNode(kid)) visit(kid, here, depth + 1);
      else if (isPageDict(kid)) walk.ordered.push({ ref: kidRef, inherited: here });
    }
  };
  visit(root, {}, 0);
  return walk;
}

/** Inherited attributes of an orphan page, from whatever part of its /Parent chain survived. */
function inheritedFromParents(context: PDFContext, page: PDFDict): Inherited {
  const chain: PDFDict[] = [];
  const seen = new Set<string>();
  let parentRef = page.get(N('Parent'));
  while (parentRef instanceof PDFRef && !seen.has(parentRef.toString()) && chain.length < MAX_TREE_DEPTH) {
    seen.add(parentRef.toString());
    const parent = context.lookup(parentRef);
    if (!(parent instanceof PDFDict)) break;
    chain.push(parent);
    parentRef = parent.get(N('Parent'));
  }
  let inh: Inherited = {};
  for (let i = chain.length - 1; i >= 0; i--) inh = withInherited(chain[i], inh);
  return inh;
}

/** Drops content-stream refs that did not survive; returns how many were lost. */
function fixContents(context: PDFContext, page: PDFDict): number {
  const contents = page.get(N('Contents'));
  if (contents === undefined) return 0;
  if (contents instanceof PDFRef) {
    const target = context.lookup(contents);
    if (target instanceof PDFStream) return 0;
    if (target instanceof PDFArray) return fixContentsArray(context, page, target);
    page.delete(N('Contents'));
    return 1;
  }
  if (contents instanceof PDFArray) return fixContentsArray(context, page, contents);
  if (contents instanceof PDFStream) return 0;
  page.delete(N('Contents'));
  return 1;
}

function fixContentsArray(context: PDFContext, page: PDFDict, arr: PDFArray): number {
  const kept: PDFObject[] = [];
  let lost = 0;
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);
    const target = item instanceof PDFRef ? context.lookup(item) : item;
    if (target instanceof PDFStream) kept.push(item);
    else lost++;
  }
  if (kept.length === 0) page.delete(N('Contents'));
  else if (lost > 0) page.set(N('Contents'), context.obj(kept));
  return lost;
}

/** True when a font / XObject named in the page's resources is missing. */
function hasMissingResources(context: PDFContext, page: PDFDict): boolean {
  const res = page.get(N('Resources'));
  const resDict = res instanceof PDFRef ? context.lookup(res) : res;
  if (!(resDict instanceof PDFDict)) return res !== undefined;
  for (const cat of ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading']) {
    const sub = resDict.get(N(cat));
    const subDict = sub instanceof PDFRef ? context.lookup(sub) : sub;
    if (sub !== undefined && !(subDict instanceof PDFDict)) return true;
    if (!(subDict instanceof PDFDict)) continue;
    for (const [, v] of subDict.entries()) {
      if (v instanceof PDFRef && context.lookup(v) === undefined) return true;
    }
  }
  return false;
}

/** With the trailer gone, an untyped dict carrying document metadata keys is the old /Info. */
function findInfoDict(context: PDFContext): PDFRef | undefined {
  const infoKeys = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);
  let found: PDFRef | undefined;
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const keys = obj.keys();
    if (keys.length > 0 && keys.every((k) => infoKeys.has(k.decodeText()))) found = ref;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Rebuilds a damaged PDF from whatever objects survive in its bytes.
 * Throws when the input is not a PDF, is encrypted, or holds no page at all.
 */
export async function repairPdf(bytes: Uint8Array): Promise<RepairResult> {
  if (!bytes || bytes.length === 0) throw new Error('The file is empty; there is nothing to repair.');
  if (!looksLikePdf(bytes)) throw new Error('This file is not a PDF (no %PDF- header found), so it cannot be repaired.');

  const context = PDFContext.create();
  const scan = scanFile(bytes);
  if (scan.headers.length === 0) {
    throw new Error('No recoverable pages: the file contains no readable PDF objects.');
  }
  const collected = collectObjects(bytes, scan.headers, context);
  const trailer = readTrailers(bytes, scan, collected, context);
  if (trailer.encrypted) {
    throw new Error(
      'This PDF is encrypted and damaged. It cannot be repaired without its encryption keys; ' +
        'try the original, undamaged file or ask the sender for an unencrypted copy.',
    );
  }

  for (const [num, e] of collected.entries) {
    // Cross-reference streams describe the old layout only; never carry them over.
    if (e.obj instanceof PDFRawStream && e.obj.dict.get(N('Type')) === N('XRef')) continue;
    context.assign(PDFRef.of(num, e.gen), e.obj);
  }

  // --- find the old catalog and page tree -------------------------------------------------
  const entriesByType = (t: string): PDFRef[] => {
    const out: PDFRef[] = [];
    for (const [ref, obj] of context.enumerateIndirectObjects()) if (typeOf(obj) === N(t)) out.push(ref);
    return out;
  };
  let catalogRef: PDFRef | undefined;
  if (trailer.root && typeOf(context.lookup(trailer.root)) === N('Catalog')) catalogRef = trailer.root;
  if (!catalogRef) {
    const cats = entriesByType('Catalog');
    // Prefer the catalog furthest into the file (latest incremental update).
    cats.sort((a, b) => (collected.entries.get(a.objectNumber)?.offset ?? 0) - (collected.entries.get(b.objectNumber)?.offset ?? 0));
    catalogRef = cats[cats.length - 1];
  }
  const oldCatalog = catalogRef ? context.lookup(catalogRef) : undefined;
  const oldCatalogDict = oldCatalog instanceof PDFDict ? oldCatalog : undefined;

  let treeRoot: PDFRef | undefined;
  const catPages = oldCatalogDict?.get(N('Pages'));
  if (catPages instanceof PDFRef && isPagesNode(context.lookup(catPages))) treeRoot = catPages;
  if (!treeRoot) {
    // A /Pages node without a surviving parent is a root candidate; take the biggest.
    let best = -1;
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (!isPagesNode(obj)) continue;
      const parent = obj.get(N('Parent'));
      if (parent instanceof PDFRef && isPagesNode(context.lookup(parent))) continue;
      const c = obj.get(N('Count'));
      const size = c instanceof PDFNumber ? c.asNumber() : 0;
      if (size > best) {
        best = size;
        treeRoot = ref;
      }
    }
  }

  const walk: TreeWalk = treeRoot ? walkPageTree(context, treeRoot) : { ordered: [] };
  const inTree = new Set(walk.ordered.map((p) => p.ref.toString()));
  const orphans: PDFRef[] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (isPageDict(obj) && !inTree.has(ref.toString())) orphans.push(ref);
  }
  orphans.sort((a, b) => a.objectNumber - b.objectNumber);
  const pages: { ref: PDFRef; inherited: Inherited }[] = [...walk.ordered];
  for (const ref of orphans) {
    const page = context.lookup(ref);
    if (page instanceof PDFDict) pages.push({ ref, inherited: inheritedFromParents(context, page) });
  }

  if (pages.length === 0) {
    throw new Error('No recoverable pages: no page objects survived in this file.');
  }

  // --- rebuild the structure --------------------------------------------------------------
  const pagesRef = context.nextRef();
  let lostContents = 0;
  let pagesMissingResources = 0;
  let pagesWithoutContent = 0;
  let defaultedMediaBox = 0;
  for (const { ref, inherited } of pages) {
    const page = context.lookup(ref);
    if (!(page instanceof PDFDict)) continue;
    page.set(N('Type'), N('Page'));
    page.set(N('Parent'), pagesRef);
    for (const key of INHERITABLE) {
      const own = page.get(N(key));
      if (own !== undefined && resolves(context, own)) continue;
      const inh = inherited[key];
      if (inh !== undefined) page.set(N(key), inh);
      else if (own !== undefined) page.delete(N(key));
    }
    if (!(page.lookup(N('MediaBox')) instanceof PDFArray)) {
      page.set(N('MediaBox'), context.obj(A4));
      defaultedMediaBox++;
    }
    if (page.get(N('Resources')) === undefined) page.set(N('Resources'), context.obj({}));
    const lost = fixContents(context, page);
    lostContents += lost;
    if (page.get(N('Contents')) === undefined && lost > 0) pagesWithoutContent++;
    if (hasMissingResources(context, page)) pagesMissingResources++;
  }

  // Drop the old structure so nothing points at a half-dead tree.
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (isPagesNode(obj) || typeOf(obj) === N('Catalog')) context.delete(ref);
    else if (obj instanceof PDFRawStream && obj.dict.get(N('Type')) === N('ObjStm')) context.delete(ref);
  }

  context.assign(
    pagesRef,
    context.obj({ Type: 'Pages', Kids: pages.map((p) => p.ref), Count: pages.length }),
  );
  const catalog = context.obj({ Type: 'Catalog', Pages: pagesRef });
  const notes: string[] = [];
  let bookmarksKept = false;
  if (oldCatalogDict) {
    for (const key of CATALOG_KEYS) {
      const v = oldCatalogDict.get(N(key));
      if (v !== undefined && resolves(context, v)) catalog.set(N(key), v);
    }
    const outlines = oldCatalogDict.get(N('Outlines'));
    if (outlines !== undefined) {
      if (resolves(context, outlines)) bookmarksKept = true;
      else notes.push('Bookmarks could not be recovered.');
    }
  } else {
    const outlines = entriesByType('Outlines');
    if (outlines.length > 0) {
      catalog.set(N('Outlines'), outlines[outlines.length - 1]);
      bookmarksKept = true;
    }
    notes.push(
      'The document catalog was missing and has been rebuilt; bookmarks, form fields and document settings ' +
        (bookmarksKept ? 'were partly re-attached.' : 'could not be recovered.'),
    );
  }
  const catalogOut = context.register(catalog);
  context.trailerInfo = { Root: catalogOut };
  const infoRef =
    trailer.info && context.lookup(trailer.info) instanceof PDFDict ? trailer.info : findInfoDict(context);
  if (infoRef) context.trailerInfo.Info = infoRef;

  // --- notes ------------------------------------------------------------------------------
  const expected = walk.expectedCount;
  let head =
    expected !== undefined && expected > pages.length
      ? `Recovered ${pages.length} of ${expected} pages`
      : `Recovered ${plural(pages.length, 'page', 'pages')}`;
  if (lostContents > 0) {
    head += `; ${plural(lostContents, 'page content was', 'page contents were')} cut off`;
    if (pagesWithoutContent > 0) head += ` (${plural(pagesWithoutContent, 'page is', 'pages are')} blank)`;
  }
  notes.unshift(head + '.');
  if (walk.ordered.length === 0) notes.push('The page tree was lost; pages are in their original storage order.');
  else if (orphans.length > 0) notes.push(`${plural(orphans.length, 'page', 'pages')} outside the surviving page tree were appended at the end.`);
  if (pagesMissingResources > 0) {
    notes.push(`${plural(pagesMissingResources, 'page references', 'pages reference')} fonts or images that were lost; they may render partially.`);
  }
  if (defaultedMediaBox > 0) notes.push(`${plural(defaultedMediaBox, 'page had', 'pages had')} no page size; A4 was assumed.`);
  const brokenObjects = collected.damaged + collected.truncatedStreams + collected.objStmLost;
  if (brokenObjects > 0) notes.push(`${plural(brokenObjects, 'damaged object was', 'damaged objects were')} skipped.`);
  if (collected.objStmExpanded > 0) notes.push(`${plural(collected.objStmExpanded, 'object stream was', 'object streams were')} unpacked.`);
  if (bookmarksKept && oldCatalogDict) notes.push('Bookmarks were preserved.');

  const out = await PDFWriter.forContext(context, 500).serializeToBuffer();
  return { bytes: out, pagesRecovered: pages.length, notes };
}
