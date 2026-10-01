/** XFA forms for tests: a dynamic one (pages laid out from the template) and a static one with AcroForm twins. */
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

export const XFA_TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb" locale="en_US" restoreState="auto">
<pageSet>
<pageArea name="Page1" id="Page1">
<contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/>
<medium stock="letter" short="8.5in" long="11in"/>
</pageArea>
</pageSet>
<subform name="Main" w="7.5in" layout="tb">
<draw name="Title" w="7.5in" h="0.5in"><value><text>Order form</text></value><font typeface="Helvetica" size="16pt" weight="bold"/></draw>
<field name="Name" w="5in" h="0.35in"><ui><textEdit/></ui><font typeface="Helvetica" size="10pt"/><caption reserve="1.5in"><value><text>Customer name</text></value></caption><border><edge/></border></field>
<field name="Qty" w="3in" h="0.35in"><ui><numericEdit/></ui><font typeface="Helvetica" size="10pt"/><caption reserve="1.5in"><value><text>Quantity</text></value></caption><border><edge/></border></field>
<field name="Express" w="3in" h="0.3in"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items><font typeface="Helvetica" size="10pt"/><caption placement="right" reserve="2.5in"><value><text>Express delivery</text></value></caption></field>
<field name="Country" w="5in" h="0.35in"><ui><choiceList open="onEntry"/></ui><items><text>Romania</text><text>Germany</text></items><font typeface="Helvetica" size="10pt"/><caption reserve="1.5in"><value><text>Country</text></value></caption><border><edge/></border></field>
<field name="Notes" w="7in" h="1in"><ui><textEdit multiLine="1"/></ui><font typeface="Helvetica" size="10pt"/><caption placement="top" reserve="0.25in"><value><text>Notes</text></value></caption><border><edge/></border></field>
</subform>
</subform>
</template>`;

export const XFA_DATASETS = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Main><Name>Ana Pop</Name><Qty>2</Qty><Express>1</Express><Country>Germany</Country><Notes></Notes></Main></form1></xfa:data></xfa:datasets>`;

function setXfa(doc: PDFDocument, packets: Array<[string, string]>, dynamic: boolean, fields: unknown[] = []) {
  const arr: unknown[] = [];
  const pre = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">';
  arr.push(PDFString.of('preamble'), doc.context.register(doc.context.stream(pre)));
  for (const [name, xml] of packets) arr.push(PDFString.of(name), doc.context.register(doc.context.stream(xml)));
  arr.push(PDFString.of('postamble'), doc.context.register(doc.context.stream('</xdp:xdp>')));
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro) (acro as unknown as { set(k: PDFName, v: unknown): void }).set(PDFName.of('XFA'), doc.context.obj(arr as never));
  else doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: fields as never, XFA: arr as never }));
  if (dynamic) doc.catalog.set(PDFName.of('NeedsRendering'), doc.context.obj(true));
}

/** Dynamic XFA: one "please wait" page; the real pages come from the template. */
export async function dynamicXfaPdf(datasets = XFA_DATASETS): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Please wait... If this message is not replaced, your viewer cannot show XFA forms.', { x: 40, y: 700, size: 11, font });
  setXfa(doc, [['config', '<config xmlns="http://www.xfa.org/schema/xci/3.1/"><present><pdf><version>1.7</version></pdf></present></config>'], ['template', XFA_TEMPLATE], ['datasets', datasets]], true);
  return doc.save();
}

/** Static XFA: AcroForm fields named like the XFA form (form1[0].Main[0].Name[0]) plus template and datasets. */
export async function staticXfaPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField('form1[0].Main[0].Name[0]');
  name.setText('Ana Pop');
  name.addToPage(page, { x: 150, y: 700, width: 250, height: 22 });
  const qty = form.createTextField('form1[0].Main[0].Qty[0]');
  qty.setText('2');
  qty.addToPage(page, { x: 150, y: 670, width: 100, height: 22 });
  const ex = form.createCheckBox('form1[0].Main[0].Express[0]');
  ex.addToPage(page, { x: 150, y: 640, width: 14, height: 14 });
  ex.check();
  const c = form.createDropdown('form1[0].Main[0].Country[0]');
  c.addOptions(['Romania', 'Germany']);
  c.select('Germany');
  c.addToPage(page, { x: 150, y: 610, width: 150, height: 22 });
  form.createTextField('form1[0].Main[0].Notes[0]').addToPage(page, { x: 150, y: 500, width: 300, height: 80 });
  form.updateFieldAppearances();
  setXfa(doc, [['template', XFA_TEMPLATE], ['datasets', XFA_DATASETS]], false);
  // Saving with appearance updates would let pdf-lib drop the XFA again.
  return doc.save({ updateFieldAppearances: false });
}
