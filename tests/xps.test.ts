import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { deobfuscateFont, xpsToPdf } from '../src/lib/pdf/xps';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/');
const standardFontDataUrl = `${root}node_modules/pdfjs-dist/standard_fonts/`;
const NOTO = new Uint8Array(readFileSync(`${root}node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf`));
const PNG = new Uint8Array(readFileSync(`${root}node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf.png`));

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl,
    verbosity: 0,
  });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

async function pageText(pdf: pdfjs.PDFDocumentProxy, n: number): Promise<string> {
  const page = await pdf.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str : '')).join('');
}

/** All painting operators on a page, including those folded into constructPath. */
async function paintOps(pdf: pdfjs.PDFDocumentProxy, n: number): Promise<Set<number>> {
  const page = await pdf.getPage(n);
  const ol = await page.getOperatorList();
  const s = new Set<number>(ol.fnArray);
  ol.fnArray.forEach((fn, i) => {
    if (fn === pdfjs.OPS.constructPath) {
      const a = ol.argsArray[i] as unknown[];
      if (typeof a?.[0] === 'number') s.add(a[0]);
    }
  });
  return s;
}

const NS = 'http://schemas.microsoft.com/xps/2005/06';
const OXPS_NS = 'http://schemas.openxps.org/oxps/v1.0';
const FONT_GUID = '0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0';

/** Obfuscate a font the way XPS producers do (the operation is its own inverse). */
function obfuscate(bytes: Uint8Array, guid: string): Uint8Array {
  const out = deobfuscateFont(bytes, `/Resources/${guid}.odttf`);
  if (!out) throw new Error('bad guid');
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function buildPackage(ns: string): Promise<Uint8Array> {
  const oxps = ns === OXPS_NS;
  const relNs = oxps ? 'http://schemas.openxps.org/oxps/v1.0' : 'http://schemas.microsoft.com/xps/2005/06';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/>` +
      `<Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/>` +
      `<Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/>` +
      `<Default Extension="dict" ContentType="application/vnd.ms-package.xps-resourcedictionary+xml"/>` +
      `<Default Extension="ttf" ContentType="application/vnd.ms-opentype"/>` +
      `<Default Extension="odttf" ContentType="application/vnd.ms-package.obfuscated-opentype"/>` +
      `<Default Extension="png" ContentType="image/png"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="R1" Type="${relNs}/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>`,
  );
  zip.file('FixedDocSeq.fdseq', `<FixedDocumentSequence xmlns="${ns}"><DocumentReference Source="Documents/1/FixedDoc.fdoc"/></FixedDocumentSequence>`);
  zip.file(
    'Documents/1/FixedDoc.fdoc',
    `<FixedDocument xmlns="${ns}"><PageContent Source="Pages/1.fpage"/>` +
      `<PageContent Source="/Documents/1/Pages/Page%202.fpage"><PageContent.LinkTargets><LinkTarget Name="second"/></PageContent.LinkTargets></PageContent></FixedDocument>`,
  );
  // Plain TTF with a space in its part name (referenced URL-encoded and relative).
  zip.file('Resources/Noto Sans.ttf', NOTO);
  zip.file(`Resources/${FONT_GUID}.odttf`, obfuscate(NOTO, FONT_GUID));
  zip.file('Resources/logo.png', PNG);
  zip.file(
    'Resources/shared.dict',
    `<ResourceDictionary xmlns="${ns}" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">` +
      `<ImageBrush x:Key="Logo" ImageSource="logo.png" Viewbox="0,0,100,100" Viewport="0,0,100,100" ViewboxUnits="Absolute" ViewportUnits="Absolute" TileMode="None"/>` +
      `</ResourceDictionary>`,
  );

  const hello = 'Hello XPS ăîșț';
  const page1 =
    `<FixedPage xmlns="${ns}" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Width="816" Height="1056" xml:lang="ro-RO">` +
    `<FixedPage.Resources><ResourceDictionary>` +
    `<SolidColorBrush x:Key="Blue" Color="#FF1F4E9A"/>` +
    `<PathGeometry x:Key="Tri" Figures="M 600,100 L 700,100 L 650,180 Z"/>` +
    `</ResourceDictionary></FixedPage.Resources>` +
    // filled rectangle
    `<Path Data="M 96,96 L 396,96 L 396,196 L 96,196 Z" Fill="{StaticResource Blue}"/>` +
    // stroked Bezier with dashes, round caps
    `<Path Data="M 96,300 C 200,200 300,400 400,300 S 600,200 700,300" Stroke="#80FF0000" StrokeThickness="4" StrokeDashArray="3 1" StrokeStartLineCap="Round" StrokeLineJoin="Round"/>` +
    // arcs, quadratic, H/V, relative commands, nonzero fill
    `<Path Data="F1 M 100,500 h 100 v 50 q 50,50 0,100 a 40,40 0 1 1 -80,0 Z" Fill="sc#1,0.2,0.8,0.2"/>` +
    // geometry resource with render transform and clip
    `<Path Data="{StaticResource Tri}" Fill="#FF00AA00" RenderTransform="1,0,0,1,0,20" Clip="M 0,0 L 816,0 L 816,1056 L 0,1056 Z"/>` +
    // Path.Data property element with PathGeometry figures
    `<Path Stroke="#FF000000" StrokeThickness="2"><Path.Data><PathGeometry FillRule="NonZero"><PathFigure StartPoint="100,700" IsClosed="true">` +
    `<PolyLineSegment Points="200,700 200,760"/><PolyBezierSegment Points="180,780 140,780 120,760"/>` +
    `<PolyQuadraticBezierSegment Points="100,740 100,720"/><ArcSegment Point="110,705" Size="10,10" SweepDirection="Clockwise" IsLargeArc="false" RotationAngle="0"/>` +
    `</PathFigure></PathGeometry></Path.Data></Path>` +
    // gradients
    `<Path Data="M 450,500 L 650,500 L 650,600 L 450,600 Z"><Path.Fill><LinearGradientBrush MappingMode="Absolute" StartPoint="450,500" EndPoint="650,600">` +
    `<LinearGradientBrush.GradientStops><GradientStop Color="#FFFF0000" Offset="0"/><GradientStop Color="#800000FF" Offset="1"/></LinearGradientBrush.GradientStops>` +
    `</LinearGradientBrush></Path.Fill></Path>` +
    `<Path Data="M 450,650 L 650,650 L 650,750 L 450,750 Z"><Path.Fill><RadialGradientBrush MappingMode="Absolute" Center="550,700" GradientOrigin="530,690" RadiusX="100" RadiusY="50">` +
    `<RadialGradientBrush.GradientStops><GradientStop Color="#FFFFFF00" Offset="0"/><GradientStop Color="#FF008000" Offset="1"/></RadialGradientBrush.GradientStops>` +
    `</RadialGradientBrush></Path.Fill></Path>` +
    // text: cmap-mapped UnicodeString, no Indices, hyperlink
    `<Canvas RenderTransform="1,0,0,1,0,0" Opacity="1">` +
    `<Glyphs Fill="#FF000000" FontUri="../../../Resources/Noto%20Sans.ttf" FontRenderingEmSize="24" OriginX="96" OriginY="260" ` +
    `UnicodeString="${esc(hello)}" FixedPage.NavigateUri="https://example.com/xps"/>` +
    `</Canvas>` +
    `</FixedPage>`;
  zip.file('Documents/1/Pages/1.fpage', page1);

  // Page 2: obfuscated font, glyph indices with advances, image brush from a remote dictionary,
  // internal link; stored as interleaved pieces.
  const f = fontkit.create(NOTO);
  const text2 = 'Glyph indices ăîșț';
  const idx = [...text2]
    .map((ch) => {
      const g = f.glyphForCodePoint(ch.codePointAt(0)!);
      return `${g.id},${((g.advanceWidth * 100) / f.unitsPerEm + 1).toFixed(2)}`;
    })
    .join(';');
  const page2 =
    `<FixedPage xmlns="${ns}" Width="595" Height="842">` +
    `<FixedPage.Resources><ResourceDictionary Source="/Resources/shared.dict"/></FixedPage.Resources>` +
    `<Path Data="M 50,50 L 150,50 L 150,150 L 50,150 Z" Fill="{StaticResource Logo}"/>` +
    `<Glyphs Fill="#FF202020" FontUri="/Resources/${FONT_GUID}.odttf" FontRenderingEmSize="16" OriginX="50" OriginY="220" ` +
    `UnicodeString="${esc(text2)}" Indices="${idx}" StyleSimulations="BoldSimulation"/>` +
    `<Glyphs Fill="#FF0000FF" FontUri="/Resources/${FONT_GUID}.odttf" FontRenderingEmSize="12" OriginX="50" OriginY="260" ` +
    `UnicodeString="Back to top" FixedPage.NavigateUri="#1"/>` +
    `<Glyphs Fill="#FF000000" FontUri="/Resources/missing.ttf" FontRenderingEmSize="12" OriginX="50" OriginY="300" UnicodeString="Fallback text"/>` +
    `<Bogus/>` +
    `</FixedPage>`;
  const half = Math.floor(page2.length / 2);
  zip.file('Documents/1/Pages/Page 2.fpage/[0].piece', page2.slice(0, half));
  zip.file('Documents/1/Pages/Page 2.fpage/[1].last.piece', page2.slice(half));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('xpsToPdf: synthetic package', () => {
  for (const [label, ns] of [
    ['XPS 1.0', NS],
    ['OpenXPS', OXPS_NS],
  ] as const) {
    it(`converts a hand-written ${label} package to vector PDF`, async () => {
      const xps = await buildPackage(ns);
      const progress: [number, number][] = [];
      const res = await xpsToPdf(xps, { onProgress: (d, t) => progress.push([d, t]) });
      expect(res.pages).toBe(2);
      expect(progress.at(-1)).toEqual([2, 2]);

      const pdf = await openPdf(res.bytes);
      expect(pdf.numPages).toBe(2);
      const p1 = await pdf.getPage(1);
      const [, , w1, h1] = p1.view;
      expect(w1).toBeCloseTo(612, 3);
      expect(h1).toBeCloseTo(792, 3);
      const p2 = await pdf.getPage(2);
      expect(p2.view[2]).toBeCloseTo(595 * 0.75, 3);
      expect(p2.view[3]).toBeCloseTo(842 * 0.75, 3);

      const t1 = await pageText(pdf, 1);
      expect(t1).toContain('Hello XPS ăîșț');
      const t2 = await pageText(pdf, 2);
      expect(t2).toContain('Glyph indices ăîșț');
      expect(t2).toContain('Back to top');
      expect(t2).toContain('Fallback text');

      const ops = await paintOps(pdf, 1);
      expect(ops.has(pdfjs.OPS.fill) || ops.has(pdfjs.OPS.eoFill)).toBe(true);
      expect(ops.has(pdfjs.OPS.stroke)).toBe(true);
      expect(ops.has(pdfjs.OPS.shadingFill)).toBe(true);
      expect(ops.has(pdfjs.OPS.showText)).toBe(true);
      const ops2 = await paintOps(pdf, 2);
      expect(ops2.has(pdfjs.OPS.paintImageXObject)).toBe(true);

      // Text position: the first glyph run starts at 96px,260px -> 72pt, 792-195pt.
      const tc = await p1.getTextContent();
      const hi = tc.items.find((i) => 'str' in i && i.str.startsWith('Hello')) as { transform: number[] } | undefined;
      expect(hi).toBeTruthy();
      expect(hi!.transform[4]).toBeCloseTo(72, 1);
      expect(hi!.transform[5]).toBeCloseTo(792 - 195, 1);

      // Links: external URI on page 1, internal GoTo on page 2.
      const a1 = await p1.getAnnotations();
      expect(a1.some((a) => a.subtype === 'Link' && a.url === 'https://example.com/xps')).toBe(true);
      const a2 = await p2.getAnnotations();
      expect(a2.some((a) => a.subtype === 'Link' && a.dest)).toBe(true);

      // Robustness: missing font and unknown element are warnings, not errors.
      expect(res.warnings.some((w) => w.includes('missing.ttf'))).toBe(true);
      expect(res.warnings.some((w) => w.includes('Bogus'))).toBe(true);
    });
  }

  it('rejects non-XPS input', async () => {
    await expect(xpsToPdf(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/Not an XPS package/);
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(xpsToPdf(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/Not an XPS package/);
  });

  it('de-obfuscates .odttf fonts', () => {
    const ob = obfuscate(NOTO, FONT_GUID);
    expect(ob.subarray(0, 32)).not.toEqual(NOTO.subarray(0, 32));
    expect(deobfuscateFont(ob, `Resources/${FONT_GUID}.odttf`)).toEqual(NOTO);
  });
});

describe('xpsToPdf: Microsoft Word output', () => {
  it('converts tests/fixtures/word-sample.xps (made by make-xps.ps1)', async () => {
    const xps = new Uint8Array(readFileSync(`${root}tests/fixtures/word-sample.xps`));
    const expected = JSON.parse(readFileSync(`${root}tests/fixtures/word-sample.json`, 'utf8')) as { pages: number };
    const res = await xpsToPdf(xps);
    expect(res.pages).toBe(expected.pages);
    const pdf = await openPdf(res.bytes);
    expect(pdf.numPages).toBe(expected.pages);
    const p1 = await pdf.getPage(1);
    expect(p1.view[2]).toBeCloseTo(612, 1);
    expect(p1.view[3]).toBeCloseTo(792, 1);
    let all = '';
    for (let i = 1; i <= pdf.numPages; i++) all += (await pageText(pdf, i)) + '\n';
    const norm = all.replace(/\s+/g, ' ');
    expect(norm).toContain('Raport XPS de test');
    expect(norm).toContain('conține diacritice românești');
    expect(norm).toContain('ă â î ș ț Ă Ș Ț');
    expect(norm).toContain('Produs');
    expect(norm).toContain('Cantitate');
    expect(norm).toContain('Pagina a doua');
    expect(norm).toContain('Forma inserata');
    const ops = await paintOps(pdf, 1);
    expect(ops.has(pdfjs.OPS.fill) || ops.has(pdfjs.OPS.eoFill)).toBe(true);
    // Word output should convert without any warnings.
    expect(res.warnings).toEqual([]);
  });
});
