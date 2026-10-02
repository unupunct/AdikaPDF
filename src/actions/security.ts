/** Password protection, permissions, metadata sanitising and form-data export. */
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, primarySourceBytes, saveDerived, suggestedName, withBusy } from './document';
import { encryptPdf, type PdfPermissions } from '@/lib/crypto/encrypt';
import { saveBytes } from '@/lib/platform';
import type { FieldLogic } from '@/lib/formLogic';

export async function protectDocument(userPassword: string, ownerPassword: string, permissions: PdfPermissions): Promise<void> {
  const out = await withBusy('Encrypting with AES-256…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    return encryptPdf(bytes, { userPassword, ownerPassword, permissions });
  });
  if (out) await saveDerived(out, '-protected', false);
}

export async function sanitizeDocument(): Promise<void> {
  const out = await withBusy('Removing hidden data…', async (progress) => {
    const bytes = await exportCurrentPdf({}, progress);
    const { sanitizeBytes } = await import('@/lib/batch');
    return sanitizeBytes(bytes);
  });
  if (out) await saveDerived(out, '-sanitized', true);
}

export interface FormFieldInfo {
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button' | 'other';
  value: string | boolean | string[];
  options: string[];
  readOnly: boolean;
  multiline: boolean;
  required: boolean;
  /** Format / range / calculation read from the field's Acrobat actions. */
  logic?: FieldLogic;
  /** What people call the field: its tooltip, or the last part of an XFA-style name. */
  label?: string;
}


/** Existing AcroForm fields of a PDF (for the fill-in panel and CSV export). */
export async function readFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return [];
  }
  const out: FormFieldInfo[] = [];
  const { fieldLabel, readFieldLogic } = await import('@/lib/pdf/formScripts');
  const logic = readFieldLogic(doc);
  for (const f of doc.getForm().getFields()) {
    const base = { name: f.getName(), readOnly: f.isReadOnly(), options: [] as string[], multiline: false, required: f.isRequired(), logic: logic[f.getName()], label: fieldLabel(f.getName(), f.acroField.dict.lookup(PDFName.of('TU'))) };
    if (f instanceof PDFTextField) out.push({ ...base, kind: 'text', value: f.getText() ?? '', multiline: f.isMultiline() });
    else if (f instanceof PDFCheckBox) out.push({ ...base, kind: 'checkbox', value: f.isChecked() });
    else if (f instanceof PDFRadioGroup) out.push({ ...base, kind: 'radio', value: f.getSelected() ?? '', options: f.getOptions() });
    else if (f instanceof PDFDropdown) out.push({ ...base, kind: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() });
    else if (f instanceof PDFOptionList) out.push({ ...base, kind: 'list', value: f.getSelected(), options: f.getOptions() });
    else if (f.constructor.name === 'PDFSignature') out.push({ ...base, kind: 'signature', value: '' });
    else out.push({ ...base, kind: f.constructor.name === 'PDFButton' ? 'button' : 'other', value: '' });
  }
  return out;
}

function csvCell(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function fieldsToCsv(fields: FormFieldInfo[]): string {
  const data = fields.filter((f) => f.kind !== 'button' && f.kind !== 'signature');
  const header = data.map((f) => csvCell(f.name)).join(',');
  const row = data.map((f) => csvCell(Array.isArray(f.value) ? f.value.join('; ') : typeof f.value === 'boolean' ? (f.value ? 'Yes' : 'No') : f.value)).join(',');
  // BOM so Excel opens UTF-8 (diacritics) correctly.
  return `﻿${header}\r\n${row}\r\n`;
}

/** Exports the (filled) form values of the current document as CSV. */
export async function exportFormCsv(): Promise<void> {
  const s = usePDFStore.getState();
  // Always from the edited document: filled values live in the editor model.
  const bytes = s.readOnlyReason ? primarySourceBytes() : await withBusy('Collecting form data…', (p) => exportCurrentPdf({}, p));
  if (!bytes) return;
  const fields = await readFormFields(bytes);
  if (fields.length === 0) {
    s.toast('This document has no form fields.', 'info');
    return;
  }
  const csv = new TextEncoder().encode(fieldsToCsv(fields));
  const path = await saveBytes(csv, suggestedName('-form-data').replace(/\.pdf$/, '.csv'), [{ name: 'CSV', extensions: ['csv'] }]);
  if (path) s.toast(`Exported ${fields.length} fields.`, 'success');
}

/** Batch extraction: one CSV row per selected PDF (collect submitted forms). */
export async function batchExtractFormCsv(files: Array<{ name: string; bytes: Uint8Array }>): Promise<void> {
  const rows: Array<{ file: string; fields: FormFieldInfo[] }> = [];
  for (const f of files) rows.push({ file: f.name, fields: await readFormFields(f.bytes) });
  const names = [...new Set(rows.flatMap((r) => r.fields.filter((x) => x.kind !== 'button' && x.kind !== 'signature').map((x) => x.name)))];
  const lines = [['File', ...names].map(csvCell).join(',')];
  for (const r of rows) {
    const byName = new Map(r.fields.map((x) => [x.name, x]));
    lines.push(
      [r.file, ...names.map((n) => {
        const v = byName.get(n)?.value;
        return v === undefined ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v;
      })]
        .map(csvCell)
        .join(','),
    );
  }
  const csv = new TextEncoder().encode(`﻿${lines.join('\r\n')}\r\n`);
  const path = await saveBytes(csv, 'form-responses.csv', [{ name: 'CSV', extensions: ['csv'] }]);
  if (path) usePDFStore.getState().toast(`Extracted ${rows.length} forms.`, 'success');
}
