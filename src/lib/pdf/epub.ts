// EPUB <-> PDF helpers. Runs in both node and the browser: no DOMParser, so
// markup is handled by a small quote-aware tag tokenizer. Nothing is fetched.
//
// epubToHtml: EPUB 2/3 -> one standalone HTML document (images, CSS and fonts
//   inlined as data: URIs; scripts, event handlers and remote refs removed).
// pdfToEpub:  extracted PDF text (convert.ts PageText) -> valid EPUB 3.

import JSZip from 'jszip';
import { stripInvalidXmlChars, xmlEscape, type PageText, type TextLine } from './convert';
import type { DocxPageGraphics } from './docx';
import { layoutReflow } from './docWriters';

// ---------------------------------------------------------------------------
// Markup tokenizer (pure)
// ---------------------------------------------------------------------------

type Attr = [name: string, value: string | null];

interface StartTag {
  name: string;
  /** Lower-case name without namespace prefix. */
  local: string;
  attrs: Attr[];
  selfClose: boolean;
  /** Index just past the closing '>'. */
  end: number;
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** Parses the start tag at `src[i] === '<'`. Returns null if malformed. */
function parseStartTag(src: string, i: number): StartTag | null {
  let p = i + 1;
  const nameStart = p;
  while (p < src.length && !isSpace(src[p]) && src[p] !== '>' && src[p] !== '/') p++;
  const name = src.slice(nameStart, p);
  if (!/^[A-Za-z][\w:.-]*$/.test(name)) return null;
  const attrs: Attr[] = [];
  let selfClose = false;
  while (p < src.length) {
    while (p < src.length && isSpace(src[p])) p++;
    const c = src[p];
    if (c === undefined) return null;
    if (c === '>') return { name, local: localName(name), attrs, selfClose, end: p + 1 };
    if (c === '/') {
      selfClose = true;
      p++;
      continue;
    }
    selfClose = false;
    const an = p;
    while (p < src.length && !isSpace(src[p]) && !'=/>'.includes(src[p])) p++;
    // Stray characters such as '"' at attribute-name position: skip one.
    if (p === an) {
      p++;
      continue;
    }
    const attrName = src.slice(an, p);
    let q = p;
    while (q < src.length && isSpace(src[q])) q++;
    if (src[q] !== '=') {
      attrs.push([attrName, null]);
      continue;
    }
    q++;
    while (q < src.length && isSpace(src[q])) q++;
    const quote = src[q];
    if (quote === '"' || quote === "'") {
      const close = src.indexOf(quote, q + 1);
      if (close < 0) return null;
      attrs.push([attrName, src.slice(q + 1, close)]);
      p = close + 1;
    } else {
      const vs = q;
      while (q < src.length && !isSpace(src[q]) && src[q] !== '>') q++;
      attrs.push([attrName, src.slice(vs, q)]);
      p = q;
    }
  }
  return null;
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1).toLowerCase();
}

/** Yields every start (and self-closing) tag in `src`. */
function* scanTags(src: string): Generator<StartTag> {
  let i = 0;
  while ((i = src.indexOf('<', i)) >= 0) {
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    const t = /[A-Za-z]/.test(src[i + 1] ?? '') ? parseStartTag(src, i) : null;
    if (t) {
      yield t;
      i = t.end;
    } else i++;
  }
}

function attr(t: StartTag, name: string): string | null {
  const n = name.toLowerCase();
  for (const [k, v] of t.attrs) if (k.toLowerCase() === n) return v === null ? '' : decodeEntities(v);
  return null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text content of the first `<[prefix:]name>` element, tags stripped. */
function elementText(xml: string, name: string): string | null {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  const text = decodeEntities(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Index of the matching `</name>` (case-insensitive, any prefix), or -1. */
function findClose(src: string, from: number, local: string): { start: number; end: number } | null {
  const re = new RegExp(`</(?:[\\w.-]+:)?${local}\\s*>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

// ---------------------------------------------------------------------------
// Zip paths / MIME
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const k = path.lastIndexOf('/');
  return k < 0 ? '' : path.slice(0, k + 1);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolves a relative href against a zip directory. Drops query/fragment. */
function resolvePath(baseDir: string, href: string): string {
  const clean = href.replace(/[?#].*$/, '');
  const parts = (clean.startsWith('/') ? clean.slice(1) : baseDir + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  css: 'text/css',
};

const REMOTE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const SCRIPT_URL = /^\s*(?:javascript|vbscript|data:(?:text\/html|application\/xhtml|text\/javascript|application\/javascript))/i;
/** Font-obfuscation algorithms: not DRM, the font is merely scrambled. */
const OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

interface Book {
  zip: JSZip;
  /** Lower-cased path -> actual zip entry name. */
  names: Map<string, string>;
  /** Resolved path -> manifest media type. */
  types: Map<string, string>;
  /** Paths whose content is obfuscated (fonts); never inlined. */
  blocked: Set<string>;
  dataUris: Map<string, Promise<string | null>>;
  /** Resolved spine path -> chapter anchor id. */
  chapterIds: Map<string, string>;
}

function entryName(book: Book, path: string): string | null {
  for (const p of [path, safeDecode(path)]) {
    if (book.zip.file(p)) return p;
    const hit = book.names.get(p.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function readText(book: Book, path: string): Promise<string | null> {
  const name = entryName(book, path);
  if (!name) return null;
  const s = await book.zip.file(name)!.async('string');
  return s.replace(/^﻿/, '');
}

function dataUri(book: Book, path: string): Promise<string | null> {
  const name = entryName(book, path);
  if (!name || book.blocked.has(name)) return Promise.resolve(null);
  let p = book.dataUris.get(name);
  if (!p) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const type = book.types.get(name) ?? MIME[ext] ?? 'application/octet-stream';
    p = book.zip
      .file(name)!
      .async('base64')
      .then((b64) => `data:${type};base64,${b64}`);
    book.dataUris.set(name, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Inlines @import and url() targets; drops remote and script-ish references. */
async function rewriteCss(book: Book, css: string, baseDir: string, seen: Set<string> = new Set()): Promise<string> {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // @import "x.css"; / @import url(x.css) media;
  const imports = [...out.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi)];
  for (const m of imports) {
    let replacement = '';
    const href = decodeEntities(m[2]);
    if (!REMOTE.test(href)) {
      const path = resolvePath(baseDir, href);
      if (!seen.has(path) && seen.size < 32) {
        seen.add(path);
        const inner = await readText(book, path);
        if (inner !== null) replacement = await rewriteCss(book, inner, dirOf(path), seen);
      }
    }
    out = out.replace(m[0], () => replacement);
  }
  const urls = [...out.matchAll(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi)];
  const parts: string[] = [];
  let last = 0;
  for (const m of urls) {
    parts.push(out.slice(last, m.index));
    last = m.index + m[0].length;
    const href = m[2].trim();
    if (href.startsWith('data:') && !SCRIPT_URL.test(href)) parts.push(m[0]);
    else if (href.startsWith('#')) parts.push(m[0]);
    else if (!href || REMOTE.test(href)) parts.push('none');
    else {
      const uri = await dataUri(book, resolvePath(baseDir, href));
      parts.push(uri ? `url("${uri}")` : 'none');
    }
  }
  parts.push(out.slice(last));
  return parts
    .join('')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/-moz-binding|behavior\s*:/gi, 'x-')
    .replace(/<\/style/gi, '<\\/style');
}

// ---------------------------------------------------------------------------
// XHTML body rewriting
// ---------------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements removed together with their content. */
const DROP_WITH_CONTENT = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'applet', 'template']);
/** Elements removed (tag only; void or content-less). */
const DROP_TAG = new Set(['base', 'meta', 'link', 'embed', 'html', 'head', 'body', 'title']);
const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'poster', 'data', 'background', 'action', 'formaction', 'longdesc', 'cite']);

async function rewriteUrlAttr(book: Book, tag: string, name: string, raw: string, docDir: string): Promise<string | null> {
  const v = decodeEntities(raw).trim();
  if (!v || SCRIPT_URL.test(v)) return null;
  if (v.startsWith('#')) return v;
  const isLink = tag === 'a' && name === 'href';
  if (v.startsWith('data:')) return isLink ? null : v;
  if (REMOTE.test(v)) return isLink && /^\s*(?:https?|mailto):/i.test(v) ? v : null;
  const path = resolvePath(docDir, v);
  if (isLink || tag === 'area') {
    const frag = /#(.+)$/.exec(v)?.[1];
    if (frag) return '#' + frag;
    const id = book.chapterIds.get(entryName(book, path) ?? path);
    return id ? '#' + id : null;
  }
  // Only resource loads remain (img, svg image, source, video poster ...).
  if (name === 'cite' || name === 'longdesc' || name === 'action' || name === 'formaction') return null;
  return dataUri(book, path);
}

/** Sanitises one chapter's markup and inlines its resources. */
async function rewriteBody(book: Book, src: string, docDir: string): Promise<string> {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const j = src.indexOf('<', i);
    if (j < 0) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, j));
    if (src.startsWith('<!--', j)) {
      const e = src.indexOf('-->', j + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', j)) {
      const e = src.indexOf(']]>', j + 9);
      out.push(escText(src.slice(j + 9, e < 0 ? src.length : e)));
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src[j + 1] === '?' || src[j + 1] === '!') {
      const e = src.indexOf('>', j);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (src[j + 1] === '/') {
      const e = src.indexOf('>', j);
      const name = src.slice(j + 2, e < 0 ? src.length : e).trim();
      i = e < 0 ? src.length : e + 1;
      if (/^[A-Za-z][\w:.-]*$/.test(name) && !DROP_TAG.has(localName(name))) out.push(`</${name}>`);
      continue;
    }
    const t = /[A-Za-z]/.test(src[j + 1] ?? '') ? parseStartTag(src, j) : null;
    if (!t) {
      out.push('&lt;');
      i = j + 1;
      continue;
    }
    i = t.end;
    if (DROP_WITH_CONTENT.has(t.local)) {
      if (!t.selfClose) {
        const c = findClose(src, t.end, t.local);
        i = c ? c.end : src.length;
      }
      continue;
    }
    if (t.local === 'style') {
      const c = t.selfClose ? null : findClose(src, t.end, 'style');
      const css = c ? src.slice(t.end, c.start) : '';
      i = c ? c.end : t.end;
      out.push(`<style>${await rewriteCss(book, css.replace(/<!\[CDATA\[|\]\]>/g, ''), docDir)}</style>`);
      continue;
    }
    if (DROP_TAG.has(t.local)) continue;

    let tag = '<' + t.name;
    for (const [rawName, rawValue] of t.attrs) {
      const n = rawName.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'formaction' || !/^[A-Za-z_:][\w:.-]*$/.test(rawName)) continue;
      if (rawValue === null) {
        tag += ' ' + rawName;
        continue;
      }
      let value: string | null;
      if (URL_ATTRS.has(n) || n.endsWith(':href')) value = await rewriteUrlAttr(book, t.local, n.endsWith(':href') ? 'xlink:href' : n, rawValue, docDir);
      else if (n === 'style') value = await rewriteCss(book, decodeEntities(rawValue), docDir);
      else value = decodeEntities(rawValue);
      if (value !== null) tag += ` ${rawName}="${escAttr(value)}"`;
    }
    // XHTML self-closing non-void tags (<div/>) are open tags in HTML.
    if (VOID.has(t.local)) tag += '>';
    else tag += t.selfClose ? `></${t.name}>` : '>';
    out.push(tag);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// EPUB -> HTML
// ---------------------------------------------------------------------------

const BASE_CSS = `
html { -webkit-text-size-adjust: 100%; }
body { font-family: "Noto Serif", Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.5; color: #111; background: #fff; margin: 0; max-width: none; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 0.6em; orphans: 2; widows: 2; }
img, svg, video { max-width: 100%; height: auto; }
img { break-inside: avoid; }
figure { margin: 1em 0; break-inside: avoid; }
table { border-collapse: collapse; max-width: 100%; }
td, th { border: 1px solid #999; padding: 0.2em 0.4em; vertical-align: top; }
pre, code { font-family: "Noto Sans Mono", Consolas, monospace; font-size: 0.9em; }
pre { white-space: pre-wrap; }
blockquote { margin: 0.8em 1.5em; }
a { color: inherit; }
`;

export interface EpubHtml {
  html: string;
  title: string;
  author: string | null;
  chapters: number;
}

export async function epubToHtml(bytes: Uint8Array): Promise<EpubHtml> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('This file is not a valid EPUB (it is not a ZIP archive).');
  }
  const book: Book = {
    zip,
    names: new Map(Object.keys(zip.files).map((n) => [n.toLowerCase(), n])),
    types: new Map(),
    blocked: new Set(),
    dataUris: new Map(),
    chapterIds: new Map(),
  };

  // DRM: any encrypted resource that is not merely an obfuscated font.
  const enc = await readText(book, 'META-INF/encryption.xml');
  if (enc) {
    for (const block of enc.match(/<(?:[\w.-]+:)?EncryptedData\b[\s\S]*?<\/(?:[\w.-]+:)?EncryptedData\s*>/gi) ?? []) {
      let algorithm = '';
      let uri = '';
      for (const t of scanTags(block)) {
        if (t.local === 'encryptionmethod') algorithm = attr(t, 'Algorithm') ?? '';
        if (t.local === 'cipherreference') uri = attr(t, 'URI') ?? '';
      }
      if (!uri) continue;
      if (OBFUSCATION.has(algorithm)) {
        const name = entryName(book, resolvePath('', uri));
        if (name) book.blocked.add(name);
      } else {
        throw new Error('This EPUB is DRM-protected (its content is encrypted) and cannot be converted. Remove the protection with the software you bought it from, or use a DRM-free copy.');
      }
    }
  }

  const container = await readText(book, 'META-INF/container.xml');
  if (!container) throw new Error('Invalid EPUB: META-INF/container.xml is missing.');
  let opfPath: string | null = null;
  for (const t of scanTags(container)) {
    if (t.local !== 'rootfile') continue;
    const fp = attr(t, 'full-path');
    const mt = attr(t, 'media-type');
    if (fp && (!mt || mt === 'application/oebps-package+xml')) {
      opfPath = resolvePath('', fp);
      break;
    }
  }
  const opf = opfPath ? await readText(book, opfPath) : null;
  if (!opfPath || opf === null) throw new Error('Invalid EPUB: the package (OPF) file was not found.');
  const opfDir = dirOf(opfPath);

  const manifest = new Map<string, { path: string; type: string }>();
  const spine: string[] = [];
  for (const t of scanTags(opf)) {
    if (t.local === 'item') {
      const id = attr(t, 'id');
      const href = attr(t, 'href');
      if (!id || !href || REMOTE.test(href)) continue;
      const path = resolvePath(opfDir, href);
      const type = (attr(t, 'media-type') ?? '').toLowerCase();
      manifest.set(id, { path, type });
      const name = entryName(book, path);
      if (name && type) book.types.set(name, type);
    } else if (t.local === 'itemref') {
      const idref = attr(t, 'idref');
      if (idref) spine.push(idref);
    }
  }
  const metadata = /<(?:[\w.-]+:)?metadata\b[\s\S]*?<\/(?:[\w.-]+:)?metadata\s*>/i.exec(opf)?.[0] ?? opf;
  const title = elementText(metadata, 'title') ?? 'Untitled';
  const author = elementText(metadata, 'creator');
  const language = elementText(metadata, 'language');

  const docs = spine
    .map((id) => manifest.get(id))
    .filter((m): m is { path: string; type: string } => !!m && /html|xml/.test(m.type) && !!entryName(book, m.path));
  if (!docs.length) throw new Error('This EPUB has no readable chapters.');
  docs.forEach((d, k) => book.chapterIds.set(entryName(book, d.path)!, `epub-ch-${k + 1}`));

  const styles: string[] = [];
  const linkedCss = new Set<string>();
  const chapters: string[] = [];
  for (let k = 0; k < docs.length; k++) {
    const path = entryName(book, docs[k].path)!;
    const dir = dirOf(path);
    const src = (await readText(book, path)) ?? '';
    const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(src)?.[1] ?? '';
    const bodyOpen = /<body\b[^>]*>/i.exec(src);
    let body: string;
    if (bodyOpen) {
      const close = src.search(/<\/body\s*>/i);
      body = src.slice(bodyOpen.index + bodyOpen[0].length, close > bodyOpen.index ? close : undefined);
    } else {
      body = src.replace(/<head\b[\s\S]*?<\/head\s*>/i, '');
    }
    // Stylesheets linked from the head or body, each inlined once.
    for (const t of scanTags(head + body)) {
      if (t.local !== 'link') continue;
      const rel = (attr(t, 'rel') ?? '').toLowerCase();
      const href = attr(t, 'href');
      if (!href || !rel.includes('stylesheet') || rel.includes('alternate') || REMOTE.test(href)) continue;
      const cssPath = resolvePath(dir, href);
      const name = entryName(book, cssPath);
      if (!name || linkedCss.has(name)) continue;
      linkedCss.add(name);
      const css = await readText(book, name);
      if (css !== null) styles.push(await rewriteCss(book, css, dirOf(name), new Set([name])));
    }
    for (const m of head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      styles.push(await rewriteCss(book, m[1].replace(/<!\[CDATA\[|\]\]>/g, ''), dir));
    }
    const bodyTag = bodyOpen ? parseStartTag(bodyOpen[0], 0) : null;
    const bodyClass = bodyTag ? attr(bodyTag, 'class') : null;
    const inner = await rewriteBody(book, body, dir);
    const brk = k ? '<div style="break-before: page"></div>\n' : '';
    chapters.push(
      `${brk}<section class="epub-chapter${bodyClass ? ' ' + escAttr(bodyClass) : ''}" id="epub-ch-${k + 1}">\n${inner.trim()}\n</section>`,
    );
  }

  const lang = language ? ` lang="${escAttr(language)}"` : '';
  const html = [
    '<!doctype html>',
    `<html${lang}>`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escText(title)}</title>`,
    author ? `<meta name="author" content="${escAttr(author)}">` : '',
    `<style>${BASE_CSS}</style>`,
    ...styles.map((s) => `<style>\n${s}\n</style>`),
    '</head>',
    '<body>',
    chapters.join('\n'),
    '</body>',
    '</html>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { html, title, author, chapters: docs.length };
}

// ---------------------------------------------------------------------------
// PDF text -> EPUB 3
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; id: string }
  | { kind: 'para'; runs: { text: string; bold: boolean; italic?: boolean }[]; spaced?: boolean }
  | { kind: 'table'; rows: string[][] };

interface Chapter {
  title: string;
  blocks: Block[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Character-weighted median font size (so short captions do not dominate). */
function bodySize(lines: TextLine[]): number {
  const sizes: number[] = [];
  for (const l of lines) for (let k = 0; k < Math.min(60, l.text.length); k++) sizes.push(l.fontSize);
  return median(sizes);
}

function headingOf(l: TextLine, body: number): 0 | 1 | 2 | 3 {
  const text = lineText(l);
  if (!text || text.length > 160 || !(body > 0)) return 0;
  const r = l.fontSize / body;
  if (r >= 1.6) return 1;
  if (r >= 1.3) return 2;
  if (r >= 1.18) return 3;
  return 0;
}

function lineText(l: TextLine): string {
  const t = l.cells.length > 1 ? l.cells.map((c) => c.text).join(' ') : l.text || (l.cells[0]?.text ?? '');
  return stripInvalidXmlChars(t).replace(/\s+/g, ' ').trim();
}

function tableRows(lines: TextLine[]): string[][] {
  const width = Math.max(...lines.map((l) => (l.cells.some((c) => c.col !== undefined) ? Math.max(...l.cells.map((c) => (c.col ?? 0) + 1)) : l.cells.length)));
  return lines.map((l) => {
    const row: string[] = Array(width).fill('');
    l.cells.forEach((c, k) => {
      const at = c.col ?? k;
      row[at] = row[at] ? `${row[at]} ${c.text}` : c.text;
    });
    return row.map((s) => stripInvalidXmlChars(s).trim());
  });
}

/** Headings, paragraphs and tables from the page layout (the Word export's analysis). */
function layoutBlocks(pages: PageText[], graphics: DocxPageGraphics[]): Block[] {
  const blocks: Block[] = [];
  let hid = 0;
  for (const b of layoutReflow(pages, graphics)) {
    if (b.kind === 'heading') blocks.push({ kind: 'heading', level: b.level, text: b.text, id: `h${++hid}` });
    else if (b.kind === 'table') blocks.push({ kind: 'table', rows: b.rows });
    else {
      const runs: { text: string; bold: boolean; italic?: boolean }[] = b.bullet ? [{ text: '• ', bold: false, italic: false }] : [];
      for (const r of b.runs) {
        const last = runs[runs.length - 1];
        if (last && last.bold === r.bold && !!last.italic === r.italic) last.text += r.text;
        else runs.push({ ...r });
      }
      // These runs carry their own spacing.
      blocks.push({ kind: 'para', runs, spaced: true });
    }
  }
  return blocks;
}

/** Turns positioned lines into headings, paragraphs and tables. */
function pagesToBlocks(pages: PageText[], graphics?: DocxPageGraphics[]): Block[] {
  if (graphics) return layoutBlocks(pages, graphics);
  const all = pages.flatMap((p) => p.lines);
  const docBody = bodySize(all) || 11;
  const blocks: Block[] = [];
  let hid = 0;
  for (const page of pages) {
    const lines = page.lines.filter((l) => lineText(l));
    // "Clearly larger than the page's median"; short pages use the book's.
    const body = lines.length >= 5 ? Math.min(bodySize(lines) || docBody, docBody * 1.1) : docBody;
    const textWidth = Math.max(1, ...lines.map((l) => l.width ?? 0));
    let para: { runs: { text: string; bold: boolean }[] } | null = null;
    let prev: TextLine | null = null;
    const flush = () => {
      if (para && para.runs.length) blocks.push({ kind: 'para', runs: para.runs });
      para = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.cells.length >= 2) {
        flush();
        let j = i + 1;
        while (j < lines.length && lines[j].cells.length >= 2) j++;
        blocks.push({ kind: 'table', rows: tableRows(lines.slice(i, j)) });
        i = j - 1;
        prev = null;
        continue;
      }
      const level = headingOf(l, body);
      const text = lineText(l);
      if (level) {
        // Consecutive heading lines of the same size are one wrapped heading.
        const last = blocks[blocks.length - 1];
        if (!para && prev && last?.kind === 'heading' && last.level === level && Math.abs(prev.fontSize - l.fontSize) < 0.5 && l.y - prev.y < l.fontSize * 1.8) {
          last.text += ' ' + text;
        } else {
          flush();
          blocks.push({ kind: 'heading', level, text, id: `h${++hid}` });
        }
        prev = l;
        continue;
      }
      const cur: { runs: { text: string; bold: boolean }[] } | null = para;
      if (cur && prev) {
        const gap = l.y - prev.y;
        const prevText = lineText(prev);
        const endsShort = /[.!?:;"”»)]$/.test(prevText) && (prev.width ?? textWidth) < textWidth * 0.8;
        const sizeJump = Math.abs(l.fontSize - prev.fontSize) > Math.max(1, prev.fontSize * 0.15);
        if (gap > Math.max(l.fontSize, prev.fontSize) * 1.75 || gap < 0 || endsShort || sizeJump) flush();
      }
      if (!para) para = { runs: [] };
      const runs: { text: string; bold: boolean }[] = para.runs;
      const lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.bold === l.bold) {
        // De-hyphenate "exam-" + "ple"; otherwise join with a space.
        if (/[A-Za-zÀ-ɏ]-$/.test(lastRun.text) && /^[a-zà-ɏ]/.test(text)) lastRun.text = lastRun.text.slice(0, -1) + text;
        else lastRun.text += ' ' + text;
      } else {
        runs.push({ text: lastRun ? ' ' + text : text, bold: l.bold });
      }
      prev = l;
    }
    flush();
  }
  return blocks;
}

/** Splits at the top heading level present, or every ~5 pages without headings. */
function splitChapters(pages: PageText[], title: string, graphics?: DocxPageGraphics[]): Chapter[] {
  const blocks = pagesToBlocks(pages, graphics);
  const levels = blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading').map((b) => b.level);
  if (levels.length) {
    const top = Math.min(...levels);
    const chapters: Chapter[] = [];
    let cur: Chapter | null = null;
    for (const b of blocks) {
      if (b.kind === 'heading' && b.level === top) {
        cur = { title: b.text, blocks: [] };
        chapters.push(cur);
      } else if (!cur) {
        cur = { title, blocks: [] };
        chapters.push(cur);
      }
      cur.blocks.push(b);
    }
    return chapters;
  }
  const chapters: Chapter[] = [];
  for (let i = 0; i < pages.length; i += 5) {
    const slice = pages.slice(i, i + 5);
    const first = slice[0].pageNumber;
    const last = slice[slice.length - 1].pageNumber;
    chapters.push({ title: first === last ? `Page ${first}` : `Pages ${first}–${last}`, blocks: pagesToBlocks(slice, graphics?.slice(i, i + 5)) });
  }
  if (!chapters.length) chapters.push({ title, blocks: [] });
  return chapters;
}

function blockXhtml(b: Block, top: number): string {
  if (b.kind === 'heading') {
    // Chapter headings become h1; deeper ones keep their relative depth.
    const h = Math.min(6, 1 + b.level - top);
    return `<h${h} id="${b.id}">${xmlEscape(b.text)}</h${h}>`;
  }
  if (b.kind === 'table') {
    const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${xmlEscape(c)}</td>`).join('')}</tr>`).join('\n');
    return `<table>\n${rows}\n</table>`;
  }
  if (b.spaced) {
    const html = b.runs
      .map((r) => {
        const m = /^(\s*)(.*?)(\s*)$/s.exec(r.text)!;
        let t = xmlEscape(m[2]);
        if (t && r.italic) t = `<em>${t}</em>`;
        if (t && r.bold) t = `<strong>${t}</strong>`;
        return m[1] + t + m[3];
      })
      .join('');
    return `<p>${html.replace(/\s+/g, ' ').trim()}</p>`;
  }
  const wrap = (r: { text: string; bold: boolean; italic?: boolean }) => {
    const t = xmlEscape(r.text.trim());
    const i = r.italic ? `<em>${t}</em>` : t;
    return r.bold ? `<strong>${i}</strong>` : i;
  };
  const inner = b.runs.map((r) => (r.bold || r.italic ? wrap(r) : xmlEscape(r.text))).join(b.runs.length > 1 ? ' ' : '');
  return `<p>${inner.replace(/ {2,}/g, ' ').trim()}</p>`;
}

const XHTML_HEAD = (title: string, lang: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xmlEscape(lang)}" xml:lang="${xmlEscape(lang)}">\n<head>\n<meta charset="utf-8"/>\n<title>${xmlEscape(title)}</title>\n<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n`;

const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; }
p { margin: 0 0 0.6em; text-indent: 0; }
table { border-collapse: collapse; margin: 0.8em 0; }
td { border: 1px solid #999; padding: 0.2em 0.4em; vertical-align: top; }
`;

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface EpubMeta {
  title: string;
  author: string;
  /** BCP 47 tag, default 'en'. */
  language?: string;
}

/** `graphics` (from `collectDocxGraphics`) enables the page-layout analysis: ruled tables, lists, running headers left out. */
export async function pdfToEpub(pages: PageText[], meta: EpubMeta, graphics?: DocxPageGraphics[]): Promise<Blob> {
  const title = stripInvalidXmlChars(meta.title).trim() || 'Untitled';
  const author = stripInvalidXmlChars(meta.author ?? '').trim();
  const lang = (meta.language ?? 'en').trim() || 'en';
  const chapters = splitChapters(pages, title, graphics);
  const topLevel = Math.min(
    3,
    ...chapters.flatMap((c) => c.blocks).flatMap((b) => (b.kind === 'heading' ? [b.level] : [])),
  );
  const id = `urn:uuid:${uuid()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const zip = new JSZip();
  // OCF: `mimetype` must be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>\n',
  );
  zip.file('OEBPS/style.css', EPUB_CSS);

  const files = chapters.map((_, k) => `chapter${String(k + 1).padStart(3, '0')}.xhtml`);
  chapters.forEach((ch, k) => {
    const body = ch.blocks.map((b) => blockXhtml(b, topLevel)).join('\n') || '<p></p>';
    zip.file(`OEBPS/${files[k]}`, `${XHTML_HEAD(ch.title, lang)}<body>\n<section epub:type="chapter">\n${body}\n</section>\n</body>\n</html>\n`);
  });

  // Navigation: chapters, each with its sub-headings nested.
  const navItems = chapters
    .map((ch, k) => {
      const subs = ch.blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading' && b.level > topLevel);
      const first = ch.blocks[0];
      const anchor = first?.kind === 'heading' && first.level === topLevel ? `#${first.id}` : '';
      const nested = subs.length
        ? `\n<ol>\n${subs.map((s) => `<li><a href="${files[k]}#${s.id}">${xmlEscape(s.text)}</a></li>`).join('\n')}\n</ol>\n`
        : '';
      return `<li><a href="${files[k]}${anchor}">${xmlEscape(ch.title)}</a>${nested}</li>`;
    })
    .join('\n');
  zip.file(
    'OEBPS/nav.xhtml',
    `${XHTML_HEAD(title, lang)}<body>\n<nav epub:type="toc" id="toc">\n<h1>${xmlEscape(title)}</h1>\n<ol>\n${navItems}\n</ol>\n</nav>\n</body>\n</html>\n`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head>\n<meta name="dtb:uid" content="${id}"/>\n<meta name="dtb:depth" content="1"/>\n<meta name="dtb:totalPageCount" content="0"/>\n<meta name="dtb:maxPageNumber" content="0"/>\n</head>\n<docTitle><text>${xmlEscape(title)}</text></docTitle>\n<navMap>\n${chapters
      .map((ch, k) => `<navPoint id="np${k + 1}" playOrder="${k + 1}"><navLabel><text>${xmlEscape(ch.title)}</text></navLabel><content src="${files[k]}"/></navPoint>`)
      .join('\n')}\n</navMap>\n</ncx>\n`,
  );
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...files.map((f, k) => `<item id="ch${k + 1}" href="${f}" media-type="application/xhtml+xml"/>`),
  ].join('\n');
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${xmlEscape(lang)}">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:identifier id="bookid">${id}</dc:identifier>\n<dc:title>${xmlEscape(title)}</dc:title>\n${author ? `<dc:creator>${xmlEscape(author)}</dc:creator>\n` : ''}<dc:language>${xmlEscape(lang)}</dc:language>\n<meta property="dcterms:modified">${modified}</meta>\n</metadata>\n<manifest>\n${manifest}\n</manifest>\n<spine toc="ncx">\n${files.map((_, k) => `<itemref idref="ch${k + 1}"/>`).join('\n')}\n</spine>\n</package>\n`,
  );
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/epub+zip' });
}
