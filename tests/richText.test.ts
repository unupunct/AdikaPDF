import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFStream, PDFString } from 'pdf-lib';
import { buildPdf } from '@/lib/pdf/exportPdf';
import { annotId, isUntouched, linkToFile, readPageAnnots } from '@/lib/pdf/fileAnnots';
import { boxStyle, compactRuns, layoutRich, parseCss, parseRichText, plainText, resolveRun, richTextXml, type RunStyle } from '@/lib/richText';
import type { EditorObject, PageRef, SourceDoc, TextObject } from '@/types';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
function loadFont(v: FontVariant): Promise<Uint8Array> {
  const weight = `${v.bold ? '700Bold' : '400Regular'}${v.italic ? '_Italic' : ''}`;
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', weight, `NotoSans_${weight}.ttf`))));
}
const measure = (_v: FontVariant, size: number) => (s: string) => s.length * size * 0.5;
const opts = { loadFont, measure };

const RC =
  '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:23.6.0" xfa:spec="2.0.2" ' +
  'style="font-size:12.0pt;text-align:left;color:#000000;font-weight:normal;font-style:normal;font-family:Helvetica,sans-serif;font-stretch:normal">' +
  '<p dir="ltr"><span style="font-weight:bold">Atenție:</span><span> termenul </span><span style="color:#FF0000;font-style:italic">expiră</span><span> mâine.</span></p>' +
  '<p dir="ltr"><span style="font-size:16pt">Mare</span><br/><b>și</b> <i>înclinat</i> <u>subliniat</u></p></body>';
const DS = 'font: Helvetica,sans-serif 12.0pt; text-align:left; color:#000000 ';

const fallback: RunStyle = { family: 'sans', bold: false, italic: false, underline: false, strike: false, color: '#000000', size: 10 };

async function source(): Promise<{ src: SourceDoc; id: string; plainId: string }> {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  const ref = d.context.register(
    d.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      F: 4,
      P: page.ref,
      Rect: [100, 500, 400, 600],
      DA: PDFString.of('0 0 0 rg /Helv 12 Tf'),
      DS: PDFString.of(DS),
      RC: PDFHexString.fromText(RC),
      Contents: PDFHexString.fromText('Atenție: termenul expiră mâine.\rMare\rși înclinat subliniat'),
      NM: PDFString.of('nm-rich'),
      T: PDFHexString.fromText('Ana'),
    }),
  );
  const plain = d.context.register(
    d.context.obj({ Type: 'Annot', Subtype: 'FreeText', F: 4, P: page.ref, Rect: [100, 300, 400, 340], DA: PDFString.of('0 0 1 rg /Helv 10 Tf'), Contents: PDFHexString.fromText('Simplu'), NM: PDFString.of('nm-plain') }),
  );
  page.node.set(PDFName.of('Annots'), d.context.obj([ref, plain]));
  return { src: { id: 'src', name: 'a.pdf', bytes: await d.save(), pageCount: 1 }, id: annotId(ref), plainId: annotId(plain) };
}

const pageRef = (takenAnnots?: string[]): PageRef => ({ id: 'p1', kind: 'source', sourceId: 'src', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 600, height: 800, takenAnnots });

function dictByNm(doc: PDFDocument, nm: string): PDFDict {
  const arr = doc.getPage(0).node.Annots() as PDFArray;
  return arr.asArray().map((r) => doc.context.lookup(r) as PDFDict).find((x) => (x.lookup(PDFName.of('NM')) as PDFString | undefined)?.decodeText() === nm)!;
}
const textOf = (d: PDFDict, k: string) => (d.lookup(PDFName.of(k)) as PDFHexString | PDFString).decodeText();

describe('rich text of comment text boxes', () => {
  it('parses /RC into styled runs', () => {
    const r = parseRichText(RC, DS, fallback)!;
    expect(r.base).toMatchObject({ size: 12, color: '#000000', bold: false, family: 'sans' });
    expect(r.text).toBe('Atenție: termenul expiră mâine.\nMare\nși înclinat subliniat');
    expect(r.align).toBe('left');
    const styled = r.runs!.map((x) => ({ text: x.text, s: resolveRun(r.base, x) }));
    expect(styled.find((x) => x.text === 'Atenție:')?.s.bold).toBe(true);
    expect(styled.find((x) => x.text === 'expiră')?.s).toMatchObject({ italic: true, color: '#ff0000' });
    expect(styled.find((x) => x.text === 'Mare')?.s.size).toBe(16);
    expect(styled.find((x) => x.text === 'și')?.s.bold).toBe(true);
    expect(styled.find((x) => x.text === 'înclinat')?.s.italic).toBe(true);
    expect(styled.find((x) => x.text === 'subliniat')?.s.underline).toBe(true);
    // Runs only hold what differs from the box.
    expect(r.runs!.find((x) => x.text.includes('termenul'))).toEqual({ text: ' termenul ' });
    expect(parseCss('font: italic bold 9pt Times New Roman; text-decoration: line-through')).toMatchObject({ italic: true, bold: true, size: 9, family: 'serif', strike: true });
    // Uniform rich text is no runs at all: the box style says it.
    expect(parseRichText('<body style="font-weight:bold;color:#00f"><p>Tot</p></body>', '', fallback)).toMatchObject({ text: 'Tot', runs: undefined, base: { bold: true, color: '#0000ff' } });
  });

  it('writes runs as /RC that reads back the same', () => {
    const r = parseRichText(RC, DS, fallback)!;
    const box = { fontFamily: r.base.family, bold: r.base.bold, italic: r.base.italic, fontSize: r.base.size, color: r.base.color, align: 'left' as const };
    const xml = richTextXml(box, r.runs!);
    expect(xml).toContain('font-weight:bold');
    expect(xml).toContain('Atenție:');
    const again = parseRichText(xml, '', fallback)!;
    expect(again.text).toBe(r.text);
    expect(again.runs).toEqual(r.runs);
  });

  it('lays out runs: larger letters make their line taller', () => {
    const o = { width: 300, fontFamily: 'sans' as const, bold: false, italic: false, fontSize: 10, color: '#000000', align: 'left' as const, lineHeight: 1.25 };
    const plain = layoutRich(o, [{ text: 'a\nb' }], measure);
    const big = layoutRich(o, [{ text: 'a\n' }, { text: 'b', size: 20 }], measure);
    const gap = (l: typeof plain) => l.lines[1].baseline - l.lines[0].baseline;
    expect(big.contentHeight).toBeGreaterThan(plain.contentHeight);
    expect(gap(big)).toBeGreaterThan(gap(plain));
    // A word split between two styles wraps as one word.
    const narrow = layoutRich({ ...o, width: 34 }, [{ text: 'aaa bb' }, { text: 'bb', bold: true }], measure);
    expect(narrow.lines.map((l) => l.segments.map((s) => s.text).join(''))).toEqual(['aaa', 'bbbb']);
    expect(compactRuns([{ text: 'x', style: boxStyle(o) }], boxStyle(o))).toBeUndefined();
  });

  it('keeps the formatting when a FreeText of the file is edited', async () => {
    const { src, id, plainId } = await source();
    const list = readPageAnnots(await PDFDocument.load(src.bytes), 0, pageRef(), () => 'p1');
    const fa = list.find((a) => a.id === id)!;
    const o = fa.object as TextObject;
    expect(o.runs?.length).toBeGreaterThan(3);
    expect(plainText(o.runs!)).toBe(o.text);
    expect(o.fontSize).toBe(12);
    const taken = linkToFile({ ...o, id: 'o1', pageId: 'p1' }, fa) as TextObject;
    // Unchanged: the annotation stays exactly as it was.
    const untouchedOut = await buildPdf({ sources: { src }, pages: [pageRef([id])], objects: [taken], fieldValues: {} }, opts);
    expect(isUntouched(taken)).toBe(true);
    expect(textOf(dictByNm(await PDFDocument.load(untouchedOut), 'nm-rich'), 'RC')).toBe(RC);
    // Edited: one word changed in a plain run, a new bold green run added.
    const runs = taken.runs!.map((r) => (r.text === ' termenul ' ? { text: ' termenul final ' } : r));
    runs.push({ text: ' Nou', bold: true, color: '#16a34a' });
    const edited = { ...taken, runs, text: plainText(runs) } as EditorObject;
    const out = await buildPdf({ sources: { src }, pages: [pageRef([id, plainId])], objects: [edited, linkToFile({ ...(list.find((a) => a.id === plainId)!.object as TextObject), id: 'o2', pageId: 'p1' }, list.find((a) => a.id === plainId)!)], fieldValues: {} }, opts);
    const doc = await PDFDocument.load(out);
    const d = dictByNm(doc, 'nm-rich');
    expect(textOf(d, 'T')).toBe('Ana');
    expect(textOf(d, 'Contents')).toBe(plainText(runs));
    expect(textOf(d, 'DS')).toContain('12pt');
    // Read again: every style is still there.
    const back = readPageAnnots(doc, 0, pageRef(), () => 'p1').find((a) => a.id === id)!.object as TextObject;
    expect(back.text).toBe(plainText(runs));
    const base = boxStyle(back);
    const style = (t: string) => resolveRun(base, back.runs!.find((r) => r.text === t || r.text.includes(t))!);
    expect(style('Atenție:').bold).toBe(true);
    expect(style('expiră')).toMatchObject({ italic: true, color: '#ff0000' });
    expect(style('Mare').size).toBe(16);
    expect(style('subliniat').underline).toBe(true);
    expect(style('Nou')).toMatchObject({ bold: true, color: '#16a34a' });
    expect(style('termenul final').bold).toBe(false);
    // The appearance draws the runs in their own fonts (regular, bold, italic).
    const ap = (d.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream;
    const fonts = (ap.dict.lookup(PDFName.of('Resources')) as PDFDict).lookup(PDFName.of('Font')) as PDFDict;
    expect(fonts.keys().length).toBeGreaterThanOrEqual(3);
    // A FreeText without rich text stays without it.
    expect(dictByNm(doc, 'nm-plain').has(PDFName.of('RC'))).toBe(false);
  });
});
