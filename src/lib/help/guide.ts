/**
 * The user guide (docs/guide/<lang>/*.md) as help pages: titles, headings
 * with GitHub-style anchors, plain-text sections for search, link and image
 * resolution, and the language choice (the interface language when the
 * guide has it, otherwise English, page by page). Pure: the Markdown and
 * the image URLs come from the caller (bundle.ts in the app, the files in
 * tests).
 */

export type GuideLang = 'en' | 'ro';
export const GUIDE_LANGS: GuideLang[] = ['en', 'ro'];

/** Reading order of the pages (the table of contents); pages not listed follow, by name. */
export const PAGE_ORDER = [
  'index',
  'getting-started',
  'efactura-read',
  'efactura-create',
  'efactura-vat-payment',
  'efactura-credit-notes',
  'efactura-anaf-check',
  'efactura-anaf-send',
  'efactura-troubleshooting',
  'signing-concepts',
  'signing-sign',
  'signing-appearance',
  'signing-batch',
  'signing-verify',
  'signing-troubleshooting',
];

/** Table-of-contents groups: the pages whose name starts with the prefix. */
export const PAGE_GROUPS: Array<{ id: string; label: string; prefix: string }> = [
  { id: 'start', label: 'Start', prefix: '' },
  { id: 'efactura', label: 'e-Factura', prefix: 'efactura-' },
  { id: 'signing', label: 'Digital signatures', prefix: 'signing-' },
];

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface Section {
  /** Heading of the section ('' for the text before the first heading). */
  heading: string;
  anchor: string | null;
  text: string;
}

export interface GuidePage {
  id: string;
  lang: GuideLang;
  title: string;
  markdown: string;
  headings: Heading[];
  sections: Section[];
}

export interface Guide {
  /** The language most pages are in. */
  lang: GuideLang;
  /** True when the interface language has no guide and English is shown. */
  fallback: boolean;
  pages: GuidePage[];
  byId: Map<string, GuidePage>;
}

/** GitHub's heading anchors: lower case, punctuation removed, each space a hyphen (letters with diacritics kept). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Heading text without Markdown emphasis, code or links. */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Markdown to plain text for search (images, links, emphasis, tables and list marks removed). */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) =>
      plainInline(
        line
          .replace(/^\s{0,3}#{1,6}\s+/, '')
          .replace(/^\s*>\s?/, '')
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
          .replace(/^\s*\|?\s*:?-{3,}.*$/, '')
          .replace(/\|/g, ' '),
      ),
    )
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Title, headings and sections of one page. */
export function parsePage(id: string, lang: GuideLang, markdown: string): GuidePage {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  const headings: Heading[] = [];
  const sections: Section[] = [];
  const used = new Map<string, number>();
  let title = '';
  let current: { heading: string; anchor: string | null; lines: string[] } = { heading: '', anchor: null, lines: [] };
  let fence = false;
  const flush = () => {
    const text = markdownToText(current.lines.join('\n'));
    if (text || current.heading) sections.push({ heading: current.heading, anchor: current.anchor, text });
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) {
      current.lines.push(line);
      continue;
    }
    const depth = m[1].length;
    const text = plainInline(m[2]);
    const base = slugify(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const slug = n ? `${base}-${n}` : base;
    headings.push({ depth, text, id: slug });
    if (depth === 1 && !title) {
      title = text;
      current.heading = '';
      continue;
    }
    flush();
    current = { heading: text, anchor: slug, lines: [] };
  }
  flush();
  return { id, lang, title: title || id, markdown, headings, sections };
}

const order = (id: string) => {
  const i = PAGE_ORDER.indexOf(id);
  return i < 0 ? PAGE_ORDER.length : i;
};

/** "…/docs/guide/ro/efactura-create.md" → { lang: 'ro', id: 'efactura-create' }. */
export function pageKey(path: string): { lang: GuideLang; id: string } | null {
  const m = /(?:^|\/)(en|ro)\/([\w-]+)\.md$/.exec(path.replace(/\\/g, '/'));
  return m ? { lang: m[1] as GuideLang, id: m[2] } : null;
}

/** The guide language for an interface language. */
export function guideLangFor(uiLang: string, available: readonly string[] = GUIDE_LANGS): GuideLang {
  return (available.includes(uiLang) ? uiLang : 'en') as GuideLang;
}

/**
 * The pages for an interface language: each page in that language when it
 * exists, otherwise in English.
 */
export function buildGuide(files: Record<string, string>, uiLang: string): Guide {
  const all = new Map<string, Map<GuideLang, string>>();
  for (const [path, md] of Object.entries(files)) {
    const k = pageKey(path);
    if (!k) continue;
    if (!all.has(k.id)) all.set(k.id, new Map());
    all.get(k.id)!.set(k.lang, md);
  }
  const langs = new Set<string>();
  for (const m of all.values()) for (const l of m.keys()) langs.add(l);
  const lang = guideLangFor(uiLang, [...langs]);
  const pages: GuidePage[] = [];
  for (const [id, versions] of all) {
    const pick: GuideLang | undefined = versions.has(lang) ? lang : versions.has('en') ? 'en' : [...versions.keys()][0];
    if (pick) pages.push(parsePage(id, pick, versions.get(pick)!));
  }
  pages.sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
  return { lang, fallback: lang !== uiLang, pages, byId: new Map(pages.map((p) => [p.id, p])) };
}

/** The group a page belongs to in the table of contents. */
export function groupOf(id: string): string {
  const g = [...PAGE_GROUPS].reverse().find((x) => x.prefix && id.startsWith(x.prefix));
  return g?.id ?? 'start';
}

// ---------------------------------------------------------------- search

/** Lower case without diacritics (ș → s, ă → a, é → e), for matching. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

export interface SearchHit {
  page: string;
  title: string;
  heading: string;
  anchor: string | null;
  snippet: string;
  score: number;
}

/** A piece of the text around the first match. */
function snippetOf(text: string, terms: string[], size = 160): string {
  const flat = text.replace(/\s+/g, ' ');
  const f = fold(flat);
  let at = -1;
  for (const t of terms) {
    const i = f.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, size) + (flat.length > size ? '…' : '');
  const start = Math.max(0, at - Math.floor(size / 3));
  const end = Math.min(flat.length, start + size);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/**
 * Sections that contain every word of the query (case and diacritics
 * ignored), best first: words in the page title or the heading count more
 * than words in the text.
 */
export function searchGuide(guide: Pick<Guide, 'pages'>, query: string, limit = 30): SearchHit[] {
  const terms = fold(query)
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const p of guide.pages) {
    const title = fold(p.title);
    for (const s of p.sections) {
      const heading = fold(s.heading);
      const body = fold(s.text);
      let score = 0;
      let all = true;
      for (const t of terms) {
        const inTitle = title.includes(t);
        const inHeading = heading.includes(t);
        const count = body.split(t).length - 1;
        if (!inTitle && !inHeading && !count) {
          all = false;
          break;
        }
        score += (inTitle ? 6 : 0) + (inHeading ? 10 : 0) + Math.min(count, 5);
      }
      if (!all) continue;
      hits.push({ page: p.id, title: p.title, heading: s.heading, anchor: s.anchor, snippet: snippetOf(s.text || s.heading, terms), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score || order(a.page) - order(b.page)).slice(0, limit);
}

// ---------------------------------------------------------------- links and images

export type LinkTarget = { kind: 'page'; page: string; anchor: string | null } | { kind: 'external'; url: string } | { kind: 'none' };

/** Where a link in a guide page leads: another page (and heading), the web, or nowhere usable. */
export function resolveLink(href: string, currentPage: string, known?: ReadonlySet<string> | Map<string, unknown>): LinkTarget {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return { kind: 'external', url: h };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { kind: 'none' };
  if (h.startsWith('#')) return { kind: 'page', page: currentPage, anchor: decodeURIComponent(h.slice(1)) || null };
  const [path, hash] = h.split('#');
  const m = /(?:^|\/)([\w-]+)\.md$/.exec(path);
  if (!m) return { kind: 'none' };
  const page = m[1];
  if (known && !known.has(page)) return { kind: 'none' };
  return { kind: 'page', page, anchor: hash ? decodeURIComponent(hash) : null };
}

/** "../img/ro/efactura-create.png" → "ro/efactura-create.png" (the key of the bundled images). */
export function imageKey(src: string): string | null {
  const m = /(?:^|\/)img\/(en|ro)\/([\w.-]+\.(?:png|jpe?g|gif|webp|svg))$/i.exec(src.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The URL of an image in the guide; a Romanian page without its picture shows the English one. */
export function resolveImage(src: string, images: Record<string, string>): string | null {
  const key = imageKey(src);
  if (!key) return null;
  return images[key] ?? images[`en/${key.slice(3)}`] ?? null;
}

/** "efactura-create#lines" → page and anchor. */
export function parseTopic(topic: string | null | undefined): { page: string; anchor: string | null } {
  const [page, anchor] = (topic || 'index').split('#');
  return { page: page || 'index', anchor: anchor || null };
}
