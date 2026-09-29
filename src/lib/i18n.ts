/**
 * Interface language (English / Română).
 *
 * The UI is written in English; `translate()` maps an English string to the
 * chosen language using the dictionary in src/locales (exact strings, and
 * patterns with {0}, {1}… for strings built at runtime, with Romanian plural
 * forms `{0#one|few|many}`). `startDomTranslation()` applies it to the page
 * as React renders — text, tooltips, placeholders, labels — so components
 * stay plain. Document text, inputs and anything inside [data-no-translate]
 * (file names, comments, bookmarks…) are never touched.
 */
import { create } from 'zustand';

export type Lang = 'en' | 'ro';
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'ro', label: 'Română' },
];
const KEY = 'adika.lang';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'ro') return v;
  } catch {
    /* no storage */
  }
  return typeof navigator !== 'undefined' && /^ro\b/i.test(navigator.language) ? 'ro' : 'en';
}

interface Pattern {
  re: RegExp;
  /** Placeholder number for each capture group. */
  slots: number[];
  to: string;
  /** Placeholders used as counts ({0#…}): the text there must be a number. */
  counts: Set<number>;
  /** Placeholders the translation drops (English plural suffixes): only "", "s" or "es". */
  dropped: Set<number>;
  /** Letters outside placeholders (more = more specific). */
  weight: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  middot: '·',
  times: '×',
  mdash: '—',
  ndash: '–',
  rarr: '→',
  larr: '←',
};
const decodeEntities = (s: string) => s.replace(/&(\w+);/g, (m, n: string) => ENTITIES[n] ?? m);

let exact = new Map<string, string>();
let patterns: Pattern[] = [];
const cache = new Map<string, string>();
let active: Lang = 'en';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Loads a dictionary { english: translation }. */
export function setDictionary(dict: Record<string, string>): void {
  exact = new Map();
  patterns = [];
  cache.clear();
  for (const [en, to] of Object.entries(dict)) {
    const key = decodeEntities(en).replace(/\s+/g, ' ').trim();
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, to);
      continue;
    }
    const literal = key.replace(/\{\d+\}/g, '');
    // No words at all (e.g. "{0} ({1})"): too generic, it would rewrite arbitrary text.
    if (!/\p{L}{2,}/u.test(literal)) continue;
    // Short ones ("of {0}") only apply around numbers.
    const numericOnly = !/\p{L}{3,}/u.test(literal);
    const slots: number[] = [];
    const body = escapeRe(key).replace(/\\\{(\d+)\\\}/g, (_m, i: string) => {
      slots.push(Number(i));
      return '(.*?)';
    });
    const used = new Set([...to.matchAll(/\{(\d+)/g)].map((m) => Number(m[1])));
    const counts = new Set(numericOnly ? slots : [...to.matchAll(/\{(\d+)#/g)].map((m) => Number(m[1])));
    patterns.push({
      re: new RegExp('^' + body + '$', 's'),
      slots,
      to,
      counts,
      dropped: new Set(slots.filter((n) => !used.has(n))),
      weight: (literal.match(/\p{L}/gu) ?? []).length,
    });
  }
  patterns.sort((a, b) => b.weight - a.weight);
}

/** Romanian plural form: 1 / 0 and x01–x19 / 20+ ("de"). */
function pluralForm(n: number): 0 | 1 | 2 {
  if (n === 1) return 0;
  const r = Math.abs(n) % 100;
  return n === 0 || (r >= 1 && r <= 19) || !Number.isInteger(n) ? 1 : 2;
}

function fill(to: string, values: string[]): string {
  return to.replace(/\{(\d+)(?:#([^}]*))?\}/g, (_m, i: string, forms?: string) => {
    const v = values[Number(i)] ?? '';
    if (forms === undefined) return exact.get(v.trim()) ?? v;
    const n = Number(v.replace(/[^\d.,-]/g, '').replace(',', '.'));
    const options = forms.split('|');
    const form = options[Math.min(options.length - 1, Number.isFinite(n) ? pluralForm(n) : 1)] ?? '';
    return form.replace(/#/g, v.trim());
  });
}

/** English UI string -> current language (unchanged when unknown or English). */
export function translate(s: string): string {
  if (active === 'en' || !s || !/\p{L}/u.test(s)) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  const core = m[2].replace(/\s+/g, ' ');
  let t = translateOne(core);
  if (t === undefined) {
    // Messages joined from several sentences: translate them one by one.
    const parts = core.split(/(?<=[.!?…])\s+(?=\p{Lu}|\(|„|“)/u);
    if (parts.length > 1) {
      const done = parts.map((p) => translateOne(p));
      if (done.some((x) => x !== undefined)) t = done.map((x, i) => x ?? parts[i]).join(' ');
    }
  }
  const out = t === undefined ? s : m[1] + t + m[3];
  if (cache.size > 5000) cache.clear();
  cache.set(s, out);
  return out;
}

function translateOne(core: string): string | undefined {
  let t = exact.get(core);
  if (t === undefined) {
    for (const p of patterns) {
      const mm = p.re.exec(core);
      if (!mm) continue;
      const values: string[] = [];
      p.slots.forEach((slot, k) => (values[slot] = mm[k + 1]));
      if ([...p.counts].some((n) => !/^\s*[\d.,]+\s*$/.test(values[n] ?? ''))) continue;
      if ([...p.dropped].some((n) => !/^(|s|es)$/.test(values[n] ?? ''))) continue;
      t = fill(p.to, values);
      break;
    }
  }
  return t;
}

export function currentLang(): Lang {
  return active;
}

async function dictionaryFor(lang: Lang): Promise<Record<string, string>> {
  if (lang === 'ro') {
    const [main, extra] = await Promise.all([import('@/locales/ro.json'), import('@/locales/ro.extra')]);
    return { ...(main.default as Record<string, string>), ...extra.RO_EXTRA };
  }
  return {};
}

export async function applyLang(lang: Lang): Promise<void> {
  setDictionary(await dictionaryFor(lang));
  active = lang;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    retranslateAll();
  }
}

export const useLang = create<{ lang: Lang; setLang: (l: Lang) => Promise<void> }>()((set) => ({
  lang: initialLang(),
  setLang: async (lang) => {
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      /* not remembered */
    }
    await applyLang(lang);
    set({ lang });
  },
}));

// ------------------------------------------------------------------ DOM

const SKIP = '[data-no-translate], .textLayer, .annotationLayer, textarea, script, style, [contenteditable="true"], [contenteditable=""]';
const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
/** What React wrote (src) and what we show (out), per text node / attribute. */
const texts = new Map<Text, { src: string; out: string }>();
const attrs = new Map<Element, Map<string, { src: string; out: string }>>();
let observer: MutationObserver | null = null;

function skipped(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !el || !!el.closest(SKIP);
}

function doText(t: Text) {
  const st = texts.get(t);
  if (st && t.data === st.out) return;
  if (skipped(t)) return;
  const src = t.data;
  const out = translate(src);
  if (out === src && !st) return;
  texts.set(t, { src, out });
  if (t.data !== out) t.data = out;
}

function doAttr(el: Element, name: string) {
  const v = el.getAttribute(name);
  if (v === null) return;
  let per = attrs.get(el);
  const st = per?.get(name);
  if (st && v === st.out) return;
  if (skipped(el)) return;
  const out = translate(v);
  if (out === v && !st) return;
  if (!per) attrs.set(el, (per = new Map()));
  per.set(name, { src: v, out });
  if (v !== out) el.setAttribute(name, out);
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    doText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if ((root as Element).closest(SKIP)) return;
    for (const a of ATTRS) doAttr(root as Element, a);
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else for (const a of ATTRS) doAttr(n as Element, a);
  }
}

/** The English text of an attribute the translator changed (or its current value). */
export function originalAttr(el: Element, name: string): string | null {
  return attrs.get(el)?.get(name)?.src ?? el.getAttribute(name);
}

function prune() {
  for (const t of texts.keys()) if (!t.isConnected) texts.delete(t);
  for (const e of attrs.keys()) if (!e.isConnected) attrs.delete(e);
}

function observe() {
  observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Puts every translated node back to English, then translates it again in the current language. */
function retranslateAll() {
  if (!observer) return;
  observer.disconnect();
  for (const [t, st] of texts) if (t.isConnected && t.data === st.out) t.data = st.src;
  for (const [el, per] of attrs) for (const [name, st] of per) if (el.isConnected && el.getAttribute(name) === st.out) el.setAttribute(name, st.src);
  texts.clear();
  attrs.clear();
  walk(document.body);
  observe();
}

export function startDomTranslation(): void {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target as Text);
      else if (m.type === 'attributes' && m.attributeName) doAttr(m.target as Element, m.attributeName);
      else m.addedNodes.forEach(walk);
    }
    if (texts.size > 20000 || attrs.size > 20000) prune();
  });
  walk(document.body);
  observe();
}
