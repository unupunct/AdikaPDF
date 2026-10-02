/**
 * A regular fillable PDF from the measured layout of a dynamic XFA form
 * (xfaMeasure.ts): the text, rules, boxes and pictures drawn on the page,
 * and an ordinary form field over every input, named like the XFA field so
 * values can be written back into the original form. Pure (pdf-lib + fonts).
 */
import { PDFDocument, PDFHexString, PDFName, rgb, type Color, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedFontForText } from './fontEmbed';
import type { FontVariant } from '@/lib/fonts';
import type { XfaInput } from './xfa';

export type XfaItem =
  | { type: 'text'; x: number; baseline: number; text: string; size: number; bold: boolean; italic: boolean; family: 'sans' | 'serif' | 'mono'; color: string }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: string; dashed?: boolean }
  | { type: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { type: 'image'; x: number; y: number; w: number; h: number; png: Uint8Array }
  | {
      type: 'field';
      x: number;
      y: number;
      w: number;
      h: number;
      input: XfaInput;
      size: number;
      tooltip?: string;
      required?: boolean;
      readOnly?: boolean;
      maxLength?: number;
    };

/** One page, top-left origin, points. */
export interface XfaPageLayout {
  width: number;
  height: number;
  items: XfaItem[];
}

function color(css: string): Color {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  if (m) return rgb(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (h) {
    const n = parseInt(h[1], 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  return rgb(0, 0, 0);
}

/** Text the font can draw (unknown characters become spaces rather than failing the page). */
function drawable(font: PDFFont, text: string): string {
  const set = font.getCharacterSet();
  return [...text].map((ch) => (set.includes(ch.codePointAt(0)!) ? ch : ' ')).join('');
}

export async function buildXfaPdf(pages: XfaPageLayout[], loadFont: (v: FontVariant) => Promise<Uint8Array>, title?: string): Promise<{ bytes: Uint8Array; fields: string[] }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = new Map<string, Promise<PDFFont>>();
  // The letters drawn anywhere (pdf-lib's own subsetter corrupts Noto glyphs).
  const texts = pages.flatMap((p) => p.items.map((it) => (it.type === 'text' ? it.text : '')));
  const fontFor = (family: 'sans' | 'serif' | 'mono', bold: boolean, italic: boolean) => {
    const key = `${family}|${bold}|${italic && family !== 'mono'}`;
    let f = fonts.get(key);
    if (!f) {
      f = loadFont({ family, bold, italic: italic && family !== 'mono' }).then((b) => embedFontForText(doc, b, texts));
      fonts.set(key, f);
    }
    return f;
  };
  // Fields get the whole font: people type any letter later.
  const fieldFont = await doc.embedFont(await loadFont({ family: 'sans', bold: false, italic: false }), { subset: false });
  const form = doc.getForm();
  const radios = new Map<string, ReturnType<typeof form.createRadioGroup>>();
  const names: string[] = [];

  for (const p of pages) {
    const page: PDFPage = doc.addPage([p.width, p.height]);
    const Y = (y: number) => p.height - y;
    for (const it of p.items) {
      if (it.type === 'rect') page.drawRectangle({ x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h, color: color(it.fill) });
      else if (it.type === 'line')
        page.drawLine({ start: { x: it.x1, y: Y(it.y1) }, end: { x: it.x2, y: Y(it.y2) }, thickness: it.width, color: color(it.color), dashArray: it.dashed ? [3, 2] : undefined });
      else if (it.type === 'image') {
        try {
          const img = await doc.embedPng(it.png);
          page.drawImage(img, { x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h });
        } catch {
          /* unreadable picture */
        }
      } else if (it.type === 'text') {
        const font = await fontFor(it.family, it.bold, it.italic);
        const text = drawable(font, it.text);
        if (text.trim()) page.drawText(text, { x: it.x, y: Y(it.baseline), size: it.size, font, color: color(it.color) });
      }
    }
    for (const it of p.items) {
      if (it.type !== 'field') continue;
      // Text boxes are see-through (the form draws its own boxes); check boxes and radio buttons get a frame.
      const rect = { x: it.x, y: Y(it.y + it.h), width: Math.max(4, it.w), height: Math.max(4, it.h), borderWidth: 0, borderColor: undefined, backgroundColor: undefined, font: fieldFont };
      const framed = { ...rect, borderWidth: 1, borderColor: rgb(0.25, 0.25, 0.25), backgroundColor: rgb(1, 1, 1) };
      const inp = it.input;
      try {
        if (inp.type === 'radio') {
          let g = radios.get(inp.name);
          if (!g) {
            g = form.createRadioGroup(inp.name);
            radios.set(inp.name, g);
            names.push(inp.name);
          }
          g.addOptionToPage(inp.on ?? String(radios.size), page, framed);
          if (inp.value === inp.on) g.select(inp.on!);
          continue;
        }
        if (names.includes(inp.name)) continue; // the same field on another page
        names.push(inp.name);
        if (inp.type === 'checkbox') {
          const c = form.createCheckBox(inp.name);
          c.addToPage(page, framed);
          if (inp.value === inp.on) c.check();
          finish(c.acroField.dict, it);
        } else if (inp.type === 'select') {
          const d = form.createDropdown(inp.name);
          const opts = inp.options ?? [];
          d.addOptions(opts.map((o) => o.value));
          if (opts.some((o) => o.label && o.label !== o.value))
            d.acroField.dict.set(PDFName.of('Opt'), doc.context.obj(opts.map((o) => doc.context.obj([PDFHexString.fromText(o.value), PDFHexString.fromText(o.label || o.value)]))));
          d.addToPage(page, rect);
          if (inp.value && opts.some((o) => o.value === inp.value)) d.select(inp.value);
          d.setFontSize(Math.max(6, Math.min(14, it.size)));
          finish(d.acroField.dict, it);
        } else {
          const t = form.createTextField(inp.name);
          if (inp.type === 'textarea') t.enableMultiline();
          if (it.maxLength) t.setMaxLength(it.maxLength);
          t.addToPage(page, rect);
          if (inp.value) t.setText(it.maxLength ? inp.value.slice(0, it.maxLength) : inp.value);
          t.setFontSize(Math.max(6, Math.min(14, it.size)));
          if (it.required) t.enableRequired();
          if (it.readOnly) t.enableReadOnly();
          finish(t.acroField.dict, it);
        }
      } catch {
        /* a field pdf-lib cannot make (duplicate name of another kind): leave it out */
      }
    }
  }
  form.updateFieldAppearances(fieldFont);
  if (title) doc.setTitle(title);
  doc.setProducer('Adika PDF Editor');
  return { bytes: await doc.save({ useObjectStreams: true }), fields: names };

  function finish(dict: { set(k: PDFName, v: unknown): void }, it: Extract<XfaItem, { type: 'field' }>) {
    // The caption as the field's tooltip (the name people see in the fill panel and screen readers).
    if (it.tooltip) dict.set(PDFName.of('TU'), PDFHexString.fromText(it.tooltip));
  }
}
