/**
 * PDF/UA-1 (ISO 14289-1) checker after the Matterhorn Protocol 1.1: the
 * machine-checkable failure conditions, each reported with its checkpoint and
 * condition id, page, object / tag and whether Adika fixes it; the checkpoints
 * a person has to judge (contrast, meaningful descriptions, logical order) are
 * listed with guidance. Untagged content is found by walking the content
 * streams (`contentWalk.ts`). Fixes live in `pdfuaFix.ts`. Pure (pdf-lib).
 */
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFObject, type PDFPage } from 'pdf-lib';
import { isUntagged, mcidContent, unionBox, walkContent, walkPage, type ContentWalk } from './contentWalk';
import { contentPages, idOf, readParentTree, readStructure, resolveRole, STANDARD_TYPES, textOf, type StructNode, type Structure } from './structEdit';
import { readXmpPacket } from './xmp';
import { readXfaPackets, xfaKindOf } from './xfa';
import { readFontProgram } from './fontProgram';
import { glyphNameToUnicode, standardMaps } from './fontEncoding';
import { resourcesOf, type Box } from './textRemoval';
import { loadEditable } from './editable';

export type UaFix =
  | 'tagDocument'
  | 'untagged'
  | 'metadata'
  | 'displayDocTitle'
  | 'language'
  | 'marked'
  | 'suspects'
  | 'roleMap'
  | 'annotTags'
  | 'tabs'
  | 'linkContents'
  | 'fieldTU'
  | 'listBody'
  | 'listNumbering'
  | 'thScope'
  | 'noteIds'
  | 'ocConfig'
  | 'fileSpec'
  | 'cidSet';

export interface UaIssue {
  /** Matterhorn checkpoint, e.g. "06". */
  checkpoint: string;
  /** Matterhorn failure condition ("06-002"), or the ISO 14289-1 clause ("§7.1") when the protocol has no number for it. */
  condition: string;
  message: string;
  /** 0-based page, null for the whole document. */
  page: number | null;
  /** Object number of the tag ("12-0") or annotation / font / file it is about. */
  object?: string;
  tag?: string;
  /** Area on the page (PDF user space). */
  box?: Box | null;
  fix: UaFix | null;
  /** The fix guesses (applied only when the user asks for it, not by "Fix all safe issues"). */
  confirm?: boolean;
}

export interface ManualCheck {
  checkpoint: string;
  title: string;
  guidance: string;
}

export interface CheckpointSummary {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'manual';
  failures: number;
}

export interface UaReport {
  issues: UaIssue[];
  manual: ManualCheck[];
  checkpoints: CheckpointSummary[];
  tagged: boolean;
  pages: number;
}

export const CHECKPOINTS: Record<string, string> = {
  '01': 'Real content tagged',
  '02': 'Role mapping',
  '03': 'Flickering',
  '04': 'Color and contrast',
  '06': 'Metadata',
  '07': 'Dictionary',
  '08': 'OCR validation',
  '09': 'Appropriate tags',
  '10': 'Character mappings',
  '11': 'Declared natural language',
  '13': 'Graphics',
  '14': 'Headings',
  '15': 'Tables',
  '16': 'Lists',
  '17': 'Mathematical expressions',
  '18': 'Page headers and footers',
  '19': 'Notes and references',
  '20': 'Optional content',
  '21': 'Embedded files',
  '25': 'XFA',
  '26': 'Security',
  '28': 'Annotations',
  '30': 'XObjects',
  '31': 'Fonts',
};

/** Machine-checked checkpoints (the others are for a person). */
const MACHINE = ['01', '02', '06', '07', '09', '10', '11', '13', '14', '15', '16', '17', '19', '20', '21', '25', '26', '28', '30', '31'];

export const MANUAL_CHECKS: ManualCheck[] = [
  { checkpoint: '01', title: 'Artifacts and real content', guidance: 'Decoration (page numbers, running headers, lines, backgrounds) is marked as artifact and everything meaningful is tagged. Use Reading order to see what is tagged.' },
  { checkpoint: '04', title: 'Colour and contrast', guidance: 'Colour is never the only way information is given (e.g. “required fields in red”), and text has enough contrast against its background (WCAG: 4.5:1, large text 3:1).' },
  { checkpoint: '08', title: 'Recognised text', guidance: 'For scanned pages, the recognised (OCR) text matches the page: proof-read it before tagging.' },
  { checkpoint: '09', title: 'Logical reading order', guidance: 'Tags follow the order in which the page is meant to be read (columns, sidebars, captions after their figure). Check it with Accessibility → Reading order.' },
  { checkpoint: '09', title: 'Tags match the meaning', guidance: 'Headings are tagged as headings, lists as lists, tables as tables, quotes as quotes; nothing is tagged only for its looks.' },
  { checkpoint: '13', title: 'Meaningful alternate text', guidance: 'Each figure’s alternate text says what the picture shows or means in context; decorative pictures are artifacts instead.' },
  { checkpoint: '14', title: 'Headings', guidance: 'Headings describe the sections that follow and their levels reflect the document outline.' },
  { checkpoint: '15', title: 'Table structure', guidance: 'Only real data tables are tagged as tables; header cells are TH with the right scope.' },
  { checkpoint: '06', title: 'Document title', guidance: 'The title identifies the document (not a file name such as “Document1”).' },
  { checkpoint: '11', title: 'Language', guidance: 'The declared language is the language of the text; passages in other languages carry their own language on their tag.' },
  { checkpoint: '28', title: 'Annotation order and purpose', guidance: 'Links, fields and comments come in a sensible tab order and their descriptions say what they do.' },
];

// ---------------------------------------------------------------- helpers

const deref = (doc: PDFDocument, v: PDFObject | undefined) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
const isTrue = (v: PDFObject | undefined) => v instanceof PDFBool && v.asBoolean();
const nameOf = (v: PDFObject | undefined) => (v instanceof PDFName ? v.decodeText() : '');

/** An attribute of a structure element (/A dicts or arrays of dicts, any owner unless given). */
export function structAttr(doc: PDFDocument, d: PDFDict, key: string, owner?: string): PDFObject | undefined {
  const a = deref(doc, d.get(PDFName.of('A')));
  const list = a instanceof PDFArray ? a.asArray().map((x) => deref(doc, x)) : [a];
  for (const x of list) {
    if (!(x instanceof PDFDict)) continue;
    if (owner && nameOf(x.lookup(PDFName.of('O'))) !== owner) continue;
    const v = x.get(PDFName.of(key));
    if (v !== undefined) return deref(doc, v);
  }
  return undefined;
}

export interface AnnotInfo {
  ref: PDFRef | null;
  dict: PDFDict;
  subtype: string;
  page: number;
  hidden: boolean;
}

export function pageAnnots(doc: PDFDocument, page: PDFPage, pi: number): AnnotInfo[] {
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  const out: AnnotInfo[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const r = annots.get(i);
    const a = deref(doc, r);
    if (!(a instanceof PDFDict)) continue;
    const f = a.lookup(PDFName.of('F'));
    out.push({ ref: r instanceof PDFRef ? r : null, dict: a, subtype: nameOf(a.lookup(PDFName.of('Subtype'))), page: pi, hidden: f instanceof PDFNumber && (f.asNumber() & 2) !== 0 });
  }
  return out;
}

function rectBox(a: PDFDict): Box | null {
  const r = a.lookup(PDFName.of('Rect'));
  if (!(r instanceof PDFArray) || r.size() !== 4) return null;
  const v = r.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
  return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

/** Field dictionary of a widget: TU on the widget or up its /Parent chain. */
export function fieldTU(w: PDFDict): string {
  let d: PDFDict | undefined = w;
  for (let i = 0; d && i < 20; i++) {
    const tu = textOf(d.lookup(PDFName.of('TU')));
    if (tu.trim()) return tu;
    const p: PDFObject | undefined = d.lookup(PDFName.of('Parent'));
    d = p instanceof PDFDict ? p : undefined;
  }
  return '';
}

export function fontEmbedded(f: PDFDict): boolean {
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

const CJK_ORDERINGS = new Set(['GB1', 'CNS1', 'Japan1', 'Korea1']);

/** Whether text in this font maps to Unicode (ISO 32000-1 §9.10.2). */
export function fontHasUnicode(doc: PDFDocument, f: PDFDict): boolean {
  if (f.has(PDFName.of('ToUnicode'))) return true;
  const sub = nameOf(f.lookup(PDFName.of('Subtype')));
  const base = nameOf(f.lookup(PDFName.of('BaseFont'))).replace(/^[A-Z]{6}\+/, '');
  if (sub === 'Type0') {
    const descs = f.lookup(PDFName.of('DescendantFonts'));
    const desc = descs instanceof PDFArray ? descs.lookup(0) : null;
    const csi = desc instanceof PDFDict ? desc.lookup(PDFName.of('CIDSystemInfo')) : null;
    const ord = csi instanceof PDFDict ? textOf(csi.lookup(PDFName.of('Ordering'))) : '';
    return CJK_ORDERINGS.has(ord);
  }
  const enc = deref(doc, f.get(PDFName.of('Encoding')));
  const diffNamesKnown = (e: PDFDict) => {
    const diffs = e.lookup(PDFName.of('Differences'));
    if (!(diffs instanceof PDFArray)) return true;
    return diffs.asArray().every((x) => !(x instanceof PDFName) || !!glyphNameToUnicode(x.decodeText()) || /^(uni[0-9A-F]{4,}|u[0-9A-F]{4,6})$/.test(x.decodeText()));
  };
  if (sub === 'Type3') return enc instanceof PDFDict && diffNamesKnown(enc);
  if (enc instanceof PDFName) return true;
  if (enc instanceof PDFDict) return diffNamesKnown(enc);
  // No encoding: the font's built-in one. Symbolic TrueType fonts have no glyph names to go by.
  const fd = f.lookup(PDFName.of('FontDescriptor'));
  const flags = fd instanceof PDFDict ? fd.lookup(PDFName.of('Flags')) : undefined;
  const symbolic = flags instanceof PDFNumber && (flags.asNumber() & 4) !== 0;
  if (sub === 'TrueType' && symbolic) return false;
  if (/^(Symbol|ZapfDingbats)$/.test(base)) return true;
  return true;
}

/** Fonts used by text on a page (also inside its Form XObjects), by object: dict + visible use. */
function pageFonts(doc: PDFDocument, page: PDFPage, w: ContentWalk, res: PDFDict | undefined, into: Map<string, { dict: PDFDict; visible: boolean; page: number; name: string }>, pi: number, depth = 0, seenForms = new Set<string>()): void {
  const fonts = res?.lookup(PDFName.of('Font'));
  for (const [key, visible] of w.fonts) {
    const r = fonts instanceof PDFDict ? fonts.get(PDFName.of(key)) : undefined;
    const f = deref(doc, r);
    if (!(f instanceof PDFDict)) continue;
    const id = r instanceof PDFRef ? idOf(r) : `${pi}:${key}`;
    const cur = into.get(id);
    if (cur) cur.visible ||= visible;
    else into.set(id, { dict: f, visible, page: pi, name: nameOf(f.lookup(PDFName.of('BaseFont'))).replace(/^[A-Z]{6}\+/, '') || key });
  }
  if (depth > 3) return;
  const xo = res?.lookup(PDFName.of('XObject'));
  if (!(xo instanceof PDFDict)) return;
  for (const op of w.ops) {
    if (op.kind !== 'form' || !op.name) continue;
    const r = xo.get(PDFName.of(op.name));
    const s = deref(doc, r);
    if (!(s instanceof PDFRawStream)) continue;
    const id = r instanceof PDFRef ? idOf(r) : op.name;
    if (seenForms.has(id)) continue;
    seenForms.add(id);
    try {
      const fr = s.dict.lookup(PDFName.of('Resources'));
      const formRes = fr instanceof PDFDict ? fr : res;
      const fw = walkContent(doc, decodePDFRawStream(s).decode(), formRes);
      pageFonts(doc, page, fw, formRes, into, pi, depth + 1, seenForms);
    } catch {
      /* unreadable form */
    }
  }
}

const HEADING = /^H([1-6])$/;
const LIST_LABEL = /^\s*(?:\(?([0-9]+|[a-z]|[ivxlcdm]+|[A-Z]|[IVXLCDM]+)[.)\]:]?)\s*$/;

/** ListNumbering value for list labels ("1.", "a)", "iv."…), or null for bullets. */
export function numberingOf(labels: string[]): string | null {
  const ls = labels.map((l) => l.trim()).filter(Boolean);
  if (!ls.length) return null;
  const m = ls.map((l) => LIST_LABEL.exec(l)?.[1] ?? null);
  if (m.some((x) => x === null)) return null;
  const all = (re: RegExp) => m.every((x) => re.test(x!));
  if (all(/^[0-9]+$/)) return 'Decimal';
  if (all(/^[ivxlcdm]+$/) && ls.length > 1 && m[0] === 'i') return 'LowerRoman';
  if (all(/^[IVXLCDM]+$/) && ls.length > 1 && m[0] === 'I') return 'UpperRoman';
  if (all(/^[a-z]$/)) return 'LowerAlpha';
  if (all(/^[A-Z]$/)) return 'UpperAlpha';
  return null;
}

// ---------------------------------------------------------------- checker

export async function checkPdfUa(bytes: Uint8Array): Promise<UaReport> {
  const doc = await loadEditable(bytes, { ignoreEncryption: true, updateMetadata: false });
  return checkPdfUaDoc(doc);
}

export function checkPdfUaDoc(doc: PDFDocument): UaReport {
  const issues: UaIssue[] = [];
  const add = (i: UaIssue) => issues.push(i);
  const pages = doc.getPages();
  const st = readStructure(doc);
  const tagged = !!st;
  const walks: Array<ContentWalk | null> = pages.map((p) => {
    try {
      return walkPage(doc, p);
    } catch {
      return null;
    }
  });
  const mcBoxes = walks.map((w) => (w ? mcidContent(w) : new Map()));
  const nodeBox = (n: StructNode): Box | null => {
    let b: Box | null = null;
    const visit = (x: StructNode, d: number) => {
      for (const m of x.mcids) if (m.page >= 0 && !m.stream) b = unionBox(b, mcBoxes[m.page]?.get(m.mcid)?.box ?? null);
      if (d < 6) for (const c of x.children) visit(c, d + 1);
    };
    visit(n, 0);
    return b;
  };
  const nodePage = (n: StructNode) => {
    const ps = [...contentPages(n)];
    return ps.length ? Math.min(...ps) : n.page >= 0 ? n.page : null;
  };
  const tagIssue = (n: StructNode, checkpoint: string, condition: string, message: string, fix: UaFix | null = null, confirm = false): UaIssue => ({
    checkpoint,
    condition,
    message,
    page: nodePage(n),
    object: n.id,
    tag: n.type,
    box: nodeBox(n),
    fix,
    ...(confirm ? { confirm } : {}),
  });

  // ---- 01 real content tagged, MarkInfo
  const markInfo = doc.catalog.lookup(PDFName.of('MarkInfo'));
  if (!tagged) add({ checkpoint: '01', condition: '01-005', message: 'The document is not tagged: no content is tagged as real content or marked as artifact.', page: null, fix: 'tagDocument' });
  if (!(markInfo instanceof PDFDict) || !isTrue(markInfo.lookup(PDFName.of('Marked'))))
    add({ checkpoint: '01', condition: '§7.1', message: 'The MarkInfo dictionary of the catalog does not say the document is tagged (Marked is not true).', page: null, fix: tagged ? 'marked' : 'tagDocument' });
  if (markInfo instanceof PDFDict && isTrue(markInfo.lookup(PDFName.of('Suspects'))))
    add({ checkpoint: '01', condition: '01-007', message: 'The Suspects entry is true: the tags may not be reliable.', page: null, fix: 'suspects' });

  const parentTree = tagged ? readParentTree(doc) : new Map<number, PDFObject>();
  if (tagged) {
    walks.forEach((w, pi) => {
      if (!w) return;
      const untagged = w.ops.filter(isUntagged);
      if (untagged.length) {
        const box = untagged.reduce<Box | null>((b, o) => unionBox(b, o.box), null);
        const kinds = [...new Set(untagged.map((o) => o.kind))];
        add({ checkpoint: '01', condition: '01-005', message: `${untagged.length} piece(s) of content (${kinds.join(', ')}) are neither tagged nor marked as artifact.`, page: pi, box, fix: 'untagged' });
      }
      for (const s of w.seqs) {
        const inside = w.ops.filter((o) => o.instr > s.open && (s.close < 0 || o.instr < s.close));
        const box = inside.reduce<Box | null>((b, o) => unionBox(b, o.box), null);
        if (s.tag === 'Artifact' && s.inTagged) add({ checkpoint: '01', condition: '01-003', message: 'Content marked as artifact is inside tagged content.', page: pi, box, fix: null });
        if (s.mcid !== null && s.inArtifact) add({ checkpoint: '01', condition: '01-004', message: `Tagged content (MCID ${s.mcid}) is inside content marked as artifact.`, page: pi, box, fix: null });
      }
      // Marked content the structure tree does not reach.
      const sp = pages[pi].node.lookup(PDFName.of('StructParents'));
      const arr = sp instanceof PDFNumber ? deref(doc, parentTree.get(sp.asNumber())) : undefined;
      const lost = w.seqs.filter((s) => s.mcid !== null && !s.inArtifact && !(arr instanceof PDFArray && deref(doc, arr.get(s.mcid)) instanceof PDFDict));
      if (lost.length) {
        const box = w.ops.filter((o) => lost.some((s) => s.mcid === o.mcid)).reduce<Box | null>((b, o) => unionBox(b, o.box), null);
        add({ checkpoint: '01', condition: '01-005', message: `${lost.length} marked-content sequence(s) are not referenced from the structure tree (ParentTree).`, page: pi, box, fix: null });
      }
    });
  }

  // ---- 02 role mapping
  if (st) {
    const reported = new Set<string>();
    for (const n of st.nodes) {
      if (STANDARD_TYPES.has(n.type) || reported.has(n.type)) continue;
      reported.add(n.type);
      const r = resolveRole(n.type, st.roleMap);
      if (r.circular) add({ ...tagIssue(n, '02', '02-003', `The role mapping of <${n.type}> is circular.`, 'roleMap') });
      else if (!STANDARD_TYPES.has(r.role)) add({ ...tagIssue(n, '02', '02-001', `<${n.type}> is not a standard type and is not role-mapped to one.`, 'roleMap') });
    }
    for (const [k, v] of st.roleMap) if (STANDARD_TYPES.has(k)) add({ checkpoint: '02', condition: '02-004', message: `The standard type <${k}> is remapped (to <${v}>).`, page: null, tag: k, fix: 'roleMap' });
  }

  // ---- 06 metadata
  const xmp = readXmpPacket(doc);
  if (!xmp) add({ checkpoint: '06', condition: '06-001', message: 'The document has no XMP metadata stream.', page: null, fix: 'metadata' });
  else {
    if (!/pdfuaid:part\s*(=\s*["']1["']|>\s*1\s*<)/.test(xmp)) add({ checkpoint: '06', condition: '06-002', message: 'The metadata does not include the PDF/UA identifier (pdfuaid:part = 1).', page: null, fix: 'metadata' });
    const t = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp)?.[1]?.trim();
    if (!t) add({ checkpoint: '06', condition: '06-003', message: 'The metadata does not contain a title (dc:title).', page: null, fix: 'metadata' });
  }

  // ---- 07 dictionary
  const vp = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
  const ddt = vp instanceof PDFDict ? vp.lookup(PDFName.of('DisplayDocTitle')) : undefined;
  if (ddt === undefined) add({ checkpoint: '07', condition: '07-001', message: 'ViewerPreferences has no DisplayDocTitle entry: the window shows the file name instead of the title.', page: null, fix: 'displayDocTitle' });
  else if (!isTrue(ddt)) add({ checkpoint: '07', condition: '07-002', message: 'DisplayDocTitle is false: the window shows the file name instead of the title.', page: null, fix: 'displayDocTitle' });

  // ---- 09 appropriate tags (nesting)
  if (st) {
    const role = (n: StructNode | null | undefined) => (n ? n.role : '');
    const kidsRoles = (n: StructNode) => n.children.map((c) => c.role);
    const needParent: Record<string, { parents: string[]; cond: string }> = {
      TR: { parents: ['Table', 'THead', 'TBody', 'TFoot'], cond: '09-004' },
      TH: { parents: ['TR'], cond: '09-004' },
      TD: { parents: ['TR'], cond: '09-004' },
      THead: { parents: ['Table'], cond: '09-004' },
      TBody: { parents: ['Table'], cond: '09-004' },
      TFoot: { parents: ['Table'], cond: '09-004' },
      LI: { parents: ['L'], cond: '09-005' },
      Lbl: { parents: ['LI', 'TOCI', 'BibEntry', 'Note', 'Reference'], cond: '09-005' },
      LBody: { parents: ['LI'], cond: '09-005' },
      TOCI: { parents: ['TOC'], cond: '09-006' },
      RB: { parents: ['Ruby'], cond: '09-007' },
      RT: { parents: ['Ruby'], cond: '09-007' },
      RP: { parents: ['Ruby'], cond: '09-007' },
      WT: { parents: ['Warichu'], cond: '09-008' },
      WP: { parents: ['Warichu'], cond: '09-008' },
    };
    const allowedKids: Record<string, { kids: string[]; cond: string; fix?: UaFix; content?: boolean }> = {
      Table: { kids: ['TR', 'THead', 'TBody', 'TFoot', 'Caption'], cond: '09-004' },
      THead: { kids: ['TR'], cond: '09-004' },
      TBody: { kids: ['TR'], cond: '09-004' },
      TFoot: { kids: ['TR'], cond: '09-004' },
      TR: { kids: ['TH', 'TD'], cond: '09-004' },
      L: { kids: ['LI', 'L', 'Caption'], cond: '09-005', fix: 'listBody' },
      LI: { kids: ['Lbl', 'LBody'], cond: '09-005', fix: 'listBody' },
      TOC: { kids: ['TOCI', 'TOC', 'Caption'], cond: '09-006' },
      Ruby: { kids: ['RB', 'RT', 'RP'], cond: '09-007' },
      Warichu: { kids: ['WT', 'WP'], cond: '09-008' },
    };
    for (const n of st.nodes) {
      const np = needParent[n.role];
      if (np && !np.parents.includes(role(n.parent))) {
        add(tagIssue(n, '09', np.cond, `<${n.type}> must be inside ${np.parents.map((p) => `<${p}>`).join(' / ')}, not ${n.parent ? `<${n.parent.type}>` : 'the root'}.`));
      }
      const ak = allowedKids[n.role];
      if (ak) {
        const bad = kidsRoles(n).filter((r) => !ak.kids.includes(r));
        const direct = n.mcids.length > 0 || (n.objrs.length > 0 && n.role !== 'LI');
        if (bad.length || direct) add(tagIssue(n, '09', ak.cond, `<${n.type}> may only contain ${ak.kids.map((k) => `<${k}>`).join(', ')}${bad.length ? `; it contains <${[...new Set(bad)].join('>, <')}>` : ''}${direct ? `${bad.length ? ' and' : ';'} content directly` : ''}.`, ak.fix ?? null));
      }
    }
  }

  // ---- 10 character mappings, 31 fonts
  const fonts = new Map<string, { dict: PDFDict; visible: boolean; page: number; name: string }>();
  walks.forEach((w, pi) => {
    if (!w) return;
    pageFonts(doc, pages[pi], w, resourcesOf(pages[pi]), fonts, pi);
  });
  for (const [id, f] of fonts) {
    const object = /^\d+-\d+$/.test(id) ? id : undefined;
    if (!fontHasUnicode(doc, f.dict)) add({ checkpoint: '10', condition: '10-001', message: `Text in the font “${f.name}” cannot be mapped to Unicode (no ToUnicode map).`, page: f.page, object, fix: null });
    checkFont(doc, f, object, add);
  }

  // ---- 11 natural language
  const lang = textOf(doc.catalog.lookup(PDFName.of('Lang'))).trim();
  const validLang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang);
  if (!validLang) {
    const hasLang = (n: StructNode | null): boolean => !!n && (!!textOf(n.dict.lookup(PDFName.of('Lang'))).trim() || hasLang(n.parent));
    const anyText = walks.some((w) => w?.ops.some((o) => o.kind === 'text'));
    const what = lang ? `The document language “${lang}” is not a valid language tag` : 'The document has no language (Lang)';
    if (anyText && !(st && st.top.length && st.top.every((t) => hasLang(t)))) add({ checkpoint: '11', condition: '11-001', message: `${what}: the language of the page text cannot be determined.`, page: null, fix: 'language' });
    if (st?.nodes.some((n) => textOf(n.dict.lookup(PDFName.of('Alt'))).trim() && !hasLang(n))) add({ checkpoint: '11', condition: '11-002', message: `${what}: the language of alternate text cannot be determined.`, page: null, fix: 'language' });
    if (st?.nodes.some((n) => textOf(n.dict.lookup(PDFName.of('ActualText'))).trim() && !hasLang(n))) add({ checkpoint: '11', condition: '11-003', message: `${what}: the language of replacement (ActualText) text cannot be determined.`, page: null, fix: 'language' });
    if (st?.nodes.some((n) => textOf(n.dict.lookup(PDFName.of('E'))).trim() && !hasLang(n))) add({ checkpoint: '11', condition: '11-004', message: `${what}: the language of expansion (E) text cannot be determined.`, page: null, fix: 'language' });
    if (pages.some((p, pi) => pageAnnots(doc, p, pi).some((a) => textOf(a.dict.lookup(PDFName.of('Contents'))).trim()))) add({ checkpoint: '11', condition: '11-005', message: `${what}: the language of annotation descriptions cannot be determined.`, page: null, fix: 'language' });
    if (pages.some((p, pi) => pageAnnots(doc, p, pi).some((a) => a.subtype === 'Widget' && fieldTU(a.dict)))) add({ checkpoint: '11', condition: '11-006', message: `${what}: the language of form field descriptions (TU) cannot be determined.`, page: null, fix: 'language' });
    if (doc.catalog.lookup(PDFName.of('Outlines')) instanceof PDFDict) add({ checkpoint: '11', condition: '11-007', message: `${what}: the language of the bookmarks cannot be determined.`, page: null, fix: 'language' });
  }

  if (st) {
    // ---- 13 graphics, 17 formulas
    for (const n of st.nodes) {
      const alt = textOf(n.dict.lookup(PDFName.of('Alt'))).trim() || textOf(n.dict.lookup(PDFName.of('ActualText'))).trim();
      if (n.role === 'Figure' && !alt) add(tagIssue(n, '13', '13-004', 'A figure has no alternate text: describe it, or mark it as artifact when it is only decoration.'));
      if (n.role === 'Formula' && !alt) add(tagIssue(n, '17', '17-002', 'A formula has no alternate text.'));
    }

    // ---- 14 headings
    const heads = st.nodes.filter((n) => HEADING.test(n.role) || n.role === 'H');
    const numbered = heads.filter((n) => HEADING.test(n.role));
    if (numbered.length && numbered[0].role !== 'H1') add(tagIssue(numbered[0], '14', '14-002', `The first numbered heading is <${numbered[0].role}>, not <H1>.`));
    for (let i = 1; i < numbered.length; i++) {
      const a = Number(HEADING.exec(numbered[i - 1].role)![1]);
      const b = Number(HEADING.exec(numbered[i].role)![1]);
      if (b > a + 1) add(tagIssue(numbered[i], '14', '14-003', `Heading levels are skipped: <H${b}> follows <H${a}>.`));
    }
    for (const n of st.nodes) if (n.children.filter((c) => c.role === 'H').length > 1) add(tagIssue(n, '14', '14-006', `<${n.type}> contains more than one <H> heading.`));
    if (numbered.length && heads.some((h) => h.role === 'H')) add({ checkpoint: '14', condition: '14-007', message: 'The document uses both <H> and numbered <H1>–<H6> headings.', page: null, fix: null });

    // ---- 15 tables
    for (const t of st.nodes.filter((n) => n.role === 'Table')) {
      const cells: StructNode[] = [];
      const collect = (n: StructNode) => n.children.forEach((c) => (c.role === 'TH' || c.role === 'TD' ? cells.push(c) : ['TR', 'THead', 'TBody', 'TFoot'].includes(c.role) ? collect(c) : undefined));
      collect(t);
      const withHeaders = cells.filter((c) => structAttr(doc, c.dict, 'Headers') instanceof PDFArray);
      if (withHeaders.length) {
        const ids = new Set(cells.map((c) => textOf(c.dict.lookup(PDFName.of('ID')))).filter(Boolean));
        for (const c of withHeaders) {
          const h = structAttr(doc, c.dict, 'Headers') as PDFArray;
          const missing = h.asArray().map((x) => textOf(deref(doc, x))).filter((x) => !ids.has(x));
          if (missing.length) add(tagIssue(c, '15', '15-005', `A table cell refers to header cells that do not exist (${missing.slice(0, 3).join(', ')}).`));
        }
      } else {
        for (const c of cells) if (c.role === 'TH' && !(structAttr(doc, c.dict, 'Scope', 'Table') instanceof PDFName)) add(tagIssue(c, '15', '15-003', 'A table header cell (TH) has no Scope (Row, Column or Both).', 'thScope', true));
      }
    }

    // ---- 16 lists
    for (const l of st.nodes.filter((n) => n.role === 'L')) {
      const labels = l.children
        .filter((c) => c.role === 'LI')
        .map((li) => li.children.find((c) => c.role === 'Lbl'))
        .filter((x): x is StructNode => !!x)
        .map((lbl) => textOf(lbl.dict.lookup(PDFName.of('ActualText'))) || lbl.mcids.map((m) => (m.page >= 0 ? (mcBoxes[m.page]?.get(m.mcid)?.text ?? '') : '')).join(''));
      const want = numberingOf(labels);
      const has = structAttr(doc, l.dict, 'ListNumbering', 'List');
      if (want && (!(has instanceof PDFName) || has.decodeText() === 'None')) add(tagIssue(l, '16', '16-002', `A numbered list (labels like “${labels[0].trim()}”) has no ListNumbering attribute.`, 'listNumbering'));
    }

    // ---- 19 notes
    const noteIds = new Map<string, number>();
    for (const n of st.nodes.filter((x) => x.role === 'Note')) {
      const id = textOf(n.dict.lookup(PDFName.of('ID')));
      if (!id) add(tagIssue(n, '19', '19-003', 'A note (<Note>) has no ID.', 'noteIds'));
      else noteIds.set(id, (noteIds.get(id) ?? 0) + 1);
    }
    for (const n of st.nodes.filter((x) => x.role === 'Note')) {
      const id = textOf(n.dict.lookup(PDFName.of('ID')));
      if (id && (noteIds.get(id) ?? 0) > 1) add(tagIssue(n, '19', '19-004', `The note ID “${id}” is used more than once.`, 'noteIds'));
    }
  }

  // ---- 20 optional content
  const ocp = doc.catalog.lookup(PDFName.of('OCProperties'));
  if (ocp instanceof PDFDict) {
    const configs = ocp.lookup(PDFName.of('Configs'));
    const list: Array<[PDFDict, boolean]> = [];
    const d = ocp.lookup(PDFName.of('D'));
    if (d instanceof PDFDict) list.push([d, true]);
    if (configs instanceof PDFArray) for (const c of configs.asArray()) {
      const cd = deref(doc, c);
      if (cd instanceof PDFDict) list.push([cd, false]);
    }
    for (const [c, isD] of list) {
      if (!textOf(c.lookup(PDFName.of('Name'))).trim()) add({ checkpoint: '20', condition: isD ? '20-002' : '20-001', message: `An optional content (layer) configuration${isD ? ' (the default one)' : ''} has no name.`, page: null, fix: 'ocConfig' });
      if (c.has(PDFName.of('AS'))) add({ checkpoint: '20', condition: '20-003', message: 'An optional content configuration has an AS entry (layers switched automatically).', page: null, fix: 'ocConfig' });
    }
  }

  // ---- 21 embedded files
  for (const fs of fileSpecs(doc)) {
    if (!fs.dict.has(PDFName.of('F')) || !fs.dict.has(PDFName.of('UF'))) add({ checkpoint: '21', condition: '21-001', message: `The embedded file “${fs.name}” has no ${fs.dict.has(PDFName.of('F')) ? 'UF' : fs.dict.has(PDFName.of('UF')) ? 'F' : 'F and UF'} file name entry.`, page: fs.page, fix: 'fileSpec' });
  }

  // ---- 25 XFA
  const packets = readXfaPackets(doc);
  const config = packets?.find(([n]) => n === 'config')?.[1] ?? '';
  if (/<dynamicRender>\s*required\s*<\/dynamicRender>/.test(config) || (packets && xfaKindOf(doc) === 'dynamic'))
    add({ checkpoint: '25', condition: '25-001', message: 'The document is a dynamic XFA form (dynamicRender required), which PDF/UA does not allow.', page: null, fix: null });

  // ---- 26 security
  const enc = deref(doc, doc.context.trailerInfo.Encrypt as PDFObject | undefined);
  if (enc instanceof PDFDict) {
    const p = enc.lookup(PDFName.of('P'));
    if (!(p instanceof PDFNumber)) add({ checkpoint: '26', condition: '26-001', message: 'The document is encrypted but its permissions (P) are missing.', page: null, fix: null });
    else if ((p.asNumber() & 512) === 0) add({ checkpoint: '26', condition: '26-002', message: 'The document is encrypted and does not allow content extraction for accessibility (permission bit 10).', page: null, fix: null });
  }

  // ---- 28 annotations
  const objrNode = new Map<string, StructNode>();
  if (st) for (const n of st.nodes) for (const o of n.objrs) objrNode.set(idOf(o.obj), n);
  const nodeByDict = new Map<PDFDict, StructNode>();
  if (st) for (const n of st.nodes) nodeByDict.set(n.dict, n);
  pages.forEach((page, pi) => {
    const annots = pageAnnots(doc, page, pi).filter((a) => a.subtype !== 'Popup');
    if (!annots.length) return;
    const tabs = page.node.lookup(PDFName.of('Tabs'));
    if (!(tabs instanceof PDFName)) add({ checkpoint: '28', condition: '28-008', message: 'A page with annotations has no tab order (Tabs).', page: pi, fix: 'tabs' });
    else if (tabs.decodeText() !== 'S') add({ checkpoint: '28', condition: '28-009', message: `A page with annotations uses the tab order “${tabs.decodeText()}” instead of the structure order (S).`, page: pi, fix: 'tabs' });
    for (const a of annots) {
      const object = a.ref ? idOf(a.ref) : undefined;
      const box = rectBox(a.dict);
      let node = a.ref ? objrNode.get(idOf(a.ref)) : undefined;
      if (!node && st) {
        const sp = a.dict.lookup(PDFName.of('StructParent'));
        const v = sp instanceof PDFNumber ? deref(doc, parentTree.get(sp.asNumber())) : undefined;
        if (v instanceof PDFDict) node = nodeByDict.get(v);
      }
      const base = { page: pi, object, box, tag: node?.type };
      if (a.subtype === 'TrapNet') {
        add({ ...base, checkpoint: '28', condition: '28-007', message: 'The page has a TrapNet annotation.', fix: null });
        continue;
      }
      if (a.subtype === 'PrinterMark') {
        if (node) add({ ...base, checkpoint: '28', condition: '28-017', message: 'A printer’s mark annotation is included in the structure tree.', fix: null });
        continue;
      }
      if (a.hidden) continue;
      if (a.subtype === 'Widget') {
        if (!node || node.role !== 'Form') add({ ...base, checkpoint: '28', condition: '28-010', message: node ? `A form field is tagged <${node.type}>, not <Form>.` : 'A form field is not in the structure tree (no <Form> tag).', fix: node ? null : 'annotTags' });
        if (!fieldTU(a.dict) && !(node && textOf(node.dict.lookup(PDFName.of('Alt'))).trim())) add({ ...base, checkpoint: '28', condition: '28-005', message: 'A form field has no description (TU tooltip or Alt).', fix: 'fieldTU' });
      } else if (a.subtype === 'Link') {
        if (!node || node.role !== 'Link') add({ ...base, checkpoint: '28', condition: '28-011', message: node ? `A link is tagged <${node.type}>, not <Link>.` : 'A link is not in the structure tree (no <Link> tag).', fix: node ? null : 'annotTags' });
        if (!textOf(a.dict.lookup(PDFName.of('Contents'))).trim()) add({ ...base, checkpoint: '28', condition: '28-012', message: 'A link has no description (Contents).', fix: 'linkContents' });
      } else {
        if (!node || node.role !== 'Annot') add({ ...base, checkpoint: '28', condition: '28-002', message: node ? `A ${a.subtype} annotation is tagged <${node.type}>, not <Annot>.` : `A ${a.subtype} annotation is not in the structure tree (no <Annot> tag).`, fix: node ? null : 'annotTags' });
        if (!textOf(a.dict.lookup(PDFName.of('Contents'))).trim() && !(node && textOf(node.dict.lookup(PDFName.of('Alt'))).trim()))
          add({ ...base, checkpoint: '28', condition: '28-004', message: `A ${a.subtype} annotation has no description (Contents or Alt).`, fix: null });
      }
    }
  });

  // ---- 30 XObjects
  const formUse = new Map<string, { count: number; tagged: boolean; page: number; ref: boolean }>();
  walks.forEach((w, pi) => {
    if (!w) return;
    const res = resourcesOf(pages[pi]);
    const xo = res?.lookup(PDFName.of('XObject'));
    for (const op of w.ops) {
      if (op.kind !== 'form' || !op.name || !(xo instanceof PDFDict)) continue;
      const r = xo.get(PDFName.of(op.name));
      const s = deref(doc, r);
      if (!(s instanceof PDFStream)) continue;
      const id = r instanceof PDFRef ? idOf(r) : `${pi}:${op.name}`;
      const u = formUse.get(id) ?? { count: 0, tagged: !!op.formTagged, page: pi, ref: s.dict.has(PDFName.of('Ref')) };
      u.count++;
      formUse.set(id, u);
    }
  });
  for (const [id, u] of formUse) {
    if (u.ref) add({ checkpoint: '30', condition: '30-001', message: 'A reference XObject (content imported from another file) is used.', page: u.page, object: id, fix: null });
    if (u.tagged && u.count > 1) add({ checkpoint: '30', condition: '30-002', message: `A Form XObject with tagged content (MCIDs) is drawn ${u.count} times.`, page: u.page, object: id, fix: null });
  }

  const failing = new Set(issues.map((i) => i.checkpoint));
  const manualIds = new Set(MANUAL_CHECKS.map((m) => m.checkpoint));
  const ids = [...new Set([...MACHINE, ...manualIds])].sort();
  const checkpoints: CheckpointSummary[] = ids.map((id) => ({
    id,
    title: CHECKPOINTS[id] ?? id,
    status: failing.has(id) ? 'fail' : MACHINE.includes(id) ? 'pass' : 'manual',
    failures: issues.filter((i) => i.checkpoint === id).length,
  }));
  return { issues, manual: MANUAL_CHECKS, checkpoints, tagged, pages: pages.length };
}

/** File specifications of embedded files: the EmbeddedFiles name tree and file attachment annotations. */
export function fileSpecs(doc: PDFDocument): Array<{ dict: PDFDict; name: string; page: number | null }> {
  const out: Array<{ dict: PDFDict; name: string; page: number | null }> = [];
  const seen = new Set<PDFDict>();
  const push = (v: PDFObject | undefined, page: number | null, fallback: string) => {
    const d = deref(doc, v);
    if (!(d instanceof PDFDict) || seen.has(d)) return;
    const ef = d.lookup(PDFName.of('EF'));
    if (!(ef instanceof PDFDict)) return;
    seen.add(d);
    out.push({ dict: d, name: textOf(d.lookup(PDFName.of('UF'))) || textOf(d.lookup(PDFName.of('F'))) || fallback, page });
  };
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const ef = names instanceof PDFDict ? names.lookup(PDFName.of('EmbeddedFiles')) : undefined;
  const walk = (node: PDFObject | undefined, depth: number) => {
    const d = deref(doc, node);
    if (!(d instanceof PDFDict) || depth > 30) return;
    const arr = d.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) for (let i = 0; i + 1 < arr.size(); i += 2) push(arr.get(i + 1), null, textOf(arr.lookup(i)));
    const kids = d.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(k, depth + 1);
  };
  walk(ef, 0);
  doc.getPages().forEach((p, pi) => {
    for (const a of pageAnnots(doc, p, pi)) if (a.subtype === 'FileAttachment') push(a.dict.get(PDFName.of('FS')), pi, 'attachment');
  });
  return out;
}

/** 31: embedding, CID font structure, widths against the font program, CIDSet. */
function checkFont(doc: PDFDocument, f: { dict: PDFDict; visible: boolean; page: number; name: string }, object: string | undefined, add: (i: UaIssue) => void): void {
  const d = f.dict;
  const sub = nameOf(d.lookup(PDFName.of('Subtype')));
  const base = { checkpoint: '31', page: f.page, object, fix: null } as const;
  if (f.visible && !fontEmbedded(d)) {
    add({ ...base, condition: '31-009', message: `The font “${f.name}” is not embedded.` });
    return;
  }
  if (sub === 'Type0') {
    const descs = d.lookup(PDFName.of('DescendantFonts'));
    const desc = descs instanceof PDFArray ? descs.lookup(0) : null;
    if (!(desc instanceof PDFDict)) return;
    const enc = deref(doc, d.get(PDFName.of('Encoding')));
    const csi = desc.lookup(PDFName.of('CIDSystemInfo'));
    if (enc instanceof PDFStream) {
      const ecsi = enc.dict.lookup(PDFName.of('CIDSystemInfo'));
      if (ecsi instanceof PDFDict && csi instanceof PDFDict) {
        if (textOf(ecsi.lookup(PDFName.of('Registry'))) !== textOf(csi.lookup(PDFName.of('Registry')))) add({ ...base, condition: '31-001', message: `The font “${f.name}” and its CMap name different character collections (Registry).` });
        if (textOf(ecsi.lookup(PDFName.of('Ordering'))) !== textOf(csi.lookup(PDFName.of('Ordering')))) add({ ...base, condition: '31-002', message: `The font “${f.name}” and its CMap name different character orderings (Ordering).` });
      }
    } else if (enc instanceof PDFName && !/-[HV]$/.test(enc.decodeText())) add({ ...base, condition: '31-006', message: `The CMap “${enc.decodeText()}” of the font “${f.name}” is not embedded.` });
    const dsub = nameOf(desc.lookup(PDFName.of('Subtype')));
    const fd = desc.lookup(PDFName.of('FontDescriptor'));
    if (dsub === 'CIDFontType2' && fd instanceof PDFDict && fd.has(PDFName.of('FontFile2'))) {
      const map = desc.get(PDFName.of('CIDToGIDMap'));
      if (map === undefined) {
        add({ ...base, condition: '31-004', message: `The TrueType CID font “${f.name}” has no CIDToGIDMap.` });
        return;
      }
      if (map !== PDFName.of('Identity')) return;
      const prog = fontFile(doc, fd.get(PDFName.of('FontFile2')));
      if (!prog) return;
      // Widths of the W array against the font program.
      const w = desc.lookup(PDFName.of('W'));
      const off: string[] = [];
      const cmp = (cid: number, width: number) => {
        if (cid >= prog.numGlyphs || !prog.hasOutline(cid)) return;
        const real = (prog.advance(cid) * 1000) / prog.unitsPerEm;
        if (Math.abs(real - width) > 1) off.push(String(cid));
      };
      if (w instanceof PDFArray) for (let k = 0; k < w.size(); ) {
        const first = w.lookup(k);
        const next = w.lookup(k + 1);
        if (!(first instanceof PDFNumber)) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => x instanceof PDFNumber && cmp(first.asNumber() + j, x.asNumber()));
          k += 2;
        } else {
          const last = w.lookup(k + 1);
          const width = w.lookup(k + 2);
          if (last instanceof PDFNumber && width instanceof PDFNumber) for (let c = first.asNumber(); c <= last.asNumber() && c - first.asNumber() < 65536; c++) cmp(c, width.asNumber());
          k += 3;
        }
      }
      if (off.length) add({ ...base, condition: '§7.21.5', message: `The widths of ${off.length} glyph(s) of “${f.name}” differ from the embedded font program.` });
      const missing = cidSetMissing(doc, fd);
      if (missing) add({ ...base, condition: '§7.21.4.2', message: `The CIDSet of “${f.name}” does not list ${missing} glyph(s) of the embedded font.`, fix: 'cidSet' });
    }
    return;
  }
  if (sub === 'TrueType') {
    const fd = d.lookup(PDFName.of('FontDescriptor'));
    if (!(fd instanceof PDFDict) || !fd.has(PDFName.of('FontFile2'))) return;
    const prog = fontFile(doc, fd.get(PDFName.of('FontFile2')));
    const widths = d.lookup(PDFName.of('Widths'));
    const fc = d.lookup(PDFName.of('FirstChar'));
    if (!prog || !(widths instanceof PDFArray) || !(fc instanceof PDFNumber)) return;
    const flags = fd.lookup(PDFName.of('Flags'));
    const symbolic = flags instanceof PDFNumber && (flags.asNumber() & 4) !== 0;
    const enc = d.lookup(PDFName.of('Encoding'));
    const std = standardMaps();
    const off: number[] = [];
    widths.asArray().forEach((x, j) => {
      if (!(x instanceof PDFNumber)) return;
      const code = fc.asNumber() + j;
      let gid = 0;
      if (symbolic && !enc) gid = prog.lookup(3, 0, 0xf000 + code) || prog.lookup(3, 0, code) || prog.lookup(1, 0, code);
      else if (enc === PDFName.of('WinAnsiEncoding')) {
        const u = std.codeToUni.get(code);
        gid = u ? prog.gidForUnicode(u.codePointAt(0)!) : 0;
      }
      if (!gid || !prog.hasOutline(gid)) return;
      const real = (prog.advance(gid) * 1000) / prog.unitsPerEm;
      if (Math.abs(real - x.asNumber()) > 1) off.push(code);
    });
    if (off.length) add({ ...base, condition: '§7.21.5', message: `The widths of ${off.length} character(s) of “${f.name}” differ from the embedded font program.` });
  }
}

/** Glyphs of an embedded TrueType CID font (Identity CIDToGIDMap) that its CIDSet leaves out. */
export function cidSetMissing(doc: PDFDocument, fd: PDFDict): number {
  const cidSet = fd.lookup(PDFName.of('CIDSet'));
  if (!(cidSet instanceof PDFRawStream)) return 0;
  const prog = fontFile(doc, fd.get(PDFName.of('FontFile2')));
  if (!prog) return 0;
  let bits: Uint8Array;
  try {
    bits = decodePDFRawStream(cidSet).decode();
  } catch {
    return 0;
  }
  let missing = 0;
  for (let g = 0; g < prog.numGlyphs; g++) if (prog.hasOutline(g) && !((bits[g >> 3] ?? 0) & (0x80 >> (g & 7)))) missing++;
  return missing;
}

function fontFile(doc: PDFDocument, v: PDFObject | undefined) {
  const s = deref(doc, v);
  if (!(s instanceof PDFRawStream)) return null;
  try {
    return readFontProgram(decodePDFRawStream(s).decode());
  } catch {
    return null;
  }
}

/** Issues grouped by checkpoint, in checkpoint order. */
export function groupIssues(issues: UaIssue[]): Array<{ checkpoint: string; title: string; issues: UaIssue[] }> {
  const by = new Map<string, UaIssue[]>();
  for (const i of issues) by.set(i.checkpoint, [...(by.get(i.checkpoint) ?? []), i]);
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([checkpoint, list]) => ({ checkpoint, title: CHECKPOINTS[checkpoint] ?? checkpoint, issues: list }));
}

/** The fixes "Fix all safe issues" applies for these issues. */
export function safeFixes(issues: UaIssue[]): UaFix[] {
  return [...new Set(issues.filter((i) => i.fix && !i.confirm).map((i) => i.fix!))];
}

export type { Structure, StructNode };
