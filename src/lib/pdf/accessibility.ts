/**
 * Accessibility (PDF/UA-style): a checker for the problems screen readers
 * meet most often, and a fixer that sets title and language, describes
 * pictures, and tags an untagged document — its text becomes paragraphs and
 * headings in reading (content) order, pictures become figures with their
 * descriptions, everything else (lines, backgrounds) is marked as artifact,
 * and links, form fields and comments are added to the structure.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { pageContent, parseContent, resourcesOf, type Instr } from './textRemoval';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface AccessCheck {
  id: 'tagged' | 'title' | 'language' | 'figures' | 'text' | 'fonts' | 'fields' | 'links' | 'tabs' | 'bookmarks' | 'security';
  status: CheckStatus;
  title: string;
  detail: string;
  /** "Make accessible" fixes it. */
  fixable: boolean;
}

export interface FigureInfo {
  /** "p{page}-{instruction}" (untagged) or "s{n}" (a Figure of the existing tags). */
  key: string;
  /** 1-based. */
  page: number;
  /** XObject name, when known. */
  name: string | null;
  alt: string;
  /** PDF user space [x0, y0, x1, y1]. */
  bbox: [number, number, number, number] | null;
}

export interface FixOptions {
  title: string;
  /** BCP 47, e.g. "ro-RO". */
  lang: string;
  /** Figure key -> description; '' leaves it undescribed. */
  alt: Record<string, string>;
  /** Figure keys that are decoration only (marked as artifacts). */
  decorative: string[];
  /** Tag an untagged document. */
  tag: boolean;
}

type M = [number, number, number, number, number, number];
const mul = (A: M, B: M): M => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4],
  A[4] * B[1] + A[5] * B[3] + B[5],
];
const nums = (ins: Instr) => ins.args.map((a) => (a.k === 'n' ? a.v : 0));

// ---------------------------------------------------------------- page scan

interface Item {
  kind: 'text' | 'figure';
  /** Instruction range [first, last]. */
  first: number;
  last: number;
  size: number;
  x: number;
  y: number;
  chars: number;
  name: string | null;
  bbox: [number, number, number, number] | null;
}

interface PageScan {
  src: Uint8Array;
  instrs: Instr[];
  items: Item[];
  /** Instruction ranges [first, lastExclusive) to mark as artifacts. */
  artifacts: Array<[number, number]>;
  text: boolean;
  images: number;
}

const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'Do', 'BI']);
const SHOW = new Set(['Tj', 'TJ', "'", '"']);

function xobject(doc: PDFDocument, page: PDFPage, name: string): PDFRawStream | null {
  const xo = resourcesOf(page)?.lookup(PDFName.of('XObject'));
  if (!(xo instanceof PDFDict)) return null;
  const v = xo.get(PDFName.of(name));
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return s instanceof PDFRawStream ? s : null;
}

function formHasText(s: PDFRawStream): boolean {
  try {
    return parseContent(decodePDFRawStream(s).decode()).some((i) => SHOW.has(i.op));
  } catch {
    return false;
  }
}

const bboxOf = (m: M): [number, number, number, number] => {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

export function scanPage(doc: PDFDocument, page: PDFPage): PageScan {
  const src = pageContent(doc, page);
  const instrs = parseContent(src);
  const n = instrs.length;
  // Depth before each instruction: graphics state (q/Q) and marked content (BDC/BMC/EMC).
  const qd = new Int32Array(n + 1);
  const md = new Int32Array(n + 1);
  const inArtifact = new Uint8Array(n);
  const mcTags: string[] = [];
  let q = 0;
  for (let k = 0; k < n; k++) {
    qd[k] = q;
    md[k] = mcTags.length;
    inArtifact[k] = mcTags.includes('Artifact') ? 1 : 0;
    const op = instrs[k].op;
    if (op === 'q') q++;
    else if (op === 'Q') q = Math.max(0, q - 1);
    else if (op === 'BMC' || op === 'BDC') mcTags.push(instrs[k].args[0]?.k === 'name' ? (instrs[k].args[0] as { v: string }).v : '');
    else if (op === 'EMC') mcTags.pop();
  }
  qd[n] = q;
  md[n] = mcTags.length;
  const balanced = (a: number, b: number) => {
    // [a, b] inclusive keeps both depths and never goes below the start.
    for (let k = a + 1; k <= b + 1; k++) if (qd[k] < qd[a] || md[k] < md[a]) return false;
    return qd[b + 1] === qd[a] && md[b + 1] === md[a];
  };

  const items: Item[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let fs = 0;
  let leading = 0;
  for (let k = 0; k < n; k++) {
    const ins = instrs[k];
    if (ins.op === 'q') stack.push(ctm);
    else if (ins.op === 'Q') ctm = stack.pop() ?? ctm;
    else if (ins.op === 'cm') {
      const v = nums(ins);
      if (v.length === 6) ctm = mul(v as M, ctm);
    } else if (ins.op === 'Tf') fs = nums(ins)[1] ?? fs;
    else if (ins.op === 'TL') leading = nums(ins)[0] ?? leading;
    else if (ins.op === 'BT') {
      let j = k + 1;
      while (j < n && instrs[j].op !== 'ET') j++;
      if (j >= n) break;
      let tm: M = [1, 0, 0, 1, 0, 0];
      let tlm: M = tm;
      let first: { size: number; x: number; y: number } | null = null;
      let chars = 0;
      for (let t = k + 1; t < j; t++) {
        const ti = instrs[t];
        const v = nums(ti);
        if (ti.op === 'Tf') fs = v[1] ?? fs;
        else if (ti.op === 'TL') leading = v[0] ?? leading;
        else if (ti.op === 'Tm' && v.length === 6) tm = tlm = v as M;
        else if (ti.op === 'Td' || ti.op === 'TD') {
          if (ti.op === 'TD') leading = -(v[1] ?? 0);
          tm = tlm = mul([1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0], tlm);
        } else if (ti.op === 'T*' || ti.op === "'" || ti.op === '"') tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        if (SHOW.has(ti.op)) {
          for (const a of ti.args) chars += a.k === 's' ? a.v.length : a.k === 'a' ? a.v.reduce((s2, x) => s2 + (x.k === 's' ? x.v.length : 0), 0) : 0;
          if (!first) {
            const m = mul(tm, ctm);
            first = { size: Math.abs(fs) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), x: m[4], y: m[5] };
          }
        }
      }
      if (first && !inArtifact[k] && balanced(k, j)) items.push({ kind: 'text', first: k, last: j, size: first.size, x: first.x, y: first.y, chars, name: null, bbox: null });
      k = j;
    } else if ((ins.op === 'Do' && ins.args[0]?.k === 'name') || ins.op === 'BI') {
      if (inArtifact[k]) continue;
      const name = ins.op === 'Do' ? (ins.args[0] as { v: string }).v : null;
      const s = name ? xobject(doc, page, name) : null;
      const subtype = s?.dict.lookup(PDFName.of('Subtype'));
      if (ins.op === 'BI' || subtype === PDFName.of('Image')) items.push({ kind: 'figure', first: k, last: k, size: 0, x: ctm[4], y: ctm[5], chars: 0, name, bbox: bboxOf(ctm) });
      else if (s && subtype === PDFName.of('Form') && formHasText(s)) items.push({ kind: 'text', first: k, last: k, size: 0, x: ctm[4], y: ctm[5] + ctm[3], chars: 40, name, bbox: null });
    }
  }

  // Everything painted outside the items: artifacts, in balanced ranges.
  const artifacts: Array<[number, number]> = [];
  const itemAt = new Map(items.map((it) => [it.first, it]));
  const runs: Array<[number, number]> = [];
  let runStart = 0;
  for (let k = 0; k < n; k++) {
    const it = itemAt.get(k);
    if (it) {
      if (k > runStart) runs.push([runStart, k]);
      k = it.last;
      runStart = k + 1;
    }
  }
  if (runStart < n) runs.push([runStart, n]);
  for (const [a, b] of runs) {
    let s = a;
    while (s < b) {
      let good = -1;
      let paint = false;
      let paintAtGood = false;
      for (let e = s; e < b; e++) {
        if (qd[e + 1] < qd[s] || md[e + 1] < md[s]) break;
        if (PAINT.has(instrs[e].op) && !inArtifact[e]) paint = true;
        if (qd[e + 1] === qd[s] && md[e + 1] === md[s]) {
          good = e + 1;
          paintAtGood = paint;
        }
      }
      if (good > s && paintAtGood) {
        artifacts.push([s, good]);
        s = good;
      } else s++;
    }
  }
  return { src, instrs, items, artifacts, text: items.some((i) => i.kind === 'text'), images: items.filter((i) => i.kind === 'figure').length };
}

// ---------------------------------------------------------------- existing tags

function structRoot(doc: PDFDocument): PDFDict | null {
  const r = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  return r instanceof PDFDict ? r : null;
}

/** Figure elements of the existing structure tree, in tree order (RoleMap applied). */
function taggedFigures(doc: PDFDocument): PDFDict[] {
  const root = structRoot(doc);
  if (!root) return [];
  const roleMap = root.lookup(PDFName.of('RoleMap'));
  const role = (s: PDFName) => {
    let name = s;
    for (let i = 0; i < 5 && roleMap instanceof PDFDict; i++) {
      const m = roleMap.lookup(name);
      if (!(m instanceof PDFName)) break;
      name = m;
    }
    return name.decodeText();
  };
  const out: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 200) return;
    const d = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (d instanceof PDFArray) {
      for (let i = 0; i < d.size(); i++) walk(d.get(i), depth + 1);
      return;
    }
    if (!(d instanceof PDFDict) || seen.has(d)) return;
    seen.add(d);
    const s = d.lookup(PDFName.of('S'));
    if (s instanceof PDFName && role(s) === 'Figure') out.push(d);
    walk(d.get(PDFName.of('K')), depth + 1);
  };
  walk(root.get(PDFName.of('K')), 0);
  return out;
}

function textOf(v: unknown): string {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
}

/** Pictures of the document with their descriptions. */
export async function listFigures(bytes: Uint8Array): Promise<FigureInfo[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  if (structRoot(doc)) {
    return taggedFigures(doc).map((f, i) => {
      const pg = f.get(PDFName.of('Pg'));
      const page = pages.findIndex((p) => p.ref === pg);
      const bb = (f.lookup(PDFName.of('A')) as PDFDict | undefined)?.lookup?.(PDFName.of('BBox'));
      const bbox = bb instanceof PDFArray && bb.size() === 4 ? (bb.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) as [number, number, number, number]) : null;
      return { key: `s${i}`, page: page + 1, name: null, alt: textOf(f.lookup(PDFName.of('Alt'))), bbox };
    });
  }
  const out: FigureInfo[] = [];
  pages.forEach((p, pi) => {
    try {
      for (const it of scanPage(doc, p).items) if (it.kind === 'figure') out.push({ key: `p${pi}-${it.first}`, page: pi + 1, name: it.name, alt: '', bbox: it.bbox });
    } catch {
      /* unreadable content */
    }
  });
  return out;
}

// ---------------------------------------------------------------- checker

function isEncrypted(doc: PDFDocument): boolean {
  return !!doc.context.trailerInfo.Encrypt;
}

function fontEmbedded(f: PDFDict): boolean {
  const sub = f.lookup(PDFName.of('Subtype'));
  if (sub === PDFName.of('Type3')) return true;
  let d = f;
  if (sub === PDFName.of('Type0')) {
    const kids = f.lookup(PDFName.of('DescendantFonts'));
    const k = kids instanceof PDFArray ? kids.lookup(0) : null;
    if (!(k instanceof PDFDict)) return false;
    d = k;
  }
  const fd = d.lookup(PDFName.of('FontDescriptor'));
  return fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
}

const pluralS = (n: number) => (n === 1 ? '' : 's');

export async function checkAccessibility(bytes: Uint8Array): Promise<AccessCheck[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const checks: AccessCheck[] = [];
  const tagged = !!structRoot(doc);
  const marked = (() => {
    const mi = doc.catalog.lookup(PDFName.of('MarkInfo'));
    return mi instanceof PDFDict && mi.lookup(PDFName.of('Marked'))?.toString() === 'true';
  })();
  checks.push(
    tagged && marked
      ? { id: 'tagged', status: 'pass', title: 'Tagged PDF', detail: 'The document has a structure tree (reading order for screen readers).', fixable: false }
      : { id: 'tagged', status: 'fail', title: 'Tagged PDF', detail: 'The document is not tagged: screen readers cannot tell paragraphs, headings and pictures apart.', fixable: !tagged },
  );
  const title = doc.getTitle()?.trim() ?? '';
  const vp = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
  const showsTitle = vp instanceof PDFDict && vp.lookup(PDFName.of('DisplayDocTitle'))?.toString() === 'true';
  checks.push(
    title && showsTitle
      ? { id: 'title', status: 'pass', title: 'Document title', detail: `“${title}”, shown in the window title.`, fixable: false }
      : { id: 'title', status: 'fail', title: 'Document title', detail: title ? 'The title is set but the window shows the file name instead.' : 'The document has no title.', fixable: true },
  );
  const lang = textOf(doc.catalog.lookup(PDFName.of('Lang')));
  checks.push(
    lang
      ? { id: 'language', status: 'pass', title: 'Document language', detail: `Language: ${lang}.`, fixable: false }
      : { id: 'language', status: 'fail', title: 'Document language', detail: 'No language is set, so screen readers may pronounce the text wrongly.', fixable: true },
  );

  const figures = await listFigures(bytes);
  const missing = figures.filter((f) => !f.alt.trim()).length;
  checks.push(
    !figures.length
      ? { id: 'figures', status: 'pass', title: 'Picture descriptions', detail: 'The document has no pictures.', fixable: false }
      : missing
        ? { id: 'figures', status: 'fail', title: 'Picture descriptions', detail: `${missing} of ${figures.length} picture${pluralS(figures.length)} have no alternative text.`, fixable: true }
        : { id: 'figures', status: 'pass', title: 'Picture descriptions', detail: `All ${figures.length} picture${pluralS(figures.length)} are described.`, fixable: false },
  );

  let scanned = 0;
  const unembedded = new Set<string>();
  let pagesWithAnnotsNoTabs = 0;
  let linksNoText = 0;
  pages.forEach((p) => {
    try {
      const s = scanPage(doc, p);
      if (!s.text && s.images) scanned++;
    } catch {
      /* ignore */
    }
    const fonts = resourcesOf(p)?.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) {
      for (const [, v] of fonts.entries()) {
        const f = v instanceof PDFRef ? doc.context.lookup(v) : v;
        if (f instanceof PDFDict && !fontEmbedded(f)) unembedded.add((f.lookup(PDFName.of('BaseFont')) as PDFName | undefined)?.decodeText?.() ?? '?');
      }
    }
    const annots = p.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray && annots.size()) {
      if (p.node.lookup(PDFName.of('Tabs')) !== PDFName.of('S')) pagesWithAnnotsNoTabs++;
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (a instanceof PDFDict && a.lookup(PDFName.of('Subtype')) === PDFName.of('Link') && !textOf(a.lookup(PDFName.of('Contents'))).trim()) linksNoText++;
      }
    }
  });
  checks.push(
    scanned
      ? { id: 'text', status: 'fail', title: 'Readable text', detail: `${scanned} page${pluralS(scanned)} contain only pictures (scanned?): run OCR first so the text can be read aloud.`, fixable: false }
      : { id: 'text', status: 'pass', title: 'Readable text', detail: 'Every page has real text.', fixable: false },
  );
  checks.push(
    unembedded.size
      ? { id: 'fonts', status: 'warn', title: 'Embedded fonts', detail: `Not embedded: ${[...unembedded].slice(0, 6).join(', ')}. Converting to PDF/A embeds them.`, fixable: false }
      : { id: 'fonts', status: 'pass', title: 'Embedded fonts', detail: 'All fonts are embedded.', fixable: false },
  );

  const fields = doc.getForm().getFields();
  const noTip = fields.filter((f) => !textOf(f.acroField.dict.lookup(PDFName.of('TU'))).trim()).length;
  checks.push(
    !fields.length
      ? { id: 'fields', status: 'pass', title: 'Form field descriptions', detail: 'The document has no form fields.', fixable: false }
      : noTip
        ? { id: 'fields', status: 'fail', title: 'Form field descriptions', detail: `${noTip} of ${fields.length} field${pluralS(fields.length)} have no description (tooltip) for screen readers.`, fixable: true }
        : { id: 'fields', status: 'pass', title: 'Form field descriptions', detail: 'Every field has a description.', fixable: false },
  );
  checks.push(
    linksNoText
      ? { id: 'links', status: 'fail', title: 'Link descriptions', detail: `${linksNoText} link${pluralS(linksNoText)} have no description.`, fixable: true }
      : { id: 'links', status: 'pass', title: 'Link descriptions', detail: 'Links are described (or there are none).', fixable: false },
  );
  checks.push(
    pagesWithAnnotsNoTabs
      ? { id: 'tabs', status: 'fail', title: 'Tab order', detail: `${pagesWithAnnotsNoTabs} page${pluralS(pagesWithAnnotsNoTabs)} with links or fields do not follow the document structure when tabbing.`, fixable: true }
      : { id: 'tabs', status: 'pass', title: 'Tab order', detail: 'Tab order follows the document structure.', fixable: false },
  );
  const hasOutline = doc.catalog.lookup(PDFName.of('Outlines')) instanceof PDFDict;
  checks.push(
    pages.length > 20 && !hasOutline
      ? { id: 'bookmarks', status: 'warn', title: 'Bookmarks', detail: `${pages.length} pages and no bookmarks: add them with Organize → Bookmarks from headings.`, fixable: false }
      : { id: 'bookmarks', status: 'pass', title: 'Bookmarks', detail: hasOutline ? 'The document has bookmarks.' : 'Short document: bookmarks are optional.', fixable: false },
  );
  checks.push(
    isEncrypted(doc)
      ? { id: 'security', status: 'warn', title: 'Security', detail: 'The document is password protected: make sure copying for accessibility is allowed.', fixable: false }
      : { id: 'security', status: 'pass', title: 'Security', detail: 'No restrictions for assistive technology.', fixable: false },
  );
  return checks;
}

// ---------------------------------------------------------------- fixer

/** "data_nasterii" -> "Data nasterii". */
export function humanize(fieldName: string): string {
  const last = fieldName.split('.').pop() ?? fieldName;
  const s = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-zăâîșț])([A-ZĂÂÎȘȚ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : fieldName;
}

type Role = 'H1' | 'H2' | 'H3' | 'P';

/** Heading levels from font sizes relative to the body text (most characters). */
function roles(scans: PageScan[]): (it: Item) => Role {
  const bySize = new Map<number, number>();
  for (const s of scans) for (const it of s.items) if (it.kind === 'text' && it.size > 0) bySize.set(Math.round(it.size * 2) / 2, (bySize.get(Math.round(it.size * 2) / 2) ?? 0) + it.chars);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  return (it) => {
    if (!it.size || it.chars > 300) return 'P';
    const r = it.size / body;
    return r >= 1.75 ? 'H1' : r >= 1.35 ? 'H2' : r >= 1.15 ? 'H3' : 'P';
  };
}

function patchXmpTitle(doc: PDFDocument, title: string): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = doc.catalog.get(PDFName.of('Metadata'));
  const m = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  let xmp = m instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(m).decode()) : '';
  const titleXml = `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>`;
  if (xmp && /<dc:title>[\s\S]*?<\/dc:title>/.test(xmp)) xmp = xmp.replace(/<dc:title>[\s\S]*?<\/dc:title>/, titleXml);
  else if (xmp && /<\/rdf:RDF>/.test(xmp))
    xmp = xmp.replace(/<\/rdf:RDF>/, `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">${titleXml}</rdf:Description></rdf:RDF>`);
  else
    xmp = [
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">${titleXml}</rdf:Description>`,
      '</rdf:RDF></x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
  const stream = doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
}

/** Rewrites one page's content with marked-content sequences. */
function markPage(doc: PDFDocument, page: PDFPage, scan: PageScan, marks: Array<{ first: number; last: number; open: string }>): void {
  const ins: Array<{ at: number; text: string; order: number }> = [];
  for (const [a, b] of scan.artifacts) marks.push({ first: a, last: b - 1, open: '/Artifact BMC' });
  for (const m of marks) {
    ins.push({ at: scan.instrs[m.first].start, text: `${m.open}\n`, order: 1 });
    ins.push({ at: scan.instrs[m.last].end, text: '\nEMC\n', order: 0 });
  }
  // At one offset: close the earlier sequence before opening the next.
  ins.sort((x, y) => x.at - y.at || x.order - y.order);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const x of ins) {
    parts.push(scan.src.subarray(pos, x.at), enc.encode(x.text));
    pos = x.at;
  }
  parts.push(scan.src.subarray(pos));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
}

export async function makeAccessible(bytes: Uint8Array, opts: FixOptions): Promise<{ bytes: Uint8Array; tagged: boolean; elements: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();

  // --- title, language, window title
  if (opts.title.trim()) {
    doc.setTitle(opts.title.trim(), { showInWindowTitleBar: true });
    patchXmpTitle(doc, opts.title.trim());
  }
  if (opts.lang.trim()) doc.catalog.set(PDFName.of('Lang'), PDFString.of(opts.lang.trim()));
  // --- form field descriptions
  for (const f of doc.getForm().getFields()) {
    if (!textOf(f.acroField.dict.lookup(PDFName.of('TU'))).trim()) f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(humanize(f.getName())));
  }

  let elements = 0;
  const alreadyTagged = !!structRoot(doc);
  if (alreadyTagged) {
    // Descriptions for the existing figures.
    taggedFigures(doc).forEach((f, i) => {
      const alt = opts.alt[`s${i}`]?.trim();
      if (alt) f.set(PDFName.of('Alt'), PDFHexString.fromText(alt));
    });
  } else if (opts.tag) {
    const scans = pages.map((p) => scanPage(doc, p));
    const roleOf = roles(scans);
    const root = ctx.obj({ Type: 'StructTreeRoot' }) as PDFDict;
    const rootRef = ctx.register(root);
    const docElem = ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef }) as PDFDict;
    const docRef = ctx.register(docElem);
    const kids: PDFRef[] = [];
    const nums: Array<PDFNumber | PDFRef | PDFArray> = [];
    let nextKey = pages.length;

    pages.forEach((page, pi) => {
      const scan = scans[pi];
      const parents: PDFRef[] = [];
      const marks: Array<{ first: number; last: number; open: string }> = [];
      // The paragraph or heading being built (consecutive lines join it).
      const open: { block: { role: Role; dict: PDFDict; ref: PDFRef; mcids: number[]; last: Item } | null } = { block: null };
      const flush = () => {
        const b = open.block;
        if (b) b.dict.set(PDFName.of('K'), b.mcids.length === 1 ? PDFNumber.of(b.mcids[0]) : ctx.obj(b.mcids));
        open.block = null;
      };
      for (const it of scan.items) {
        const key = `p${pi}-${it.first}`;
        if (it.kind === 'figure' && opts.decorative.includes(key)) {
          marks.push({ first: it.first, last: it.last, open: '/Artifact BMC' });
          continue;
        }
        const mcid = parents.length;
        if (it.kind === 'figure') {
          flush();
          const fig = ctx.obj({ Type: 'StructElem', S: 'Figure', P: docRef, Pg: page.ref, K: mcid }) as PDFDict;
          const alt = opts.alt[key]?.trim();
          if (alt) fig.set(PDFName.of('Alt'), PDFHexString.fromText(alt));
          if (it.bbox) fig.set(PDFName.of('A'), ctx.obj({ O: 'Layout', BBox: it.bbox.map((v) => Math.round(v * 100) / 100) }));
          const ref = ctx.register(fig);
          kids.push(ref);
          parents.push(ref);
          marks.push({ first: it.first, last: it.last, open: `/Figure <</MCID ${mcid}>> BDC` });
          elements++;
          continue;
        }
        const role = roleOf(it);
        const prev = open.block;
        const sameBlock =
          !!prev &&
          prev.role === role &&
          (it.size === 0 || prev.last.size === 0 || Math.abs(prev.last.size - it.size) < 0.6) &&
          (Math.abs(prev.last.y - it.y) < Math.max(it.size, 1) * 0.35 || (prev.last.y - it.y > 0 && prev.last.y - it.y < Math.max(it.size, prev.last.size, 6) * 2.1));
        let c = open.block;
        if (!sameBlock || !c) {
          flush();
          const dict = ctx.obj({ Type: 'StructElem', S: role, P: docRef, Pg: page.ref }) as PDFDict;
          const ref = ctx.register(dict);
          kids.push(ref);
          c = open.block = { role, dict, ref, mcids: [], last: it };
          elements++;
        }
        c.mcids.push(mcid);
        c.last = it;
        parents.push(c.ref);
        marks.push({ first: it.first, last: it.last, open: `/${role} <</MCID ${mcid}>> BDC` });
      }
      flush();
      markPage(doc, page, scan, marks);
      page.node.set(PDFName.of('StructParents'), PDFNumber.of(pi));
      nums.push(PDFNumber.of(pi), ctx.obj(parents));

      // Links, form fields and comments, after the page's content.
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (annots instanceof PDFArray && annots.size()) {
        page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
        for (let i = 0; i < annots.size(); i++) {
          const aRef = annots.get(i);
          const a = annots.lookup(i);
          if (!(aRef instanceof PDFRef) || !(a instanceof PDFDict)) continue;
          const sub = a.lookup(PDFName.of('Subtype'));
          if (sub === PDFName.of('Popup')) continue;
          const S = sub === PDFName.of('Link') ? 'Link' : sub === PDFName.of('Widget') ? 'Form' : 'Annot';
          const el = ctx.obj({ Type: 'StructElem', S, P: docRef, Pg: page.ref, K: [{ Type: 'OBJR', Obj: aRef, Pg: page.ref }] }) as PDFDict;
          const elRef = ctx.register(el);
          kids.push(elRef);
          a.set(PDFName.of('StructParent'), PDFNumber.of(nextKey));
          nums.push(PDFNumber.of(nextKey++), elRef);
          elements++;
        }
      }
    });
    docElem.set(PDFName.of('K'), ctx.obj(kids));
    root.set(PDFName.of('K'), docRef);
    root.set(PDFName.of('ParentTree'), ctx.register(ctx.obj({ Nums: nums })));
    root.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(nextKey));
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
    doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  }

  // --- links and tab order (also for documents tagged elsewhere)
  for (const page of pages) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray) || !annots.size()) continue;
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict) || a.lookup(PDFName.of('Subtype')) !== PDFName.of('Link') || textOf(a.lookup(PDFName.of('Contents'))).trim()) continue;
      const action = a.lookup(PDFName.of('A'));
      const uri = action instanceof PDFDict ? textOf(action.lookup(PDFName.of('URI'))) : '';
      a.set(PDFName.of('Contents'), PDFHexString.fromText(uri ? `Link: ${uri.replace(/^mailto:/i, '')}` : 'Link to another page'));
    }
  }
  if (!(doc.catalog.lookup(PDFName.of('ViewerPreferences')) instanceof PDFDict)) doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));
  return { bytes: await doc.save({ useObjectStreams: true }), tagged: alreadyTagged || opts.tag, elements };
}

export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'ro-RO', label: 'Română' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'es-ES', label: 'Español' },
  { code: 'hu-HU', label: 'Magyar' },
  { code: 'pl-PL', label: 'Polski' },
  { code: 'nl-NL', label: 'Nederlands' },
  { code: 'pt-PT', label: 'Português' },
];

