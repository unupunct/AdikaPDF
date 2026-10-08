/**
 * Mail merge: a PDF form filled once for every row of a table (CSV or
 * Excel), giving one PDF per row or one combined PDF. Columns are matched
 * to form fields by name (case, spaces and diacritics ignored).
 */
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import type { FontVariant } from './fonts';

export interface DataTable {
  headers: string[];
  rows: Record<string, string>[];
}

// ---------------------------------------------------------------- reading

/** RFC 4180 CSV; the delimiter (, ; tab) is guessed from the first line. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.replace(/"[^"]*"/g, '').split(ch).length - 1;
  const delim = [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** Text of every <t> in an XML fragment (shared / inline strings, rich text runs). */
const runsText = (xml: string) => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => xmlText(m[1])).join('');

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A stored number as Excel shows it: with the format's decimals, else at 15
 * significant digits (12.300000000000001 -> 12.3). Pure; exported for tests.
 */
export function excelNumber(n: number, decimals?: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (decimals !== undefined) return n.toFixed(decimals);
  return String(Number(n.toPrecision(15)));
}

/** Excel serial date -> dd.mm.yyyy. */
function excelDate(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400e3));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** The first worksheet of an .xlsx file as rows of text. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const zip = await JSZip.loadAsync(bytes);
  const read = (p: string) => zip.file(p)?.async('string') ?? Promise.resolve(null);
  const shared = ((await read('xl/sharedStrings.xml')) ?? '').match(/<(?:\w+:)?si>[\s\S]*?<\/(?:\w+:)?si>/g)?.map(runsText) ?? [];
  // The first sheet, in workbook order.
  const workbook = (await read('xl/workbook.xml')) ?? '';
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const rid = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] : undefined;
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = (await read(path)) ?? (await read('xl/worksheets/sheet1.xml'));
  if (!sheet) throw new Error('The workbook has no worksheet.');
  // Date formats: cell styles whose number format is a date.
  const styles = (await read('xl/styles.xml')) ?? '';
  const customDates = new Set([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].filter((m) => /[dy]/i.test(m[2].replace(/\[[^\]]*\]|"[^"]*"/g, ''))).map((m) => Number(m[1])));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const xfIds = [...xfs.matchAll(/<xf\b[^>]*?(?:numFmtId="(\d+)")?[^>]*\/?>/g)].map((m) => Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0));
  const dateStyles = xfIds.map((id) => (id >= 14 && id <= 22) || customDates.has(id));
  // Fixed decimals of plain number formats ("0.00", "#,##0.000"), as Excel shows the value.
  const customCodes = new Map([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]));
  const decimalStyles = xfIds.map((id) => {
    if (id === 1 || id === 3) return 0;
    if (id === 2 || id === 4) return 2;
    const code = customCodes.get(id)?.split(';')[0];
    const m = code && /^[#,0]*0(?:\.(0+))?$/.exec(code);
    return m ? (m[1]?.length ?? 0) : undefined;
  });
  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = runsText(inner);
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        const numeric = (type === undefined || type === 'n') && /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v);
        if (numeric && dateStyles[style] && Number(v) >= 0) text = excelDate(Number(v));
        else if (numeric) text = excelNumber(Number(v), decimalStyles[style]);
        else text = xmlText(v);
      }
      row[ref ? columnIndex(ref) : row.length] = text;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** A CSV or .xlsx file as a header row plus records. */
export async function readTable(fileName: string, bytes: Uint8Array): Promise<DataTable> {
  const grid = /\.xlsx$/i.test(fileName) ? await readXlsx(bytes) : parseCsv(new TextDecoder('utf-8').decode(bytes));
  if (grid.length < 2) throw new Error('The table needs a header row and at least one data row.');
  const headers = grid[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, rows };
}

// ---------------------------------------------------------------- matching

const key = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Field name -> column (or '' for none), matched by name. */
export function matchColumns(fields: string[], headers: string[]): Record<string, string> {
  const byKey = new Map(headers.map((h) => [key(h), h]));
  return Object.fromEntries(fields.map((f) => [f, byKey.get(key(f)) ?? byKey.get(key(f.split('.').pop() ?? f)) ?? '']));
}

/** "Contract {Nume} {#}" -> "Contract Popescu 3" (file-name safe). */
export function fileNameFor(pattern: string, row: Record<string, string>, index: number): string {
  const byKey = new Map(Object.entries(row).map(([k, v]) => [key(k), v]));
  const name = pattern
    .replace(/\{#\}/g, String(index + 1))
    .replace(/\{([^{}]+)\}/g, (_, col: string) => byKey.get(key(col)) ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${name || `document ${index + 1}`}.pdf`;
}

// ---------------------------------------------------------------- filling

/** Names of the fillable fields of a PDF (signature fields and buttons excluded). */
export async function formFieldNames(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return doc
    .getForm()
    .getFields()
    .filter((f) => f instanceof PDFTextField || f instanceof PDFCheckBox || f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList)
    .map((f) => f.getName());
}

const TRUE_WORDS = new Set(['1', 'x', 'true', 'yes', 'y', 'da', 'on', 'checked', 'ja', 'oui', 'si', 'adevarat', '✓', '✔']);

function pickOption(options: string[], value: string): string | undefined {
  return options.find((o) => o === value) ?? options.find((o) => key(o) === key(value));
}

/** Fills the fields; values that do not fit a field are reported. */
export function fillFields(doc: PDFDocument, values: Record<string, string>, font: PDFFont): string[] {
  const form = doc.getForm();
  const problems: string[] = [];
  for (const [fieldName, value] of Object.entries(values)) {
    let field;
    try {
      field = form.getField(fieldName);
    } catch {
      continue;
    }
    if (field instanceof PDFTextField) {
      const max = field.getMaxLength();
      field.setText(max !== undefined && value.length > max ? value.slice(0, max) : value);
    } else if (field instanceof PDFCheckBox) {
      if (TRUE_WORDS.has(key(value)) || TRUE_WORDS.has(value.trim().toLowerCase())) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (!value) {
        if (!(field instanceof PDFRadioGroup)) field.clear();
        continue;
      }
      const option = pickOption(field.getOptions(), value);
      if (option) field.select(option);
      else if (field instanceof PDFDropdown && field.isEditable()) field.select(value);
      else problems.push(`${fieldName}: “${value}” is not one of the choices`);
    }
  }
  form.updateFieldAppearances(font);
  return problems;
}

export interface MergeOptions {
  /** Field name -> column name ('' leaves the field as it is). */
  mapping: Record<string, string>;
  /** Burn the values into the pages (no longer editable). */
  flatten: boolean;
  loadFont: (v: FontVariant) => Promise<Uint8Array>;
}

/** The template filled with one row. */
export async function mergeRow(template: Uint8Array, row: Record<string, string>, opts: MergeOptions): Promise<{ bytes: Uint8Array; problems: string[] }> {
  const doc = await PDFDocument.load(template);
  doc.registerFontkit(fontkit);
  // A Unicode font, so values with ă â î ș ț (or any other script) display.
  const font = await doc.embedFont(await opts.loadFont({ family: 'sans', bold: false, italic: false }), { subset: opts.flatten });
  const values = Object.fromEntries(Object.entries(opts.mapping).filter(([, col]) => col).map(([field, col]) => [field, row[col] ?? '']));
  const problems = fillFields(doc, values, font);
  if (opts.flatten) {
    const { flattenDocument } = await import('./pdf/exportPdf');
    flattenDocument(doc, font);
  }
  return { bytes: await doc.save({ useObjectStreams: true }), problems };
}

/** All rows in one PDF, one copy of the (flattened) form after another. */
export async function combineMerged(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const p of parts) {
    const src = await PDFDocument.load(p);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save({ useObjectStreams: true });
}
