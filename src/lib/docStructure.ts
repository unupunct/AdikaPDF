/**
 * Structure found in page text: headings (for automatic bookmarks) and web
 * / e-mail addresses (for automatic links). Pure: works on text lines.
 */
import type { BookmarkItem } from '@/types';
import { uid } from './uid';

export interface TextLine {
  pageId: string;
  text: string;
  /** Font size in points (largest on the line). */
  size: number;
  bold: boolean;
  /** Top of the line, points from the top of the page (as shown). */
  top: number;
  /** Bookmark destination: top of the line in PDF units from the page bottom (null = whole page). */
  destTop: number | null;
}

const round = (n: number) => Math.round(n * 2) / 2;

/**
 * Headings = lines clearly larger than the body text (up to three levels by
 * size), plus short bold lines at body size as the deepest level when bold
 * is rare in the document. Page numbers, running headers repeated on many
 * pages and long lines are left out.
 */
export function headingTree(lines: TextLine[]): BookmarkItem[] {
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text.length > 0);
  if (!clean.length) return [];
  // Body size: the size with the most characters.
  const weight = new Map<number, number>();
  for (const l of clean) weight.set(round(l.size), (weight.get(round(l.size)) ?? 0) + l.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // Lines repeated on several pages (running headers / footers).
  const pagesWith = new Map<string, Set<string>>();
  for (const l of clean) {
    const k = l.text.toLowerCase();
    if (!pagesWith.has(k)) pagesWith.set(k, new Set());
    pagesWith.get(k)!.add(l.pageId);
  }
  const pageCount = new Set(clean.map((l) => l.pageId)).size;
  const repeated = (l: TextLine) => pageCount > 2 && pagesWith.get(l.text.toLowerCase())!.size > Math.max(2, pageCount / 3);
  const plausible = (l: TextLine) => l.text.length >= 2 && l.text.length <= 120 && /\p{L}/u.test(l.text) && !/^(page|pagina)?\s*\d+(\s*(of|din|\/)\s*\d+)?$/i.test(l.text) && !repeated(l);

  const big = clean.filter((l) => round(l.size) >= body * 1.15 && plausible(l));
  const sizes = [...new Set(big.map((l) => round(l.size)))].sort((a, b) => b - a);
  // Merge sizes within 1 pt into one level; at most three levels.
  const levels: number[] = [];
  for (const s of sizes) if (!levels.length || levels[levels.length - 1] - s > 1) levels.push(s);
  const levelOf = (size: number) => Math.min(2, levels.findIndex((s) => round(size) >= s - 1));
  const boldBody = clean.filter((l) => l.bold && Math.abs(round(l.size) - body) < 1 && plausible(l) && l.text.length <= 80);
  const useBold = boldBody.length > 0 && boldBody.length <= clean.length * 0.15;

  const heads = clean
    .map((l, i) => ({ l, i, level: big.includes(l) ? levelOf(l.size) : useBold && boldBody.includes(l) ? Math.min(2, levels.length) : -1 }))
    .filter((h) => h.level >= 0);
  // Consecutive lines of the same heading (wrapped titles) become one.
  const merged: Array<{ l: TextLine; level: number; last: number; lastTop: number }> = [];
  for (const h of heads) {
    const prev = merged[merged.length - 1];
    if (prev && prev.level === h.level && prev.l.pageId === h.l.pageId && h.i === prev.last + 1 && Math.abs(h.l.top - prev.lastTop) < h.l.size * 1.8 && prev.l.text.length < 90) {
      prev.l = { ...prev.l, text: `${prev.l.text} ${h.l.text}` };
      prev.last = h.i;
      prev.lastTop = h.l.top;
    } else merged.push({ l: { ...h.l }, level: h.level, last: h.i, lastTop: h.l.top });
  }
  // Nest by level.
  const root: BookmarkItem[] = [];
  const stack: Array<{ level: number; item: BookmarkItem }> = [];
  for (const h of merged) {
    const item: BookmarkItem = { id: uid('bm'), title: h.l.text, pageId: h.l.pageId, top: h.l.destTop, url: null, bold: false, italic: false, open: true, children: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : root).push(item);
    stack.push({ level: h.level, item });
  }
  return root;
}

export interface UrlMatch {
  start: number;
  end: number;
  url: string;
}

/** Web and e-mail addresses in text, as link targets (www. gets https://, e-mails mailto:). */
export function findUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"“”‘’()]+[^\s<>"“”‘’().,;:!?]|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/giu;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    const url = s.includes('@') && !/^https?:/i.test(s) && !/^www\./i.test(s) ? `mailto:${s}` : /^www\./i.test(s) ? `https://${s}` : s;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + s.length, url });
  }
  return out;
}
