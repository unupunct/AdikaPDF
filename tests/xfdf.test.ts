import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { countComments, exportFdf, exportXfdf, importFdf, importXfdf, parseXfdf } from '../src/lib/pdf/xfdf';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
function openPdf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  tasks.push(task);
  return task.promise;
}
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});

const RO = 'Ștefan Țepeș: ăâîșț ĂÂÎȘȚ <&> "quoted" \'apos\'';
const u = (s: string) => PDFHexString.fromText(s);

/** Two pages; comments of every kind written as raw dictionaries, plus a link and a form widget. */
async function makeSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p0 = doc.addPage([600, 800]);
  const p1 = doc.addPage([600, 800]);
  const ctx = doc.context;
  // An (empty) appearance on each comment stops pdf.js from generating its own
  // and adjusting /Rect, so it reports the dictionary values as written.
  const emptyAp = (rect: unknown) => ({ N: ctx.register(ctx.formXObject([], { BBox: rect as number[] })) });
  const add = (page: typeof p0, obj: Record<string, unknown>): PDFRef => {
    const ap = obj.Subtype === 'Link' || obj.Subtype === 'Widget' || obj.AP ? {} : { AP: emptyAp(obj.Rect) };
    const ref = ctx.register(ctx.obj({ Type: 'Annot', P: page.ref, ...ap, ...obj } as never));
    page.node.addAnnot(ref);
    return ref;
  };
  const noteRef = ctx.nextRef();
  const popupRef = ctx.nextRef();
  ctx.assign(
    noteRef,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [50, 698, 72, 720],
      Contents: u(RO),
      T: u('Ana Popescu'),
      Subj: u('Notă'),
      NM: u('note-1'),
      M: PDFString.of("D:20240315101700+02'00'"),
      CreationDate: PDFString.of("D:20240315101500+02'00'"),
      C: [1, 0.8, 0],
      Name: 'Comment',
      F: 28,
      P: p0.ref,
      Popup: popupRef,
    }),
  );
  ctx.assign(popupRef, ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [70, 610, 270, 720], Parent: noteRef, Open: false, P: p0.ref }));
  p0.node.addAnnot(noteRef);
  p0.node.addAnnot(popupRef);
  add(p0, { Subtype: 'Text', Rect: [50, 698, 72, 720], Contents: u('Răspuns: de acord'), T: u('Ion'), NM: u('reply-1'), IRT: noteRef, C: [1, 0.8, 0], Name: 'Comment' });
  add(p0, {
    Subtype: 'Highlight',
    Rect: [100, 650, 300, 670],
    QuadPoints: [100, 670, 300, 670, 100, 650, 300, 650],
    C: [1, 1, 0],
    CA: 1,
    Contents: u('evidențiat'),
    T: u('Ana Popescu'),
    NM: u('hl-1'),
  });
  add(p0, { Subtype: 'StrikeOut', Rect: [100, 600, 200, 620], QuadPoints: [100, 620, 200, 620, 100, 600, 200, 600], C: [1, 0, 0], T: u('Ion'), NM: u('so-1') });
  add(p0, { Subtype: 'Link', Rect: [10, 10, 100, 30], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com') } });
  add(p0, { Subtype: 'Widget', Rect: [10, 40, 100, 60], FT: 'Tx', T: PDFString.of('field1') });

  add(p1, {
    Subtype: 'FreeText',
    Rect: [100, 600, 300, 660],
    Contents: u('Linia unu\nLinia doi, cu ș și ț'),
    DA: PDFString.of('0 0 1 rg /Helv 14 Tf'),
    Q: 1,
    T: u('Ana Popescu'),
    NM: u('ft-1'),
    BS: { W: 1 },
  });
  add(p1, { Subtype: 'Square', Rect: [50, 400, 150, 480], C: [0, 0, 1], IC: [0.8, 0.9, 1], BS: { W: 2, S: 'D', D: [4, 2] }, T: u('Ion'), NM: u('sq-1'), Contents: u('pătrat') });
  add(p1, { Subtype: 'Circle', Rect: [200, 400, 300, 480], C: [0, 0.5, 0], BS: { W: 3 }, NM: u('ci-1') });
  add(p1, { Subtype: 'Line', Rect: [45, 295, 255, 355], AP: { N: ctx.register(ctx.formXObject([], { BBox: [45, 295, 255, 355] })) }, L: [50, 300, 250, 350], LE: ['OpenArrow', 'None'], C: [1, 0, 0], BS: { W: 2 }, NM: u('ln-1') });
  add(p1, { Subtype: 'Polygon', Rect: [299, 249, 401, 351], Vertices: [300, 250, 400, 250, 350, 350], C: [0.5, 0, 0.5], NM: u('pg-1') });
  add(p1, { Subtype: 'PolyLine', Rect: [399, 249, 501, 351], Vertices: [400, 250, 450, 350, 500, 250], C: [0, 0, 0], NM: u('pl-1') });
  add(p1, { Subtype: 'Ink', Rect: [57.5, 107.5, 192.5, 192.5], InkList: [[60, 110, 100, 190, 140, 120], [150, 150, 190, 160]], C: [0, 0, 1], BS: { W: 2.5 }, NM: u('ink-1') });
  add(p1, { Subtype: 'Stamp', Rect: [300, 100, 450, 150], Name: 'Approved', C: [0, 0.6, 0], NM: u('st-1'), T: u('Șef') });
  add(p1, { Subtype: 'Caret', Rect: [480, 600, 490, 610], C: [0, 0, 1], NM: u('ca-1'), Contents: u('inserează') });
  add(p1, { Subtype: 'Underline', Rect: [100, 700, 200, 720], QuadPoints: [100, 720, 200, 720, 100, 700, 200, 700], C: [0, 0.6, 0], NM: u('ul-1') });
  add(p1, { Subtype: 'Squiggly', Rect: [300, 700, 400, 720], QuadPoints: [300, 720, 400, 720, 300, 700, 400, 700], C: [1, 0, 1], NM: u('sg-1') });
  return doc.save();
}

async function blankPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]);
  return doc.save();
}

interface Seen {
  page: number;
  subtype: string;
  contents: string;
  title: string;
  color: number[] | null;
  rect: number[];
  quadPoints?: number[];
  vertices?: number[];
  inkLists?: number[][];
  line?: number[];
  id: string;
  inReplyTo?: string;
}

/** Comments as pdf.js sees them (popups, links and widgets left out). */
async function seen(bytes: Uint8Array): Promise<Seen[]> {
  const pdf = await openPdf(bytes);
  const out: Seen[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of (await page.getAnnotations()) as any[]) {
      if (['Popup', 'Link', 'Widget'].includes(a.subtype)) continue;
      out.push({
        page: n - 1,
        subtype: a.subtype,
        contents: a.contentsObj?.str ?? '',
        title: a.titleObj?.str ?? '',
        color: a.color ? Array.from(a.color as ArrayLike<number>) : null,
        rect: Array.from(a.rect as ArrayLike<number>),
        quadPoints: a.quadPoints ? Array.from(a.quadPoints as ArrayLike<number>) : undefined,
        vertices: a.vertices ? (a.vertices.length && typeof a.vertices[0] === 'object' ? a.vertices.flatMap((v: { x: number; y: number }) => [v.x, v.y]) : Array.from(a.vertices as ArrayLike<number>)) : undefined,
        inkLists: a.inkLists ? a.inkLists.map((l: ArrayLike<number> | { x: number; y: number }[]) => (Array.isArray(l) && typeof l[0] === 'object' ? (l as { x: number; y: number }[]).flatMap((p) => [p.x, p.y]) : Array.from(l as ArrayLike<number>))) : undefined,
        line: a.lineCoordinates ? Array.from(a.lineCoordinates as ArrayLike<number>) : undefined,
        id: a.id,
        inReplyTo: a.inReplyTo ?? undefined,
      });
    }
  }
  return out;
}

function expectSame(got: Seen[], want: Seen[]) {
  expect(got.map((s) => `${s.page}:${s.subtype}`)).toEqual(want.map((s) => `${s.page}:${s.subtype}`));
  got.forEach((g, i) => {
    const w = want[i];
    expect(g.contents, `${w.subtype} contents`).toBe(w.contents);
    expect(g.title, `${w.subtype} title`).toBe(w.title);
    expect(g.color, `${w.subtype} color`).toEqual(w.color);
    g.rect.forEach((v, k) => expect(Math.abs(v - w.rect[k]), `${w.subtype} rect ${g.rect} vs ${w.rect}`).toBeLessThanOrEqual(0.5));
    expect(g.quadPoints, `${w.subtype} quads`).toEqual(w.quadPoints);
    expect(g.vertices, `${w.subtype} vertices`).toEqual(w.vertices);
    expect(g.inkLists, `${w.subtype} ink`).toEqual(w.inkLists);
    expect(g.line, `${w.subtype} line`).toEqual(w.line);
    expect(!!g.inReplyTo, `${w.subtype} reply`).toBe(!!w.inReplyTo);
  });
  // Replies point at the imported copy of their parent.
  for (const g of got.filter((s) => s.inReplyTo)) expect(got.some((p) => p.id === g.inReplyTo)).toBe(true);
}

/** Every imported comment carries an /AP /N appearance and a /P back-pointer. */
async function expectAppearances(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    for (const x of annots.asArray()) {
      const d = doc.context.lookup(x, PDFDict);
      if (d.lookup(PDFName.of('Subtype'))?.toString() === '/Popup') continue;
      const ap = d.lookup(PDFName.of('AP'), PDFDict);
      expect(ap.get(PDFName.of('N'))).toBeInstanceOf(PDFRef);
      expect(d.get(PDFName.of('P'))).toBe(page.ref);
    }
  }
}

describe('XFDF export', () => {
  it('writes every comment kind, skipping links, widgets and popups', async () => {
    const src = await makeSource();
    expect(await countComments(src)).toBe(15);
    const xml = await exportXfdf(src, { fileName: 'Contract & anexă.pdf' });
    expect(xml).toContain('<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">');
    expect(xml).toContain('<f href="Contract &amp; anexă.pdf"/>');
    for (const tag of ['text', 'freetext', 'highlight', 'underline', 'strikeout', 'squiggly', 'square', 'circle', 'line', 'polygon', 'polyline', 'ink', 'stamp', 'caret']) {
      expect(xml, tag).toMatch(new RegExp(`<${tag}\\s`));
    }
    expect(xml).not.toMatch(/<link|<widget/);
    expect(xml).toContain('page="0" rect="50,698,72,720" color="#FFCC00" title="Ana Popescu" subject="Notă" name="note-1"');
    expect(xml).toContain(`date="D:20240315101700+02'00'" creationdate="D:20240315101500+02'00'" flags="print,nozoom,norotate"`);
    expect(xml).toContain('<contents>Ștefan Țepeș: ăâîșț ĂÂÎȘȚ &lt;&amp;&gt; "quoted" \'apos\'</contents>');
    expect(xml).toContain('<popup page="0" rect="70,610,270,720" open="no"/>');
    expect(xml).toMatch(/<text [^>]*name="reply-1" [^>]*inreplyto="note-1" replyType="reply"/);
    expect(xml).toContain('coords="100,670,300,670,100,650,300,650"');
    expect(xml).toContain('<defaultappearance>0 0 1 rg /Helv 14 Tf</defaultappearance>');
    expect(xml).toContain('justification="centered"');
    expect(xml).toMatch(/<square [^>]*interior-color="#CCE6FF"[^>]*width="2" style="dash" dashes="4,2"/);
    expect(xml).toContain('start="50,300" end="250,350" head="OpenArrow" tail="None"');
    expect(xml).toContain('<vertices>300,250;400,250;350,350</vertices>');
    expect(xml).toContain('<inklist><gesture>60,110;100,190;140,120</gesture><gesture>150,150;190,160</gesture></inklist>');
    expect(xml).toMatch(/<stamp [^>]*icon="Approved"/);
    // Well-formed and re-readable.
    expect(parseXfdf(xml).records).toHaveLength(15);
  });
});

describe('XFDF round trip', () => {
  it('imports into a clean copy with the same subtypes, text, authors, colours and geometry', async () => {
    const src = await makeSource();
    const xml = await exportXfdf(src, { fileName: 'a.pdf' });
    const res = await importXfdf(await blankPdf(), xml);
    expect(res.added).toBe(15);
    expect(res.skipped).toBe(0);
    expect(await countComments(res.bytes)).toBe(15);
    expectSame(await seen(res.bytes), await seen(src));
    await expectAppearances(res.bytes);
  });

  it('renders the imported appearance streams in pdf.js', async () => {
    const xml = await exportXfdf(await makeSource(), { fileName: 'a.pdf' });
    const res = await importXfdf(await blankPdf(), xml);
    const pdf = await openPdf(res.bytes);
    const ops0 = await (await pdf.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    const ops1 = await (await pdf.getPage(2)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    const count = (list: typeof ops0, op: number) => list.fnArray.filter((f) => f === op).length;
    expect(count(ops0, pdfjs.OPS.beginAnnotation)).toBeGreaterThanOrEqual(4);
    expect(count(ops0, pdfjs.OPS.constructPath)).toBeGreaterThan(0);
    expect(count(ops1, pdfjs.OPS.showText)).toBeGreaterThanOrEqual(3); // FreeText (2 lines) + stamp label
  });

  it('skips duplicates by NM, both against the source and on a second import', async () => {
    const src = await makeSource();
    const xml = await exportXfdf(src, { fileName: 'a.pdf' });
    const same = await importXfdf(src, xml);
    expect(same).toMatchObject({ added: 0, skipped: 15 });
    const once = await importXfdf(await blankPdf(), xml);
    const twice = await importXfdf(once.bytes, xml);
    expect(twice).toMatchObject({ added: 0, skipped: 15 });
    expect(await countComments(twice.bytes)).toBe(15);
  });

  it('skips comments whose page is out of range', async () => {
    const src = await makeSource();
    const xml = await exportXfdf(src, { fileName: 'a.pdf' });
    const res = await importXfdf(await blankPdf(1), xml);
    expect(res.added).toBe(4);
    expect(res.skipped).toBe(11);
    const items = await seen(res.bytes);
    expect(items.map((s) => s.subtype)).toEqual(['Text', 'Text', 'Highlight', 'StrikeOut']);
  });

  it('keeps Romanian text and XML special characters both ways', async () => {
    const src = await makeSource();
    const xml = await exportXfdf(src, { fileName: 'a.pdf' });
    const res = await importXfdf(await blankPdf(), xml);
    const items = await seen(res.bytes);
    expect(items[0].contents).toBe(RO);
    expect(items[0].title).toBe('Ana Popescu');
    expect(items.find((s) => s.subtype === 'FreeText')?.contents).toBe('Linia unu\nLinia doi, cu ș și ț');
    expect(items.find((s) => s.subtype === 'Stamp')?.title).toBe('Șef');
    // And back out again unchanged.
    expect(await exportXfdf(res.bytes, { fileName: 'a.pdf' })).toContain(`<contents>Ștefan Țepeș: ăâîșț ĂÂÎȘȚ &lt;&amp;&gt;`);
  });
});

describe('FDF round trip', () => {
  it('writes an FDF file and reads it back into a clean copy', async () => {
    const src = await makeSource();
    const fdf = await exportFdf(src, { fileName: 'Contract.pdf' });
    const head = new TextDecoder('latin1').decode(fdf.subarray(0, 8));
    expect(head).toBe('%FDF-1.2');
    const text = new TextDecoder('latin1').decode(fdf);
    expect(text).toContain('/FDF');
    expect(text).toContain('/F (Contract.pdf)');
    expect(text).toMatch(/\/Page 1/);
    const res = await importFdf(await blankPdf(), fdf);
    expect(res.added).toBe(15);
    expect(res.skipped).toBe(0);
    expectSame(await seen(res.bytes), await seen(src));
    await expectAppearances(res.bytes);
    expect(await importFdf(res.bytes, fdf)).toMatchObject({ added: 0, skipped: 15 });
  });

  it('reads a hand-written Acrobat-style FDF (no xref, popups listed separately)', async () => {
    const fdf = `%FDF-1.2
%âãÏÓ
1 0 obj
<</FDF<</Annots[2 0 R 3 0 R 4 0 R]/F(Report.pdf)/ID[<7A0631678ED475F0898815F0A818CFA1><BEF7724317B311718E8675B677EF9B4E>]>>/Type/Catalog>>
endobj
2 0 obj
<</C[1.0 1.0 0.0]/Contents(Check this \\(twice\\))/CreationDate(D:20240101120000Z)/F 28/M(D:20240101120500Z)/NM(acro-note-1)/Name/Note/Page 0/Popup 3 0 R/Rect[100.0 500.0 124.0 524.0]/Subj(Sticky Note)/Subtype/Text/T(Reviewer)/Type/Annot>>
endobj
3 0 obj
<</F 28/Open false/Page 0/Parent 2 0 R/Rect[124.0 400.0 324.0 524.0]/Subtype/Popup/Type/Annot>>
endobj
4 0 obj
<</C[0.0 0.0 1.0]/F 4/NM(acro-ink-1)/InkList[[10 10 20 30 30 10]]/Page 0/Rect[5 5 35 35]/Subtype/Ink/T(Reviewer)/BS<</W 1.5>>/Type/Annot>>
endobj
trailer
<</Root 1 0 R>>
%%EOF
`;
    const bytes = Uint8Array.from(fdf, (c) => c.charCodeAt(0));
    const res = await importFdf(await blankPdf(1), bytes);
    expect(res).toMatchObject({ added: 2, skipped: 0 });
    const items = await seen(res.bytes);
    expect(items.map((s) => s.subtype)).toEqual(['Text', 'Ink']);
    expect(items[0].contents).toBe('Check this (twice)');
    expect(items[0].title).toBe('Reviewer');
    expect(items[0].color).toEqual([255, 255, 0]);
    expect(items[1].inkLists).toEqual([[10, 10, 20, 30, 30, 10]]);
  });
});

describe('Acrobat-style XFDF', () => {
  const sample = `<?xml version="1.0" encoding="UTF-8" ?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<text color="#FFFF00" creationdate="D:20240315101500+02'00'" flags="print,nozoom,norotate" date="D:20240315101700+02'00'" name="a1b2c3d4-0001" icon="Comment" page="0" rect="100.5,700.25,120.5,720.25" subject="Sticky Note" title="Maria Ionescu"><contents-richtext><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:23.8.0" xfa:spec="2.0.2"><p>Verificați <b>tabelul</b> &amp; graficul</p></body></contents-richtext><contents>Verificați tabelul &amp; graficul&#13;al doilea rând</contents><popup flags="print,nozoom,norotate" open="no" page="0" rect="120.5,600,320.5,720.25"/></text>
<text color="#FFFF00" date="D:20240315102000+02'00'" flags="print,nozoom,norotate" name="a1b2c3d4-0002" icon="Comment" inreplyto="a1b2c3d4-0001" replyType="reply" page="0" rect="100.5,700.25,120.5,720.25" subject="Sticky Note" title="Andrei"><contents>De acord.</contents></text>
<highlight color="#FFFF00" creationdate="D:20240315101800+02'00'" flags="print" date="D:20240315101800+02'00'" name="a1b2c3d4-0003" page="0" coords="72.1,650.2,300.3,650.2,72.1,636.4,300.3,636.4" rect="71.1,635.4,301.3,651.2" subject="Highlight" title="Maria Ionescu" opacity="1"><contents>text evidențiat</contents></highlight>
<freetext color="#FFFFFF" creationdate="D:20240315101900+02'00'" flags="print" date="D:20240315101900+02'00'" name="a1b2c3d4-0004" page="0" rect="300,500,500,540" subject="Text Box" title="Maria Ionescu" width="1" justification="left"><contents>Casetă de text</contents><defaultappearance>0 0 0 rg /Helv 12 Tf</defaultappearance><defaultstyle>font: Helvetica 12pt; text-align:left; color:#E52237</defaultstyle></freetext>
<ink color="#0000FF" flags="print" name="a1b2c3d4-0005" page="0" rect="50,50,150,150" width="2" title="Maria Ionescu"><inklist><gesture>60,60;100,140;140,60</gesture></inklist></ink>
<polygon color="#FF0000" interior-color="#FFCCCC" flags="print" name="a1b2c3d4-0006" page="0" rect="200,50,300,150" width="1" title="Maria Ionescu"><vertices>200,50;300,50;250,150;200,50</vertices></polygon>
<line color="#FF0000" flags="print" name="a1b2c3d4-0007" page="0" rect="300,300,400,400" start="305,305" end="395,395" head="None" tail="ClosedArrow" width="1" title="Maria Ionescu"/>
<link page="0" rect="10,10,50,20"/>
<!-- a comment the parser must ignore -->
</annots>
<f href="Contract.pdf"/>
<ids original="7A0631678ED475F0898815F0A818CFA1" modified="BEF7724317B311718E8675B677EF9B4E"/>
</xfdf>`;

  it('imports the sample, with rich text, replies and popups', async () => {
    const res = await importXfdf(await blankPdf(1), sample);
    expect(res).toMatchObject({ added: 7, skipped: 1 });
    const items = await seen(res.bytes);
    expect(items.map((s) => s.subtype)).toEqual(['Text', 'Text', 'Highlight', 'FreeText', 'Ink', 'Polygon', 'Line']);
    expect(items[0].contents).toBe('Verificați tabelul & graficul\ral doilea rând');
    expect(items[0].title).toBe('Maria Ionescu');
    expect(items[0].rect).toEqual([100.5, 700.25, 120.5, 720.25]);
    expect(items[1].inReplyTo).toBe(items[0].id);
    expect(items[2].quadPoints).toEqual([72.1, 650.2, 300.3, 650.2, 72.1, 636.4, 300.3, 636.4].map(Math.fround));
    expect(items[4].inkLists).toEqual([[60, 60, 100, 140, 140, 60]]);
    expect(items[6].line).toEqual([305, 305, 395, 395]);
    await expectAppearances(res.bytes);

    const doc = await PDFDocument.load(res.bytes);
    const annots = doc.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray);
    const note = doc.context.lookup(annots.get(0), PDFDict);
    const rc = note.lookup(PDFName.of('RC'));
    expect(rc).toBeInstanceOf(PDFHexString);
    expect((rc as PDFHexString).decodeText()).toContain('<p>Verificați <b>tabelul</b> &amp; graficul</p>');
    const popup = note.lookup(PDFName.of('Popup'), PDFDict);
    expect(popup.get(PDFName.of('Parent'))).toEqual(annots.get(0));
    // Re-export carries the rich text through as XML.
    const again = await exportXfdf(res.bytes, { fileName: 'Contract.pdf' });
    expect(again).toContain('<contents-richtext><body xmlns="http://www.w3.org/1999/xhtml"');
    expect(again).toContain('interior-color="#FFCCCC"');
  });

  it('rejects files that are not XFDF', async () => {
    await expect(importXfdf(await blankPdf(1), '<html><body/></html>')).rejects.toThrow(/XFDF/);
    await expect(importXfdf(await blankPdf(1), '<xfdf><annots><text page="0"></annots></xfdf>')).rejects.toThrow(/XFDF/);
  });
});
