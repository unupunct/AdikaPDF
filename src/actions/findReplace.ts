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
import type { EditorObject, PageRef, TextObject } from '@/types';
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
