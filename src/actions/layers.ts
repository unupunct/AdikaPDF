/** Layers panel: rename, delete, merge and flatten layers (undoable document rewrites). */
import { usePDFStore } from '@/store/usePDFStore';
import { askConfirm } from '@/store/useDialogs';
import { withBusy } from './document';
import { rewriteSource } from './sourceRewrite';

export async function renameLayerIn(sourceId: string, id: string, name: string): Promise<void> {
  if (!name.trim()) return;
  await withBusy('Renaming the layer…', () => rewriteSource(sourceId, async (doc) => (await import('@/lib/pdf/layers')).renameLayer(doc, id, name.trim())));
}

export async function deleteLayersIn(sourceId: string, ids: string[], names: string[]): Promise<void> {
  const ok = await askConfirm({
    title: 'Delete layers?',
    message: `These layers and everything drawn in them will be removed from the document: ${names.join(', ')}.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const done = await withBusy('Deleting layers…', () => rewriteSource(sourceId, async (doc) => (await import('@/lib/pdf/layers')).deleteLayers(doc, ids)));
  if (done) usePDFStore.getState().toast('Layers deleted. Undo brings them back.', 'success');
}

export async function mergeLayersIn(sourceId: string, ids: string[], into: string): Promise<void> {
  const done = await withBusy('Merging layers…', () => rewriteSource(sourceId, async (doc) => (await import('@/lib/pdf/layers')).mergeLayers(doc, ids, into)));
  if (done) usePDFStore.getState().toast('Layers merged.', 'success');
}

/** Flattens the layers of a source: what is visible now stays, hidden layers are removed. */
export async function flattenLayersIn(sourceId: string, hiddenIds: string[]): Promise<void> {
  const ok = await askConfirm({
    title: 'Flatten layers?',
    message: hiddenIds.length
      ? 'What is visible now becomes ordinary page content; the hidden layers and their content are removed.'
      : 'All layers become ordinary page content and can no longer be shown or hidden.',
    confirmLabel: 'Flatten',
  });
  if (!ok) return;
  const done = await withBusy('Flattening layers…', () => rewriteSource(sourceId, async (doc) => (await import('@/lib/pdf/layers')).flattenLayers(doc, hiddenIds)));
  if (done) usePDFStore.getState().toast('Layers flattened.', 'success');
}
