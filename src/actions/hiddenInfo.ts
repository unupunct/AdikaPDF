/** Protect → Hidden info: scan the open document and remove the chosen kinds of hidden information (undoable). */
import { usePDFStore } from '@/store/usePDFStore';
import type { HiddenFinding, HiddenKind } from '@/lib/pdf/hiddenInfo';
import type { EditorObject } from '@/types';
import { withBusy } from './document';
import { rewriteSource } from './sourceRewrite';

/** Objects added in the editor that would be saved as that kind. */
function addedOfKind(o: EditorObject): HiddenKind | null {
  if (o.type === 'attachment') return 'attachments';
  if (o.type === 'link') return o.target.kind === 'url' ? 'links' : null;
  if (o.type === 'note' || o.type === 'markup' || o.type === 'stamp' || o.type === 'poly' || o.type === 'measure' || (o.type === 'text' && o.annotation)) return 'comments';
  return null;
}

function usedSources(): string[] {
  return [...new Set(usePDFStore.getState().pages.map((p) => p.sourceId).filter((id): id is string => !!id))];
}

export async function scanCurrentHiddenInfo(): Promise<HiddenFinding[] | null> {
  const s = usePDFStore.getState();
  const { HIDDEN_KINDS, scanHiddenInfo } = await import('@/lib/pdf/hiddenInfo');
  const merged = new Map<HiddenKind, HiddenFinding>(HIDDEN_KINDS.map(({ kind }) => [kind, { kind, count: 0, preview: [] }]));
  const multi = usedSources().length > 1;
  for (const id of usedSources()) {
    const src = s.sources[id];
    if (!src) continue;
    for (const f of await scanHiddenInfo(src.bytes)) {
      const m = merged.get(f.kind)!;
      m.count += f.count;
      m.preview.push(...f.preview.map((p) => (multi ? `${src.name}: ${p}` : p)));
    }
  }
  // Not yet in the file, but saved with it.
  for (const o of s.objects) {
    const kind = addedOfKind(o);
    if (!kind) continue;
    const m = merged.get(kind)!;
    m.count++;
    const label = o.type === 'attachment' ? o.fileName : o.type === 'link' && o.target.kind === 'url' ? o.target.url : 'text' in o ? o.text : '';
    m.preview.push(`${label || o.type} (added)`);
  }
  const filled = Object.entries(s.fieldValues).filter(([, v]) => v !== '' && v !== false && !(Array.isArray(v) && !v.length));
  if (filled.length) {
    const m = merged.get('formData')!;
    for (const [k, v] of filled) if (!m.preview.some((p) => p.startsWith(`${k.split('::').pop()}:`))) m.preview.push(`${k.split('::').pop()}: ${String(v)}`);
    m.count = Math.max(m.count, m.preview.length);
  }
  return [...merged.values()];
}

/** Removes the chosen kinds from every source of the document; each source change can be undone. */
export async function removeCurrentHiddenInfo(kinds: HiddenKind[]): Promise<boolean> {
  if (!kinds.length) return false;
  const done = await withBusy('Removing hidden information…', async () => {
    const { removeHiddenBeforeSave } = await import('@/lib/pdf/hiddenInfo');
    for (const id of usedSources()) await rewriteSource(id, (doc) => removeHiddenBeforeSave(doc, kinds));
    // What the editor would write back on saving: added comments, attachments, links, typed field values.
    const s = usePDFStore.getState();
    const objects = s.objects.filter((o) => {
      const k = addedOfKind(o);
      return !k || !kinds.includes(k);
    });
    const clearFields = kinds.includes('formData') && Object.keys(s.fieldValues).length > 0;
    if (objects.length !== s.objects.length || clearFields) s.commit(() => ({ objects, ...(clearFields ? { fieldValues: {} } : {}) }));
    return true;
  });
  if (done) usePDFStore.getState().toast('Hidden information removed. Save the document to keep the change.', 'success');
  return !!done;
}
