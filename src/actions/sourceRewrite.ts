/**
 * Changes made to a source document itself (layers, page sizes): the PDF is
 * rewritten and swapped in, keeping page order, objects and form values; the
 * previous version stays loaded, so the change can be undone.
 */
import type { PDFDocument } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import type { EditorObject, PageRef } from '@/types';

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
  if (usePDFStore.getState().primarySource === sourceId) usePDFStore.setState({ primarySource: source.id });
  return source.id;
}

/**
 * Swaps in a new version of the whole document (`bytes`: the document with
 * its edits applied, then transformed by a tool) as one undoable step. The
 * edits are in the new file now; `carry` objects (e.g. redactions not yet
 * applied) stay editable on the page with the same position.
 */
export async function replaceWholeDocument(bytes: Uint8Array, carry: EditorObject[] = []): Promise<void> {
  const st = usePDFStore.getState();
  const index = new Map(st.pages.map((p, i) => [p.id, i]));
  const { source, pages } = await st.addSource(bytes, st.fileName ?? 'Untitled.pdf');
  usePDFStore.getState().commit(() => ({
    pages,
    objects: carry.flatMap((o) => {
      const page = pages[index.get(o.pageId) ?? -1];
      return page ? [{ ...o, pageId: page.id } as EditorObject] : [];
    }),
    fieldValues: {},
    outline: null,
  }));
  const after = usePDFStore.getState();
  usePDFStore.setState({
    primarySource: source.id,
    selectedIds: [],
    editingTextId: null,
    currentPageId: pages[index.get(after.currentPageId ?? '') ?? -1]?.id ?? pages[0]?.id ?? null,
  });
}
