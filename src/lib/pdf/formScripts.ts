/** Smart-field logic in the PDF: field /AA actions (K, F, V, C) and the AcroForm calculation order. */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, PDFTextField, type PDFField } from 'pdf-lib';
import { acrobatScripts, calcOrder, parseScripts, type FieldLogic } from '@/lib/formLogic';

function jsText(doc: PDFDocument, v: unknown): string {
  const a = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (!(a instanceof PDFDict)) return '';
  const js = a.lookup(PDFName.of('JS'));
  if (js instanceof PDFString || js instanceof PDFHexString) return js.decodeText();
  if (js instanceof PDFStream) {
    const raw = (js as unknown as { getContents?: () => Uint8Array; contents?: Uint8Array }).contents;
    return raw ? new TextDecoder('latin1').decode(raw) : '';
  }
  return '';
}

/** Logic of every text field that has format / validate / calculate actions. */
export function readFieldLogic(doc: PDFDocument): Record<string, FieldLogic> {
  const out: Record<string, FieldLogic> = {};
  let fields: PDFField[] = [];
  try {
    fields = doc.getForm().getFields();
  } catch {
    return out;
  }
  for (const f of fields) {
    if (!(f instanceof PDFTextField)) continue;
    const aa = f.acroField.dict.lookup(PDFName.of('AA'));
    if (!(aa instanceof PDFDict)) continue;
    const logic = parseScripts({ F: jsText(doc, aa.get(PDFName.of('F'))), V: jsText(doc, aa.get(PDFName.of('V'))), C: jsText(doc, aa.get(PDFName.of('C'))) });
    if (logic.format || logic.range || logic.calc) out[f.getName()] = logic;
  }
  return out;
}

/** Writes the actions of one field (replacing K, F, V, C). */
export function writeFieldLogic(doc: PDFDocument, field: PDFField, logic: FieldLogic, names: string[]): void {
  const js = acrobatScripts(logic, names);
  const entries: Record<string, PDFRef> = {};
  for (const [k, code] of Object.entries(js)) {
    if (!code) continue;
    entries[k] = doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFHexString.fromText(code) }));
  }
  if (!Object.keys(entries).length) return;
  field.acroField.dict.set(PDFName.of('AA'), doc.context.obj(entries));
}

/** AcroForm /CO: calculated fields in dependency order (totals after their parts). */
export function writeCalcOrder(doc: PDFDocument, logic: Record<string, FieldLogic>): void {
  const order = calcOrder(logic);
  if (!order.length) return;
  const form = doc.getForm();
  const refs = order.map((n) => {
    try {
      return form.getField(n).acroField.ref;
    } catch {
      return null;
    }
  });
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro instanceof PDFDict) acro.set(PDFName.of('CO'), doc.context.obj(refs.filter((r): r is PDFRef => !!r)) as PDFArray);
}
