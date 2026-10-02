/**
 * Changes made to a source document itself (layers, page sizes): the PDF is
 * rewritten and swapped in, keeping page order, objects and form values; the
 * previous version stays loaded, so the change can be undone.
 */
import type { PDFDocument } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import type { PageRef } from '@/types';

export async function rewriteSource(sourceId: string, fn: (doc: PDFDocument) => void | Promise<void>, patchPage?: (p: PageRef, doc: PDFDocument) => Partial<PageRef>): Promise<string> {
  const src = usePDFStore.getState().sources[sourceId];
  if (!src) throw new Error('The document is no longer open.');
  const [{ PDFDocument }, { dropUnreachableObjects }] = await Promise.all([import('pdf-lib'), import('@/lib/pdf/prune')]);
  const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
  await fn(doc);
  dropUnreachableObjects(doc);
  const bytes = await doc.save({ useObjectStreams: true });
  const { source } = await usePDFStore.getState().addSource(bytes, src.name);
  const prefix = `${sourceId}::`;
  usePDFStore.getState().commit((st) => ({
    pages: st.pages.map((p) => (p.sourceId === sourceId ? { ...p, sourceId: source.id, ...(patchPage ? patchPage(p, doc) : {}) } : p)),
    fieldValues: Object.fromEntries(Object.entries(st.fieldValues).map(([k, v]) => [k.startsWith(prefix) ? `${source.id}::${k.slice(prefix.length)}` : k, v])),
  }));
  return source.id;
}
