/**
 * Check spelling (like Acrobat's Edit > Check Spelling): the texts people
 * wrote in a document (comments, text boxes, typewriter text, form field
 * values) are checked by the Windows spell checker; this module collects
 * them and applies corrections. Pure.
 */
import type { EditorObject, PageRef } from '@/types';

export interface SpellTarget {
  /** "obj:<id>" for an object, "field:<sourceId>::<name>" for a filled form field. */
  key: string;
  /** Where it is, e.g. "Comment, page 2". */
  label: string;
  pageId?: string;
  text: string;
}

export interface SpellFinding {
  start: number;
  length: number;
  action: 'suggest' | 'replace' | 'delete';
  replacement: string;
  suggestions: string[];
}

export interface SpellIssue extends SpellFinding {
  target: SpellTarget;
  word: string;
}

const KIND: Partial<Record<EditorObject['type'], string>> = {
  note: 'Comment',
  markup: 'Comment',
  poly: 'Comment',
  measure: 'Comment',
  attachment: 'Comment',
  text: 'Text box',
};

/** Texts of the document's objects people typed. */
export function collectTargets(objects: EditorObject[], pages: PageRef[]): SpellTarget[] {
  const pageNo = new Map(pages.map((p, i) => [p.id, i + 1]));
  const out: SpellTarget[] = [];
  for (const o of objects) {
    const n = pageNo.get(o.pageId);
    if (!n) continue;
    if (o.type === 'field') {
      if (o.fieldKind === 'text' && o.value.trim()) out.push({ key: `obj:${o.id}`, label: `Form field ${o.name}`, pageId: o.pageId, text: o.value });
      continue;
    }
    const kind = o.type === 'text' ? (o.annotation ? 'Typewriter' : 'Text box') : KIND[o.type];
    const text = (o as { text?: string }).text;
    if (!kind || typeof text !== 'string' || !text.trim()) continue;
    // Edited page text (Edit text, Find & replace) is the document's own text, not a comment.
    if (o.type === 'text' && o.replaces?.length) continue;
    out.push({ key: `obj:${o.id}`, label: `${kind}, page ${n}`, pageId: o.pageId, text });
  }
  return out;
}

export function issuesOf(targets: SpellTarget[], findings: SpellFinding[][]): SpellIssue[] {
  const out: SpellIssue[] = [];
  targets.forEach((t, i) => {
    for (const f of findings[i] ?? []) out.push({ ...f, target: t, word: t.text.slice(f.start, f.start + f.length) });
  });
  return out;
}

export function replaceAt(text: string, start: number, length: number, by: string): string {
  return text.slice(0, start) + by + text.slice(start + length);
}

/**
 * Applies a change to one issue and moves the later issues of the same text
 * (their positions shift by the length difference). Returns the new text and
 * the remaining issues.
 */
export function applyChange(issues: SpellIssue[], index: number, by: string): { text: string; rest: SpellIssue[] } {
  const it = issues[index];
  // A repeated word ("the the"): deleting also removes the space before it.
  let start = it.start;
  let length = it.length;
  if (it.action === 'delete' && by === '') {
    while (start > 0 && /\s/.test(it.target.text[start - 1])) {
      start--;
      length++;
    }
  }
  const text = replaceAt(it.target.text, start, length, by);
  const delta = by.length - length;
  const target = { ...it.target, text };
  const rest: SpellIssue[] = [];
  issues.forEach((x, i) => {
    if (i === index) return;
    if (x.target.key !== it.target.key) {
      rest.push(x);
      return;
    }
    if (x.start >= start + length) rest.push({ ...x, start: x.start + delta, target });
    else if (x.start + x.length <= start) rest.push({ ...x, target });
    // overlapping: dropped
  });
  return { text, rest };
}

const PREFERRED: Record<string, string> = { en: 'en-US', ro: 'ro-RO', de: 'de-DE', fr: 'fr-FR', hu: 'hu-HU', it: 'it-IT', es: 'es-ES' };

/** The spelling language to start with: the interface language when Windows has it. */
export function defaultSpellLang(uiLang: string, available: string[], remembered?: string | null): string | null {
  if (!available.length) return null;
  const has = (t: string) => available.find((a) => a.toLowerCase() === t.toLowerCase());
  if (remembered && has(remembered)) return has(remembered)!;
  const want = PREFERRED[uiLang] ?? uiLang;
  return has(want) ?? available.find((a) => a.toLowerCase().startsWith(`${uiLang.toLowerCase()}-`)) ?? has('en-US') ?? available[0];
}
