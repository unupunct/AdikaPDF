// Buttons and barcode fields, comment review, certificate encryption — included by suite.mjs.
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import jsQR from 'jsqr';
import { PDFArray, PDFDocument as PD, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';

export function registerForms2Tests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, drag, setTool, FONT_DATA, pfxPath } = ctx;
  const slash = (p) => p.split('\\').join('/');
  const waitSaved = (re) => page.waitForFunction((src) => window.__adika.platform.e2eSavedFiles().some((f) => new RegExp(src).test(f)), re.source, { timeout: 60000 });

  test('form buttons (e-mail, reset) and a QR barcode field made from the field values', async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([595, 842]).drawText('Comanda', { x: 50, y: 790, size: 18, font: f });
    const path = join(dir, 'comanda.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-forms"]');
    await page.click('[data-testid="tool-field-text"]');
    await drag(1, [50, 80], [250, 102]);
    await page.click('[data-testid="tool-field-button"]');
    await drag(1, [50, 130], [150, 156]);
    await page.click('[data-testid="tool-field-barcode"]');
    await drag(1, [300, 80], [420, 200]);
    await setTool('select');
    // Set them up through the properties panel.
    const objs = await S(() => window.__adika.store.getState().objects.filter((o) => o.type === 'field').map((o) => ({ id: o.id, kind: o.fieldKind, name: o.name })));
    const text = objs.find((o) => o.kind === 'text');
    const button = objs.find((o) => o.kind === 'button');
    const barcode = objs.find((o) => o.kind === 'barcode');
    assert(text && button && barcode, `fields (${JSON.stringify(objs)})`);
    await S((id) => window.__adika.store.getState().updateObject(id, { value: 'Ana Popescu' }), text.id);
    await S((id) => window.__adika.store.getState().select([id]), button.id);
    await page.waitForSelector('[data-testid="button-caption"]');
    await page.fill('[data-testid="button-caption"]', 'Trimite');
    await page.selectOption('select[aria-label="Button action"]', 'submit');
    await page.fill('[data-testid="button-email"]', 'office@example.com');
    await S((id) => window.__adika.store.getState().select([id]), barcode.id);
    await page.waitForSelector('[data-testid="barcode-template"]');
    await page.fill('[data-testid="barcode-template"]', `Client: {${text.name}}`);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const saved = await savedFile(/comanda\.pdf$/);
    const bytes = readFileSync(saved);
    const form = (await PD.load(bytes)).getForm();
    const a = String(form.getField(button.name).acroField.getWidgets()[0].dict.lookup(PDFName.of('A')));
    assert(/SubmitForm/.test(a) && /mailto:office@example\.com/.test(a), `submit action (${a})`);
    // The barcode reads back the field's value.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: FONT_DATA, verbosity: 0 }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 2.5 });
    const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp, canvas: null }).promise;
    const img = g.getImageData(0, 0, c.width, c.height);
    const code = jsQR(new Uint8ClampedArray(img.data), c.width, c.height);
    await doc.loadingTask.destroy();
    assert(code?.data === 'Client: Ana Popescu', `QR content (${code?.data})`);
  });

  test("review: a comment's status is saved as a review reply; reviewers' copies are merged", async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([400, 300]).drawText('Raport de revizuit', { x: 30, y: 250, size: 14, font: f });
    const base = await d.save();
    const withNote = async (src, author, text, x) => {
      const doc = await PD.load(src);
      const p = doc.getPage(0);
      const ref = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [x, 200, x + 20, 220], Contents: PDFHexString.fromText(text), T: PDFHexString.fromText(author), NM: PDFString.of(`nm-${author}`), F: 4 }));
      const arr = p.node.lookup(PDFName.of('Annots'));
      if (arr instanceof PDFArray) arr.push(ref);
      else p.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
      return doc.save();
    };
    const path = join(dir, 'revizuire.pdf');
    writeFileSync(path, await withNote(base, 'Ana', 'Verifică cifrele', 40));
    const copy = join(dir, 'revizuire-dan.pdf');
    writeFileSync(copy, await withNote(base, 'Dan', 'Adaugă sursa', 120));
    await open(path);
    await S(() => window.__adika.store.setState({ sidebarOpen: true, sidebarTab: 'comments' }));
    await page.waitForSelector('[data-testid="comment-row"]');
    await page.selectOption('[data-testid="comment-set-status"]', 'Accepted');
    await page.waitForFunction(() => document.querySelector('[data-testid="comment-row"]')?.getAttribute('data-status') === 'Accepted', null, { timeout: 20000 });
    const rows = await page.$$('[data-testid="comment-row"]');
    assert(rows.length === 1, `the status is not a comment of its own (${rows.length} rows)`);
    await page.selectOption('[data-testid="comments-status-filter"]', 'open');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-row"]').length === 0, null, { timeout: 5000 });
    await page.selectOption('[data-testid="comments-status-filter"]', 'all');
    // Merge Dan's copy.
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), slash(copy));
    await page.click('[data-testid="comments-merge"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-row"]').length === 2, null, { timeout: 20000 });
    const texts = await page.$$eval('[data-testid="comment-row"]', (els) => els.map((e) => e.textContent));
    assert(texts.some((t) => /Dan/.test(t) && /Adaugă sursa/.test(t)), `merged comment (${texts.join(' | ')})`);
  });

  test('certificate encryption: encrypted for a Windows certificate, opened with it (CNG) and with the .pfx file', async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([400, 300]).drawText('Salarii 2026 - confidential', { x: 30, y: 250, size: 14, font: f });
    const path = join(dir, 'salarii.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-security"]');
    await page.click('[data-testid="btn-certencrypt"]');
    await page.waitForSelector('[data-testid="certencrypt-modal"]');
    await page.waitForSelector('[data-testid="certencrypt-add-mine"]', { timeout: 15000 });
    await page.click('[data-testid="certencrypt-add-mine"]');
    await page.waitForSelector('[data-testid="certencrypt-recipients"]');
    await page.click('[data-testid="certencrypt-run"]');
    await waitSaved(/salarii-encrypted\.pdf$/);
    await idle();
    const enc = await savedFile(/salarii-encrypted\.pdf$/);
    const raw = readFileSync(enc);
    assert(raw.includes(Buffer.from('/Adobe.PubSec')) && !raw.toString('latin1').includes('Salarii 2026'), 'encrypted for certificates');
    // Opened with the Windows certificate.
    for (const how of ['store', 'file']) {
      // An already-open file only switches to its tab: close it so each way of opening is tried.
      await S(() => {
        const t = window.__adika.tabs;
        window.__adika.store.setState({ dirty: false });
        for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id);
      });
      const opening = S((p) => window.__adika.document.openPdfPath(p), slash(enc));
      await page.waitForSelector('[data-testid="certkey-dialog"]', { timeout: 15000 });
      if (how === 'file') {
        await page.click('[data-testid="certkey-dialog"] [role="tab"]:has-text("Digital ID file")');
        await S((p) => window.__adika.platform.e2eQueuePicks([p]), slash(pfxPath));
        await page.click('[data-testid="certkey-pick"]');
        await page.fill('[data-testid="certkey-password"]', 'adika-e2e');
      }
      await page.click('[data-testid="certkey-open"]');
      assert(await opening, `opened (${how})`);
      await idle();
      const t = await S(async () => {
        const bytes = await window.__adika.document.exportCurrentPdf();
        return new TextDecoder('latin1').decode(bytes).length;
      });
      assert(t > 500, `document open (${how})`);
      const name = await S(() => window.__adika.store.getState().fileName);
      assert(name === 'salarii-encrypted.pdf', `file name (${name})`);
    }
  });
}
