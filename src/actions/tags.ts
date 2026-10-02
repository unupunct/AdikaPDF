/** Tags panel: edits of the tag tree (undoable document rewrites). */
import { withBusy } from './document';
import { rewriteSource } from './sourceRewrite';

const tags = () => import('@/lib/pdf/structTree');

export async function updateTag(sourceId: string, id: string, p: { type?: string; alt?: string }): Promise<void> {
  await withBusy('Updating the tag…', () => rewriteSource(sourceId, async (doc) => (await tags()).setTagProps(doc, id, p)));
}

export async function moveTagIn(sourceId: string, id: string, delta: -1 | 1): Promise<void> {
  await withBusy('Changing the reading order…', () => rewriteSource(sourceId, async (doc) => void (await tags()).moveTag(doc, id, delta)));
}

export async function unwrapTagIn(sourceId: string, id: string): Promise<void> {
  await withBusy('Updating the tags…', () => rewriteSource(sourceId, async (doc) => (await tags()).unwrapTag(doc, id)));
}

export async function deleteTagIn(sourceId: string, id: string): Promise<void> {
  await withBusy('Updating the tags…', () => rewriteSource(sourceId, async (doc) => (await tags()).deleteTag(doc, id)));
}
