import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { checkEInvoice, detectEInvoice, parseEInvoice, pickInvoiceXml } from '@/lib/einvoice/parse';
import { renderEInvoice } from '@/lib/einvoice/render';
import { facturXLevel, findEmbeddedInvoice, makeHybridInvoice } from '@/lib/einvoice/facturx';
import { createPortfolio, readPortfolio } from '@/lib/pdf/portfolio';
import { buildTocPdf, tocPageCount } from '@/lib/pdf/tocPage';
import type { FontVariant } from '@/lib/fonts';
import { EFACTURA_UBL, FACTURX_CII } from './helpers/einvoices';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const fam = v.family === 'sans' ? 'noto-sans' : v.family === 'serif' ? 'noto-serif' : 'noto-sans-mono';
  const base = v.family === 'sans' ? 'NotoSans' : v.family === 'serif' ? 'NotoSerif' : 'NotoSansMono';
  const weight = v.bold ? '700Bold' : '400Regular';
  const italic = v.italic && v.family !== 'mono' ? '_Italic' : '';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, fam, `${weight}${italic}`, `${base}_${weight}${italic}.ttf`))));
};
const textOf = async (bytes: Uint8Array) => {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' '));
  await doc.loadingTask.destroy();
  return out.join('\n');
};

describe('electronic invoices', () => {
  it('reads a Romanian e-Factura (UBL, CIUS-RO)', () => {
    expect(detectEInvoice(EFACTURA_UBL)).toBe('UBL');
    const inv = parseEInvoice(EFACTURA_UBL);
    expect(inv).toMatchObject({ syntax: 'UBL', kind: 'invoice', number: 'ADK-2026-0042', issueDate: '2026-09-15', dueDate: '2026-10-15', currency: 'RON', orderReference: 'PO-7781' });
    expect(inv.customization).toContain('CIUS-RO');
    expect(inv.seller).toMatchObject({ name: 'Adika Software SRL', vatId: 'RO12345678', companyId: 'J12/3456/2020', email: 'facturi@adika.example' });
    expect(inv.seller.address).toEqual({ street: 'Str. Memorandumului 28', city: 'Cluj-Napoca', postalCode: '400114', region: 'RO-CJ', country: 'RO' });
    expect(inv.buyer.name).toBe('Tipografia Moldova SA');
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ name: 'Adika PDF Editor – licență', quantity: 3, unit: 'H87', unitPrice: 500, vatPercent: 19, net: 1500 });
    expect(inv.vat).toEqual([{ category: 'S', percent: 19, taxable: 2100, amount: 399, exemption: '' }]);
    expect(inv.totals).toMatchObject({ taxExclusive: 2100, tax: 399, taxInclusive: 2499, payable: 2499 });
    expect(inv.payment).toMatchObject({ meansCode: '42', iban: 'RO49AAAA1B31007593840000', terms: 'Plata în 30 de zile.' });
    expect(checkEInvoice(inv)).toEqual([]);
  });

  it('reads a Factur-X / ZUGFeRD invoice (CII)', () => {
    expect(detectEInvoice(FACTURX_CII)).toBe('CII');
    const inv = parseEInvoice(FACTURX_CII);
    expect(inv).toMatchObject({ syntax: 'CII', number: 'RE-2026-100', issueDate: '2026-09-20', dueDate: '2026-10-20', currency: 'EUR', buyerReference: '04011000-12345-34' });
    expect(inv.seller).toMatchObject({ name: 'Papier Müller GmbH', vatId: 'DE123456789' });
    expect(inv.lines[0]).toMatchObject({ name: 'Druckerpapier A4', quantity: 20, unitPrice: 4.5, net: 90 });
    expect(inv.totals).toMatchObject({ tax: 17.1, payable: 107.1 });
    expect(checkEInvoice(inv)).toEqual([]);
    expect(facturXLevel(FACTURX_CII)).toBe('EN 16931');
  });

  it('finds sums that do not add up', () => {
    const inv = parseEInvoice(EFACTURA_UBL.replace('<cbc:PayableAmount currencyID="RON">2499.00', '<cbc:PayableAmount currencyID="RON">2500.00'));
    expect(checkEInvoice(inv)).toEqual(['The amount due should be 2499.00, the invoice says 2500.00.']);
    expect(pickInvoiceXml(['semnatura_4123.xml', '4123.xml'])).toBe('4123.xml');
  });

  it('renders a readable PDF with the XML attached', async () => {
    const inv = parseEInvoice(EFACTURA_UBL);
    const bytes = await renderEInvoice(inv, { loadFont, locale: 'ro-RO', xml: { name: 'ADK-2026-0042.xml', bytes: new TextEncoder().encode(EFACTURA_UBL) } });
    const text = await textOf(bytes);
    for (const s of ['INVOICE', 'ADK-2026-0042', 'Adika Software SRL', 'RO12345678', 'Tipografia Moldova SA', 'Adika PDF Editor – licență', '1.500,00', '2.499,00', 'RO49 AAAA 1B31 0075 9384 0000', 'Plata în 30 de zile.']) expect(text).toContain(s);
    // The attached XML is found again as the invoice.
    const found = await findEmbeddedInvoice(bytes);
    expect(found?.name).toBe('ADK-2026-0042.xml');
    expect(parseEInvoice(found!.xml).number).toBe('ADK-2026-0042');
  });

  it('makes a Factur-X PDF/A-3 with factur-x.xml and its metadata', async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([595, 842]).drawText('Rechnung RE-2026-100', { x: 50, y: 780, size: 14, font: f });
    const r = await makeHybridInvoice(await d.save(), FACTURX_CII);
    expect(r.kind).toBe('Factur-X');
    expect(r.level).toBe('EN 16931');
    const found = await findEmbeddedInvoice(r.bytes);
    expect(found?.name).toBe('factur-x.xml');
    const doc = await PDFDocument.load(r.bytes);
    const meta = doc.catalog.lookup(PDFName.of('Metadata')) as unknown as { getContents(): Uint8Array };
    const xmp = new TextDecoder().decode(meta.getContents());
    expect(xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(xmp).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(xmp).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(String(doc.catalog.lookup(PDFName.of('AF')))).toMatch(/\d+ 0 R/);
  });
});

describe('portfolios and contents pages', () => {
  it('a PDF Portfolio carries files with descriptions and lists them on its cover', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const files = [
      { name: 'contract.pdf', bytes: await pdf.save(), description: 'Signed contract', modified: new Date(Date.UTC(2026, 8, 1)) },
      { name: 'oferta.xlsx', bytes: new Uint8Array([80, 75, 3, 4, 1, 2, 3]), description: 'Price list' },
    ];
    const bytes = await createPortfolio(files, { title: 'Dosar client', loadFont });
    const doc = await PDFDocument.load(bytes);
    expect(String(doc.catalog.lookup(PDFName.of('Collection')))).toContain('/Collection');
    const entries = await readPortfolio(bytes);
    expect(entries?.map((e) => [e.name, e.description, e.size])).toEqual([
      ['contract.pdf', 'Signed contract', files[0].bytes.length],
      ['oferta.xlsx', 'Price list', 7],
    ]);
    expect(entries?.[0].modified?.toISOString().slice(0, 10)).toBe('2026-09-01');
    const text = await textOf(bytes);
    expect(text).toContain('Dosar client');
    expect(text).toContain('contract.pdf');
    expect(await readPortfolio(files[0].bytes)).toBeNull();
  });

  it('a contents page lists the bookmarks with the page numbers they will have', async () => {
    const entries = [
      { title: 'Introduction', level: 0, target: 0 },
      { title: 'Background', level: 1, target: 1 },
      { title: 'Results', level: 0, target: 4 },
      { title: 'Too deep', level: 3, target: 5 },
    ];
    const r = await buildTocPdf(entries, { title: 'Contents', loadFont });
    expect(r.pageCount).toBe(1);
    expect(r.links.map((l) => l.entry)).toEqual([0, 1, 2]);
    const text = await textOf(r.bytes);
    expect(text).toContain('Contents');
    expect(text).toMatch(/Introduction[ .]*2/);
    expect(text).toMatch(/Results[ .]*6/);
    expect(text).not.toContain('Too deep');
    expect(tocPageCount(39, 842)).toBe(1);
    expect(tocPageCount(40, 842)).toBe(2);
    expect(tocPageCount(200, 842)).toBe(5);
  });
});
