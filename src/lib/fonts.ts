/**
 * Bundled fonts. The same TTF files are used for on-screen rendering
 * (via FontFace) and for embedding into exported PDFs (via fontkit), so text
 * wraps and sits identically in the editor and in the saved file. Noto covers
 * Latin, Latin Extended (ă â î ș ț …), Greek and Cyrillic, which the PDF
 * standard-14 fonts cannot encode.
 */
import fontkit from '@pdf-lib/fontkit';
import sansRegular from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url';
import sansBold from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url';
import sansItalic from '@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf?url';
import sansBoldItalic from '@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf?url';
import serifRegular from '@expo-google-fonts/noto-serif/400Regular/NotoSerif_400Regular.ttf?url';
import serifBold from '@expo-google-fonts/noto-serif/700Bold/NotoSerif_700Bold.ttf?url';
import serifItalic from '@expo-google-fonts/noto-serif/400Regular_Italic/NotoSerif_400Regular_Italic.ttf?url';
import serifBoldItalic from '@expo-google-fonts/noto-serif/700Bold_Italic/NotoSerif_700Bold_Italic.ttf?url';
import monoRegular from '@expo-google-fonts/noto-sans-mono/400Regular/NotoSansMono_400Regular.ttf?url';
import monoBold from '@expo-google-fonts/noto-sans-mono/700Bold/NotoSansMono_700Bold.ttf?url';
import type { FontFamily } from '@/types';

export interface FontVariant {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

interface FontMetrics {
  /** Ascender as a fraction of the em. */
  ascent: number;
  /** Descender as a positive fraction of the em. */
  descent: number;
}

export const FONT_LABELS: Record<FontFamily, string> = {
  sans: 'Sans (Noto Sans)',
  serif: 'Serif (Noto Serif)',
  mono: 'Mono (Noto Sans Mono)',
};

const CSS_FAMILY: Record<FontFamily, string> = {
  sans: 'Adika Sans',
  serif: 'Adika Serif',
  mono: 'Adika Mono',
};

/** Mono has no italic cut; italic maps to upright so screen and PDF agree. */
const URLS: Record<FontFamily, [string, string, string, string]> = {
  sans: [sansRegular, sansBold, sansItalic, sansBoldItalic],
  serif: [serifRegular, serifBold, serifItalic, serifBoldItalic],
  mono: [monoRegular, monoBold, monoRegular, monoBold],
};

function variantIndex(v: Pick<FontVariant, 'bold' | 'italic'>): number {
  return (v.bold ? 1 : 0) + (v.italic ? 2 : 0);
}

export function fontUrl(v: FontVariant): string {
  return URLS[v.family][variantIndex(v)];
}

export function cssFontFamily(family: FontFamily): string {
  return `"${CSS_FAMILY[family]}"`;
}

/** Canvas `font` shorthand for a variant at a size in CSS px. */
export function canvasFont(v: FontVariant, sizePx: number): string {
  return `${v.italic ? 'italic ' : ''}${v.bold ? '700' : '400'} ${sizePx}px ${cssFontFamily(v.family)}`;
}

const bytesCache = new Map<string, Promise<Uint8Array>>();
const metricsCache = new Map<string, FontMetrics>();

export function loadFontBytes(v: FontVariant): Promise<Uint8Array> {
  const url = fontUrl(v);
  let p = bytesCache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Font ${url} failed to load (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    });
    bytesCache.set(url, p);
    p.catch(() => bytesCache.delete(url));
  }
  return p;
}

/** Fallback used until fonts are loaded; Noto's real values are close to this. */
const DEFAULT_METRICS: FontMetrics = { ascent: 1.069, descent: 0.293 };

export function fontMetrics(v: FontVariant): FontMetrics {
  return metricsCache.get(fontUrl(v)) ?? DEFAULT_METRICS;
}

let ready: Promise<void> | null = null;

/** Registers every variant with the document and reads its vertical metrics. */
export function ensureFontsLoaded(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const tasks: Promise<void>[] = [];
    for (const family of Object.keys(URLS) as FontFamily[]) {
      for (const bold of [false, true]) {
        for (const italic of [false, true]) {
          const v: FontVariant = { family, bold, italic };
          tasks.push(
            loadFontBytes(v).then(async (bytes) => {
              const face = new FontFace(CSS_FAMILY[family], bytes.slice().buffer, {
                weight: bold ? '700' : '400',
                style: italic ? 'italic' : 'normal',
              });
              await face.load();
              document.fonts.add(face);
              const parsed = fontkit.create(bytes);
              metricsCache.set(fontUrl(v), {
                ascent: parsed.ascent / parsed.unitsPerEm,
                descent: Math.abs(parsed.descent) / parsed.unitsPerEm,
              });
            }),
          );
        }
      }
    }
    await Promise.all(tasks);
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}
