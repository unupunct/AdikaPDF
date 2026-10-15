/**
 * Which pages of large sources still have estimated sizes, and the real
 * sizes that turned out different. The store, parked tabs and the export
 * correct their PageRefs from here (`correctPages`); `pageSizesReady` waits
 * until every page of the given sources has been read.
 */
import type { PageRef } from '@/types';
import type { PageSize } from './pageSizes';

interface Pending {
  unknown: Set<number>;
  estimate: Omit<PageSize, 'index'>;
  done: Promise<void>;
  resolve: () => void;
}

const pending = new Map<string, Pending>();
const corrections = new Map<string, Map<number, PageSize>>();
const listeners = new Set<() => void>();

/** Registers pages created with `estimate` (unrotated size and /Rotate) until their real size is reported. */
export function beginEstimated(sourceId: string, unknown: number[], estimate: Omit<PageSize, 'index'>): void {
  if (!unknown.length) return;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  pending.set(sourceId, { unknown: new Set(unknown), estimate, done, resolve });
}

export function isEstimated(sourceId: string, index: number): boolean {
  return !!pending.get(sourceId)?.unknown.has(index);
}

/** True while some page of `sourceId` (or of any source) is still estimated. */
export function hasEstimated(sourceId?: string): boolean {
  return sourceId ? pending.has(sourceId) : pending.size > 0;
}

/** Real sizes read from the file. Listeners run when one differs from its estimate. */
export function reportSizes(sourceId: string, sizes: PageSize[]): void {
  const p = pending.get(sourceId);
  if (!p) return;
  let changed = false;
  for (const s of sizes) {
    if (!p.unknown.delete(s.index)) continue;
    const e = p.estimate;
    if (s.width === e.width && s.height === e.height && s.rotation === e.rotation) continue;
    let m = corrections.get(sourceId);
    if (!m) corrections.set(sourceId, (m = new Map()));
    m.set(s.index, s);
    changed = true;
  }
  if (!p.unknown.size) {
    pending.delete(sourceId);
    p.resolve();
  }
  if (changed) for (const fn of listeners) fn();
}

export function onSizesCorrected(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves once every page of these sources (default: all) has its real size. */
export function pageSizesReady(sourceIds?: Iterable<string>): Promise<void> {
  const ids = sourceIds ? [...sourceIds] : [...pending.keys()];
  return Promise.all(ids.map((id) => pending.get(id)?.done)).then(() => undefined);
}

/** A closed source: nothing more is waited for. */
export function forgetSource(sourceId: string): void {
  const p = pending.get(sourceId);
  pending.delete(sourceId);
  corrections.delete(sourceId);
  p?.resolve();
}

/** The page with its real size and /Rotate (the same object when nothing changes). The user's rotation is kept. */
export function correctPage(page: PageRef): PageRef {
  if (page.kind !== 'source' || !page.sourceId) return page;
  const s = corrections.get(page.sourceId)?.get(page.sourceIndex);
  if (!s || (s.width === page.width && s.height === page.height && s.rotation === page.baseRotation)) return page;
  return { ...page, width: s.width, height: s.height, baseRotation: s.rotation };
}

/** The pages with real sizes; the same array when none changed. */
export function correctPages(pages: PageRef[]): PageRef[] {
  let out: PageRef[] | null = null;
  for (let i = 0; i < pages.length; i++) {
    const c = correctPage(pages[i]);
    if (c !== pages[i]) (out ??= pages.slice())[i] = c;
  }
  return out ?? pages;
}

/** Corrects page arrays shared between snapshots once each, so shared arrays stay shared. */
export function pageCorrector(): (pages: PageRef[]) => PageRef[] {
  const memo = new Map<PageRef[], PageRef[]>();
  return (pages) => {
    let out = memo.get(pages);
    if (!out) memo.set(pages, (out = correctPages(pages)));
    return out;
  };
}
