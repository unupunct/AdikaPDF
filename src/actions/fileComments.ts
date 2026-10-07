/**
 * Edit, move and delete comments that were already in the file. Taking one
 * over (Edit in the Comments panel, or a click with the Select tool) turns it
 * into an editor object and hides the original in the viewer, in one undoable
 * step; the file itself only changes when the object does (see
 * lib/pdf/fileAnnots.ts).
 */
import type { PDFDocument } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { getAnnotations, onSourceRelease, openPdf, setHiddenAnnotations } from '@/lib/pdf/pdfService';
import { totalRotation } from '@/lib/geometry';
import { uid } from '@/lib/uid';
import type { EditorObject, PageRef } from '@/types';
import type { FileAnnot } from '@/lib/pdf/fileAnnots';

const docs = new WeakMap<Uint8Array, Promise<PDFDocument>>();
const lists = new Map<string, Promise<FileAnnot[]>>();

onSourceRelease((sourceId) => {
  for (const key of [...lists.keys()]) if (key.startsWith(`${sourceId}:`)) lists.delete(key);
});

function sourceDoc(bytes: Uint8Array): Promise<PDFDocument> {
  let d = docs.get(bytes);
  if (!d) {
    d = import('pdf-lib').then(({ PDFDocument }) => PDFDocument.load(bytes, { updateMetadata: false }));
    docs.set(bytes, d);
  }
  return d;
}

/** The annotations of a page of the opened file, each with what it becomes when taken over. */
export function fileAnnotsOf(page: PageRef): Promise<FileAnnot[]> {
  const s = usePDFStore.getState();
  const src = page.kind === 'source' && page.sourceId ? s.sources[page.sourceId] : null;
  if (!src) return Promise.resolve([]);
  const key = `${src.id}:${page.sourceIndex}:${totalRotation(page)}:${src.bytes.length}`;
  let l = lists.get(key);
  if (!l) {
    l = Promise.all([sourceDoc(src.bytes), import('@/lib/pdf/fileAnnots')])
      .then(([doc, { readPageAnnots }]) =>
        readPageAnnots(doc, page.sourceIndex, page, (i) => usePDFStore.getState().pages.find((p) => p.sourceId === src.id && p.sourceIndex === i)?.id ?? null),
      )
      .catch(() => []);
    lists.set(key, l);
  }
  return l;
}

/** Ids taken over on the page whose object was deleted: the annotation goes, with its replies. */
function deletedOn(page: PageRef, objects: EditorObject[]): string[] {
  return (page.takenAnnots ?? []).filter((id) => !objects.some((o) => o.pageId === page.id && o.fileAnnot?.ref === id));
}

/** Changes whenever what pdf.js must hide on the page changes (for re-rendering). */
export function hiddenKey(page: PageRef, objects: EditorObject[]): string {
  return page.takenAnnots?.length ? `${page.takenAnnots.join(',')}|${deletedOn(page, objects).join(',')}` : '';
}

/** Taken-over annotations of a page, plus the replies of deleted ones (pdf.js draws replies too). */
async function hiddenIds(page: PageRef): Promise<string[]> {
  if (!page.takenAnnots?.length || !page.sourceId) return [];
  const gone = new Set(deletedOn(page, usePDFStore.getState().objects));
  const out = new Set(page.takenAnnots);
  if (gone.size) {
    const annots = (await getAnnotations(page.sourceId, page.sourceIndex)) as Array<{ id?: string; inReplyTo?: string | null }>;
    for (let grew = true; grew; ) {
      grew = false;
      for (const a of annots) {
        if (a.id && a.inReplyTo && gone.has(a.inReplyTo) && !gone.has(a.id)) {
          gone.add(a.id);
          out.add(a.id);
          grew = true;
        }
      }
    }
  }
  return [...out];
}

setHiddenAnnotations(hiddenIds);

/** The stamp's own appearance as a PNG data URL, drawn by pdf.js. */
async function stampPicture(page: PageRef, id: string): Promise<string | null> {
  const src = page.sourceId ? usePDFStore.getState().sources[page.sourceId] : null;
  if (!src) return null;
  const { stampPicturePdf } = await import('@/lib/pdf/fileAnnots');
  const pic = await stampPicturePdf(await sourceDoc(src.bytes), id);
  if (!pic) return null;
  const pdf = await openPdf(pic.bytes);
  try {
    const p = await pdf.getPage(1);
    const scale = Math.min(4, Math.max(1, 600 / Math.max(pic.width, pic.height)));
    const viewport = p.getViewport({ scale, rotation: totalRotation(page) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const { pdfjs } = await import('@/lib/pdf/pdfService');
    await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, background: 'rgba(0,0,0,0)', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

function canEdit(): boolean {
  const s = usePDFStore.getState();
  if (s.readOnlyReason) {
    s.toast(s.readOnlyReason, 'info');
    return false;
  }
  return true;
}

/** Turns a comment of the file into an editor object and selects it. */
export async function takeOverAnnot(pageId: string, id: string): Promise<boolean> {
  if (!canEdit()) return false;
  const s0 = usePDFStore.getState();
  const page = s0.pages.find((p) => p.id === pageId);
  if (!page) return false;
  const existing = s0.objects.find((o) => o.pageId === pageId && o.fileAnnot?.ref === id);
  if (existing) {
    s0.setTool('select');
    s0.select([existing.id]);
    return true;
  }
  const fa = (await fileAnnotsOf(page)).find((a) => a.id === id);
  if (!fa?.object) {
    s0.toast('This comment cannot be edited here; it can only be deleted.', 'info');
    return false;
  }
  let obj: EditorObject = { ...fa.object, id: uid('obj'), pageId };
  if (fa.needsPicture && obj.type === 'stamp') {
    const src = await stampPicture(page, id).catch(() => null);
    if (!src) {
      s0.toast('This comment cannot be edited here; it can only be deleted.', 'info');
      return false;
    }
    obj = { ...obj, src };
  }
  const { linkToFile } = await import('@/lib/pdf/fileAnnots');
  const linked = linkToFile(obj, fa);
  const s = usePDFStore.getState();
  s.commit((st) => ({
    pages: st.pages.map((p) => (p.id === pageId ? { ...p, takenAnnots: [...new Set([...(p.takenAnnots ?? []), id])] } : p)),
    objects: [...st.objects, linked],
  }));
  s.setTool('select');
  s.select([linked.id]);
  return true;
}

/** Deletes a comment of the file (with its popup and replies) when the document is saved; undoable. */
export async function deleteFileAnnot(pageId: string, id: string): Promise<void> {
  if (!canEdit()) return;
  const s = usePDFStore.getState();
  const page = s.pages.find((p) => p.id === pageId);
  if (!page) return;
  const adopted = s.objects.filter((o) => o.pageId === pageId && o.fileAnnot?.ref === id).map((o) => o.id);
  const related = (await fileAnnotsOf(page)).find((a) => a.id === id)?.related ?? [];
  s.commit((st) => ({
    pages: st.pages.map((p) => (p.id === pageId ? { ...p, takenAnnots: [...new Set([...(p.takenAnnots ?? []), id, ...related])] } : p)),
    objects: st.objects.filter((o) => !adopted.includes(o.id)),
  }));
  usePDFStore.setState((st) => ({ selectedIds: st.selectedIds.filter((x) => !adopted.includes(x)) }));
}

/** The comment of the file under a point (display space) that a Select-tool click takes over, if any. */
export function fileAnnotAt(list: FileAnnot[], page: PageRef, x: number, y: number): FileAnnot | null {
  const taken = new Set(page.takenAnnots ?? []);
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (taken.has(a.id) || a.inReplyTo) continue;
    const r = a.rect;
    if (x >= r.x - 2 && x <= r.x + r.width + 2 && y >= r.y - 2 && y <= r.y + r.height + 2) return a;
  }
  return null;
}
