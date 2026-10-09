/**
 * Designed appearances of visible digital signatures: a graphic (handwritten
 * signature, logo, or the signer's name in a script font) and the details
 * (name, date, reason, issuer…) drawn as real text in an embedded font, so the
 * signature stays sharp at any zoom and its text can be selected and searched.
 * Pictures (drawn ink, logos) are embedded as images.
 */
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, type PDFFont, type PDFImage, type PDFRef } from 'pdf-lib';
import { embedFontForText } from '@/lib/pdf/fontEmbed';
import type { FontFamily } from '@/types';

export type SigLayout = 'graphic-left' | 'graphic-top' | 'text' | 'graphic';

export type SigGraphic =
  | { kind: 'none' }
  /** A handwritten signature (drawn, typed or a picture of it) or a logo: PNG or JPEG data URL. */
  | { kind: 'image'; src: string }
  /** The signer's name in a script font installed in Windows. */
  | { kind: 'name'; font: string; color: string };

export interface SigDetails {
  /** "Digitally signed by" before the name. */
  signedBy: boolean;
  name: boolean;
  date: boolean;
  reason: boolean;
  location: boolean;
  contact: boolean;
  issuer: boolean;
  /** Extra text with placeholders: {name} {date} {reason} {location} {contact} {issuer} {cn} {o} {email}. */
  custom: string;
}

export interface SigLabels {
  signedBy: string;
  date: string;
  reason: string;
  location: string;
  contact: string;
  issuer: string;
}

export type SigDateFormat = 'locale' | 'iso' | 'dmy' | 'dmy-date' | 'ymd';

export interface AppearanceProfile {
  id: string;
  name: string;
  layout: SigLayout;
  graphic: SigGraphic;
  details: SigDetails;
  labels: SigLabels;
  dateFormat: SigDateFormat;
  font: FontFamily;
  /** Largest text size in points; null = as large as fits. The text always shrinks to fit. */
  fontSize: number | null;
  textColor: string;
  align: 'left' | 'center';
  border: { color: string; width: number } | null;
  background: string | null;
  /** A logo behind everything, faded. */
  watermark: { src: string; opacity: number } | null;
}

/** What a signature's text says. */
export interface AppearanceValues {
  name: string;
  when: Date;
  reason: string;
  location: string;
  contact: string;
  /** Issuing CA (common name). */
  issuer: string;
  /** Certificate subject common name and organisation. */
  cn: string;
  o: string;
  email: string;
  /** Formats the date for 'locale' (the app's language); default: the runtime's. */
  locale?: string;
}

export const DEFAULT_LABELS: SigLabels = { signedBy: 'Digitally signed by', date: 'Date:', reason: 'Reason:', location: 'Location:', contact: 'Contact:', issuer: 'Issuer:' };

/** Adika's standard badge: the ink or nothing on the left, the details on the right, a light blue box. */
export function standardProfile(labels: SigLabels = DEFAULT_LABELS): AppearanceProfile {
  return {
    id: 'standard',
    name: 'Standard',
    layout: 'graphic-left',
    graphic: { kind: 'none' },
    details: { signedBy: true, name: true, date: true, reason: true, location: false, contact: false, issuer: true, custom: '' },
    labels,
    dateFormat: 'locale',
    font: 'sans',
    fontSize: null,
    textColor: '#0f172a',
    align: 'left',
    border: { color: '#0284c7', width: 1 },
    background: '#f0f9ff',
    watermark: null,
  };
}

// ------------------------------------------------------------------ text

const p2 = (n: number) => String(n).padStart(2, '0');

function tzOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  return `${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}

export function formatSigDate(d: Date, fmt: SigDateFormat, locale?: string): string {
  const date = { y: d.getFullYear(), m: p2(d.getMonth() + 1), d: p2(d.getDate()) };
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  switch (fmt) {
    case 'iso':
      return `${date.y}-${date.m}-${date.d} ${time} ${tzOffset(d)}`;
    case 'ymd':
      return `${date.y}.${date.m}.${date.d} ${time}`;
    case 'dmy':
      return `${date.d}.${date.m}.${date.y} ${time}`;
    case 'dmy-date':
      return `${date.d}.${date.m}.${date.y}`;
    default:
      return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  }
}

export function fillPlaceholders(s: string, v: AppearanceValues, dateFormat: SigDateFormat): string {
  const map: Record<string, string> = {
    name: v.name,
    date: formatSigDate(v.when, dateFormat, v.locale),
    reason: v.reason,
    location: v.location,
    contact: v.contact,
    issuer: v.issuer,
    cn: v.cn,
    o: v.o,
    email: v.email,
  };
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k.toLowerCase() in map ? map[k.toLowerCase()] : m));
}

export interface AppearanceLine {
  text: string;
  bold: boolean;
}

/** The text lines of a signature (empty values left out). */
export function appearanceLines(p: AppearanceProfile, v: AppearanceValues): AppearanceLine[] {
  if (p.layout === 'graphic') return [];
  const d = p.details;
  const L = p.labels;
  const out: AppearanceLine[] = [];
  const add = (text: string, bold = false) => {
    const t = text.normalize('NFC').trim();
    if (t) out.push({ text: t, bold });
  };
  if (d.signedBy && d.name) add(`${L.signedBy} ${v.name}`, true);
  else if (d.name) add(v.name, true);
  else if (d.signedBy) add(L.signedBy, true);
  const labelled = (on: boolean, label: string, value: string) => {
    if (on && value.trim()) add(label ? `${label} ${value}` : value);
  };
  labelled(d.date, L.date, formatSigDate(v.when, p.dateFormat, v.locale));
  labelled(d.reason, L.reason, v.reason);
  labelled(d.location, L.location, v.location);
  labelled(d.contact, L.contact, v.contact);
  labelled(d.issuer, L.issuer, v.issuer);
  if (d.custom.trim()) for (const line of fillPlaceholders(d.custom, v, p.dateFormat).split(/\r?\n/)) add(line);
  return out;
}

export type TextMeasure = (text: string, bold: boolean, size: number) => number;

/** Words wrapped to `width`; a word wider than the line is broken by letters. */
export function wrapLine(text: string, bold: boolean, size: number, width: number, measure: TextMeasure): string[] {
  const out: string[] = [];
  let line = '';
  const pushWord = (w: string) => {
    let chunk = '';
    for (const ch of w) {
      if (chunk && measure(chunk + ch, bold, size) > width) {
        out.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const cand = line ? `${line} ${word}` : word;
    if (measure(cand, bold, size) <= width) line = cand;
    else {
      if (line) out.push(line);
      line = measure(word, bold, size) > width ? pushWord(word) : word;
    }
  }
  if (line) out.push(line);
  return out;
}

export const LINE_HEIGHT = 1.22;

/**
 * The largest size (≤ max) at which the lines, wrapped, fit in width × height.
 * At the smallest size the lines that do not fit are dropped.
 */
export function fitLines(lines: AppearanceLine[], width: number, height: number, max: number, measure: TextMeasure, min = 3): { size: number; lines: AppearanceLine[] } {
  if (!lines.length || width <= 0 || height <= 0) return { size: max, lines: [] };
  const wrapAll = (size: number) => lines.flatMap((l) => wrapLine(l.text, l.bold, size, width, measure).map((t) => ({ text: t, bold: l.bold })));
  for (let size = Math.max(min, max); size >= min; size -= size > 8 ? 0.5 : 0.25) {
    const wrapped = wrapAll(size);
    if (wrapped.length * size * LINE_HEIGHT <= height + 1e-6) return { size, lines: wrapped };
  }
  const wrapped = wrapAll(min);
  return { size: min, lines: wrapped.slice(0, Math.max(1, Math.floor(height / (min * LINE_HEIGHT)))) };
}

// ------------------------------------------------------------------ drawing

export type ImageAsset = { bytes: Uint8Array; png: boolean };

export interface AppearanceAssets {
  /** Noto regular and bold of the profile's family. */
  font: Uint8Array;
  bold: Uint8Array;
  /** The graphic: a picture, or the name drawn in a script font. */
  graphic?: ImageAsset | { text: string; font: Uint8Array; color: string; prune?: boolean } | null;
  watermark?: ImageAsset | null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

function rgb(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const v = parseInt(full, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => n(c / 255)).join(' ');
}

/** Fits an aspect ratio into a box, centred. */
function fitInto(box: Box, ratio: number, alignLeft = false): Box {
  let w = box.w;
  let h = w / ratio;
  if (h > box.h) {
    h = box.h;
    w = h * ratio;
  }
  return { x: alignLeft ? box.x : box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Where the graphic and the text go in a W × H box (y up). */
export function appearanceAreas(p: AppearanceProfile, W: number, H: number, hasGraphic: boolean, hasText: boolean): { graphic: Box | null; text: Box | null } {
  const inset = (p.border?.width ?? 0) + Math.max(2, Math.min(6, Math.min(W, H) * 0.06));
  const inner: Box = { x: inset, y: inset, w: Math.max(1, W - inset * 2), h: Math.max(1, H - inset * 2) };
  const gap = Math.min(6, inner.w * 0.03);
  const g = hasGraphic && p.layout !== 'text';
  const t = hasText && p.layout !== 'graphic';
  if (g && t && p.layout === 'graphic-top') {
    const gh = inner.h * 0.5;
    return { graphic: { x: inner.x, y: inner.y + inner.h - gh, w: inner.w, h: gh }, text: { x: inner.x, y: inner.y, w: inner.w, h: inner.h - gh - gap / 2 } };
  }
  if (g && t) {
    const gw = inner.w * 0.4;
    return { graphic: { x: inner.x, y: inner.y, w: gw, h: inner.h }, text: { x: inner.x + gw + gap, y: inner.y, w: inner.w - gw - gap, h: inner.h } };
  }
  return { graphic: g ? inner : null, text: t ? inner : null };
}

/** The form matrix that shows a W × H appearance upright on a page turned by `rotation` (its /Rotate). */
function uprightMatrix(rotation: number, W: number, H: number): number[] {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, H, 0];
    case 180:
      return [-1, 0, 0, -1, W, H];
    case 270:
      return [0, -1, 1, 0, 0, W];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * Draws the appearance as a form XObject for a widget of `width` × `height`
 * (PDF user space) on a page with /Rotate `rotation`; returns its reference.
 */
export async function drawSignatureAppearance(
  doc: PDFDocument,
  width: number,
  height: number,
  profile: AppearanceProfile,
  values: AppearanceValues,
  assets: AppearanceAssets,
  rotation = 0,
): Promise<PDFRef> {
  doc.registerFontkit(fontkit);
  const turned = ((rotation % 180) + 180) % 180 === 90;
  const W = turned ? height : width;
  const H = turned ? width : height;
  const lines = appearanceLines(profile, values);
  const graphic = profile.layout === 'text' ? null : assets.graphic ?? null;
  const areas = appearanceAreas(profile, W, H, !!graphic, lines.length > 0);
  const ops: string[] = ['q'];
  const xobjects: Record<string, PDFRef> = {};
  const fonts: Record<string, PDFRef> = {};
  const gstates: Record<string, PDFRef> = {};

  if (profile.background) ops.push(`${rgb(profile.background)} rg 0 0 ${n(W)} ${n(H)} re f`);
  if (profile.watermark && assets.watermark) {
    const img = await embedImage(doc, assets.watermark);
    xobjects.Wm = img.ref;
    gstates.GW = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: profile.watermark.opacity, CA: profile.watermark.opacity }));
    const b = fitInto({ x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 }, img.width / img.height);
    ops.push(`q /GW gs ${n(b.w)} 0 0 ${n(b.h)} ${n(b.x)} ${n(b.y)} cm /Wm Do Q`);
  }
  if (profile.border && profile.border.width > 0) {
    const bw = profile.border.width;
    ops.push(`${rgb(profile.border.color)} RG ${n(bw)} w ${n(bw / 2)} ${n(bw / 2)} ${n(W - bw)} ${n(H - bw)} re S`);
  }

  if (graphic && areas.graphic) {
    const area = areas.graphic;
    if ('bytes' in graphic) {
      const img = await embedImage(doc, graphic);
      xobjects.Gr = img.ref;
      const b = fitInto(area, img.width / img.height, profile.layout === 'graphic-left' && profile.align === 'left' && !!areas.text);
      ops.push(`q ${n(b.w)} 0 0 ${n(b.h)} ${n(b.x)} ${n(b.y)} cm /Gr Do Q`);
    } else if (graphic.text.trim()) {
      const text = graphic.text.normalize('NFC').trim();
      const f = await embedFontForText(doc, graphic.font, [text], { prune: graphic.prune ?? true });
      fonts.FS = f.ref;
      const h1 = f.heightAtSize(1, { descender: true });
      const size = Math.max(3, Math.min(area.h / h1, (area.w * 0.95) / Math.max(1e-6, f.widthOfTextAtSize(text, 1))));
      const tw = f.widthOfTextAtSize(text, size);
      const descent = h1 - f.heightAtSize(1, { descender: false });
      const x = area.x + (area.w - tw) / 2;
      const y = area.y + (area.h - h1 * size) / 2 + descent * size;
      ops.push(`BT ${rgb(graphic.color)} rg /FS ${n(size)} Tf ${n(x)} ${n(y)} Td ${f.encodeText(text).toString()} Tj ET`);
    }
  }

  if (lines.length && areas.text) {
    const area = areas.text;
    const regular = await embedFontForText(doc, assets.font, lines.filter((l) => !l.bold).map((l) => l.text).concat('…'));
    const bold = await embedFontForText(doc, assets.bold, lines.filter((l) => l.bold).map((l) => l.text).concat('…'));
    fonts.F1 = regular.ref;
    fonts.F2 = bold.ref;
    const measure: TextMeasure = (t, b, size) => (b ? bold : regular).widthOfTextAtSize(safe(b ? bold : regular, t), size);
    const max = profile.fontSize ?? Math.min(14, area.h / (lines.length * LINE_HEIGHT) + 1, area.h);
    const fit = fitLines(lines, area.w, area.h, max, measure);
    const lh = fit.size * LINE_HEIGHT;
    const top = area.y + (area.h + fit.lines.length * lh) / 2;
    ops.push(`${rgb(profile.textColor)} rg`);
    fit.lines.forEach((l, i) => {
      const f = l.bold ? bold : regular;
      const t = safe(f, l.text);
      const tw = f.widthOfTextAtSize(t, fit.size);
      const x = profile.align === 'center' ? area.x + (area.w - tw) / 2 : area.x;
      const y = top - i * lh - fit.size * 0.98;
      ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${n(fit.size)} Tf ${n(x)} ${n(y)} Td ${f.encodeText(t).toString()} Tj ET`);
    });
  }
  ops.push('Q');

  const resources: Record<string, unknown> = {};
  if (Object.keys(xobjects).length) resources.XObject = xobjects;
  if (Object.keys(fonts).length) resources.Font = fonts;
  if (Object.keys(gstates).length) resources.ExtGState = gstates;
  const stream = doc.context.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, W, H],
    Matrix: uprightMatrix(rotation, W, H),
    Resources: resources,
  });
  // Optional content and the like are not needed: a plain form the viewer scales into /Rect.
  stream.dict.set(PDFName.of('FormType'), doc.context.obj(1));
  return doc.context.register(stream);
}

/** Letters the font cannot draw become "?" (pdf-lib would throw). */
function safe(font: PDFFont, s: string): string {
  const set = new Set(font.getCharacterSet());
  return [...s].map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('');
}

async function embedImage(doc: PDFDocument, a: ImageAsset): Promise<PDFImage> {
  return a.png ? doc.embedPng(a.bytes) : doc.embedJpg(a.bytes);
}

/** PNG or JPEG bytes of a data URL (other image types are drawn into a PNG by the app first). */
export function imageAssetFromDataUrl(src: string): ImageAsset | null {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: m[1].toLowerCase() === 'png' };
}

/** A one-page PDF of the page size holding just the appearance (the designer's preview). */
export async function appearancePreviewPdf(width: number, height: number, profile: AppearanceProfile, values: AppearanceValues, assets: AppearanceAssets): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const ap = await drawSignatureAppearance(doc, width, height, profile, values, assets);
  const content = doc.context.stream('q /Ap Do Q');
  page.node.set(PDFName.of('Contents'), doc.context.register(content));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Ap: ap } }));
  return doc.save();
}
