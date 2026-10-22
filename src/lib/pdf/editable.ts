/**
 * pdf-lib's view of a file pdf.js opened. pdf.js recovers broken page trees,
 * catalogs and cross-references by itself; pdf-lib (which writes every edit)
 * may then see no pages, fewer pages or a page tree it cannot walk. Such a
 * file is edited from its repaired copy (repair.ts) when that has the pages
 * pdf.js shows, so saving, compressing and the checks see the same document.
 */
import { PDFDocument, PDFName, PDFPageLeaf, PDFPageTree } from 'pdf-lib';
import { repairPdf } from './repair';

type LoadOptions = Parameters<typeof PDFDocument.load>[1];

/** Why pdf-lib's document is unusable for `expectedPages` pages, or null when it is fine. */
export function pdfLibProblem(doc: PDFDocument, expectedPages?: number): string | null {
  let pages;
  try {
    pages = doc.getPages();
  } catch (e) {
    return `page tree not readable (${e instanceof Error ? e.message : String(e)})`;
  }
  if (expectedPages !== undefined && pages.length !== expectedPages) return `${pages.length} pages instead of ${expectedPages}`;
  for (const p of pages) {
    if (!(p.node instanceof PDFPageLeaf)) return 'a page is not a page dictionary';
    const parent = p.node.get(PDFName.of('Parent'));
    if (parent !== undefined && !(p.node.Parent() instanceof PDFPageTree)) return 'a page has a broken parent';
    try {
      p.node.MediaBox();
      p.node.Resources();
    } catch (e) {
      return `page attributes not readable (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return null;
}

const repaired = new WeakMap<Uint8Array, Promise<Uint8Array | null>>();

/**
 * The repaired copy of `bytes` when pdf-lib cannot use the file as it is and the
 * repair keeps `expectedPages` pages; null when the file is fine (or repair does not help).
 */
export function editableCopy(bytes: Uint8Array, expectedPages?: number): Promise<Uint8Array | null> {
  let p = repaired.get(bytes);
  if (!p) {
    p = (async () => {
      try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
        if (!pdfLibProblem(doc, expectedPages)) return null;
      } catch (e) {
        if (e instanceof Error && /encrypt/i.test(e.message)) return null;
      }
      try {
        const fixed = await repairPdf(bytes);
        const doc = await PDFDocument.load(fixed.bytes, { updateMetadata: false });
        return pdfLibProblem(doc, expectedPages) ? null : fixed.bytes;
      } catch {
        return null;
      }
    })();
    repaired.set(bytes, p);
  }
  return p;
}

/** PDFDocument.load, from the repaired copy when pdf-lib cannot use the file itself. */
export async function loadEditable(bytes: Uint8Array, options: LoadOptions = {}, expectedPages?: number): Promise<PDFDocument> {
  let first: unknown = null;
  let doc: PDFDocument | null = null;
  try {
    doc = await PDFDocument.load(bytes, options);
    if (!pdfLibProblem(doc, expectedPages)) return doc;
  } catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message)) throw e;
    first = e;
  }
  const fixed = await editableCopy(bytes, expectedPages);
  if (fixed) return PDFDocument.load(fixed, options);
  if (doc) return doc;
  throw first;
}
