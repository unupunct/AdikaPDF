/**
 * Printed page labels ("i", "ii", "1", "A-3"…) for the current page order,
 * falling back to the position number. Labels follow their source page when
 * pages are reordered, merged or duplicated.
 */
import { useEffect, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { getPageLabels } from '@/lib/pdf/pdfService';

const cache = new Map<string, Promise<string[] | null>>();

function labelsFor(sourceId: string): Promise<string[] | null> {
  let p = cache.get(sourceId);
  if (!p) {
    p = getPageLabels(sourceId).catch(() => null);
    cache.set(sourceId, p);
  }
  return p;
}

/** pageId → label; pages without a printed label get their position (1-based). */
export function usePageLabels(): Record<string, string> {
  const pages = usePDFStore((s) => s.pages);
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      const bySource = new Map<string, string[] | null>();
      for (const p of pages) if (p.sourceId && !bySource.has(p.sourceId)) bySource.set(p.sourceId, await labelsFor(p.sourceId));
      const out: Record<string, string> = {};
      pages.forEach((p, i) => {
        const l = p.sourceId ? bySource.get(p.sourceId)?.[p.sourceIndex] : null;
        out[p.id] = l && l.trim() ? l : String(i + 1);
      });
      if (alive) setLabels(out);
    })();
    return () => {
      alive = false;
    };
  }, [pages]);
  return labels;
}

/** Finds a page by what the user typed: a printed label first, then a position number. */
export function findPageByInput(input: string, pageIds: string[], labels: Record<string, string>): string | null {
  const t = input.trim();
  if (!t) return null;
  const byLabel = pageIds.find((id) => labels[id]?.toLowerCase() === t.toLowerCase());
  if (byLabel) return byLabel;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= pageIds.length) return pageIds[n - 1];
  return null;
}
