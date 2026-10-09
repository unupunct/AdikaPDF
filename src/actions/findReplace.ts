/**
 * Find & replace and Redact by pattern.
 *
 * Replacing adds a text object over each match whose `replaces` areas tell
 * the exporter to delete the original letters from the page content; the
 * new text uses a matching font family, size, weight and colour. Redacting
 * marks each match with a redaction box, applied with "Apply & save".
 */
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { makeRedaction, makeText } from '@/lib/objectFactory';
import { canvasMeasure, layoutText, TEXT_PADDING } from '@/lib/textLayout';
import { normalizeAngle, normalizeRotation, totalRotation } from '@/lib/geometry';
import { findPattern, type PatternId } from '@/lib/patterns';
import type { Finder, Range, TextMatch } from '@/lib/pdf/textSearch';
import type { BookmarkItem, EditorObject, PageRef, TextObject } from '@/types';
import type { DocMeta, FieldValue } from '@/store/usePDFStore';
import type { ElsewhereHit, ElsewhereKind, ElsewhereOptions } from '@/lib/pdf/redactElsewhere';
import type { SearchOptions } from '@/lib/search';
import { tellFontFallbacks } from './fontNotes';

export async function findMatches(finder: Finder): Promise<TextMatch[]> {
  const s = usePDFStore.getState();
  const [{ findTextMatches }, { pageTextRuns }] = await Promise.all([import('@/lib/pdf/textSearch'), import('@/lib/pdf/textGeometry')]);
  return findTextMatches(s.pages, s.sources, finder, pageTextRuns);
}

export async function queryMatches(query: string, opts: SearchOptions = {}): Promise<TextMatch[]> {
  const { queryFinder } = await import('@/lib/pdf/textSearch');
  return findMatches(queryFinder(query, opts));
}

/** A text object that sits exactly on the baseline of the match. */
export function replacementFor(m: TextMatch, text: string): TextObject {
  const style = usePDFStore.getState().style;
  const fontSize = Math.round(m.size * 10) / 10;
  const measure = canvasMeasure({ family: m.family, bold: m.bold, italic: m.italic }, fontSize);
  const base = makeText(m.pageId, 0, 0, style, {
    text,
    fontSize,
    fontFamily: m.family,
    bold: m.bold,
    italic: m.italic,
    color: m.color,
    background: null,
    // Room for the new text on one line.
    width: Math.max(m.width, measure(text)) + TEXT_PADDING * 2 + fontSize * 0.6,
    replaces: m.rects.map((r) => ({ ...r })),
  });
  const layout = layoutText(base);
  const baseline = layout.lines[0]?.baseline ?? fontSize;
  const [dx, dy] = m.dir;
  const ux = dy;
  const uy = -dx;
  return {
    ...base,
    x: m.origin[0] - dx * TEXT_PADDING + ux * baseline,
    y: m.origin[1] - dy * TEXT_PADDING + uy * baseline,
    rotation: normalizeAngle(Math.round((Math.atan2(dy, dx) * 180) / Math.PI)),
    height: layout.contentHeight,
  };
}

function addAll(objs: EditorObject[]) {
  if (!objs.length) return;
  usePDFStore.getState().commit((s) => ({ objects: [...s.objects, ...objs] }));
}

/**
 * Replaces every match right away: each affected source document is rebuilt
 * with the old letters deleted and the new text written in (in the
 * document's own font when it has the letters, the rest of the line moved
 * to make room), and the pages switch to it. Undo switches them back.
 */
export async function replaceAll(query: string, replacement: string, opts: SearchOptions = {}): Promise<{ replaced: number; approximate: number }> {
  const store = usePDFStore.getState();
  const why = blockedReason(store, 'content');
  if (why) {
    store.toast(why, 'info');
    return { replaced: 0, approximate: 0 };
  }
  const matches = await queryMatches(query, opts);
  if (!matches.length) {
    store.toast(`“${query}” was not found.`, 'info');
    return { replaced: 0, approximate: 0 };
  }
  const { withBusy } = await import('./document');
  const done = await withBusy('Replacing text…', async () => {
    const s0 = usePDFStore.getState();
    const pageById = new Map(s0.pages.map((p) => [p.id, p]));
    const bySource = new Map<string, TextMatch[]>();
    for (const m of matches) {
      const sid = pageById.get(m.pageId)?.sourceId;
      if (sid) bySource.set(sid, [...(bySource.get(sid) ?? []), m]);
    }
    const [{ buildPdf }, { PDFDocument }] = await Promise.all([import('@/lib/pdf/exportPdf'), import('pdf-lib')]);
    let pages = s0.pages;
    let fieldValues = s0.fieldValues;
    for (const [sid, list] of bySource) {
      const src = s0.sources[sid];
      if (!src) continue;
      // Every page of the source, in order; pages in the document keep their id and rotation.
      const lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
      const refs: PageRef[] = lib.getPages().map((pg, i) => {
        const cur = pages.find((p) => p.sourceId === sid && p.sourceIndex === i);
        if (cur) return cur;
        const box = pg.getCropBox();
        return { id: `tmp-${sid}-${i}`, kind: 'source', sourceId: sid, sourceIndex: i, baseRotation: normalizeRotation(pg.getRotation().angle), userRotation: 0, width: box.width, height: box.height };
      });
      const onRefs = new Set(refs.map((r) => r.id));
      const objs = list.filter((m) => onRefs.has(m.pageId)).map((m) => replacementFor(m, replacement));
      const bytes = await buildPdf({ sources: { [sid]: src }, pages: refs, objects: objs, fieldValues: {} }, { onFontFallback: tellFontFallbacks });
      const { source, pages: fresh } = await usePDFStore.getState().addSource(bytes, src.name);
      pages = pages.map((p) => {
        if (p.sourceId !== sid) return p;
        const n = fresh[p.sourceIndex];
        return { ...p, sourceId: source.id, baseRotation: n.baseRotation, userRotation: normalizeRotation(totalRotation(p) - n.baseRotation), width: n.width, height: n.height };
      });
      const prefix = `${sid}::`;
      fieldValues = Object.fromEntries(Object.entries(fieldValues).map(([k, v]) => [k.startsWith(prefix) ? `${source.id}::${k.slice(prefix.length)}` : k, v]));
    }
    usePDFStore.getState().commit(() => ({ pages, fieldValues }));
    return true;
  });
  if (!done) return { replaced: 0, approximate: 0 };
  const approximate = matches.filter((m) => !m.exact).length;
  usePDFStore
    .getState()
    .toast(
      `Replaced ${matches.length} occurrence${matches.length === 1 ? '' : 's'}.` +
        (approximate ? ` ${approximate} on pages whose text cannot be edited exactly: there the old text is covered.` : '') +
        ' Undo (Ctrl+Z) restores the original.',
      'success',
    );
  return { replaced: matches.length, approximate };
}

export interface SensitiveQuery {
  patterns: PatternId[];
  terms: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** Combined finder: pattern ranges plus plain terms, overlapping ranges merged. */
export async function sensitiveFinder(q: SensitiveQuery): Promise<Finder> {
  const { queryFinder } = await import('@/lib/pdf/textSearch');
  const termFinders = q.terms.map((t) => queryFinder(t, { caseSensitive: q.caseSensitive, wholeWord: q.wholeWord }));
  return (text) => {
    const ranges: Range[] = [...q.patterns.flatMap((p) => findPattern(p, text)), ...termFinders.flatMap((f) => f(text))];
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged: Range[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  };
}

export async function findSensitive(q: SensitiveQuery): Promise<TextMatch[]> {
  return findMatches(await sensitiveFinder(q));
}

/** Marks matches for redaction (1 pt margin); returns the number of boxes. */
export function markForRedaction(matches: TextMatch[]): number {
  const objs = matches.flatMap((m) => m.rects.map((r) => makeRedaction(m.pageId, { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 })));
  addAll(objs);
  return objs.length;
}

// ---------------------------------------------------------------- outside the page text

export interface ElsewhereMatch extends ElsewhereHit {
  /** 1-based page of the document (comments, links). */
  page?: number;
}

const COMMENT_TYPES = new Set(['note', 'markup', 'stamp', 'poly', 'measure']);

/** "12 0 R" -> pdf.js' "12R". */
function pdfjsId(ref: string): string {
  const m = /^(\d+) (\d+) R$/.exec(ref);
  return m ? (m[2] === '0' ? `${m[1]}R` : `${m[1]}R${m[2]}`) : ref;
}

function firstMatch(finder: Finder, texts: Array<string | undefined>): string | null {
  for (const t of texts) {
    const r = t ? finder(t) : [];
    if (r.length) return t!.slice(r[0][0], r[0][1]);
  }
  return null;
}

/** Text fields of an editor object a comment / attachment / link carries. */
function objectTexts(o: EditorObject): string[] {
  const t: string[] = [];
  if ('text' in o && typeof o.text === 'string') t.push(o.text);
  if ('author' in o && typeof o.author === 'string') t.push(o.author);
  if (o.type === 'markup') t.push(o.selectedText);
  if (o.type === 'stamp') t.push(o.label, o.subtitle);
  if (o.type === 'attachment') t.push(o.fileName);
  return t;
}

function objectKind(o: EditorObject): ElsewhereKind | null {
  if (COMMENT_TYPES.has(o.type) || (o.type === 'text' && o.annotation)) return 'comment';
  if (o.type === 'attachment') return 'attachment';
  if (o.type === 'link') return 'link';
  return null;
}

function walkBookmarks(items: BookmarkItem[], fn: (b: BookmarkItem) => void): void {
  for (const b of items) {
    fn(b);
    walkBookmarks(b.children, fn);
  }
}

const META_KEYS: Array<[keyof DocMeta, string]> = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['copyright', 'Copyright'],
];

function fieldValueText(v: FieldValue): string[] {
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

/** Hits in comments, fields, bookmarks, metadata, attachments, links and alternate text: the files and the unsaved edits. */
export async function findSensitiveElsewhere(q: SensitiveQuery): Promise<ElsewhereMatch[]> {
  const finder = await sensitiveFinder(q);
  const [{ findElsewhere }, { PDFDocument }] = await Promise.all([import('@/lib/pdf/redactElsewhere'), import('pdf-lib')]);
  const s = usePDFStore.getState();
  const out: ElsewhereMatch[] = [];
  for (const sid of new Set(s.pages.map((p) => p.sourceId).filter((x): x is string => !!x))) {
    const src = s.sources[sid];
    if (!src) continue;
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    for (const h of findElsewhere(doc, finder)) {
      if (h.pageIndex === undefined) {
        // Edited bookmarks replace the file's own when saving: those are listed below.
        if (!(h.kind === 'bookmark' && s.outline)) out.push(h);
        continue;
      }
      const page = s.pages.find((p) => p.sourceId === sid && p.sourceIndex === h.pageIndex);
      // Not in the document, or taken over into the editor (listed below).
      if (!page || (h.ref && page.takenAnnots?.includes(pdfjsId(h.ref)))) continue;
      out.push({ ...h, page: s.pages.indexOf(page) + 1 });
    }
  }
  const pageNo = (id: string) => s.pages.findIndex((p) => p.id === id) + 1;
  for (const o of s.objects) {
    const kind = objectKind(o);
    if (kind) {
      const hit = firstMatch(finder, o.type === 'link' ? [o.target.kind === 'url' ? o.target.url : ''] : objectTexts(o));
      if (hit) out.push({ kind, where: kind === 'comment' ? 'Comment' : kind === 'link' ? 'Link' : 'Attachment', page: pageNo(o.pageId), text: hit });
    } else if (o.type === 'field') {
      const v = firstMatch(finder, [o.value]);
      if (v) out.push({ kind: 'fieldValue', where: 'Field value', detail: o.name, text: v });
      const n = firstMatch(finder, [o.name]);
      if (n) out.push({ kind: 'fieldName', where: 'Field name', detail: o.name, text: n });
    }
  }
  for (const [key, v] of Object.entries(s.fieldValues)) {
    const hit = firstMatch(finder, fieldValueText(v));
    if (hit) out.push({ kind: 'fieldValue', where: 'Field value', detail: key.split('::').slice(1).join('::'), text: hit });
  }
  if (s.outline) walkBookmarks(s.outline, (b) => {
    const hit = firstMatch(finder, [b.title]);
    if (hit) out.push({ kind: 'bookmark', where: 'Bookmark', text: hit });
  });
  if (s.docMeta) {
    for (const [k, label] of META_KEYS) {
      const hit = firstMatch(finder, [s.docMeta[k] as string | undefined]);
      if (hit) out.push({ kind: 'metadata', where: `Metadata: ${label}`, text: hit });
    }
    for (const [k, v] of Object.entries(s.docMeta.custom ?? {})) {
      const hit = firstMatch(finder, [k, v]);
      if (hit) out.push({ kind: 'metadata', where: `Metadata: ${k}`, text: hit });
    }
  }
  // A field value or property found both in the file and in the unsaved edits is listed once.
  const seen = new Set<string>();
  return out.filter((m) => {
    if (m.kind !== 'fieldValue' && m.kind !== 'metadata') return true;
    const key = [m.kind, m.where, m.page ?? '', m.detail ?? '', m.text].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Redacts the hits outside the page text right away (undoable): each
 * affected source is rewritten without them (unreferenced objects dropped, no
 * earlier revision kept) and the unsaved edits are cleaned the same way.
 */
export async function redactSensitiveElsewhere(q: SensitiveQuery, opts: ElsewhereOptions): Promise<number> {
  const store = usePDFStore.getState();
  const why = blockedReason(store, 'content');
  if (why) {
    store.toast(why, 'info');
    return 0;
  }
  const finder = await sensitiveFinder(q);
  const kinds = new Set(opts.kinds ?? ['comment', 'fieldValue', 'fieldName', 'bookmark', 'metadata', 'attachment', 'link', 'altText']);
  const want = (k: ElsewhereKind) => kinds.has(k) && (k !== 'fieldName' || !!opts.fieldNames);
  const [{ findElsewhere, redactElsewhere, blockOut }, { PDFDocument }, { dropUnreachableObjects }, { withBusy }] = await Promise.all([
    import('@/lib/pdf/redactElsewhere'),
    import('pdf-lib'),
    import('@/lib/pdf/prune'),
    import('./document'),
  ]);
  const block = (t: string) => blockOut(t, finder(t));
  const done = await withBusy('Redacting…', async () => {
    let changed = 0;
    const s0 = usePDFStore.getState();
    const swaps = new Map<string, { id: string; renamed: Record<string, string> }>();
    for (const sid of new Set(s0.pages.map((p) => p.sourceId).filter((x): x is string => !!x))) {
      const src = s0.sources[sid];
      if (!src) continue;
      const probe = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
      if (!findElsewhere(probe, finder).some((h) => want(h.kind))) continue;
      // A fresh file (unreferenced objects dropped, no earlier revision), swapped in below in one undoable step.
      const r = redactElsewhere(probe, finder, opts);
      changed += r.changed;
      dropUnreachableObjects(probe);
      const { source } = await usePDFStore.getState().addSource(await probe.save({ useObjectStreams: true }), src.name);
      swaps.set(sid, { id: source.id, renamed: r.renamed });
    }
    // The unsaved edits.
    const s = usePDFStore.getState();
    const pages = s.pages.map((p) => (p.sourceId && swaps.has(p.sourceId) ? { ...p, sourceId: swaps.get(p.sourceId)!.id } : p));
    // Typed values follow their source and renamed fields (with their children).
    const moved = Object.fromEntries(
      Object.entries(s.fieldValues).map(([k, v]) => {
        const at = k.indexOf('::');
        const swap = swaps.get(k.slice(0, at));
        if (!swap) return [k, v];
        const name = k.slice(at + 2);
        const from = Object.keys(swap.renamed).find((old) => name === old || name.startsWith(`${old}.`));
        return [`${swap.id}::${from ? `${swap.renamed[from]}${name.slice(from.length)}` : name}`, v];
      }),
    );
    const objects: EditorObject[] = [];
    for (const o of s.objects) {
      const kind = objectKind(o);
      if (kind && want(kind) && (o.type === 'link' ? firstMatch(finder, [o.target.kind === 'url' ? o.target.url : '']) : firstMatch(finder, objectTexts(o)))) {
        changed++;
        if (kind !== 'comment' || (opts.comments ?? 'remove') === 'remove') continue;
        const patch: Record<string, unknown> = {};
        for (const key of ['text', 'author', 'selectedText', 'label', 'subtitle'] as const) {
          const v = (o as unknown as Record<string, unknown>)[key];
          if (typeof v === 'string') patch[key] = block(v);
        }
        objects.push({ ...o, ...patch } as EditorObject);
        continue;
      }
      if (o.type === 'field') {
        let f = o;
        if (want('fieldValue') && finder(o.value).length) f = { ...f, value: '' };
        if (want('fieldName') && finder(o.name).length) f = { ...f, name: block(o.name) };
        if (f !== o) changed++;
        objects.push(f);
        continue;
      }
      objects.push(o);
    }
    const fieldValues = want('fieldValue')
      ? Object.fromEntries(
          Object.entries(moved).map(([k, v]): [string, FieldValue] => {
            if (!fieldValueText(v).some((t) => finder(t).length)) return [k, v];
            changed++;
            return [k, Array.isArray(v) ? [] : ''];
          }),
        )
      : moved;
    const redactItems = (items: BookmarkItem[]): BookmarkItem[] =>
      items.flatMap((b) => {
        if (!finder(b.title).length) return [{ ...b, children: redactItems(b.children) }];
        changed++;
        return (opts.bookmarks ?? 'redact') === 'remove' ? [] : [{ ...b, title: block(b.title), children: redactItems(b.children) }];
      });
    const outline = s.outline && want('bookmark') ? redactItems(s.outline) : s.outline;
    s.commit(() => ({ pages, objects, fieldValues, outline }));
    const primary = s.primarySource && swaps.get(s.primarySource);
    if (primary) usePDFStore.setState({ primarySource: primary.id });
    if (s.docMeta && want('metadata')) {
      const meta: DocMeta = { ...s.docMeta };
      let touched = false;
      for (const [k] of META_KEYS) {
        const v = meta[k];
        if (typeof v === 'string' && finder(v).length) {
          (meta as Record<string, unknown>)[k] = '';
          touched = true;
        }
      }
      if (meta.custom) {
        const kept = Object.entries(meta.custom).filter(([k, v]) => !finder(k).length && !finder(v).length);
        if (kept.length !== Object.keys(meta.custom).length) {
          meta.custom = Object.fromEntries(kept);
          touched = true;
        }
      }
      if (touched) {
        changed++;
        s.setDocMeta(meta);
      }
    }
    return changed;
  });
  return done || 0;
}
