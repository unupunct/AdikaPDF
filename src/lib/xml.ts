/**
 * A small XML DOM that runs in the app and in Node tests (no DOMParser):
 * elements with their qualified names, attributes in order, text and CDATA
 * as text. Serialising gives back equivalent XML, so packets such as XFA
 * datasets, XMP metadata or e-invoices can be read, changed and written.
 */

export interface XEl {
  name: string;
  attrs: Array<[string, string]>;
  children: XNode[];
}
export type XNode = XEl | string;

export const isEl = (n: XNode | undefined): n is XEl => typeof n === 'object' && n !== null;

export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
    return String.fromCodePoint(cp);
  });
}

export const escapeXmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Line breaks and tabs in an attribute would come back as spaces (attribute normalisation): written as references.
export const escapeXmlAttr = (s: string) =>
  escapeXmlText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

/** Parses a document; the result is a synthetic root whose children are the top-level nodes. */
export function parseXmlDoc(xml: string): XEl {
  const root: XEl = { name: '#document', attrs: [], children: [] };
  const stack: XEl[] = [root];
  const n = xml.length;
  let i = 0;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const top = () => stack[stack.length - 1];
  const addText = (t: string) => {
    if (!t) return;
    const c = top().children;
    if (typeof c[c.length - 1] === 'string') c[c.length - 1] = (c[c.length - 1] as string) + t;
    else c.push(t);
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (stack.length > 1) addText(decodeXmlEntities(xml.slice(i)));
      break;
    }
    if (lt > i && stack.length > 1) addText(decodeXmlEntities(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      addText(xml.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (xml[j] === '[') depth++;
        else if (xml[j] === ']') depth--;
        else if (xml[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt);
      const nm = xml.slice(lt + 2, e < 0 ? n : e).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === nm) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    let q: string | null = null;
    for (; j < n; j++) {
      const c = xml[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const body = xml.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const el: XEl = { name, attrs: [], children: [] };
    if (sp >= 0) {
      attrRe.lastIndex = 0;
      const rest = inner.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rest))) el.attrs.push([m[1], decodeXmlEntities(m[3] ?? m[4] ?? '')]);
    }
    top().children.push(el);
    if (!selfClose) stack.push(el);
    i = j + 1;
  }
  return root;
}

/** The document element. */
export function parseXml(xml: string): XEl {
  const doc = parseXmlDoc(xml);
  const el = doc.children.find(isEl);
  if (!el) throw new Error('The XML has no element.');
  return el;
}

export function serializeXml(node: XNode, declaration = false): string {
  const out: string[] = [];
  if (declaration) out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const walk = (x: XNode) => {
    if (typeof x === 'string') {
      out.push(escapeXmlText(x));
      return;
    }
    if (x.name === '#document') {
      x.children.forEach(walk);
      return;
    }
    out.push('<', x.name);
    for (const [k, v] of x.attrs) out.push(' ', k, '="', escapeXmlAttr(v), '"');
    if (!x.children.length) {
      out.push('/>');
      return;
    }
    out.push('>');
    x.children.forEach(walk);
    out.push('</', x.name, '>');
  };
  walk(node);
  return out.join('');
}

// ------------------------------------------------------------------ queries

export const localName = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

export function attr(el: XEl | undefined, name: string): string | undefined {
  if (!el) return undefined;
  const hit = el.attrs.find(([k]) => k === name) ?? el.attrs.find(([k]) => localName(k) === name);
  return hit?.[1];
}

export function setAttr(el: XEl, name: string, value: string): void {
  const hit = el.attrs.find(([k]) => k === name);
  if (hit) hit[1] = value;
  else el.attrs.push([name, value]);
}

/** Child elements (by local name when given). */
export function kids(el: XEl | undefined, local?: string): XEl[] {
  if (!el) return [];
  return el.children.filter((c): c is XEl => isEl(c) && (!local || localName(c.name) === local));
}

export function kid(el: XEl | undefined, local: string): XEl | undefined {
  return el?.children.find((c): c is XEl => isEl(c) && localName(c.name) === local);
}

/** Follows a path of local names: path(invoice, 'AccountingSupplierParty', 'Party', 'PartyName'). */
export function path(el: XEl | undefined, ...locals: string[]): XEl | undefined {
  let cur = el;
  for (const l of locals) cur = kid(cur, l);
  return cur;
}

/** Every descendant with this local name. */
export function descendants(el: XEl | undefined, local: string, out: XEl[] = []): XEl[] {
  if (!el) return out;
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (localName(c.name) === local) out.push(c);
    descendants(c, local, out);
  }
  return out;
}

/** All text inside, concatenated. */
export function textOf(el: XNode | undefined): string {
  if (el === undefined) return '';
  if (typeof el === 'string') return el;
  return el.children.map(textOf).join('');
}

/** Replaces an element's content with text. */
export function setText(el: XEl, text: string): void {
  el.children = text ? [text] : [];
}

/** The namespace prefix an element uses ("xfa" for "xfa:data", "" for none). */
export const prefixOf = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(0, i) : '';
};
