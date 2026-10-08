/** Forms → Detect fields: turns a flat or scanned form into a fillable one. */
import { blockedReason, usePDFStore } from '@/store/usePDFStore';
import { makeField } from '@/lib/objectFactory';
import type { FieldObject, PageRef } from '@/types';
import type { Rect } from '@/lib/geometry';
import { withBusy } from './document';

const DPI = 144;

/** Rects (display space) of form fields the source PDF already has on this page. */
async function existingWidgets(page: PageRef): Promise<Rect[]> {
  if (page.kind !== 'source' || !page.sourceId) return [];
  const { getAnnotations, pageViewport } = await import('@/lib/pdf/pdfService');
  const [annots, vp] = await Promise.all([getAnnotations(page.sourceId, page.sourceIndex), pageViewport(page, 1)]);
  if (!vp) return [];
  return annots
    .filter((a) => a.subtype === 'Widget')
    .map((a) => {
      const [x0, y0] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x1, y1] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    });
}

/** Detects fields on every page (or the given pages) and adds them in one undoable step. */
export async function detectFormFields(pageIds?: string[]): Promise<{ text: number; checkbox: number }> {
  const s = usePDFStore.getState();
  const why = blockedReason(s, 'content');
  if (why) {
    s.toast(why, 'info');
    return { text: 0, checkbox: 0 };
  }
  const pages = pageIds ? s.pages.filter((p) => pageIds.includes(p.id)) : s.pages;
  const created = await withBusy('Looking for form fields…', async (progress) => {
    const [{ rasterizePage }, { pageTextRuns, runRect }, { detectFields, fieldNames }] = await Promise.all([
      import('@/lib/pdf/pdfService'),
      import('@/lib/pdf/textGeometry'),
      import('@/lib/formDetect'),
    ]);
    const names = s.objects.filter((o): o is FieldObject => o.type === 'field').map((o) => o.name);
    const out: FieldObject[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      progress(`Page ${i + 1} of ${pages.length}`, i / pages.length);
      const canvas = await rasterizePage(page, DPI);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 0;
      const runs = (await pageTextRuns(page)).map((r) => ({ str: r.str, rect: runRect(r) }));
      const existing = [
        ...(await existingWidgets(page)),
        ...s.objects.filter((o): o is FieldObject => o.type === 'field' && o.pageId === page.id).map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height })),
      ];
      const found = detectFields(img, DPI / 72, runs, existing);
      const fieldNamesForPage = fieldNames(found, [...names, ...out.map((o) => o.name)]);
      found.forEach((f, k) => {
        const obj = makeField(f.kind, page.id, f.rect, []);
        out.push({ ...obj, name: fieldNamesForPage[k], ...(f.kind === 'text' ? { fontSize: Math.max(8, Math.min(12, Math.round(f.rect.height * 0.65))) } : {}) });
      });
    }
    return out;
  });
  if (!created) return { text: 0, checkbox: 0 };
  const counts = { text: created.filter((f) => f.fieldKind === 'text').length, checkbox: created.filter((f) => f.fieldKind === 'checkbox').length };
  if (!created.length) {
    usePDFStore.getState().toast('No form fields found. Detect fields looks for fill-in lines, empty boxes and checkboxes.', 'info');
    return counts;
  }
  const store = usePDFStore.getState();
  store.commit((st) => ({ objects: [...st.objects, ...created] }));
  usePDFStore.setState({ selectedIds: created.map((f) => f.id), tool: 'select' });
  store.toast(
    `Added ${counts.text} text field${counts.text === 1 ? '' : 's'} and ${counts.checkbox} checkbox${counts.checkbox === 1 ? '' : 'es'}, named after their labels. Review them, then save. Undo removes them.`,
    'success',
  );
  return counts;
}
