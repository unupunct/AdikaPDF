// E-invoices (e-Factura, Factur-X), portfolios and contents pages — included by suite.mjs.
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFArray, PDFDict, PDFDocument as PD, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { EFACTURA_UBL, FACTURX_CII } from '../helpers/einvoices.ts';

/** Names and contents of a PDF's embedded files (checked independently of the app's code). */
function embedded(doc) {
  const out = [];
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const visit = (n) => {
    if (!(n instanceof PDFDict)) return;
    const arr = n.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray)
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const spec = arr.lookup(i + 1);
        const ef = spec.lookup(PDFName.of('EF'));
        const s = ef.lookup(PDFName.of('F'));
        out.push({ name: arr.lookup(i).decodeText(), text: new TextDecoder().decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()) });
      }
    const kids = n.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i));
  };
  visit(names instanceof PDFDict ? names.lookup(PDFName.of('EmbeddedFiles')) : undefined);
  return out;
}

export function registerEInvoiceTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, pdfText } = ctx;
  const waitSaved = (re) => page.waitForFunction((src) => window.__adika.platform.e2eSavedFiles().some((f) => new RegExp(src).test(f)), re.source, { timeout: 60000 });

  test('an e-Factura XML and the ANAF ZIP open as a readable invoice with the XML attached', async () => {
    const xml = join(dir, '4123456789.xml');
    writeFileSync(xml, EFACTURA_UBL);
    await S((p) => window.__adika.document.openPdfPath(p), xml);
    await idle();
    await page.waitForSelector('[data-testid="page-1"] canvas', { timeout: 20000 });
    const name = await S(() => window.__adika.store.getState().fileName);
    assert(/ADK-2026-0042\.pdf$/.test(name), `file name (${name})`);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const saved = await savedFile(/ADK-2026-0042\.pdf$/);
    const text = (await pdfText(saved)).join(' ');
    assert(text.includes('Adika Software SRL') && text.includes('Tipografia Moldova SA') && text.includes('2,499.00'), `invoice text (${text.slice(0, 300)})`);
    const files = embedded(await PD.load(readFileSync(saved)));
    assert(files.some((f) => f.name === '4123456789.xml' && f.text.includes('ADK-2026-0042')), `attached XML (${files.map((f) => f.name)})`);
    // The ZIP from ANAF's SPV: invoice + signature.
    const zip = new JSZip();
    zip.file('4123456789.xml', EFACTURA_UBL);
    zip.file('semnatura_4123456789.xml', '<Signature/>');
    const zipPath = join(dir, '4123456789.zip');
    writeFileSync(zipPath, await zip.generateAsync({ type: 'uint8array' }));
    await open(zipPath);
    const n2 = await S(() => window.__adika.store.getState().fileName);
    assert(/ADK-2026-0042\.pdf$/.test(n2), `zip opened (${n2})`);
  });

  test('a PDF invoice and its CII XML become a Factur-X; its data shows in the E-invoice dialog', async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([595, 842]).drawText('Rechnung RE-2026-100', { x: 50, y: 780, size: 14, font: f });
    const pdf = join(dir, 'rechnung.pdf');
    writeFileSync(pdf, await d.save());
    const xml = join(dir, 'rechnung-cii.xml');
    writeFileSync(xml, FACTURX_CII);
    await open(pdf);
    await page.click('[data-testid="tab-convert"]');
    await page.click('[data-testid="btn-einvoice"]');
    await page.waitForSelector('[data-testid="einvoice-modal"]');
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), xml);
    await page.click('[data-testid="einvoice-embed"]');
    await waitSaved(/rechnung-facturx\.pdf$/);
    await idle();
    const saved = await savedFile(/rechnung-facturx\.pdf$/);
    const doc = await PD.load(readFileSync(saved));
    const files = embedded(doc);
    assert(files.some((x) => x.name === 'factur-x.xml' && x.text.includes('RE-2026-100')), `factur-x.xml (${files.map((x) => x.name)})`);
    const xmp = new TextDecoder().decode(doc.catalog.lookup(PDFName.of('Metadata')).getContents());
    assert(xmp.includes('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>') && xmp.includes('<pdfaid:part>3</pdfaid:part>'), 'Factur-X XMP');
    // The saved copy was reopened: the dialog shows the invoice.
    await page.click('[data-testid="tab-convert"]');
    await page.click('[data-testid="btn-einvoice"]');
    await page.waitForSelector('[data-testid="einvoice-due"]', { timeout: 20000 });
    const due = await page.textContent('[data-testid="einvoice-due"]');
    assert(due.includes('107.10') && due.includes('EUR'), `amount due (${due})`);
    await page.keyboard.press('Escape');
  });

  test('a PDF Portfolio carries files; opening it lists them', async () => {
    const a = join(dir, 'oferta.txt');
    writeFileSync(a, 'Oferta de pret');
    const b = join(dir, 'contract.pdf');
    const d = await PD.create();
    d.addPage();
    writeFileSync(b, await d.save());
    await S(() => window.__adika.store.getState().openModal('portfolio'));
    await page.waitForSelector('[data-testid="portfolio-modal"]');
    await S(([x, y]) => window.__adika.platform.e2eQueuePicks([x, y]), [a, b]);
    await page.click('[data-testid="portfolio-add"]');
    await page.waitForSelector('[data-testid="portfolio-modal"] input[aria-label="Description"]');
    await page.fill('[data-testid="portfolio-title"]', 'Dosar client');
    await page.fill('[data-testid="portfolio-modal"] input[aria-label="Description"] >> nth=0', 'Price offer');
    await page.click('[data-testid="portfolio-create"]');
    await idle();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="attachment-name"]').length === 2, null, { timeout: 20000 });
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const saved = await savedFile(/Dosar client\.pdf$/);
    const doc = await PD.load(readFileSync(saved));
    assert(doc.catalog.lookup(PDFName.of('Collection')) instanceof PDFDict, 'collection kept when saved');
    const files = embedded(doc);
    assert(files.map((x) => x.name).sort().join(',') === 'contract.pdf,oferta.txt', `files (${files.map((x) => x.name)})`);
  });

  test('a contents page is made from the bookmarks, with links', async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) d.addPage([595, 842]).drawText(`Chapter ${i}`, { x: 50, y: 780, size: 20, font: f });
    const p = join(dir, 'chapters.pdf');
    writeFileSync(p, await d.save());
    await open(p);
    await S(() => {
      const st = window.__adika.store.getState();
      const mk = (title, i) => ({ id: `b${i}`, title, pageId: st.pages[i].id, top: null, url: null, bold: false, italic: false, open: true, children: [] });
      st.commit(() => ({ outline: [mk('Introduction', 0), { ...mk('Methods', 1), children: [mk('Data', 2)] }] }));
    });
    await page.click('[data-testid="tab-organize"]');
    await page.click('[data-testid="btn-toc"]');
    await page.waitForFunction(() => window.__adika.store.getState().pages.length === 4, null, { timeout: 20000 });
    await idle();
    const st = await S(() => {
      const s = window.__adika.store.getState();
      return { pages: s.pages.length, links: s.objects.filter((o) => o.type === 'link' && o.pageId === s.pages[0].id).map((o) => s.pages.findIndex((x) => x.id === o.target.pageId)) };
    });
    assert(st.pages === 4, `pages (${st.pages})`);
    assert(JSON.stringify(st.links) === '[1,2,3]', `links to the chapter pages (${st.links})`);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const text = (await pdfText(await savedFile(/chapters\.pdf$/)))[0];
    assert(/Contents/.test(text) && /Introduction[ .]*2/.test(text) && /Data[ .]*4/.test(text), `contents text (${text})`);
  });
}
