import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { FormScripting, hasFormScripts } from '@/lib/pdf/formSandbox';
import { scriptedFormPdf } from './helpers/scriptedForm';
import { loadTestSandbox } from './helpers/sandboxEnv';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const open = async (bytes: Uint8Array) => (await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy;

describe('form JavaScript in the sandbox', () => {
  it('runs calculate, validate, keystroke and format scripts and document functions', async () => {
    const doc = await open(await scriptedFormPdf());
    expect(await hasFormScripts(doc)).toBe(true);
    const started = await FormScripting.start(doc, loadTestSandbox);
    expect(started).not.toBeNull();
    const s = started!.scripting;

    s.commit('Qty', '3');
    const r = s.commit('Price', '10.5');
    expect(r.accepted).toBe(true);
    expect(r.updates.Price.formatted).toBe('10.50');
    // Total = withVat(3 * 10.5) from the document-level script, formatted.
    expect(r.updates.Total.value).toBe('37.49');
    expect(r.updates.Total.formatted).toBe('37.49');

    const bad = s.commit('Qty', '500');
    expect(bad.accepted).toBe(false);
    expect(bad.alerts).toEqual(['At most 100 pieces.']);

    expect(s.commit('Upper', 'cluj').updates.Upper.value).toBe('CLUJ');

    const ship = s.commit('Express', true);
    expect(ship.updates.Shipping.value).toBe('25');
    expect(s.commit('Express', false).updates.Shipping.value).toBe('0');
    s.destroy();
  });

  it('calculates fields the form forgot to list in its calculation order', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    const form = d.getForm();
    form.createTextField('A').addToPage(p, { x: 50, y: 700 });
    form.createTextField('B').addToPage(p, { x: 50, y: 650 });
    const sum = form.createTextField('Sum');
    sum.addToPage(p, { x: 50, y: 600 });
    sum.acroField.dict.set(PDFName.of('AA'), d.context.obj({ C: d.context.obj({ S: 'JavaScript', JS: PDFString.of('AFSimple_Calculate("SUM", new Array("A", "B"));') }) }));
    const doc = await open(await d.save());
    const s = (await FormScripting.start(doc, loadTestSandbox))!.scripting;
    s.commit('A', '2');
    expect(s.commit('B', '5').updates.Sum.value).toBe('7');
    s.destroy();
  });

  it('starts nothing for a form without scripts', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    d.getForm().createTextField('Name').addToPage(p, { x: 50, y: 700 });
    const doc = await open(await d.save());
    expect(await hasFormScripts(doc)).toBe(false);
    expect(await FormScripting.start(doc, loadTestSandbox)).toBeNull();
  });
});
