/**
 * Turns an appearance profile into what the signing code draws: fonts,
 * pictures and the signer's details, for single, batch and cloud signing.
 */
import type forge from 'node-forge';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import {
  DEFAULT_LABELS,
  drawSignatureAppearance,
  imageAssetFromDataUrl,
  standardProfile,
  type AppearanceAssets,
  type AppearanceProfile,
  type AppearanceValues,
  type ImageAsset,
  type SigLabels,
} from '@/lib/crypto/sigAppearance';
import { loadFontBytes } from '@/lib/fonts';
import { currentLang, translate } from '@/lib/i18n';
import { readSystemFont, systemFonts } from '@/lib/platform';
import { embeddingAllowed, fontFromCollection } from '@/lib/pdf/fontProgram';
import { profileById } from '@/store/sigProfiles';

export type AppearanceBuilder = (doc: PDFDocument, width: number, height: number, rotation: number) => Promise<PDFRef>;

/** The labels in the interface language (new profiles and the standard badge). */
export function localLabels(): SigLabels {
  const out = { ...DEFAULT_LABELS };
  for (const k of Object.keys(out) as Array<keyof SigLabels>) out[k] = translate(out[k]);
  return out;
}

/** The profile chosen in a signing dialog ('standard', an id, or none = the default). */
export function chosenProfile(id: string | null | undefined): AppearanceProfile {
  return profileById(id) ?? standardProfile(localLabels());
}

export function appearanceValues(o: { name: string; issuer: string; when: Date; reason?: string; location?: string; contact?: string; certificate?: forge.pki.Certificate | null }): AppearanceValues {
  const field = (n: string) => (o.certificate?.subject.getField(n)?.value as string | undefined) ?? '';
  const lang = currentLang();
  return {
    name: o.name,
    when: o.when,
    reason: o.reason ?? '',
    location: o.location ?? '',
    contact: o.contact ?? '',
    issuer: o.issuer,
    cn: field('CN') || o.name,
    o: field('O'),
    email: field('E') || ((o.certificate?.subject.getField({ name: 'emailAddress' })?.value as string | undefined) ?? ''),
    locale: lang === 'en' ? undefined : lang,
  };
}

/** A picture as PNG or JPEG bytes (other formats are drawn into a PNG). */
async function imageAsset(src: string): Promise<ImageAsset | null> {
  const direct = imageAssetFromDataUrl(src);
  if (direct) return direct;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')?.drawImage(img, 0, 0);
    return imageAssetFromDataUrl(c.toDataURL('image/png'));
  } catch {
    return null;
  }
}

/** The name in a script font: the installed font embedded as text when its licence allows, else a picture. */
async function nameGraphic(name: string, font: string, color: string): Promise<AppearanceAssets['graphic']> {
  if (!name.trim()) return null;
  try {
    const faces = (await systemFonts()).filter((f) => f.family.toLowerCase() === font.toLowerCase() || f.typoFamily.toLowerCase() === font.toLowerCase());
    const face = faces.find((f) => !f.italic && !f.bold) ?? faces[0];
    if (face && embeddingAllowed(face.fsType)) {
      const bytes = fontFromCollection(await readSystemFont(face.path), face.index);
      return { text: name, font: bytes, color, prune: (face.fsType & 0x0100) === 0 };
    }
  } catch {
    /* fall back to a picture */
  }
  const c = document.createElement('canvas');
  const size = 96;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${size}px "${font}", cursive`;
  c.width = Math.ceil(ctx.measureText(name).width) + size / 2;
  c.height = Math.ceil(size * 1.5);
  const g = c.getContext('2d')!;
  g.font = `${size}px "${font}", cursive`;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(name, size / 4, c.height / 2);
  return imageAssetFromDataUrl(c.toDataURL('image/png'));
}

/** Fonts and pictures for a profile; `inkSrc` (signing on a placed ink signature) is the graphic when given. */
export async function appearanceAssets(p: AppearanceProfile, name: string, inkSrc: string | null): Promise<AppearanceAssets> {
  const [font, bold] = await Promise.all([loadFontBytes({ family: p.font, bold: false, italic: false }), loadFontBytes({ family: p.font, bold: true, italic: false })]);
  let graphic: AppearanceAssets['graphic'] = null;
  if (p.layout !== 'text') {
    if (inkSrc) graphic = await imageAsset(inkSrc);
    else if (p.graphic.kind === 'image') graphic = await imageAsset(p.graphic.src);
    else if (p.graphic.kind === 'name') graphic = await nameGraphic(name, p.graphic.font, p.graphic.color);
  }
  const watermark = p.watermark ? await imageAsset(p.watermark.src) : null;
  return { font, bold, graphic, watermark };
}

/** The signing code's appearance callback for a profile (assets loaded once, also for a batch). */
export async function appearanceBuilder(p: AppearanceProfile, name: string, inkSrc: string | null): Promise<(values: AppearanceValues) => AppearanceBuilder> {
  const assets = await appearanceAssets(p, name, inkSrc);
  return (values) => (doc, w, h, rotation) => drawSignatureAppearance(doc, w, h, p, values, assets, rotation);
}
