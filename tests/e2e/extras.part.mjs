// Round 10 extras: scanned tables to Excel, redline compare, validation report, Tags panel — included by suite.mjs.
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument as PD, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';

export function registerExtrasTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, pdfText } = ctx;

  test('a scanned table becomes cells in Excel (OCR first, ruled lines from the scan)', async () => {
    // A "scan": a picture of a ruled 3 × 3 table, no text in the PDF.
    const c = createCanvas(1240, 1754);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#000';
    g.lineWidth = 4;
    const xs = [150, 500, 850, 1100];
    const ys = [300, 420, 540, 660];
    for (const x of xs) g.strokeRect(x, ys[0], 0, ys[3] - ys[0]);
    for (const y of ys) g.strokeRect(xs[0], y, xs[3] - xs[0], 0);
    g.beginPath();
    for (const x of xs) (g.moveTo(x, ys[0]), g.lineTo(x, ys[3]));
    for (const y of ys) (g.moveTo(xs[0], y), g.lineTo(xs[3], y));
    g.stroke();
    g.fillStyle = '#000';
    g.font = 'bold 52px Arial';
    const cells = [
      ['City', 'Orders', 'Total'],
      ['Cluj', '120', '4500'],
      ['Brasov', '75', '2900'],
    ];
    cells.forEach((row, r) => row.forEach((t, k) => g.fillText(t, xs[k] + 30, ys[r] + 80)));
    const png = c.toBuffer('image/png');
    const d = await PD.create();
    const img = await d.embedPng(png);
    d.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const path = join(dir, 'tabel-scanat.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await S(() => window.__adika.convert.exportAs({ format: 'xlsx', dpi: 150 }));
    await idle(240000);
    const xlsx = readFileSync(await savedFile(/tabel-scanat\.xlsx$/));
    const zip = await JSZip.loadAsync(xlsx);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const shared = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
    const all = sheet + shared;
    for (const w of ['City', 'Cluj', 'Brasov', '4500']) assert(all.includes(w), `"${w}" in the workbook`);
    // Cluj and 4500 are on the same row, in different cells.
    const rows = [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((m) => m[1]);
    const cellsIn = (r) => (r.match(/<c /g) ?? []).length;
    assert(rows.some((r) => cellsIn(r) >= 3), `a row with three cells (${rows.map(cellsIn)})`);
  });

  test('compare with a list of changes (redline)', async () => {
    const make = async (name, text) => {
      const d = await PD.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font: f });
      const p = join(dir, name);
      writeFileSync(p, await d.save());
      return p;
    };
    const oldPath = await make('contract-v1.pdf', 'Payment is due in 30 days after delivery.');
    const newPath = await make('contract-v2.pdf', 'Payment is due in 60 days after delivery.');
    await open(newPath);
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), oldPath);
    await S(() => window.__adika.pageTools.compareWithFile(true));
    await idle();
    await page.waitForFunction(() => /compared\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 30000 });
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const text = (await pdfText(await savedFile(/compared\.pdf$/)))[1];
    assert(/List of changes/.test(text) && /in\s+30\s+60\s+days/.test(text), `redline page (${text})`);
  });

  test('the signature checks are saved as a PDF report', async () => {
    const d = await PD.create();
    d.addPage([595, 842]);
    const path = join(dir, 'semnat.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-cert-sign"]');
    await page.click('text=Create self-signed ID');
    await page.fill('[data-testid="selfsigned-name"]', 'Maria Report');
    await page.click('[data-testid="selfsigned-create"]');
    await page.waitForSelector('[data-testid="identity-card"]', { timeout: 30000 });
    await page.click('[data-testid="cert-sign-now"]');
    await idle();
    await page.waitForFunction(() => /semnat-signed\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 30000 });
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-verify"]');
    await page.waitForSelector('[data-testid="verify-report"]', { timeout: 30000 });
    await page.click('[data-testid="verify-report"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /-validation\.pdf$/.test(f)), null, { timeout: 30000 });
    const text = (await pdfText(await savedFile(/-validation\.pdf$/))).join(' ');
    // The signer is whichever ID signed (an earlier test may have left one selected).
    assert(text.includes('Signature validation report') && text.includes('semnat-signed.pdf') && text.includes('The signed content has not changed.'), `report (${text.slice(0, 600)})`);
    await page.keyboard.press('Escape');
  });

  test('the Tags panel changes a tag type and alternate text', async () => {
    const doc = await PD.create();
    const pg = doc.addPage();
    const cx = doc.context;
    const rootRef = cx.nextRef();
    const docRef = cx.nextRef();
    const p = cx.register(cx.obj({ Type: 'StructElem', S: 'P', P: docRef, Pg: pg.ref, K: 0 }));
    const fig = cx.register(cx.obj({ Type: 'StructElem', S: 'Figure', P: docRef, Pg: pg.ref, K: 1 }));
    cx.assign(docRef, cx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: [p, fig] }));
    cx.assign(rootRef, cx.obj({ Type: 'StructTreeRoot', K: docRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
    doc.catalog.set(PDFName.of('MarkInfo'), cx.obj({ Marked: true }));
    const path = join(dir, 'etichete.pdf');
    writeFileSync(path, await doc.save());
    await open(path);
    await page.click('[data-testid="sidebar-tags"]');
    await page.waitForSelector('[data-testid="tag-row"][data-tag="P"]');
    await page.click('[data-testid="tag-row"][data-tag="P"]');
    await page.selectOption('select[aria-label="Tag type"]', 'H1');
    await idle();
    await page.waitForSelector('[data-testid="tag-row"][data-tag="H1"]');
    await page.click('[data-testid="tag-row"][data-tag="Figure"]');
    await page.fill('[data-testid="tag-alt"]', 'Company logo');
    await page.keyboard.press('Enter');
    await idle();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="tag-row"]')].some((r) => r.textContent.includes('Company logo')), null, { timeout: 15000 });
    await S(() => window.__adika.document.saveDocument(true));
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/etichete\.pdf$/)));
    const types = [];
    let alt = '';
    for (const [, o] of out.context.enumerateIndirectObjects()) {
      const s = o.lookup?.(PDFName.of('S'));
      if (o.lookup?.(PDFName.of('Type')) === PDFName.of('StructElem') && s) {
        types.push(s.decodeText());
        const a = o.lookup(PDFName.of('Alt'));
        if (a instanceof PDFHexString || a?.decodeText) alt = a.decodeText();
      }
    }
    assert(types.includes('H1') && !types.includes('P'), `tag types (${types})`);
    assert(alt === 'Company logo', `alternate text (${alt})`);
  });
}
