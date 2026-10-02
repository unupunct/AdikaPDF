/** Shared helpers for the redaction / hidden-information tests. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { FontVariant } from '@/lib/fonts';
import type { PageRef, Rotation, SourceDoc } from '@/types';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
export function loadFont(v: FontVariant): Promise<Uint8Array> {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
}
export const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;

export const PNG_1PX = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
export const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_1PX).toString('base64')}`;
export const JPEG_1PX = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  ),
);
export const rasterize = async () => ({ bytes: JPEG_1PX, format: 'jpeg' as const });

/**
 * Every piece of text in a file: all streams decoded, all strings decoded,
 * all names, plus the raw bytes. Used to assert that a word is gone everywhere.
 */
export async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts: string[] = [Buffer.from(bytes).toString('latin1')];
  const seen = new Set<unknown>();
  const walk = (v: unknown) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    if (v instanceof PDFString || v instanceof PDFHexString) parts.push(v.decodeText(), v.toString());
    else if (v instanceof PDFName) parts.push(v.decodeText());
    else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) walk(v.get(i));
    else if (v instanceof PDFDict) for (const [k, x] of v.entries()) (walk(k), walk(x));
    else if (v instanceof PDFStream) {
      walk(v.dict);
      if (v instanceof PDFRawStream) {
        try {
          const d = decodePDFRawStream(v).decode();
          parts.push(Buffer.from(d).toString('latin1'), Buffer.from(d).toString('utf16le'));
        } catch {
          parts.push(Buffer.from(v.contents).toString('latin1'));
        }
      }
    } else if (!(v instanceof PDFRef)) parts.push(String(v));
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) walk(obj);
  walk(doc.context.trailerInfo.Info ? doc.context.lookup(doc.context.trailerInfo.Info) : null);
  return parts.join('\n');
}

export function contains(hay: string, word: string): boolean {
  if (hay.includes(word)) return true;
  // Hex-encoded strings in content streams.
  return hay.toLowerCase().includes(Buffer.from(word, 'latin1').toString('hex'));
}

export async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out.push(c.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await task.destroy();
  return out;
}

export function sourceOf(bytes: Uint8Array, id = 'src'): SourceDoc {
  return { id, name: 'test.pdf', bytes, pageCount: 0 };
}

export function pageRefs(src: SourceDoc, count: number, w = 300, h = 300): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${src.id}_p${i}`,
    kind: 'source' as const,
    sourceId: src.id,
    sourceIndex: i,
    baseRotation: 0 as Rotation,
    userRotation: 0 as Rotation,
    width: w,
    height: h,
  }));
}
