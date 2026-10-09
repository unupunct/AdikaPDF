/**
 * Builds tagged test PDFs for the PDF/UA checker and the reading-order
 * editor: page content written by hand (marked content, MCIDs), an embedded
 * TrueType font (Liberation Sans, Type0 Identity-H with ToUnicode), the
 * structure tree with its ParentTree, and the catalog entries PDF/UA wants.
 * With the defaults the result passes every machine check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFDict, type PDFObject, type PDFRef, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export interface TreeSpec {
  S: string;
  /** MCIDs on `page` (default 0). */
  mcid?: number | number[];
  page?: number;
  kids?: TreeSpec[];
  alt?: string;
  /** Extra entries (pdf-lib literal objects). */
  extra?: Record<string, unknown>;
}

export interface UaDocSpec {
  /** Content stream per page; `T` encodes text for /F1. */
  content?: (T: (s: string) => string) => string[];
  tree?: TreeSpec[] | null;
  lang?: string | null;
  title?: string | null;
  xmp?: 'full' | 'noUa' | 'noTitle' | null;
  displayDocTitle?: boolean | null;
  marked?: boolean;
  roleMap?: Record<string, string>;
  /** Last changes before saving (refs of the tree by spec order). */
  mutate?: (doc: PDFDocument, t: { font: PDFFont; elems: PDFRef[]; T: (s: string) => string }) => void | Promise<void>;
}

const FONT = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts', 'LiberationSans-Regular.ttf');

export const DEFAULT_CONTENT = (T: (s: string) => string) => [
  [
    '/Artifact BMC 0 0 1 RG 2 w 40 800 m 555 800 l S EMC',
    `/H1 <</MCID 0>> BDC BT /F1 24 Tf 60 760 Td ${T('Access guide')} Tj ET EMC`,
    `/P <</MCID 1>> BDC BT /F1 11 Tf 60 720 Td ${T('The building opens at eight.')} Tj ET EMC`,
  ].join('\n'),
];
export const DEFAULT_TREE: TreeSpec[] = [{ S: 'H1', mcid: 0 }, { S: 'P', mcid: 1 }];

export function xmpPacket(kind: 'full' | 'noUa' | 'noTitle', title = 'Access guide'): string {
  const ua = kind === 'noUa' ? '' : '<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description>';
  const dc = kind === 'noTitle' ? '' : `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title></rdf:Description>`;
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${ua}${dc}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

export async function uaDoc(spec: UaDocSpec = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(new Uint8Array(readFileSync(FONT)));
  const T = (s: string) => font.encodeText(s).toString();
  const ctx = doc.context;
  const contents = (spec.content ?? DEFAULT_CONTENT)(T);
  const pages = contents.map((c) => {
    const p = doc.addPage([595, 842]);
    p.node.newFontDictionary('F1', font.ref);
    p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(c)));
    return p;
  });
  const title = spec.title === undefined ? 'Access guide' : spec.title;
  if (title !== null) doc.setTitle(title);
  const lang = spec.lang === undefined ? 'en-US' : spec.lang;
  if (lang !== null) doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  const xmp = spec.xmp === undefined ? 'full' : spec.xmp;
  if (xmp) doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(xmpPacket(xmp, title ?? ''), { Type: 'Metadata', Subtype: 'XML' })));
  const ddt = spec.displayDocTitle === undefined ? true : spec.displayDocTitle;
  if (ddt !== null) doc.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: ddt }));

  const elems: PDFRef[] = [];
  const tree = spec.tree === undefined ? DEFAULT_TREE : spec.tree;
  if (tree) {
    const rootRef = ctx.nextRef();
    const docRef = ctx.nextRef();
    const parents: PDFObject[][] = pages.map(() => []);
    const build = (s: TreeSpec, parent: PDFRef, inheritPage: number): PDFRef => {
      const ref = ctx.nextRef();
      elems.push(ref);
      const page = s.page ?? inheritPage;
      const k: PDFObject[] = [];
      const ids = s.mcid === undefined ? [] : Array.isArray(s.mcid) ? s.mcid : [s.mcid];
      for (const m of ids) {
        k.push(PDFNumber.of(m));
        parents[page][m] = ref;
      }
      for (const c of s.kids ?? []) k.push(build(c, ref, page));
      const d = ctx.obj({ Type: 'StructElem', S: s.S, P: parent, Pg: pages[page].ref }) as PDFDict;
      if (k.length) d.set(PDFName.of('K'), k.length === 1 ? k[0] : ctx.obj(k));
      if (s.alt !== undefined) d.set(PDFName.of('Alt'), PDFHexString.fromText(s.alt));
      for (const [key, v] of Object.entries(s.extra ?? {})) d.set(PDFName.of(key), ctx.obj(v as never));
      ctx.assign(ref, d);
      return ref;
    };
    const top = tree.map((s) => build(s, docRef, 0));
    ctx.assign(docRef, ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: top }));
    const nums: PDFObject[] = [];
    pages.forEach((p, i) => {
      p.node.set(PDFName.of('StructParents'), PDFNumber.of(i));
      nums.push(PDFNumber.of(i), ctx.obj(Array.from({ length: parents[i].length }, (_, j) => parents[i][j] ?? null) as never));
    });
    const root = ctx.obj({ Type: 'StructTreeRoot', K: docRef, ParentTree: ctx.obj({ Nums: nums }), ParentTreeNextKey: pages.length }) as PDFDict;
    if (spec.roleMap) root.set(PDFName.of('RoleMap'), ctx.obj(Object.fromEntries(Object.entries(spec.roleMap).map(([k, v]) => [k, PDFName.of(v)]))));
    ctx.assign(rootRef, root);
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
    if (spec.marked !== false) doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  }
  await spec.mutate?.(doc, { font, elems, T });
  return doc.save({ useObjectStreams: false });
}
