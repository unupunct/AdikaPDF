/**
 * Review: the status of a comment (Accepted, Rejected, Cancelled,
 * Completed) as a hidden reply annotation with StateModel /Review — the
 * way Acrobat and Foxit store it — and merging the comments of several
 * reviewers' copies of a document into one.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFPage } from 'pdf-lib';

export type ReviewState = 'Accepted' | 'Rejected' | 'Cancelled' | 'Completed' | 'None';
export const REVIEW_STATES: ReviewState[] = ['Accepted', 'Rejected', 'Cancelled', 'Completed', 'None'];

const pdfDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** Adds the review-state reply to `target` (an annotation on `page`). */
export function addReviewReply(doc: PDFDocument, page: PDFPage, target: PDFRef, state: ReviewState, author: string): PDFRef {
  const ctx = doc.context;
  const t = ctx.lookup(target);
  const rect = t instanceof PDFDict && t.lookup(PDFName.of('Rect')) instanceof PDFArray ? (t.lookup(PDFName.of('Rect')) as PDFArray) : ctx.obj([0, 0, 0, 0]);
  const now = pdfDate(new Date());
  const reply = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: rect,
    IRT: target,
    StateModel: PDFString.of('Review'),
    State: PDFString.of(state),
    F: 30, // hidden, printable, no zoom, no rotate: a status, not a note on the page
    T: PDFHexString.fromText(author || 'Reviewer'),
    Contents: PDFHexString.fromText(`${state} set by ${author || 'Reviewer'}`),
    NM: PDFString.of(`adika-review-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`),
    M: PDFString.of(now),
    CreationDate: PDFString.of(now),
    P: page.ref,
  });
  const ref = ctx.register(reply);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  return ref;
}

const nums = (a: unknown): number[] => (a instanceof PDFArray ? a.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : []);
const textOf = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');

/** Sets the review state of the comment on `pageIndex` that matches (type, position, text). */
export async function setReviewStateAt(
  bytes: Uint8Array,
  pageIndex: number,
  match: { subtype: string; rect: number[]; contents: string },
  state: ReviewState,
  author: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) throw new Error('The comment is no longer on this page.');
  let target: PDFRef | null = null;
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i);
    const d = annots.lookup(i);
    if (!(ref instanceof PDFRef) || !(d instanceof PDFDict) || d.has(PDFName.of('IRT'))) continue;
    if ((d.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText() !== match.subtype) continue;
    // Viewers resize note icons (pdf.js: 22 × 22): the top-left corner identifies it.
    const r = nums(d.lookup(PDFName.of('Rect')));
    const left = (q: number[]) => Math.min(q[0], q[2]);
    const top = (q: number[]) => Math.max(q[1], q[3]);
    if (r.length !== 4 || Math.abs(left(r) - left(match.rect)) > 3 || Math.abs(top(r) - top(match.rect)) > 3) continue;
    if (textOf(d.lookup(PDFName.of('Contents'))) !== match.contents) continue;
    target = ref;
    break;
  }
  if (!target) throw new Error('The comment is no longer on this page.');
  addReviewReply(doc, page, target, state, author);
  return doc.save({ useObjectStreams: true });
}

export interface MergeReport {
  added: number;
  skipped: number;
  files: Array<{ name: string; added: number; error?: string }>;
}

/** Adds the comments (and their replies and states) of each reviewer's copy; duplicates are skipped. */
export async function mergeCommentCopies(
  bytes: Uint8Array,
  copies: Array<{ name: string; bytes: Uint8Array }>,
  loadFont?: import('./xfdf').ImportFontLoader,
): Promise<{ bytes: Uint8Array; report: MergeReport }> {
  const { exportXfdf, importXfdf } = await import('./xfdf');
  const report: MergeReport = { added: 0, skipped: 0, files: [] };
  let cur = bytes;
  const pageCount = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  for (const c of copies) {
    try {
      const other = await PDFDocument.load(c.bytes, { ignoreEncryption: true, updateMetadata: false });
      if (other.getPageCount() !== pageCount) throw new Error(`it has ${other.getPageCount()} pages, this document ${pageCount}`);
      const xfdf = await exportXfdf(c.bytes, { fileName: c.name });
      const r = await importXfdf(cur, xfdf, loadFont);
      cur = r.bytes;
      report.added += r.added;
      report.skipped += r.skipped;
      report.files.push({ name: c.name, added: r.added });
    } catch (e) {
      report.files.push({ name: c.name, added: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { bytes: cur, report };
}
