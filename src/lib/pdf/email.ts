// E-mail (.eml / .mht MIME, Outlook .msg) -> standalone, print-friendly HTML.
//
// Everything runs locally. Parsers are loaded lazily (postal-mime for MIME,
// @kenjiuno/msgreader for Outlook CFB files) so they only land in the bundle
// chunk of whoever imports this module.
//
// The HTML body is sanitised with a small tokenizer (no DOM needed, so it
// also runs in node tests): active content is removed, `cid:` references are
// resolved to data: URIs and remote resources are blocked unless the caller
// explicitly allows them (privacy: remote images are tracking beacons).
//
// Bundling note: msgreader imports iconv-lite, which needs Node's Buffer and
// throws on load in the browser. vite.config.ts must alias
// `iconv-lite` -> src/lib/pdf/iconvLiteShim.ts (TextDecoder based).

export interface EmailAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** True when the attachment is referenced from the body (cid: image). */
  inline: boolean;
}

export interface EmailRender {
  html: string;
  subject: string;
  attachments: EmailAttachment[];
}

export interface EmailOptions {
  allowRemoteImages?: boolean;
}

// ---------------------------------------------------------------------------
// Normalised message
// ---------------------------------------------------------------------------

interface RawAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  contentId?: string;
}

interface ParsedMail {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** Parsed date, or the raw header text when unparseable. */
  date?: Date | string;
  html?: string;
  text?: string;
  attachments: RawAttachment[];
  notes: string[];
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && CFB_MAGIC.every((b, i) => bytes[i] === b);
}

export async function emailToHtml(bytes: Uint8Array, fileName: string, opts: EmailOptions = {}): Promise<EmailRender> {
  const mail = isCfb(bytes) || /\.msg$/i.test(fileName) ? await parseMsg(bytes) : await parseMime(bytes);
  return renderMail(mail, fileName, opts);
}

// ---------------------------------------------------------------------------
// MIME (.eml, .mht) via postal-mime
// ---------------------------------------------------------------------------

interface PmMailbox {
  name: string;
  address?: string;
  group?: PmMailbox[];
}

function formatAddress(a: PmMailbox | undefined): string {
  if (!a) return '';
  if (a.group) return `${a.name ? a.name + ': ' : ''}${a.group.map(formatAddress).join(', ')}`;
  if (a.name && a.address && a.name !== a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '';
}

async function parseMime(bytes: Uint8Array): Promise<ParsedMail> {
  const { default: PostalMime } = await import('postal-mime');
  const email = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
  const header = (k: string) => email.headers.find((h) => h.key === k)?.value;
  let date: Date | string | undefined;
  const rawDate = header('date');
  if (rawDate) {
    const d = new Date(rawDate);
    date = Number.isNaN(d.getTime()) ? rawDate : d;
  }
  const attachments: RawAttachment[] = email.attachments.map((a, i) => {
    const content = a.content;
    const data =
      typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content instanceof Uint8Array
          ? content
          : new Uint8Array(content);
    return {
      name: a.filename || `attachment-${i + 1}${extForMime(a.mimeType)}`,
      mime: a.mimeType || 'application/octet-stream',
      bytes: data,
      contentId: a.contentId,
    };
  });
  // MHT pages reference parts by Content-Location, which postal-mime does not
  // expose; those parts are matched by file name in resolveRef() instead.
  return {
    subject: email.subject ?? '',
    from: formatAddress(email.from as PmMailbox | undefined),
    to: (email.to ?? []).map((a) => formatAddress(a as PmMailbox)).join(', '),
    cc: (email.cc ?? []).map((a) => formatAddress(a as PmMailbox)).join(', '),
    date,
    html: email.html || undefined,
    text: email.text || undefined,
    attachments,
    notes: [],
  };
}

function extForMime(mime: string | undefined): string {
  const m = (mime || '').toLowerCase();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/html': '.html',
    'message/rfc822': '.eml',
  };
  return map[m] ?? '';
}

// ---------------------------------------------------------------------------
// Outlook .msg via @kenjiuno/msgreader
// ---------------------------------------------------------------------------

/** Maps a Windows code page to a WHATWG TextDecoder label. */
export function codepageToLabel(cp: number | undefined): string {
  if (!cp) return 'windows-1252';
  if (cp === 65001) return 'utf-8';
  if (cp === 1200) return 'utf-16le';
  if (cp === 1201) return 'utf-16be';
  if (cp === 874 || (cp >= 1250 && cp <= 1258)) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28606) return `iso-8859-${cp - 28590}`;
  const map: Record<number, string> = {
    20127: 'us-ascii',
    20866: 'koi8-r',
    21866: 'koi8-u',
    932: 'shift_jis',
    936: 'gbk',
    54936: 'gb18030',
    949: 'euc-kr',
    950: 'big5',
    50220: 'iso-2022-jp',
    51932: 'euc-jp',
    10000: 'macintosh',
  };
  return map[cp] ?? 'windows-1252';
}

function decodeBytes(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function parseMsg(bytes: Uint8Array): Promise<ParsedMail> {
  const { default: MsgReader } = await import('@kenjiuno/msgreader');
  // Copy into a standalone ArrayBuffer (the input may be a view into a larger one).
  let reader = new MsgReader(bytes.slice().buffer);
  let f = reader.getFileData();
  if (f.error) throw new Error(`Not a readable Outlook message: ${f.error}`);
  // Non-Unicode (PT_STRING8) properties are stored in the message code page;
  // msgreader reads them as Latin-1 unless told otherwise, so re-parse.
  const ansiCp = f.messageCodepage || f.internetCodepage;
  if (ansiCp && ansiCp !== 1252 && ansiCp !== 20127) {
    reader = new MsgReader(bytes.slice().buffer);
    reader.parserConfig = { ansiEncoding: codepageToLabel(ansiCp) };
    f = reader.getFileData();
    if (f.error) throw new Error(`Not a readable Outlook message: ${f.error}`);
  }
  const notes: string[] = [];
  const recips = f.recipients ?? [];
  const fmt = (r: { name?: string; email?: string; smtpAddress?: string }) => {
    const addr = r.smtpAddress || r.email || '';
    return r.name && addr && r.name !== addr ? `${r.name} <${addr}>` : addr || r.name || '';
  };
  const list = (t: 'to' | 'cc') => recips.filter((r) => (r.recipType ?? 'to') === t).map(fmt).filter(Boolean).join(', ');
  const senderAddr = f.senderSmtpAddress || f.senderEmail || '';
  const from =
    f.senderName && senderAddr && f.senderName !== senderAddr ? `${f.senderName} <${senderAddr}>` : senderAddr || f.senderName || '';
  const rawDate = f.messageDeliveryTime || f.clientSubmitTime || f.creationTime;
  let date: Date | string | undefined;
  if (rawDate) {
    const d = new Date(rawDate);
    date = Number.isNaN(d.getTime()) ? rawDate : d;
  }

  let html: string | undefined = f.bodyHtml || undefined;
  if (!html && f.html && f.html.length) html = decodeBytes(f.html, codepageToLabel(f.internetCodepage));
  let text: string | undefined = f.body || undefined;
  if (!html && f.compressedRtf && f.compressedRtf.length) {
    try {
      const { decompressRTF } = await import('@kenjiuno/decompressrtf');
      const rtf = new Uint8Array(decompressRTF(Array.from(f.compressedRtf)));
      const deenc = deEncapsulateHtmlFromRtf(rtf);
      if (deenc !== null) html = deenc;
      else if (text) notes.push('This message has a rich-text (RTF) body; it is shown as plain text.');
      else {
        text = rtfToPlainText(rtf);
        notes.push('This message has a rich-text (RTF) body; formatting was not preserved.');
      }
    } catch {
      if (text) notes.push('This message has a rich-text (RTF) body; it is shown as plain text.');
    }
  }

  const attachments: RawAttachment[] = [];
  (f.attachments ?? []).forEach((a, i) => {
    let content: Uint8Array;
    let name: string;
    try {
      const got = reader.getAttachment(i);
      content = got.content;
      name = got.fileName;
    } catch {
      return;
    }
    name = name || a.fileName || a.fileNameShort || `attachment-${i + 1}${a.extension ?? ''}`;
    attachments.push({
      name,
      mime: a.attachMimeTag || (a.innerMsgContent ? 'application/vnd.ms-outlook' : guessMime(name)),
      bytes: content,
      contentId: a.pidContentId,
    });
  });

  return {
    subject: f.subject ?? '',
    from,
    to: list('to'),
    cc: list('cc'),
    date,
    html,
    text,
    attachments,
    notes,
  };
}

function guessMime(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    htm: 'text/html',
    html: 'text/html',
    eml: 'message/rfc822',
    msg: 'application/vnd.ms-outlook',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// RTF helpers (encapsulated HTML per [MS-OXRTFEX])
// ---------------------------------------------------------------------------

interface RtfState {
  skip: boolean; // inside an ignored destination
  htmltag: boolean; // inside {\*\htmltag ...}
  htmlrtf: boolean; // \htmlrtf suppression
  uc: number;
}

/**
 * Walks an RTF byte stream calling `emit` for text. Handles groups, control
 * words, \'hh bytes (decoded with \ansicpg) and \uN with \ucN skipping.
 */
function walkRtf(
  rtf: Uint8Array,
  onText: (text: string, st: RtfState) => void,
  onWord?: (word: string, param: number | null, st: RtfState, isDestStart: boolean) => boolean | void,
): void {
  let label = 'windows-1252';
  const stack: RtfState[] = [];
  let st: RtfState = { skip: false, htmltag: false, htmlrtf: false, uc: 1 };
  let pendingBytes: number[] = [];
  let groupStart = false; // just after '{'
  let starDest = false; // just saw \*
  let skipChars = 0;
  const flushBytes = () => {
    if (pendingBytes.length) {
      const s = decodeBytes(new Uint8Array(pendingBytes), label);
      pendingBytes = [];
      onText(s, st);
    }
  };
  const text = (s: string) => {
    flushBytes();
    onText(s, st);
  };
  const IGNORED = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr',
    'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata',
    'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'revtbl', 'pgdsctbl', 'mmathPr',
  ]);
  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i];
    if (c === 0x7b /* { */) {
      flushBytes();
      stack.push(st);
      st = { ...st };
      groupStart = true;
      starDest = false;
      i++;
      continue;
    }
    if (c === 0x7d /* } */) {
      flushBytes();
      st = stack.pop() ?? st;
      groupStart = false;
      starDest = false;
      i++;
      continue;
    }
    if (c === 0x5c /* \ */) {
      const nx = rtf[i + 1];
      if (nx === undefined) break;
      // Control symbol.
      if (!((nx >= 0x61 && nx <= 0x7a) || (nx >= 0x41 && nx <= 0x5a))) {
        i += 2;
        if (nx === 0x27 /* ' */) {
          const hex = String.fromCharCode(rtf[i] ?? 0x30, rtf[i + 1] ?? 0x30);
          i += 2;
          if (skipChars > 0) {
            skipChars--;
            continue;
          }
          if (!st.skip) pendingBytes.push(parseInt(hex, 16) || 0);
          continue;
        }
        if (nx === 0x2a /* * */) {
          starDest = true;
          continue;
        }
        groupStart = false;
        if (st.skip) continue;
        if (nx === 0x5c || nx === 0x7b || nx === 0x7d) text(String.fromCharCode(nx));
        else if (nx === 0x7e) text(' ');
        else if (nx === 0x5f) text('‑');
        else if (nx === 0x0a || nx === 0x0d) text('\n');
        continue;
      }
      // Control word.
      let j = i + 1;
      while (j < n && ((rtf[j] >= 0x61 && rtf[j] <= 0x7a) || (rtf[j] >= 0x41 && rtf[j] <= 0x5a))) j++;
      const word = String.fromCharCode(...rtf.subarray(i + 1, j));
      let param: number | null = null;
      let k = j;
      if (rtf[k] === 0x2d || (rtf[k] >= 0x30 && rtf[k] <= 0x39)) {
        const s = k;
        k++;
        while (k < n && rtf[k] >= 0x30 && rtf[k] <= 0x39) k++;
        param = parseInt(String.fromCharCode(...rtf.subarray(s, k)), 10);
      }
      if (rtf[k] === 0x20) k++;
      i = k;
      const destStart = groupStart;
      groupStart = false;
      // Control words can change the output state (htmlrtf): emit pending text first.
      flushBytes();
      if (word === 'ansicpg' && param !== null) {
        label = codepageToLabel(param);
        continue;
      }
      if (onWord && onWord(word, param, st, destStart)) {
        starDest = false;
        continue;
      }
      if (destStart && (starDest || IGNORED.has(word))) {
        flushBytes();
        st.skip = true;
        starDest = false;
        continue;
      }
      starDest = false;
      if (st.skip) continue;
      if (word === 'uc' && param !== null) st.uc = param;
      else if (word === 'u' && param !== null) {
        flushBytes();
        const code = param < 0 ? param + 65536 : param;
        onText(String.fromCharCode(code), st);
        skipChars = st.uc;
      } else if (word === 'par' || word === 'line') text('\n');
      else if (word === 'tab') text('\t');
      else if (word === 'emdash') text('—');
      else if (word === 'endash') text('–');
      else if (word === 'bullet') text('•');
      else if (word === 'lquote') text('‘');
      else if (word === 'rquote') text('’');
      else if (word === 'ldblquote') text('“');
      else if (word === 'rdblquote') text('”');
      continue;
    }
    groupStart = false;
    starDest = false;
    if (c === 0x0d || c === 0x0a) {
      i++;
      continue;
    }
    if (skipChars > 0) {
      skipChars--;
      i++;
      continue;
    }
    if (!st.skip) pendingBytes.push(c);
    i++;
  }
  flushBytes();
}

/**
 * Returns the HTML encapsulated in an RTF body (`\fromhtml1`), or null when
 * the RTF is native (not produced from HTML).
 */
export function deEncapsulateHtmlFromRtf(rtf: Uint8Array): string | null {
  const head = String.fromCharCode(...rtf.subarray(0, Math.min(rtf.length, 512)));
  if (!/\\fromhtml1/.test(head)) return null;
  const out: string[] = [];
  walkRtf(
    rtf,
    (t, st) => {
      if (st.htmltag || !st.htmlrtf) out.push(t);
    },
    (word, param, st, destStart) => {
      if (destStart && word === 'htmltag') {
        st.htmltag = true;
        st.skip = false;
        st.htmlrtf = false;
        return true;
      }
      if (destStart && word === 'mhtmltag') {
        st.skip = true;
        return true;
      }
      if (word === 'htmlrtf') {
        st.htmlrtf = param !== 0;
        return true;
      }
      return false;
    },
  );
  return out.join('').replace(/\r?\n/g, '\n');
}

function rtfToPlainText(rtf: Uint8Array): string {
  const out: string[] = [];
  walkRtf(rtf, (t) => out.push(t));
  return out.join('').trim();
}

// ---------------------------------------------------------------------------
// Sanitiser (pure, tokenizer based)
// ---------------------------------------------------------------------------

const DROP_WITH_CONTENT = new Set([
  'script', 'iframe', 'object', 'applet', 'frame', 'frameset', 'noscript', 'noembed', 'noframes', 'title',
  'select', 'textarea', 'template', 'xml',
]);
const DROP_TAG = new Set([
  'embed', 'form', 'input', 'button', 'option', 'optgroup', 'meta', 'base', 'link', 'html', 'head', 'body',
  'param', 'keygen', 'portal', 'fencedframe',
]);
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'xml', 'template']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'background', 'poster', 'lowsrc', 'dynsrc', 'data', 'cite', 'longdesc', 'usemap', 'xlink:href', 'ping', 'codebase', 'manifest', 'profile']);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'ping', 'http-equiv', 'nonce', 'integrity']);

export interface SanitizeContext {
  allowRemote: boolean;
  /** Resolves a cid:/relative reference to a data: URI, or null. */
  resolveRef: (ref: string) => string | null;
  /** Incremented for every blocked remote resource. */
  blocked: number;
}

function decodeEntitiesLoose(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => safeFromCode(parseInt(d, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeFromCode(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

type UrlKind = 'ok' | 'dangerous' | 'remote' | 'cid';

function classifyUrl(raw: string, forImage: boolean): UrlKind {
  // Browsers ignore control chars and whitespace inside the scheme.
  const v = decodeEntitiesLoose(raw).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('livescript:') || v.startsWith('mocha:')) return 'dangerous';
  if (v.startsWith('data:')) {
    if (forImage && /^data:image\/(png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/.test(v)) return 'ok';
    return forImage ? 'dangerous' : /^data:(image\/|text\/plain)/.test(v) && !v.startsWith('data:image/svg') ? 'ok' : 'dangerous';
  }
  if (v.startsWith('cid:')) return 'cid';
  if (/^(https?:|ftp:)?\/\//.test(v) || v.startsWith('http:') || v.startsWith('https:')) return 'remote';
  if (/^[a-z][a-z0-9+.-]*:/.test(v)) {
    return !forImage && /^(mailto|tel|sms|callto):/.test(v) ? 'ok' : 'dangerous';
  }
  return 'ok'; // relative / fragment
}

/** Sanitises a CSS text (style element or attribute). */
export function sanitizeCss(css: string, ctx: SanitizeContext): string {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Unescape CSS escapes for the danger checks only.
  const probe = s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => safeFromCode(parseInt(h, 16))).replace(/\\(.)/g, '$1').toLowerCase();
  const DANGER = /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding/i;
  if (DANGER.test(probe)) {
    // Drop every declaration carrying active content.
    s = s.replace(/[^;{}]*(?:expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding)[^;{}]*;?/gi, '');
    // Hidden behind CSS escapes: give up on the whole style text.
    const again = s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => safeFromCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    if (DANGER.test(again)) return '';
  }
  // @import: remote stylesheets are blocked unless allowed; others are dropped.
  s = s.replace(/@import\s+(url\(\s*)?(['"]?)([^'")\s;]+)\2\s*\)?[^;]*;?/gi, (m, _u, _q, url: string) => {
    const k = classifyUrl(url, false);
    if (k === 'remote' && ctx.allowRemote) return m;
    if (k === 'remote') ctx.blocked++;
    return '';
  });
  s = s.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, url: string) => {
    const k = classifyUrl(url, true);
    if (k === 'cid') {
      const data = ctx.resolveRef(url);
      return data ? `url("${data}")` : 'none';
    }
    if (k === 'remote') {
      if (ctx.allowRemote) return m;
      ctx.blocked++;
      return 'none';
    }
    if (k === 'dangerous') return 'none';
    const local = ctx.resolveRef(url);
    return local ? `url("${local}")` : m;
  });
  return s.replace(/<\/(style)/gi, '<\\/$1');
}

const BLOCKED_IMG = '<span class="adika-blocked" title="Remote image blocked">[remote image blocked]</span>';

function escapeAttr(v: string): string {
  return v.replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const ATTR_RE = /([^\s"'>/=\u0000-\u001f]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * Sanitises an HTML document or fragment and returns a fragment (styles are
 * kept inline as <style> elements; html/head/body wrappers are dropped).
 */
export function sanitizeHtml(html: string, ctx: SanitizeContext): string {
  const out: string[] = [];
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    i = lt;
    // Comments / conditional comments / doctype / processing instructions.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(html.slice(i, i + 64));
    if (!m) {
      out.push('&lt;');
      i++;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    // Find the end of the tag, honouring quoted attribute values.
    let j = i + m[0].length;
    let quote = '';
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        // Only treat as a quote when it starts an attribute value.
        if (/=\s*$/.test(html.slice(Math.max(i, j - 8), j))) quote = ch;
      } else if (ch === '>') break;
      j++;
    }
    const attrText = html.slice(i + m[0].length, j).replace(/\/\s*$/, '');
    const selfClosing = /\/\s*$/.test(html.slice(i + m[0].length, j));
    i = Math.min(n, j + 1);
    const bareName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

    if (!closing && RAWTEXT.has(bareName)) {
      const endIdx = lower.indexOf(`</${name}`, i);
      const inner = html.slice(i, endIdx < 0 ? n : endIdx);
      i = endIdx < 0 ? n : Math.min(n, (html.indexOf('>', endIdx) + 1) || n);
      if (bareName === 'style') out.push(`<style>${sanitizeCss(inner, ctx)}</style>`);
      else if (bareName === 'textarea') out.push(`<pre>${inner.replace(/</g, '&lt;')}</pre>`);
      continue;
    }
    if (DROP_WITH_CONTENT.has(bareName)) {
      if (closing) continue;
      if (selfClosing) continue;
      const endIdx = lower.indexOf(`</${name}`, i);
      i = endIdx < 0 ? n : Math.min(n, (html.indexOf('>', endIdx) + 1) || n);
      continue;
    }
    if (DROP_TAG.has(bareName)) {
      if (bareName === 'link' && !closing && ctx.allowRemote) {
        const attrs = parseAttrs(attrText);
        const href = attrs.get('href') ?? '';
        if (/stylesheet/i.test(attrs.get('rel') ?? '') && classifyUrl(href, false) === 'remote') {
          out.push(`<link rel="stylesheet" href="${escapeAttr(href)}">`);
        }
      } else if (bareName === 'link' && !closing) {
        const attrs = parseAttrs(attrText);
        if (/stylesheet/i.test(attrs.get('rel') ?? '') && classifyUrl(attrs.get('href') ?? '', false) === 'remote') ctx.blocked++;
      }
      continue;
    }
    if (closing) {
      out.push(`</${name}>`);
      continue;
    }
    const attrs = parseAttrs(attrText);
    const kept: string[] = [];
    let replaceWithPlaceholder = false;
    for (const [rawKey, value] of attrs) {
      const key = rawKey.toLowerCase();
      if (key.startsWith('on') || DROP_ATTRS.has(key)) continue;
      if (key === 'style') {
        kept.push(`style="${escapeAttr(sanitizeCss(value, ctx))}"`);
        continue;
      }
      if (key === 'srcset' || key === 'imagesrcset') {
        // Keep only candidates that are safe and local.
        const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
        const safe: string[] = [];
        for (const p of parts) {
          const [u, ...rest] = p.split(/\s+/);
          const k = classifyUrl(u, true);
          if (k === 'ok') safe.push(p);
          else if (k === 'cid') {
            const d = ctx.resolveRef(u);
            if (d) safe.push([d, ...rest].join(' '));
          } else if (k === 'remote') {
            if (ctx.allowRemote) safe.push(p);
            else ctx.blocked++;
          }
        }
        if (safe.length) kept.push(`${key}="${escapeAttr(safe.join(', '))}"`);
        continue;
      }
      if (URL_ATTRS.has(key)) {
        const forImage = key !== 'href' && key !== 'xlink:href' && key !== 'cite' && key !== 'longdesc' && key !== 'usemap';
        const k = classifyUrl(value, forImage);
        if (k === 'dangerous') continue;
        if (k === 'cid') {
          const d = ctx.resolveRef(value);
          if (d) kept.push(`${key}="${escapeAttr(d)}"`);
          continue;
        }
        if (k === 'remote' && forImage && !ctx.allowRemote) {
          ctx.blocked++;
          if (bareName === 'img' && key === 'src') replaceWithPlaceholder = true;
          continue;
        }
        if (k === 'ok' && forImage) {
          // Relative references (MHT Content-Location parts).
          const d = ctx.resolveRef(value);
          if (d) {
            kept.push(`${key}="${escapeAttr(d)}"`);
            continue;
          }
        }
        if (key === 'href' && bareName === 'a') {
          kept.push(`href="${escapeAttr(value)}"`);
          continue;
        }
      }
      if (key === 'target' || key === 'xmlns' || key.startsWith('xmlns:')) continue;
      kept.push(value === '' && !attrText.includes(`${rawKey}=`) ? key : `${key}="${escapeAttr(value)}"`);
    }
    if (replaceWithPlaceholder) {
      out.push(BLOCKED_IMG);
      continue;
    }
    if (bareName === 'a' && kept.some((k) => k.startsWith('href='))) kept.push('rel="noopener noreferrer"');
    out.push(`<${name}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing ? ' /' : ''}>`);
  }
  return out.join('');
}

function parseAttrs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(text))) {
    const key = m[1];
    const k = key.toLowerCase();
    if (map.has(k) || !/^[a-z_:][-a-z0-9_:.]*$/.test(k)) continue;
    map.set(k, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes plain text and turns http(s)/mailto URLs into links. */
export function linkifyText(text: string): string {
  const re = /\b((?:https?:\/\/|mailto:)[^\s<>"']+|www\.[^\s<>"']+)/gi;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let url = m[1];
    const trail = /[).,;:!?\]]+$/.exec(url);
    if (trail && !(trail[0].startsWith(')') && url.includes('('))) url = url.slice(0, url.length - trail[0].length);
    out += htmlEscape(text.slice(last, m.index));
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    out += `<a href="${htmlEscape(href)}" rel="noopener noreferrer">${htmlEscape(url)}</a>`;
    last = m.index + url.length;
    re.lastIndex = last;
  }
  return out + htmlEscape(text.slice(last));
}

function base64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(d: Date | string | undefined): string {
  if (!d) return '';
  if (typeof d === 'string') return d;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(d);
  } catch {
    return d.toString();
  }
}

const SAFE_INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

function normCid(s: string): string {
  let v = s.trim();
  if (/^cid:/i.test(v)) v = v.slice(4);
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep raw */
  }
  return v.replace(/^<|>$/g, '').trim().toLowerCase();
}

const DOC_CSS = `
@page { margin: 15mm }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Segoe UI", "Noto Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; margin: 0; background: #fff; overflow-wrap: anywhere; }
.adika-mail-header { border-collapse: collapse; width: 100%; margin: 0 0 14px; background: #f5f6f8; border: 1px solid #d9dce1; font-size: 10pt; }
.adika-mail-header th { text-align: left; vertical-align: top; padding: 4px 10px; width: 80px; color: #555; font-weight: 600; white-space: nowrap; }
.adika-mail-header td { padding: 4px 10px; }
.adika-mail-header tr.subject td { font-weight: 700; font-size: 12pt; }
.adika-notice { font-size: 9pt; color: #6b4e00; background: #fff6d6; border: 1px solid #f0dc9a; padding: 4px 8px; margin: 0 0 10px; }
.adika-blocked { display: inline-block; font-size: 8pt; color: #777; border: 1px dashed #bbb; padding: 1px 4px; }
.adika-mail-body { max-width: 100%; }
.adika-mail-body img { max-width: 100%; height: auto; }
.adika-mail-body table { max-width: 100%; }
.adika-mail-body pre.adika-plain { white-space: pre-wrap; font-family: Consolas, "Noto Sans Mono", monospace; font-size: 10pt; margin: 0; }
.adika-attachments { margin-top: 18px; border-top: 1px solid #d9dce1; padding-top: 8px; font-size: 10pt; page-break-inside: avoid; }
.adika-attachments h2 { font-size: 11pt; margin: 0 0 4px; }
.adika-attachments ul { margin: 0; padding-left: 20px; }
.adika-attachments .size { color: #666; }
`;

function renderMail(mail: ParsedMail, fileName: string, opts: EmailOptions): EmailRender {
  const byCid = new Map<string, number>();
  const byName = new Map<string, number>();
  mail.attachments.forEach((a, i) => {
    if (a.contentId) byCid.set(normCid(a.contentId), i);
    byName.set(a.name.toLowerCase(), i);
  });
  const used = new Set<number>();
  const dataUris = new Map<number, string>();
  const dataUriFor = (idx: number): string | null => {
    const a = mail.attachments[idx];
    const mime = SAFE_INLINE_IMAGE.test(a.mime) ? a.mime : guessMime(a.name);
    if (!SAFE_INLINE_IMAGE.test(mime)) return null;
    used.add(idx);
    let uri = dataUris.get(idx);
    if (!uri) {
      uri = `data:${mime.toLowerCase()};base64,${base64(a.bytes)}`;
      dataUris.set(idx, uri);
    }
    return uri;
  };
  const ctx: SanitizeContext = {
    allowRemote: !!opts.allowRemoteImages,
    blocked: 0,
    resolveRef: (ref) => {
      if (/^cid:/i.test(ref.trim())) {
        const key = normCid(ref);
        let idx = byCid.get(key);
        if (idx === undefined) idx = byName.get(key) ?? byName.get(key.split('@')[0]);
        return idx === undefined ? null : dataUriFor(idx);
      }
      // Relative reference: match an attachment by file name (MHT parts).
      const v = decodeEntitiesLoose(ref).trim();
      if (!v || v.startsWith('#') || v.startsWith('data:')) return null;
      const base = v.split(/[?#]/)[0].split('/').pop()?.toLowerCase() ?? '';
      const idx = byName.get(base);
      return idx === undefined ? null : dataUriFor(idx);
    },
  };

  let bodyHtml: string;
  if (mail.html) {
    bodyHtml = sanitizeHtml(mail.html, ctx);
  } else if (mail.text) {
    bodyHtml = `<pre class="adika-plain" style="white-space:pre-wrap">${linkifyText(mail.text.replace(/\r\n?/g, '\n'))}</pre>`;
  } else {
    bodyHtml = '<p><em>(This message has no body.)</em></p>';
  }

  const subject = mail.subject || fileName.replace(/\.[^.]+$/, '');
  const rows: string[] = [];
  const row = (label: string, value: string, cls = '') => {
    if (value) rows.push(`<tr${cls ? ` class="${cls}"` : ''}><th>${label}</th><td>${htmlEscape(value)}</td></tr>`);
  };
  row('From', mail.from);
  row('To', mail.to);
  row('Cc', mail.cc);
  row('Date', formatDate(mail.date));
  row('Subject', mail.subject || '(no subject)', 'subject');

  const notices = [...mail.notes];
  if (ctx.blocked > 0) {
    notices.unshift(
      `Remote content blocked for privacy (${ctx.blocked} ${ctx.blocked === 1 ? 'item' : 'items'}). Enable remote images to load it.`,
    );
  }

  const attachments: EmailAttachment[] = mail.attachments.map((a, i) => ({
    name: a.name,
    mime: a.mime,
    bytes: a.bytes,
    inline: used.has(i),
  }));
  const listed = attachments.filter((a) => !a.inline);
  const attHtml = listed.length
    ? `<div class="adika-attachments"><h2>Attachments (${listed.length})</h2><ul>${listed
        .map((a) => `<li>${htmlEscape(a.name)} <span class="size">(${formatSize(a.bytes.length)})</span></li>`)
        .join('')}</ul></div>`
    : '';

  const html =
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${ctx.allowRemote ? ' http: https:' : ''}; style-src 'unsafe-inline'${ctx.allowRemote ? ' http: https:' : ''}; font-src data:${ctx.allowRemote ? ' http: https:' : ''}">` +
    `<title>${htmlEscape(subject)}</title><style>${DOC_CSS}</style></head><body>` +
    notices.map((t) => `<div class="adika-notice">${htmlEscape(t)}</div>`).join('') +
    `<table class="adika-mail-header">${rows.join('')}</table>` +
    `<div class="adika-mail-body">${bodyHtml}</div>` +
    attHtml +
    '</body></html>';

  return { html, subject, attachments };
}
