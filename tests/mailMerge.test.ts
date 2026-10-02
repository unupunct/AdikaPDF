import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { combineMerged, fileNameFor, formFieldNames, matchColumns, mergeRow, parseCsv, readTable, readXlsx } from '@/lib/mailMerge';
import { runSequence, sequenceProblem, sequenceSuffix, type BatchOp } from '@/lib/batch';
import { isPdfEncrypted } from '@/lib/crypto/encrypt';
import type { FontVariant } from '@/lib/fonts';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const tasks: pdfjs.PDFDocumentLoadingTask[] = [];
afterAll(async () => {
  for (const t of tasks) await t.destroy();
});
async function pageTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0 });
  tasks.push(task);
  const pdf = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' '));
  return out;
}

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Adeverinta', { x: 60, y: 780, size: 18, font });
  const form = doc.getForm();
  form.createTextField('Nume').addToPage(p, { x: 60, y: 700, width: 240, height: 22 });
  form.createTextField('Oras').addToPage(p, { x: 60, y: 660, width: 240, height: 22 });
  form.createCheckBox('Angajat').addToPage(p, { x: 60, y: 620, width: 14, height: 14 });
  const dd = form.createDropdown('Departament');
  dd.addOptions(['Vânzări', 'Tehnic', 'Juridic']);
  dd.addToPage(p, { x: 60, y: 580, width: 160, height: 22 });
  const rg = form.createRadioGroup('Tip');
  rg.addOptionToPage('Nedeterminat', p, { x: 60, y: 540, width: 14, height: 14 });
  rg.addOptionToPage('Determinat', p, { x: 100, y: 540, width: 14, height: 14 });
  return doc.save();
}

describe('mail merge: tables', () => {
  it('reads CSV with quotes, semicolons, a BOM, CRLF and line breaks in cells', () => {
    const rows = parseCsv('﻿Nume;Oraș;Notă\r\n"Popescu; Ion";Cluj;"spune ""da""\nși pleacă"\r\nIonescu Ana;Iași;\r\n\r\n');
    expect(rows).toEqual([
      ['Nume', 'Oraș', 'Notă'],
      ['Popescu; Ion', 'Cluj', 'spune "da"\nși pleacă'],
      ['Ionescu Ana', 'Iași', ''],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')[1]).toEqual(['1', '2']);
  });

  it('reads the first sheet of an .xlsx: shared and inline strings, empty cells, dates, booleans', async () => {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Date" sheetId="1" r:id="rId7"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/data.xml"/></Relationships>');
    zip.file('xl/sharedStrings.xml', '<sst><si><t>Nume</t></si><si><t>Data</t></si><si><r><t>Pop</t></r><r><t>escu &amp; fiul</t></r></si></sst>');
    zip.file('xl/styles.xml', '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>');
    zip.file(
      'xl/worksheets/data.xml',
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Activ</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46023</v></c><c r="C2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    expect(await readXlsx(bytes)).toEqual([
      ['Nume', 'Data', '', 'Activ'],
      ['Popescu & fiul', '01.01.2026', '12.5', 'TRUE'],
    ]);
    const t = await readTable('date.xlsx', bytes);
    expect(t.headers).toEqual(['Nume', 'Data', 'Column 3', 'Activ']);
    expect(t.rows[0].Nume).toBe('Popescu & fiul');
  });

  it('matches columns to fields ignoring case, spaces and diacritics; builds safe file names', () => {
    expect(matchColumns(['Nume', 'Oras', 'Data_nasterii', 'Altceva'], ['NUME', 'Oraș', 'Data nașterii'])).toEqual({ Nume: 'NUME', Oras: 'Oraș', Data_nasterii: 'Data nașterii', Altceva: '' });
    expect(fileNameFor('Adeverință {Nume} {#}', { Nume: 'Pop/Ion: "A"' }, 2)).toBe('Adeverință Pop_Ion_ _A_ 3.pdf');
    expect(fileNameFor('{Lipsa}', {}, 0)).toBe('document 1.pdf');
  });
});

describe('mail merge: filling', () => {
  it('fills text, checkbox, dropdown and radio fields with Romanian text; reports bad choices', async () => {
    const tpl = await formPdf();
    expect(await formFieldNames(tpl)).toEqual(['Nume', 'Oras', 'Angajat', 'Departament', 'Tip']);
    const mapping = { Nume: 'Nume', Oras: 'Oraș', Angajat: 'Angajat', Departament: 'Dept', Tip: 'Tip' };
    const r = await mergeRow(tpl, { Nume: 'Ștefan Țurcanu', Oraș: 'Brașov', Angajat: 'da', Dept: 'vanzari', Tip: 'Pe durată' }, { mapping, flatten: false, loadFont });
    expect(r.problems).toEqual(['Tip: “Pe durată” is not one of the choices']);
    const form = (await PDFDocument.load(r.bytes)).getForm();
    expect(form.getTextField('Nume').getText()).toBe('Ștefan Țurcanu');
    expect(form.getCheckBox('Angajat').isChecked()).toBe(true);
    expect(form.getDropdown('Departament').getSelected()).toEqual(['Vânzări']);
    // Burned into the page, the diacritics survive (Unicode font).
    const flat = await mergeRow(tpl, { Nume: 'Ștefan Țurcanu', Oraș: 'Brașov' }, { mapping, flatten: true, loadFont });
    const [text] = await pageTexts(flat.bytes);
    expect(text).toContain('Ștefan Țurcanu');
    expect(text).toContain('Brașov');
  });

  it('flattened rows combine into one PDF, one copy of the form per row', async () => {
    const tpl = await formPdf();
    const mapping = { Nume: 'Nume', Oras: '', Angajat: '', Departament: '', Tip: '' };
    const parts = [];
    for (const Nume of ['Ana', 'Bogdan', 'Cristina']) parts.push((await mergeRow(tpl, { Nume }, { mapping, flatten: true, loadFont })).bytes);
    expect((await PDFDocument.load(parts[0])).getForm().getFields()).toHaveLength(0);
    const all = await combineMerged(parts);
    const texts = await pageTexts(all);
    expect(texts).toHaveLength(3);
    expect(texts.map((t) => /Ana|Bogdan|Cristina/.exec(t)?.[0])).toEqual(['Ana', 'Bogdan', 'Cristina']);
  });
});

describe('action sequences', () => {
  const sample = async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 2; i++) d.addPage([595, 842]).drawText(`Pagina ${i}`, { x: 60, y: 760, size: 18, font: f });
    return d.save();
  };
  const ctx = { fileName: 'raport.pdf', loadFont };

  it('checks the order of the steps and names the results', () => {
    expect(sequenceProblem([])).toMatch(/at least one step/);
    expect(sequenceProblem([{ kind: 'protect', userPassword: 'x' }, { kind: 'flatten' }])).toMatch(/must be the last step/);
    expect(sequenceProblem([{ kind: 'pdfa' }, { kind: 'watermark', text: 'X' }])).toMatch(/PDF\/A/);
    expect(sequenceProblem([{ kind: 'pdfa' }, { kind: 'protect', userPassword: 'x' }])).toMatch(/forbids encryption/);
    expect(sequenceProblem([{ kind: 'protect', userPassword: '' }])).toMatch(/password/);
    expect(sequenceSuffix('Scanări → Arhivă 2026')).toBe('-scanari-arhiva-2026');
    expect(sequenceSuffix('  ')).toBe('-processed');
  });

  it('runs watermark, page numbers, compress (nothing to gain: noted) and protect in order', async () => {
    const steps: BatchOp[] = [
      { kind: 'watermark', text: 'CIORNĂ' },
      { kind: 'pageNumbers', format: 'Pagina {page} din {pages}' },
      { kind: 'compress', level: 'balanced' },
      { kind: 'protect', userPassword: 'secret' },
    ];
    const r = await runSequence(await sample(), steps, ctx);
    expect(r.note).toMatch(/Compress.*no smaller version/);
    expect(isPdfEncrypted(r.bytes)).toBe(true);
    const texts = await pageTexts(r.bytes, 'secret');
    expect(texts[0]).toContain('CIORNĂ');
    expect(texts[1]).toContain('Pagina 2 din 2');
  });

  it('refuses an invalid sequence and a protected input', async () => {
    await expect(runSequence(await sample(), [{ kind: 'protect', userPassword: 'x' }, { kind: 'flatten' }], ctx)).rejects.toThrow(/last step/);
    const locked = (await runSequence(await sample(), [{ kind: 'protect', userPassword: 'x' }], ctx)).bytes;
    await expect(runSequence(locked, [{ kind: 'flatten' }], ctx)).rejects.toThrow(/password-protected/);
  });
});
