/**
 * Full-text search across folders of PDFs (pure part): the index (text of
 * every page of every file, with size and date to notice changes) and the
 * search (all words, or "an exact phrase"; case and diacritics ignored),
 * with a snippet of each matching page.
 */

export interface IndexedFile {
  path: string;
  size: number;
  modified: number;
  /** Text of each page ('' for pages without text, e.g. scans). */
  pages: string[];
  /** Why the file has no text (encrypted, damaged…). */
  error?: string;
}

export interface SearchIndex {
  version: 1;
  folders: string[];
  files: Record<string, IndexedFile>;
  updated: number;
}

export const emptyIndex = (): SearchIndex => ({ version: 1, folders: [], files: {}, updated: 0 });

/** Lower case, no diacritics, one space between words; keeps the length map to the original. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[şș]/g, 's')
    .replace(/[ţț]/g, 't');
}

export interface Query {
  /** Words that must all appear in the document (folded). */
  words: string[];
  /** Exact phrases (folded, spaces collapsed). */
  phrases: string[];
}

export function parseQuery(q: string): Query {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p: string) => {
    const f = fold(p).replace(/\s+/g, ' ').trim();
    if (f) phrases.push(f);
    return ' ';
  });
  const words = fold(rest)
    .split(/[\s,;]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  return { words, phrases };
}

export interface PageHit {
  /** 1-based. */
  page: number;
  /** Text around the first match: before, match, after. */
  snippet: [string, string, string];
  count: number;
}

export interface FileHit {
  path: string;
  name: string;
  hits: PageHit[];
  score: number;
}

function snippetOf(text: string, folded: string, at: number, len: number): [string, string, string] {
  // Folding keeps positions for Latin text (one code unit per letter after NFD stripping is not guaranteed):
  // map through a folded-per-character index.
  const start = Math.max(0, at - 70);
  const end = Math.min(folded.length, at + len + 70);
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  return [`${start > 0 ? '…' : ''}${clean(text.slice(start, at)).trimStart()}`, clean(text.slice(at, at + len)), `${clean(text.slice(at + len, end)).trimEnd()}${end < folded.length ? '…' : ''}`];
}

/** Folds each character on its own, so positions match the original text. */
function foldKeepLength(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = fold(ch);
    out += f.length === ch.length ? f : ch.length === 1 ? (f[0] ?? ch) : ch;
  }
  return out;
}

export function searchIndex(index: SearchIndex, q: string, limit = 200): FileHit[] {
  const query = parseQuery(q);
  const terms = [...query.phrases, ...query.words];
  if (!terms.length) return [];
  const out: FileHit[] = [];
  for (const f of Object.values(index.files)) {
    const foldedPages = f.pages.map((p) => foldKeepLength(p.replace(/\s+/g, ' ')));
    const whole = foldedPages.join('\n');
    // Every term must appear somewhere in the document.
    if (!terms.every((t) => whole.includes(t))) continue;
    const hits: PageHit[] = [];
    let score = 0;
    foldedPages.forEach((fp, i) => {
      let first = -1;
      let firstLen = 0;
      let count = 0;
      for (const t of terms) {
        let at = fp.indexOf(t);
        if (at >= 0 && (first < 0 || at < first)) {
          first = at;
          firstLen = t.length;
        }
        while (at >= 0) {
          count++;
          at = fp.indexOf(t, at + t.length);
        }
      }
      if (count) {
        hits.push({ page: i + 1, snippet: snippetOf(f.pages[i].replace(/\s+/g, ' '), fp, first, firstLen), count });
        score += count;
      }
    });
    const name = f.path.split(/[\\/]/).pop() ?? f.path;
    // Words in the file name count extra.
    if (terms.some((t) => fold(name).includes(t))) score += 5;
    out.push({ path: f.path, name, hits, score });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

/** Files to (re)index: new or changed; and the ones to drop. */
export function indexPlan(index: SearchIndex, found: Array<{ path: string; size: number; modified: number }>): { toRead: string[]; toDrop: string[] } {
  const seen = new Set(found.map((f) => f.path));
  const toRead = found.filter((f) => {
    const old = index.files[f.path];
    return !old || old.size !== f.size || old.modified !== f.modified;
  }).map((f) => f.path);
  const toDrop = Object.keys(index.files).filter((p) => !seen.has(p));
  return { toRead, toDrop };
}
