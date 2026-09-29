import { afterAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { checkAccessibility, humanize, listFigures, makeAccessible, scanPage } from '@/lib/pdf/accessibility';
import { pageContent, parseContent } from '@/lib/pdf/textRemoval';

const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function open(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  tasks.push(task);
  return task.promise;
}

// 2x2 red PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([595, 842]);
  p.drawRectangle({ x: 40, y: 800, width: 515, height: 4, color: rgb(0.2, 0.4, 0.8) }); // decoration
  p.drawText('Raport anual', { x: 60, y: 760, size: 26, font: bold });
  p.drawText('1. Introducere', { x: 60, y: 720, size: 16, font: bold });
  const lines = ['Aceasta este prima linie a paragrafului, destul de lunga pentru corp.', 'A doua linie continua acelasi paragraf fara pauza.', 'A treia linie inchide paragraful intr-un mod firesc.'];
  lines.forEach((l, i) => p.drawText(l, { x: 60, y: 690 - i * 14, size: 11, font }));
  p.drawText('Un paragraf nou, dupa un spatiu mai mare.', { x: 60, y: 620, size: 11, font });
  const img = await doc.embedPng(PNG);
  p.drawImage(img, { x: 60, y: 450, width: 120, height: 120 });
  p.drawText('Sigla firmei', { x: 60, y: 430, size: 11, font });
  // A link and a form field.
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 400, 200, 414], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://adika.test/') } }));
  p.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  doc.getForm().createTextField('data_nasterii').addToPage(p, { x: 60, y: 360, width: 160, height: 22 });
  return doc.save();
}

describe('accessibility checker', () => {
  it('finds what an untagged document is missing', async () => {
    const checks = await checkAccessibility(await sample());
    const st = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(st).toMatchObject({ tagged: 'fail', title: 'fail', language: 'fail', figures: 'fail', text: 'pass', fields: 'fail', links: 'fail', tabs: 'fail', security: 'pass' });
    expect(checks.find((c) => c.id === 'figures')!.detail).toMatch(/1 of 1 picture have no alternative text/);
    expect(checks.find((c) => c.id === 'fonts')!.status).toBe('warn'); // standard 14 fonts are not embedded
  });

  it('turns field names into descriptions', () => {
    expect(humanize('data_nasterii')).toBe('Data nasterii');
    expect(humanize('form.numeComplet')).toBe('Nume Complet');
  });
});

describe('making a document accessible', () => {
  it('tags paragraphs, headings, the picture (with its description), the link and the field; decoration becomes an artifact', async () => {
    const src = await sample();
    const figures = await listFigures(src);
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ page: 1, alt: '' });
    const { bytes, elements } = await makeAccessible(src, { title: 'Raport anual 2025', lang: 'ro-RO', alt: { [figures[0].key]: 'Sigla Adika: un pătrat roșu' }, decorative: [], tag: true });
    expect(elements).toBeGreaterThanOrEqual(8);

    const pdf = await open(bytes);
    const tree = (await (await pdf.getPage(1)).getStructTree()) as { children: Array<{ role: string; alt?: string; children: unknown[] }> };
    const doc = tree.children[0];
    expect(doc.role).toBe('Document');
    const roles = (doc.children as Array<{ role: string; alt?: string; children: Array<{ type?: string }> }>).map((c) => c.role);
    expect(roles).toEqual(['H1', 'H2', 'P', 'P', 'Figure', 'P', 'Link', 'Form']);
    const kids = doc.children as Array<{ role: string; alt?: string; children: Array<{ type?: string }> }>;
    expect(kids[2].children).toHaveLength(3); // the three lines form one paragraph
    expect(kids[4].alt).toBe('Sigla Adika: un pătrat roșu');
    const meta = await pdf.getMetadata();
    expect((meta.info as { Title?: string }).Title).toBe('Raport anual 2025');
    expect(meta.metadata?.get('dc:title')).toBe('Raport anual 2025');
    // The text is unchanged.
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(text).toContain('A doua linie continua acelasi paragraf');

    // Every painting operator is inside marked content.
    const out = await PDFDocument.load(bytes);
    const instrs = parseContent(pageContent(out, out.getPage(0)));
    let depth = 0;
    const loose: string[] = [];
    for (const i of instrs) {
      if (i.op === 'BDC' || i.op === 'BMC') depth++;
      else if (i.op === 'EMC') depth--;
      else if (depth === 0 && ['f', 'S', 'B', 'Do', 'Tj', 'TJ', 're'].includes(i.op) && i.op !== 're') loose.push(i.op);
    }
    expect(loose).toEqual([]);
    expect(out.catalog.lookup(PDFName.of('Lang'))?.toString()).toBe('(ro-RO)');
    expect(out.getPage(0).node.lookup(PDFName.of('Tabs'))).toBe(PDFName.of('S'));
    const annot = (out.getPage(0).node.lookup(PDFName.of('Annots')) as PDFArray).lookup(0) as PDFDict;
    expect((annot.lookup(PDFName.of('Contents')) as PDFString).decodeText()).toBe('Link: https://adika.test/');

    // Checked again: the fixable problems are gone.
    const st = Object.fromEntries((await checkAccessibility(bytes)).map((c) => [c.id, c.status]));
    expect(st).toMatchObject({ tagged: 'pass', title: 'pass', language: 'pass', figures: 'pass', fields: 'pass', links: 'pass', tabs: 'pass' });
  });

  it('a decorative picture is an artifact; an existing tag tree only gets the new descriptions', async () => {
    const src = await sample();
    const [fig] = await listFigures(src);
    const deco = await makeAccessible(src, { title: 'T', lang: 'en-US', alt: {}, decorative: [fig.key], tag: true });
    const d = await PDFDocument.load(deco.bytes);
    expect(scanPage(d, d.getPage(0)).items.filter((i) => i.kind === 'figure')).toHaveLength(0); // now inside an artifact
    const pdf = await open(deco.bytes);
    const roles = ((await (await pdf.getPage(1)).getStructTree()) as { children: Array<{ children: Array<{ role: string }> }> }).children[0].children.map((c) => c.role);
    expect(roles).not.toContain('Figure');

    // Tagged without a description, then described later.
    const first = await makeAccessible(src, { title: 'T', lang: 'en-US', alt: {}, decorative: [], tag: true });
    const figs = await listFigures(first.bytes);
    expect(figs).toEqual([expect.objectContaining({ key: 's0', page: 1, alt: '' })]);
    expect((await checkAccessibility(first.bytes)).find((c) => c.id === 'figures')!.status).toBe('fail');
    const second = await makeAccessible(first.bytes, { title: 'T', lang: 'en-US', alt: { s0: 'A red square' }, decorative: [], tag: true });
    expect((await listFigures(second.bytes))[0].alt).toBe('A red square');
    // Not tagged twice.
    const again = await PDFDocument.load(second.bytes);
    const text = new TextDecoder().decode(pageContent(again, again.getPage(0)));
    expect(text.match(/\/MCID 0\b/g)).toHaveLength(1);
  });
});
