/**
 * Lays out a dynamic XFA form with pdf.js (its XFA engine produces HTML),
 * renders each page offscreen and measures what the browser drew: text runs
 * line by line, borders, backgrounds, pictures and the inputs. The measured
 * layout becomes a regular fillable PDF (xfaPdf.ts). Browser only.
 */
import { pdfjs } from './pdfService';
import { xfaInputs, type XfaHtmlNode, type XfaInput } from './xfa';
import { buildXfaPdf, type XfaItem, type XfaPageLayout } from './xfaPdf';
import { loadFontBytes } from '@/lib/fonts';

const assetBase = () => new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

const parseColor = (c: string) => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return a < 0.05 ? null : `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
};

function familyOf(cs: CSSStyleDeclaration): 'sans' | 'serif' | 'mono' {
  const f = cs.fontFamily.toLowerCase();
  if (/courier|mono|consol/.test(f)) return 'mono';
  if (/times|serif|georgia|garamond|minion/.test(f) && !/sans/.test(f)) return 'serif';
  return 'sans';
}

function measurePage(div: HTMLElement, inputs: Map<string, XfaInput>): XfaItem[] {
  const base = div.getBoundingClientRect();
  const X = (x: number) => x - base.left;
  const Yp = (y: number) => y - base.top;
  const items: XfaItem[] = [];
  const isControl = (el: Element | null) => !!el?.closest('input, textarea, select, option');

  // Backgrounds and borders of every box.
  for (const el of div.querySelectorAll<HTMLElement>('*')) {
    if (isControl(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg !== 'rgb(255, 255, 255)') items.push({ type: 'rect', x: X(r.left), y: Yp(r.top), w: r.width, h: r.height, fill: bg });
    const side = (w: string, style: string, color: string, line: [number, number, number, number]) => {
      const width = parseFloat(w);
      const c = parseColor(color);
      if (!(width > 0) || style === 'none' || style === 'hidden' || !c) return;
      items.push({ type: 'line', x1: line[0], y1: line[1], x2: line[2], y2: line[3], width, color: c, dashed: style === 'dashed' || style === 'dotted' });
    };
    const l = X(r.left);
    const t = Yp(r.top);
    const rr = X(r.right);
    const b = Yp(r.bottom);
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    side(cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, [l, t + bt / 2, rr, t + bt / 2]);
    side(cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor, [l, b - bb / 2, rr, b - bb / 2]);
    side(cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor, [l + bl / 2, t, l + bl / 2, b]);
    side(cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor, [rr - br / 2, t, rr - br / 2, b]);
  }

  // Lines and rectangles drawn as SVG (XFA <line>, <rectangle>).
  for (const el of div.querySelectorAll<SVGGraphicsElement>('svg line, svg rect, svg path')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const stroke = parseColor(cs.stroke);
    const w = parseFloat(cs.strokeWidth) || 1;
    if (!stroke) continue;
    const l = X(r.left);
    const t = Yp(r.top);
    if (el.tagName.toLowerCase() === 'line' || r.width < 2 || r.height < 2) {
      const horizontal = r.width >= r.height;
      items.push({ type: 'line', x1: l, y1: horizontal ? t + r.height / 2 : t, x2: horizontal ? l + r.width : l + r.width / 2, y2: horizontal ? t + r.height / 2 : t + r.height, width: w, color: stroke });
      if (!horizontal) (items[items.length - 1] as { x1: number }).x1 = l + r.width / 2;
    } else {
      for (const seg of [
        [l, t, l + r.width, t],
        [l, t + r.height, l + r.width, t + r.height],
        [l, t, l, t + r.height],
        [l + r.width, t, l + r.width, t + r.height],
      ])
        items.push({ type: 'line', x1: seg[0], y1: seg[1], x2: seg[2], y2: seg[3], width: w, color: stroke });
    }
  }

  // Text, line by line (word boxes on the same line make one run).
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const parent = node.parentElement;
    if (!parent || isControl(parent) || !node.data.trim()) continue;
    const cs = getComputedStyle(parent);
    if (cs.visibility === 'hidden') continue;
    const size = parseFloat(cs.fontSize) || 10;
    const style = { size, bold: (parseInt(cs.fontWeight, 10) || 400) >= 600, italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique', family: familyOf(cs), color: parseColor(cs.color) ?? 'rgb(0, 0, 0)' };
    let run: { start: number; end: number; left: number; top: number; height: number } | null = null;
    const flush = () => {
      if (!run) return;
      const text = node.data.slice(run.start, run.end);
      items.push({ type: 'text', x: X(run.left), baseline: Yp(run.top) + run.height / 2 + size * 0.35, text, ...style });
      run = null;
    };
    for (const m of node.data.matchAll(/\S+/g)) {
      range.setStart(node, m.index!);
      range.setEnd(node, m.index! + m[0].length);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      if (run && Math.abs(rect.top - run.top) < Math.max(1, size * 0.3)) run.end = m.index! + m[0].length;
      else {
        flush();
        run = { start: m.index!, end: m.index! + m[0].length, left: rect.left, top: rect.top, height: rect.height };
      }
    }
    flush();
  }

  // Pictures.
  for (const img of div.querySelectorAll('img')) {
    if (!img.complete || !img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      const bin = atob(c.toDataURL('image/png').split(',')[1]);
      const png = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      items.push({ type: 'image', x: X(r.left), y: Yp(r.top), w: r.width, h: r.height, png });
    } catch {
      /* tainted or broken picture */
    }
  }

  // The inputs become form fields.
  for (const el of div.querySelectorAll<HTMLElement>('input, textarea, select')) {
    const input = inputs.get(el.getAttribute('fieldId') ?? '');
    if (!input) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    const caption = el.closest('.xfaField')?.querySelector('.xfaCaption, .xfaCaptionForCheckButton')?.textContent?.trim() || el.getAttribute('aria-label') || undefined;
    const max = Number(el.getAttribute('maxLength'));
    items.push({
      type: 'field',
      x: X(r.left),
      y: Yp(r.top),
      w: r.width,
      h: r.height,
      input,
      size: parseFloat(cs.fontSize) || 10,
      tooltip: caption,
      required: el.getAttribute('aria-required') === 'true',
      readOnly: (el as HTMLInputElement).readOnly || (el as HTMLInputElement).disabled,
      maxLength: max > 0 ? max : undefined,
    });
  }
  return items;
}

/** The measured pages of a dynamic XFA form. */
export async function measureDynamicXfa(original: Uint8Array, onPage?: (i: number, n: number) => void): Promise<XfaPageLayout[]> {
  const base = assetBase();
  const task = pdfjs.getDocument({
    data: original.slice(),
    enableXfa: true,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  });
  const host = document.createElement('div');
  // Offscreen but not hidden: hidden boxes would read as hidden to the measuring.
  host.style.cssText = 'position:fixed;left:-30000px;top:0;pointer-events:none;contain:layout;';
  document.body.append(host);
  try {
    const doc = await task.promise;
    if (!doc.isPureXfa) throw new Error('This is not a dynamic XFA form.');
    const html = doc.allXfaHtml as unknown as XfaHtmlNode | null;
    const inputs = new Map(xfaInputs(html?.children ?? []).map((i) => [i.fieldId, i]));
    const linkService = { addLinkAttributes: (a: HTMLAnchorElement, url: string) => a.setAttribute('data-href', url), eventBus: null };
    const pages: XfaPageLayout[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      onPage?.(i, doc.numPages);
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const xfaHtml = await page.getXfa();
      if (!xfaHtml) continue;
      const div = document.createElement('div');
      div.style.cssText = `position:relative;width:${vp.width}px;height:${vp.height}px;--scale-factor:1;--total-scale-factor:1;`;
      host.append(div);
      pdfjs.XfaLayer.render({ xfaHtml, div, annotationStorage: doc.annotationStorage, linkService: linkService as never, intent: 'display', viewport: undefined as never });
      await document.fonts.ready;
      pages.push({ width: vp.width, height: vp.height, items: measurePage(div, inputs) });
      div.remove();
    }
    return pages;
  } finally {
    host.remove();
    await task.destroy();
  }
}

/** A dynamic XFA form as a regular fillable PDF (fields named like the XFA fields). */
export async function convertDynamicXfa(original: Uint8Array, title?: string, onPage?: (i: number, n: number) => void): Promise<{ bytes: Uint8Array; fields: string[] }> {
  const pages = await measureDynamicXfa(original, onPage);
  if (!pages.length) throw new Error('The XFA form has no pages.');
  return buildXfaPdf(pages, loadFontBytes, title);
}
