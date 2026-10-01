/** An Acrobat-style form whose logic is JavaScript (custom calculate / validate scripts, a document script). */
import { PDFArray, PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib';

export async function scriptedFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  const js = (code: string) => doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of(code) }));
  const field = (name: string, y: number, aa: Record<string, string> = {}) => {
    const f = form.createTextField(name);
    f.addToPage(page, { x: 120, y, width: 160, height: 22 });
    if (Object.keys(aa).length) {
      const dict = doc.context.obj({});
      for (const [k, code] of Object.entries(aa)) dict.set(PDFName.of(k), js(code));
      f.acroField.dict.set(PDFName.of('AA'), dict);
    }
    return f;
  };
  field('Qty', 760, { V: 'if (event.value !== "" && Number(event.value) > 100) { app.alert("At most 100 pieces."); event.rc = false; }' });
  field('Price', 720, { F: 'AFNumber_Format(2, 0, 0, 0, "", true);', K: 'AFNumber_Keystroke(2, 0, 0, 0, "", true);' });
  const total = field('Total', 680, { C: 'event.value = withVat(Number(this.getField("Qty").value) * Number(this.getField("Price").value));', F: 'AFNumber_Format(2, 0, 0, 0, "", true);' });
  field('Upper', 640, { K: 'if (event.willCommit) event.value = String(event.value).toUpperCase();' });
  const extra = form.createCheckBox('Express');
  extra.addToPage(page, { x: 120, y: 600, width: 16, height: 16 });
  field('Shipping', 560, { C: 'event.value = this.getField("Express").value === "Off" ? 0 : 25;' });
  // Calculation order and a document-level script the calculation uses.
  const acro = doc.catalog.lookup(PDFName.of('AcroForm')) as unknown as { set(k: PDFName, v: unknown): void };
  acro.set(PDFName.of('CO'), doc.context.obj([total.acroField.ref, form.getTextField('Shipping').acroField.ref] as PDFRef[]));
  const names = doc.context.obj({ JavaScript: doc.context.obj({ Names: doc.context.obj([PDFString.of('vat'), js('function withVat(n) { return Math.round(n * 1.19 * 100) / 100; }')]) as PDFArray }) });
  doc.catalog.set(PDFName.of('Names'), names);
  return doc.save();
}
