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

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface PageMatch {
  rects: SearchHit['rects'];
  snippet: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Same length as the input: diacritics folded, optionally lower-cased. */
export function normalizeForSearch(s: string, caseSensitive: boolean): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '') || ch;
    const c = caseSensitive ? base : base.toLowerCase();
    out += c.length === ch.length ? c : (caseSensitive ? ch : ch.toLowerCase()).slice(0, ch.length).padEnd(ch.length, ' ');
  }
  return out;
}

export function findInPage(runs: TextRun[], query: string, opts: SearchOptions = {}): PageMatch[] {
  const cs = !!opts.caseSensitive;
  const q = normalizeForSearch(query.trim(), cs).replace(/\s+/g, ' ');
  if (!q) return [];
  const { text, segments } = joinRuns(runs);
  const hay = normalizeForSearch(text, cs).replace(/\s/g, ' ');
  const results: PageMatch[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(q, from);
    if (at < 0) break;
    const end = at + q.length;
    from = at + 1;
    if (opts.wholeWord && ((at > 0 && WORD_CHAR.test(text[at - 1])) || (end < text.length && WORD_CHAR.test(text[end])))) continue;
    const rects: SearchHit['rects'] = [];
    for (const seg of segments) {
      const s0 = seg.start;
      const s1 = seg.start + seg.run.str.length;
      const a = Math.max(at, s0);
      const b = Math.min(end, s1);
      if (a < b) rects.push(runRect(seg.run, a - s0, b - s0));
    }
    const before = text.slice(Math.max(0, at - 40), at).replace(/\s+/g, ' ');
    const after = text.slice(end, end + 50).replace(/\s+/g, ' ');
    if (rects.length) results.push({ rects, snippet: `${at > 40 ? '…' : ''}${before}[[${text.slice(at, end)}]]${after}${end + 50 < text.length ? '…' : ''}` });
    from = end;
  }
  return results;
}

export async function searchDocument(pages: PageRef[], query: string, signal: { cancelled: boolean }, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (const page of pages) {
    if (signal.cancelled) break;
    const runs = await pageTextRuns(page);
    for (const m of findInPage(runs, query, opts)) hits.push({ pageId: page.id, rects: m.rects, snippet: m.snippet });
  }
  return hits;
}
