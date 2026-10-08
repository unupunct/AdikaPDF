/**
 * Organize → Replace pages, Bookmarks from headings, Links from web
 * addresses; Convert → Export images.
 */
import { usePDFStore } from '@/store/usePDFStore';
import { withBusy } from './document';
import { allowed } from './protection';
import { makeLink } from '@/lib/objectFactory';
import { saveFile } from './saveGuard';
import type { BookmarkItem, LinkObject, PageRef } from '@/types';
import type { Rect } from '@/lib/geometry';

/** Bookmarks as they are now (the file's own until the first edit). */
async function currentOutline(pages: PageRef[]): Promise<BookmarkItem[]> {
  const s = usePDFStore.getState();
  if (s.outline) return s.outline;
  const { toEditable } = await import('@/lib/pdf/outlineTree');
  const seen = new Set<string>();
  const sources = pages.filter((p) => p.sourceId && !seen.has(p.sourceId) && seen.add(p.sourceId)).map((p) => ({ id: p.sourceId! }));
  return toEditable(sources, pages);
}

/**
 * Replaces pages (0-based `targets`) with pages of another PDF starting at
 * `from` (0-based). The pages keep their place and id, so comments on them
 * and bookmarks pointing to them stay.
 */
export async function replacePages(targets: number[], other: { bytes: Uint8Array; name: string }, from: number): Promise<boolean> {
  const s0 = usePDFStore.getState();
  if (!allowed('pages')) return false;
  const done = await withBusy('Replacing pages…', async () => {
    const outline = await currentOutline(s0.pages);
    const { pages: fresh } = await usePDFStore.getState().addSource(other.bytes, other.name);
    if (from + targets.length > fresh.length) throw new Error(`“${other.name}” has ${fresh.length} page(s): not enough to replace ${targets.length} from page ${from + 1}.`);
    const set = new Map(targets.map((t, j) => [t, fresh[from + j]]));
    const pages = usePDFStore.getState().pages.map((p, i) => {
      const n = set.get(i);
      return n ? { ...n, id: p.id } : p;
    });
    usePDFStore.getState().commit(() => ({ pages, outline }));
    return true;
  });
  if (done) usePDFStore.getState().toast(`Replaced ${targets.length} page${targets.length === 1 ? '' : 's'} with pages from “${other.name}”. Comments and bookmarks on them were kept.`, 'success');
  return !!done;
}

/** Text lines of a page for heading detection. */
async function pageLines(page: PageRef) {
  const [{ pageTextRuns }, { pageViewport }] = await Promise.all([import('@/lib/pdf/textGeometry'), import('@/lib/pdf/pdfService')]);
  const runs = (await pageTextRuns(page)).filter((r) => Math.abs(r.dir[0]) > 0.9 && r.str.trim());
  const vp = await pageViewport(page, 1);
  runs.sort((a, b) => a.origin[1] - b.origin[1] || a.origin[0] - b.origin[0]);
  const lines: Array<{ text: string; size: number; boldChars: number; chars: number; y: number; x: number }> = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.origin[1] - last.y) < r.size * 0.4) {
      last.text += (/\s$/.test(last.text) || /^\s/.test(r.str) ? '' : ' ') + r.str;
      last.size = Math.max(last.size, r.size);
      last.chars += r.str.length;
      if (r.bold) last.boldChars += r.str.length;
    } else lines.push({ text: r.str, size: r.size, boldChars: r.bold ? r.str.length : 0, chars: r.str.length, y: r.origin[1], x: r.origin[0] });
  }
  return lines.map((l) => {
    const top = l.y - l.size;
    const destTop = vp ? vp.convertToPdfPoint(l.x, Math.max(0, top - 4))[1] : null;
    return { pageId: page.id, text: l.text, size: l.size, bold: l.boldChars > l.chars / 2, top, destTop };
  });
}

/** Builds bookmarks from the document's headings (replaces the current bookmarks after asking). */
export async function bookmarksFromHeadings(): Promise<number> {
  const s = usePDFStore.getState();
  if (!allowed('content')) return 0;
  const tree = await withBusy('Looking for headings…', async (progress) => {
    const { headingTree } = await import('@/lib/docStructure');
    const lines = [];
    for (let i = 0; i < s.pages.length; i++) {
      progress(`Page ${i + 1} of ${s.pages.length}`, i / s.pages.length);
      lines.push(...(await pageLines(s.pages[i])));
    }
    return headingTree(lines);
  });
  if (!tree) return 0;
  const count = (t: BookmarkItem[]): number => t.reduce((n, i) => n + 1 + count(i.children), 0);
  const n = count(tree);
  if (!n) {
    usePDFStore.getState().toast('No headings found (text larger or bolder than the body text). Scanned pages need OCR first.', 'info');
    return 0;
  }
  const existing = count(await currentOutline(s.pages));
  if (existing) {
    const { askConfirm } = await import('@/store/useDialogs');
    const ok = await askConfirm({ title: 'Replace bookmarks?', message: `The document has ${existing} bookmark(s). Replace them with ${n} made from the headings?`, confirmLabel: 'Replace bookmarks' });
    if (!ok) return 0;
  }
  usePDFStore.getState().commit(() => ({ outline: tree }));
  usePDFStore.setState({ sidebarOpen: true, sidebarTab: 'bookmarks' });
  usePDFStore.getState().toast(`Made ${n} bookmark${n === 1 ? '' : 's'} from the headings. Rename, move or delete them in the Bookmarks panel.`, 'success');
  return n;
}

const overlap = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(a.width * a.height, b.width * b.height) : 0;
};

/** Makes every web / e-mail address in the text a clickable link (skips ones already linked). */
export async function linksFromUrls(): Promise<number> {
  const s = usePDFStore.getState();
  if (!allowed('content')) return 0;
  const links = await withBusy('Looking for web addresses…', async (progress) => {
    const [{ pageTextRuns }, { runMatches }, { findUrls }, { getAnnotations, pageViewport }] = await Promise.all([
      import('@/lib/pdf/textGeometry'),
      import('@/lib/pdf/textSearch'),
      import('@/lib/docStructure'),
      import('@/lib/pdf/pdfService'),
    ]);
    const out: LinkObject[] = [];
    for (let i = 0; i < s.pages.length; i++) {
      const page = s.pages[i];
      progress(`Page ${i + 1} of ${s.pages.length}`, i / s.pages.length);
      const existing: Rect[] = s.objects.filter((o): o is LinkObject => o.type === 'link' && o.pageId === page.id).map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
      if (page.kind === 'source' && page.sourceId) {
        const [annots, vp] = await Promise.all([getAnnotations(page.sourceId, page.sourceIndex), pageViewport(page, 1)]);
        if (vp)
          for (const a of annots.filter((x) => x.subtype === 'Link')) {
            const [x0, y0] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
            const [x1, y1] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
            existing.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
          }
      }
      const matches = runMatches(page, await pageTextRuns(page), (t) => findUrls(t).map((m) => [m.start, m.end] as [number, number]));
      for (const m of matches) {
        const url = findUrls(m.text)[0]?.url;
        if (!url) continue;
        for (const r of m.rects) {
          const box = { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 };
          if (existing.some((e) => overlap(e, box) > 0.5)) continue;
          out.push(makeLink(page.id, box, { kind: 'url', url }));
          existing.push(box);
        }
      }
    }
    return out;
  });
  if (!links) return 0;
  if (!links.length) {
    usePDFStore.getState().toast('No new web or e-mail addresses found (addresses that are already links are skipped).', 'info');
    return 0;
  }
  usePDFStore.getState().commit((st) => ({ objects: [...st.objects, ...links] }));
  usePDFStore.getState().toast(`Made ${links.length} link${links.length === 1 ? '' : 's'} from web and e-mail addresses. Undo removes them.`, 'success');
  return links.length;
}

/** Saves every picture in the document into one ZIP file. */
export async function exportImages(): Promise<number> {
  const s = usePDFStore.getState();
  if (!allowed('copy')) return 0;
  const result = await withBusy('Collecting images…', async (progress) => {
    const [{ extractImages }, { default: JSZip }] = await Promise.all([import('@/lib/pdf/imageExport'), import('jszip')]);
    const zip = new JSZip();
    const seen = new Set<string>();
    const ids = s.pages.map((p) => p.sourceId).filter((id): id is string => !!id && !seen.has(id) && !!seen.add(id));
    let count = 0;
    let skipped = 0;
    for (const [k, id] of ids.entries()) {
      const src = s.sources[id];
      if (!src) continue;
      const { images, skipped: sk } = await extractImages(src.bytes);
      skipped += sk;
      const prefix = ids.length > 1 ? `${src.name.replace(/\.pdf$/i, '')}-` : '';
      for (const [i, img] of images.entries()) {
        progress(`Image ${i + 1} of ${images.length}`, (k + i / Math.max(1, images.length)) / ids.length);
        let data = img.bytes;
        if (img.kind === 'pixels' && img.rgba) {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
          data = new Uint8Array(await (await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'))).arrayBuffer());
          c.width = c.height = 0;
        }
        if (data) {
          zip.file(prefix + img.name, data);
          count++;
        }
      }
    }
    return { zip: count ? await zip.generateAsync({ type: 'uint8array' }) : null, count, skipped };
  });
  if (!result) return 0;
  const store = usePDFStore.getState();
  if (!result.zip) {
    store.toast(result.skipped ? `No images could be exported (${result.skipped} in formats that cannot be exported).` : 'This document has no images.', 'info');
    return 0;
  }
  const base = (store.fileName ?? 'document.pdf').replace(/\.pdf$/i, '');
  await saveFile(result.zip, `${base}-images.zip`, [{ name: 'ZIP archive', extensions: ['zip'] }], {
    successMessage: `Exported ${result.count} image${result.count === 1 ? '' : 's'}${result.skipped ? ` (${result.skipped} skipped: unusual formats)` : ''}.`,
  });
  return result.count;
}

/**
 * Organize → Contents page: a table of contents made from the bookmarks,
 * inserted before the first page, each line a link to its page. Undoable.
 */
export async function insertContentsPage(maxLevel = 2): Promise<boolean> {
  const s0 = usePDFStore.getState();
  if (!allowed('pages')) return false;
  const outline = await currentOutline(s0.pages);
  const entries: Array<{ title: string; level: number; target: number; pageId: string }> = [];
  const walk = (items: BookmarkItem[], level: number) => {
    for (const b of items) {
      const target = b.pageId ? s0.pages.findIndex((p) => p.id === b.pageId) : -1;
      if (target >= 0) entries.push({ title: b.title, level, target, pageId: b.pageId! });
      walk(b.children, level + 1);
    }
  };
  walk(outline, 0);
  if (!entries.length) {
    s0.toast('The document has no bookmarks to list. Add bookmarks first (Organize → Bookmarks from headings).', 'info');
    return false;
  }
  const done = await withBusy('Making the contents page…', async () => {
    const { buildTocPdf } = await import('@/lib/pdf/tocPage');
    const { loadFontBytes } = await import('@/lib/fonts');
    const { translate } = await import('@/lib/i18n');
    const first = s0.pages[0];
    const size: [number, number] = first && (first.userRotation + first.baseRotation) % 180 === 0 ? [first.width, first.height] : [595.28, 841.89];
    const toc = await buildTocPdf(entries, { title: translate('Contents'), loadFont: loadFontBytes, size, maxLevel });
    const { pages: fresh } = await usePDFStore.getState().addSource(toc.bytes, translate('Contents'));
    const links: LinkObject[] = toc.links.map((l) => makeLink(fresh[l.page].id, { x: l.x, y: l.y, width: l.width, height: l.height }, { kind: 'page', pageId: entries[l.entry].pageId }));
    usePDFStore.getState().commit((s) => ({ pages: [...fresh, ...s.pages], objects: [...s.objects, ...links], outline }));
    return toc.links.length;
  });
  if (done) usePDFStore.getState().toast(`Contents page added (${done} entries).`, 'success');
  return !!done;
}
