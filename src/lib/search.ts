/**
 * Full-document text search. Runs are joined per page (adjacent runs glued,
 * others separated by a space) so words split across runs still match.
 * Matching ignores case and diacritics ("sectiune" finds "secțiune").
 */
import type { PageRef, SearchHit } from '@/types';
import { pageTextRuns, runRect, type TextRun } from './pdf/textGeometry';

/** Lower-case, strip combining marks; one output char per input char. */
export function foldForSearch(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const c = (base || ch).toLowerCase();
    // Keep a 1:1 length mapping with the source (UTF-16 units).
    out += c.length === ch.length ? c : ch.toLowerCase().slice(0, ch.length).padEnd(ch.length, ' ');
  }
  return out;
}

interface Segment {
  run: TextRun;
  start: number;
}

export function joinRuns(runs: TextRun[]): { text: string; segments: Segment[] } {
  let text = '';
  const segments: Segment[] = [];
  runs.forEach((run, i) => {
    if (i > 0) {
      const prev = runs[i - 1];
      const endX = prev.origin[0] + prev.dir[0] * prev.width;
      const endY = prev.origin[1] + prev.dir[1] * prev.width;
      const gap = Math.hypot(run.origin[0] - endX, run.origin[1] - endY);
      const glued = gap < prev.size * 0.25 && !/\s$/.test(prev.str) && !/^\s/.test(run.str);
      if (!glued) text += ' ';
    }
    segments.push({ run, start: text.length });
    text += run.str;
  });
  return { text, segments };
}

export function findInPage(runs: TextRun[], query: string): SearchHit['rects'][] {
  const q = foldForSearch(query.trim()).replace(/\s+/g, ' ');
  if (!q) return [];
  const { text, segments } = joinRuns(runs);
  const hay = foldForSearch(text).replace(/\s/g, ' ');
  const results: SearchHit['rects'][] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at < 0) break;
    const end = at + q.length;
    const rects: SearchHit['rects'] = [];
    for (const seg of segments) {
      const s0 = seg.start;
      const s1 = seg.start + seg.run.str.length;
      const a = Math.max(at, s0);
      const b = Math.min(end, s1);
      if (a < b) rects.push(runRect(seg.run, a - s0, b - s0));
    }
    if (rects.length) results.push(rects);
    from = end;
  }
  return results;
}

export async function searchDocument(pages: PageRef[], query: string, signal: { cancelled: boolean }): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (const page of pages) {
    if (signal.cancelled) break;
    const runs = await pageTextRuns(page);
    for (const rects of findInPage(runs, query)) hits.push({ pageId: page.id, rects });
  }
  return hits;
}
