/**
 * XFA forms (Adobe LiveCycle / AEM Forms), the format of many government and
 * bank forms.
 *
 * - Static XFA: the PDF also has ordinary form fields named like the XFA form
 *   ("form1[0].Page1[0].Name[0]"). Acrobat shows the values of the XFA data
 *   (datasets packet), so saving writes every filled value there too.
 * - Dynamic XFA: the pages exist only in the XFA template (the PDF page says
 *   "Please wait…"). pdf.js lays them out; xfaMeasure.ts turns that layout
 *   into a regular fillable PDF, and fillXfaData() writes filled values back
 *   into the original form so it stays an XFA form for Acrobat.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib';
import { attr, isEl, kid, kids, localName, parseXml, parseXmlDoc, prefixOf, serializeXml, setText, textOf, type XEl } from '@/lib/xml';

export type XfaKind = 'dynamic' | 'static';

function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  const a = doc.catalog.lookup(PDFName.of('AcroForm'));
  return a instanceof PDFDict ? a : undefined;
}

function streamText(doc: PDFDocument, v: unknown): string {
  const s = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (!(s instanceof PDFStream)) return '';
  const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getContents(): Uint8Array }).getContents();
  return new TextDecoder('utf-8').decode(bytes);
}

/** The XFA packets of a document (name -> XML), in file order. */
export function readXfaPackets(doc: PDFDocument): Array<[string, string]> | null {
  const xfa = acroFormOf(doc)?.lookup(PDFName.of('XFA'));
  if (!xfa) return null;
  if (xfa instanceof PDFArray) {
    const out: Array<[string, string]> = [];
    for (let i = 0; i + 1 < xfa.size(); i += 2) {
      const n = xfa.get(i);
      const name = n instanceof PDFString || n instanceof PDFHexString ? n.decodeText() : String(n);
      out.push([name, streamText(doc, xfa.get(i + 1))]);
    }
    return out;
  }
  // One stream with the whole XDP: split it into its packets.
  const xdp = streamText(doc, xfa);
  if (!xdp) return null;
  const root = parseXml(xdp);
  return kids(root).map((el) => [localName(el.name), serializeXml(el)] as [string, string]);
}

/** Replaces one packet (the datasets after filling). */
export function writeXfaPacket(doc: PDFDocument, name: string, xml: string): boolean {
  const acro = acroFormOf(doc);
  const xfa = acro?.lookup(PDFName.of('XFA'));
  if (!acro || !xfa) return false;
  const stream = doc.context.flateStream(new TextEncoder().encode(xml));
  if (xfa instanceof PDFArray) {
    for (let i = 0; i + 1 < xfa.size(); i += 2) {
      const n = xfa.get(i);
      const nm = n instanceof PDFString || n instanceof PDFHexString ? n.decodeText() : '';
      if (nm !== name) continue;
      const old = xfa.get(i + 1);
      if (old instanceof PDFRef) doc.context.assign(old, stream);
      else xfa.set(i + 1, doc.context.register(stream));
      return true;
    }
    // No such packet yet: before the postamble.
    const at = Math.max(0, xfa.size() - 2);
    xfa.insert(at, PDFString.of(name));
    xfa.insert(at + 1, doc.context.register(stream));
    return true;
  }
  const xdp = parseXml(streamText(doc, xfa));
  const newEl = parseXml(xml);
  const i = xdp.children.findIndex((c) => isEl(c) && localName(c.name) === name);
  if (i >= 0) xdp.children[i] = newEl;
  else xdp.children.push(newEl);
  acro.set(PDFName.of('XFA'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(serializeXml(xdp)))));
  return true;
}

/** Dynamic (pages from the template) or static (ordinary fields too); null when the PDF has no XFA. */
export async function xfaKind(bytes: Uint8Array): Promise<XfaKind | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return null;
  }
  return xfaKindOf(doc);
}

export function xfaKindOf(doc: PDFDocument): XfaKind | null {
  const acro = acroFormOf(doc);
  if (!acro?.lookup(PDFName.of('XFA'))) return null;
  const needs = doc.catalog.lookup(PDFName.of('NeedsRendering'));
  const fields = acro.lookup(PDFName.of('Fields'));
  const noFields = !(fields instanceof PDFArray) || fields.size() === 0;
  return (needs && String(needs) === 'true') || noFields ? 'dynamic' : 'static';
}

/** Drops the XFA form so readers use the ordinary fields (and pdf.js / Acrobat agree on the values). */
export function removeXfa(doc: PDFDocument): void {
  acroFormOf(doc)?.delete(PDFName.of('XFA'));
  doc.catalog.delete(PDFName.of('NeedsRendering'));
}

// ------------------------------------------------------------------ static XFA: field names -> data

interface Binding {
  /** Data path below xfa:data, each step a name with its occurrence index. */
  data: Array<{ name: string; index: number }>;
  kind: 'field' | 'checkbox' | 'exclGroup';
  /** checkButton values (on, off) / exclGroup choices (on value of each option). */
  items: string[];
}

const seg = (name: string, index: number) => `${name}[${index}]`;

function itemsOf(field: XEl): string[] {
  const items = kid(field, 'items');
  return kids(items).map((i) => textOf(i).trim());
}

function resolveRef(ref: string, root: string): Array<{ name: string; index: number }> | null {
  // "$.a.b", "$record.a.b", "$data.root.a" ("$" = the current record = data root's first child).
  const m = /^\$(record|data)?\.?(.*)$/.exec(ref.trim());
  if (!m) return null;
  const parts = m[2] ? m[2].split('.') : [];
  const steps = parts.map((p) => {
    const mm = /^([^[\]]+)(?:\[(\d+|\*)\])?$/.exec(p);
    return { name: mm ? mm[1] : p, index: mm && mm[2] && mm[2] !== '*' ? Number(mm[2]) : 0 };
  });
  if (m[1] === 'data') return steps;
  return [{ name: root, index: 0 }, ...steps];
}

/** XFA field names (as the ordinary fields of a static form use them) -> where the value lives in the data. */
export function xfaBindings(templateXml: string): Map<string, Binding> {
  const out = new Map<string, Binding>();
  const template = parseXml(templateXml);
  const rootForm = kids(template, 'subform')[0];
  if (!rootForm) return out;
  const rootName = attr(rootForm, 'name') ?? 'form1';

  const walk = (node: XEl, som: string, data: Array<{ name: string; index: number }>) => {
    const counts = new Map<string, number>();
    for (const c of kids(node)) {
      const type = localName(c.name);
      if (!['subform', 'subformSet', 'area', 'field', 'exclGroup'].includes(type)) continue;
      const name = attr(c, 'name');
      const key = name ?? `#${type}`;
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const path = `${som}.${seg(key, index)}`;
      const bind = kid(c, 'bind');
      const match = attr(bind, 'match') ?? 'once';
      let dataHere = data;
      if (match === 'dataRef') dataHere = resolveRef(attr(bind, 'ref') ?? '', rootName) ?? data;
      else if (match !== 'none' && name && type !== 'area') dataHere = [...data, { name, index }];
      if (type === 'field') {
        if (match === 'none' || !name) continue;
        const ui = kids(kid(c, 'ui'))[0];
        const isCheck = ui && localName(ui.name) === 'checkButton';
        out.set(path, { data: dataHere, kind: isCheck ? 'checkbox' : 'field', items: itemsOf(c) });
      } else if (type === 'exclGroup') {
        if (match === 'none' || !name) continue;
        out.set(path, { data: dataHere, kind: 'exclGroup', items: kids(c, 'field').map((f) => itemsOf(f)[0] ?? '') });
      } else {
        // Unnamed subforms and areas are transparent for the data.
        walk(c, path, type === 'subform' && !name && match !== 'dataRef' ? data : dataHere);
      }
    }
  };
  walk(rootForm, seg(rootName, 0), [{ name: rootName, index: 0 }]);
  return out;
}

function dataElement(datasetsXml: string): { doc: XEl; data: XEl } {
  const doc = parseXmlDoc(datasetsXml);
  const ds = kids(doc)[0];
  if (!ds) throw new Error('Empty datasets');
  let data = kid(ds, 'data');
  if (!data) {
    const pre = prefixOf(ds.name);
    data = { name: pre ? `${pre}:data` : 'data', attrs: [], children: [] };
    ds.children.push(data);
  }
  return { doc, data };
}

/** Finds (or creates) the data element at a path. */
function ensurePath(data: XEl, path: Array<{ name: string; index: number }>): XEl {
  let cur = data;
  for (const step of path) {
    const same = kids(cur).filter((k) => localName(k.name) === step.name);
    let next = same[step.index];
    while (!next) {
      next = { name: step.name, attrs: [], children: [] };
      cur.children.push(next);
      same.push(next);
      next = same[step.index];
    }
    cur = next;
  }
  return cur;
}

/** Writes filled values into the datasets XML. Returns the new XML and the field names it could not place. */
export function fillDatasets(templateXml: string, datasetsXml: string, values: Record<string, string | boolean | string[]>): { xml: string; unmapped: string[] } {
  const bindings = xfaBindings(templateXml);
  const { doc, data } = dataElement(datasetsXml);
  const unmapped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const b = bindings.get(name);
    if (!b) {
      unmapped.push(name);
      continue;
    }
    let text: string;
    if (b.kind === 'checkbox') text = value === true ? (b.items[0] ?? '1') : value === false ? (b.items[1] ?? '0') : String(value);
    else if (b.kind === 'exclGroup') {
      const v = String(value);
      text = b.items.includes(v) ? v : /^\d+$/.test(v) && b.items[Number(v)] !== undefined ? b.items[Number(v)] : v;
    } else text = Array.isArray(value) ? value.join('\n') : String(value);
    setText(ensurePath(data, b.data), text);
  }
  return { xml: serializeXml(doc), unmapped };
}

/** Sets the whole XFA form (as an array of packets). */
export function writeXfaPackets(doc: PDFDocument, packets: Array<[string, string]>): void {
  let acro = acroFormOf(doc);
  if (!acro) {
    acro = doc.context.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro));
  }
  const arr = doc.context.obj([]);
  for (const [name, xml] of packets) {
    arr.push(PDFString.of(name));
    arr.push(doc.context.register(doc.context.flateStream(new TextEncoder().encode(xml))));
  }
  acro.set(PDFName.of('XFA'), arr);
}

/**
 * Puts a static form's XFA back after saving (pdf-lib drops it as soon as
 * the form is touched) with the filled values in its data. When a filled
 * field has no place in the XFA data, the XFA stays out: better an ordinary
 * form that shows the values than an XFA form that shows old ones. Call it
 * after the last form operation; save without updateFieldAppearances.
 */
export function restoreStaticXfa(doc: PDFDocument, packets: Array<[string, string]>, values: Record<string, string | boolean | string[]>): 'synced' | 'removed' {
  const template = packets.find(([n]) => n === 'template')?.[1];
  const hasDatasets = packets.some(([n]) => n === 'datasets');
  const datasets = packets.find(([n]) => n === 'datasets')?.[1] ?? '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>';
  try {
    if (!template) throw new Error('no template');
    const r = fillDatasets(template, datasets, values);
    if (r.unmapped.length) throw new Error(`unmapped ${r.unmapped.join(', ')}`);
    const out = packets.map(([n, x]) => [n, n === 'datasets' ? r.xml : x] as [string, string]);
    if (!hasDatasets) out.splice(Math.max(0, out.findIndex(([n]) => n === 'postamble')), 0, ['datasets', r.xml]);
    writeXfaPackets(doc, out);
    return 'synced';
  } catch {
    removeXfa(doc);
    return 'removed';
  }
}

/** The data part of a form as XML (what the form submits). */
export function xfaDataXml(packets: Array<[string, string]>): string | null {
  const ds = packets.find(([n]) => n === 'datasets')?.[1];
  if (!ds) return null;
  const data = kid(kids(parseXmlDoc(ds))[0], 'data');
  const root = kids(data)[0];
  return root ? `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(root)}\n` : null;
}

// ------------------------------------------------------------------ dynamic XFA (pdf.js layout)

/** A node of pdf.js' XFA HTML tree. */
export interface XfaHtmlNode {
  name: string;
  attributes?: Record<string, unknown> & { id?: string; xfaName?: string; class?: string[]; fieldId?: string; dataId?: string };
  children?: XfaHtmlNode[];
  value?: string;
}

/**
 * Field names in the XFA way ("form1[0].Main[0].Name[0]") for each field of
 * pdf.js' layout, keyed by its fieldId. Containers that continue on later
 * pages keep their index.
 */
export function xfaFieldNames(pages: XfaHtmlNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const index = new Map<string, Map<string, number>>(); // parent instance -> "name|childId" -> index
  const counters = new Map<string, Map<string, number>>(); // parent instance -> name -> next index
  const indexOf = (parent: string, name: string, id: string) => {
    let byId = index.get(parent);
    if (!byId) index.set(parent, (byId = new Map()));
    const k = `${name}|${id}`;
    let i = byId.get(k);
    if (i === undefined) {
      let c = counters.get(parent);
      if (!c) counters.set(parent, (c = new Map()));
      i = c.get(name) ?? 0;
      c.set(name, i + 1);
      byId.set(k, i);
    }
    return i;
  };
  const walk = (n: XfaHtmlNode, parentId: string, prefix: string) => {
    const a = n.attributes ?? {};
    const cls = a.class ?? [];
    const id = a.id;
    if (id && (cls.includes('xfaSubform') || cls.includes('xfaExclgroup') || cls.includes('xfaField') || cls.includes('xfaArea'))) {
      const isField = cls.includes('xfaField');
      const name = a.xfaName || (cls.includes('xfaSubform') ? '#subform' : cls.includes('xfaArea') ? '#area' : isField ? '#field' : '#exclGroup');
      const path = prefix ? `${prefix}.${name}[${indexOf(parentId, name, id)}]` : `${name}[0]`;
      if (isField) out.set(id, path);
      for (const c of n.children ?? []) walk(c, id, path);
      return;
    }
    for (const c of n.children ?? []) walk(c, parentId, prefix);
  };
  for (const p of pages) walk(p, '#root', '');
  return out;
}

export interface XfaInput {
  /** XFA name of the field; for a radio button the name of its group (exclGroup). */
  name: string;
  fieldId: string;
  dataId: string;
  type: 'text' | 'textarea' | 'checkbox' | 'radio' | 'select';
  value: string;
  /** Checkbox / radio values when on and off. */
  on?: string;
  off?: string;
  options?: Array<{ value: string; label: string }>;
}

/** Every input of pdf.js' XFA layout with its XFA name and data id. */
export function xfaInputs(pages: XfaHtmlNode[]): XfaInput[] {
  const names = xfaFieldNames(pages);
  const out: XfaInput[] = [];
  const seen = new Set<string>();
  const walk = (n: XfaHtmlNode) => {
    const a = (n.attributes ?? {}) as Record<string, unknown> & { fieldId?: string; dataId?: string };
    if (a.fieldId && a.dataId && ['input', 'textarea', 'select'].includes(n.name)) {
      const som = names.get(a.fieldId);
      const t = String(a.type ?? '');
      const type: XfaInput['type'] = n.name === 'textarea' ? 'textarea' : n.name === 'select' ? 'select' : t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : 'text';
      if (som && !seen.has(a.fieldId)) {
        seen.add(a.fieldId);
        const group = type === 'radio' ? som.slice(0, som.lastIndexOf('.')) : som;
        const checked = a.checked === true;
        out.push({
          name: group,
          fieldId: a.fieldId,
          dataId: a.dataId,
          type,
          value: type === 'checkbox' || type === 'radio' ? (checked ? String(a.xfaOn ?? '1') : String(a.xfaOff ?? '0')) : String(a.value ?? n.value ?? ''),
          on: a.xfaOn !== undefined ? String(a.xfaOn) : undefined,
          off: a.xfaOff !== undefined ? String(a.xfaOff) : undefined,
          options: type === 'select' ? (n.children ?? []).filter((o) => o.name === 'option').map((o) => ({ value: String(o.attributes?.value ?? o.value ?? ''), label: String(o.value ?? '') })) : undefined,
        });
      }
    }
    (n.children ?? []).forEach(walk);
  };
  pages.forEach(walk);
  return out;
}

interface PdfjsLike {
  getDocument(src: { data: Uint8Array; enableXfa: boolean; verbosity?: number } & Record<string, unknown>): { promise: Promise<PdfjsXfaDoc>; destroy(): Promise<void> };
}
interface PdfjsXfaDoc {
  annotationStorage: { setValue(key: string, value: unknown): void };
  allXfaHtml: unknown;
  saveDocument(): Promise<Uint8Array>;
}

/**
 * Writes filled values (keyed by XFA field name, as the converted form names
 * its fields) back into the original dynamic XFA form, which stays an XFA form.
 */
export async function fillXfaData(pdfjs: PdfjsLike, original: Uint8Array, values: Record<string, string | boolean | string[]>, extra: Record<string, unknown> = {}): Promise<Uint8Array> {
  const task = pdfjs.getDocument({ data: original.slice(), enableXfa: true, verbosity: 0, ...extra });
  try {
    const doc = await task.promise;
    const html = doc.allXfaHtml as XfaHtmlNode | null;
    for (const input of xfaInputs(html?.children ?? [])) {
      if (!(input.name in values)) continue;
      const v = values[input.name];
      let value: string | null;
      if (input.type === 'checkbox') value = v === true || v === input.on ? (input.on ?? '1') : (input.off ?? '0');
      else if (input.type === 'radio') value = v === input.on ? input.on : null;
      else value = Array.isArray(v) ? (v[0] ?? '') : String(v);
      if (value !== null) doc.annotationStorage.setValue(input.dataId, { value });
    }
    return await doc.saveDocument();
  } finally {
    await task.destroy();
  }
}
