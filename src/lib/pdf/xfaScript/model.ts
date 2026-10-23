/**
 * Research prototype (no UI): the part of an XFA template that its scripts
 * see, as plain JSON for the script runtime (runtime.js). Containers
 * (subforms, fields, exclusion groups, draws, areas, subform sets), their
 * occurrence rules, default values and types, list items, presence / access,
 * script objects (<variables><script name>) and every script with the event
 * it belongs to. Layout, fonts, pictures and data binding are left out.
 */
import { attr, isEl, kid, kids, localName, parseXml, textOf, type XEl } from '@/lib/xml';

export type XfaEventName = string;

export interface XfaScriptDef {
  /** initialize, calculate, validate, click, exit, enter, change, ready, docReady, preSave… */
  event: XfaEventName;
  /** $form / $layout for ready events. */
  ref?: string;
  lang: 'js' | 'formcalc';
  code: string;
}

export interface XfaNodeDef {
  cls: 'subform' | 'field' | 'exclGroup' | 'draw' | 'area' | 'subformSet' | 'pageSet' | 'pageArea' | 'form';
  name: string;
  occur?: { min: number; max: number; initial: number };
  /** Default value as text (null when the template has none). */
  value?: string | null;
  /** text, decimal, integer, float, date, time, dateTime, boolean, image, exData. */
  valueType?: string;
  /** textEdit, numericEdit, checkButton, choiceList, button, dateTimeEdit, signature, passwordEdit, imageEdit, barcode. */
  ui?: string;
  /** Display items and save items of a choice list or the on / off / neutral values of a check button. */
  items?: string[];
  saveItems?: string[];
  presence?: string;
  access?: string;
  nullTest?: string;
  toolTip?: string;
  bind?: string;
  scripts: XfaScriptDef[];
  scriptObjects?: Array<{ name: string; code: string }>;
  /** Named <variables> values (<text name="errMsg">…), seen by scripts as objects with .value. */
  dataVars?: Array<{ name: string; value: string }>;
  children: XfaNodeDef[];
}

export interface XfaModel {
  root: XfaNodeDef;
  stats: { containers: number; fields: number; scripts: number; js: number; formcalc: number; scriptObjects: number };
}

const CONTAINERS = new Set(['subform', 'field', 'exclGroup', 'draw', 'area', 'subformSet', 'pageSet', 'pageArea']);
const VALUE_TYPES = ['text', 'decimal', 'integer', 'float', 'date', 'time', 'dateTime', 'boolean', 'image', 'exData'];

function scriptOf(el: XEl | undefined): { lang: 'js' | 'formcalc'; code: string } | null {
  const s = el && kid(el, 'script');
  if (!s) return null;
  const code = textOf(s);
  if (!code.trim()) return null;
  return { lang: /javascript/i.test(attr(s, 'contentType') ?? '') ? 'js' : 'formcalc', code };
}

function valueOf(el: XEl): { value: string | null; type?: string } {
  const v = kid(el, 'value');
  if (!v) return { value: null };
  const inner = kids(v).find((k) => VALUE_TYPES.includes(localName(k.name)));
  if (!inner) return { value: null };
  const type = localName(inner.name);
  if (type === 'image') return { value: null, type };
  const t = textOf(inner);
  return { value: t === '' ? null : t, type };
}

function itemsOf(el: XEl): { items?: string[]; saveItems?: string[] } {
  const lists = kids(el, 'items');
  if (!lists.length) return {};
  const vals = (l: XEl) => kids(l).map((k) => textOf(k));
  const save = lists.find((l) => attr(l, 'save') === '1');
  const display = lists.find((l) => l !== save) ?? lists[0];
  return { items: vals(display), saveItems: save ? vals(save) : undefined };
}

function occurOf(el: XEl): XfaNodeDef['occur'] {
  const o = kid(el, 'occur');
  if (!o) return undefined;
  const min = Number(attr(o, 'min') ?? 1);
  const max = Number(attr(o, 'max') ?? 1);
  const initial = Number(attr(o, 'initial') ?? min);
  return { min, max, initial };
}

function build(el: XEl, stats: XfaModel['stats']): XfaNodeDef {
  const cls = localName(el.name) as XfaNodeDef['cls'];
  const node: XfaNodeDef = { cls, name: attr(el, 'name') ?? '', scripts: [], children: [] };
  stats.containers++;
  const presence = attr(el, 'presence');
  if (presence) node.presence = presence;
  const access = attr(el, 'access');
  if (access) node.access = access;
  const occur = occurOf(el);
  if (occur) node.occur = occur;
  if (cls === 'field' || cls === 'draw' || cls === 'exclGroup') {
    const { value, type } = valueOf(el);
    node.value = value;
    if (type) node.valueType = type;
  }
  if (cls === 'field') {
    stats.fields++;
    const ui = kid(el, 'ui');
    const uiKind = ui ? kids(ui).find((k) => !['extras', 'picture'].includes(localName(k.name))) : undefined;
    node.ui = uiKind ? localName(uiKind.name) : 'textEdit';
    Object.assign(node, itemsOf(el));
  }
  const tip = kid(kid(el, 'assist'), 'toolTip');
  if (tip) node.toolTip = textOf(tip);
  const bind = kid(el, 'bind');
  if (bind && attr(bind, 'match')) node.bind = attr(bind, 'match');
  const addScript = (event: string, s: { lang: 'js' | 'formcalc'; code: string } | null, ref?: string) => {
    if (!s) return;
    node.scripts.push({ event, ...(ref ? { ref } : {}), ...s });
    stats.scripts++;
    stats[s.lang]++;
  };
  for (const k of kids(el)) {
    const n = localName(k.name);
    if (n === 'event') addScript(attr(k, 'activity') ?? 'unknown', scriptOf(k), attr(k, 'ref'));
    else if (n === 'calculate') addScript('calculate', scriptOf(k));
    else if (n === 'validate') {
      if (attr(k, 'nullTest')) node.nullTest = attr(k, 'nullTest');
      addScript('validate', scriptOf(k));
    } else if (n === 'variables') {
      for (const v of kids(k)) {
        const vn = attr(v, 'name');
        if (vn && localName(v.name) !== 'script') (node.dataVars ??= []).push({ name: vn, value: textOf(v) });
      }
      for (const s of kids(k, 'script')) {
        const name = attr(s, 'name');
        if (!name) continue;
        (node.scriptObjects ??= []).push({ name, code: textOf(s) });
        stats.scriptObjects++;
        stats.scripts++;
        stats[/javascript/i.test(attr(s, 'contentType') ?? '') ? 'js' : 'formcalc']++;
      }
    } else if (CONTAINERS.has(n)) node.children.push(build(k, stats));
    else if (n === 'proto') continue;
  }
  return node;
}

/** The script-visible model of an XFA template packet. */
export function buildXfaModel(templateXml: string): XfaModel {
  const tpl = parseXml(templateXml);
  const stats = { containers: 0, fields: 0, scripts: 0, js: 0, formcalc: 0, scriptObjects: 0 };
  const top = kids(tpl).filter((k) => isEl(k) && localName(k.name) === 'subform');
  const root: XfaNodeDef = { cls: 'form', name: 'form', scripts: [], children: top.map((s) => build(s, stats)) };
  return { root, stats };
}
