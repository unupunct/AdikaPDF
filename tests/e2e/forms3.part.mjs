// Forms compatibility: filling on the page, form JavaScript, XFA forms, spell check — included by suite.mjs.
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument as PD, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { scriptedFormPdf } from '../helpers/scriptedForm.ts';
import { dynamicXfaPdf, staticXfaPdf } from '../helpers/xfaForms.ts';

/** The XFA kind and datasets text of a saved file (checked independently of the app's code). */
function xfaOf(doc) {
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  const xfa = acro instanceof PDFDict ? acro.lookup(PDFName.of('XFA')) : undefined;
  if (!(xfa instanceof PDFArray)) return { kind: null, datasets: '' };
  let datasets = '';
  for (let i = 0; i + 1 < xfa.size(); i += 2) {
    if (xfa.lookup(i).decodeText() !== 'datasets') continue;
    const s = xfa.lookup(i + 1);
    datasets = new TextDecoder().decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  }
  const needs = doc.catalog.lookup(PDFName.of('NeedsRendering'));
  return { kind: needs && String(needs) === 'true' ? 'dynamic' : 'static', datasets };
}

export function registerForms3Tests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync } = ctx;
  const values = () => S(() => window.__adika.store.getState().fieldValues);
  const fill = async (name, text) => {
    const sel = `[data-testid="page-field"][data-field="${name}"]`;
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.click(sel);
    await page.fill(sel, text);
    await page.keyboard.press('Tab');
  };
  const waitValue = (name, v) => page.waitForFunction(([n, want]) => Object.entries(window.__adika.store.getState().fieldValues).some(([k, x]) => k.endsWith(`::${n}`) && JSON.stringify(x) === JSON.stringify(want)), [name, v], { timeout: 15000 });

  test('form fields are filled on the page; the form’s JavaScript calculates, formats and validates', async () => {
    const path = join(dir, 'scripted.pdf');
    writeFileSync(path, await scriptedFormPdf());
    await open(path);
    await fill('Qty', '3');
    await fill('Price', '10.5');
    // Total = withVat(Qty * Price), a document-level function, formatted by AFNumber_Format.
    await waitValue('Total', '37.49');
    await fill('Upper', 'cluj');
    await waitValue('Upper', 'CLUJ');
    await page.click('[data-testid="page-field"][data-field="Express"]');
    await waitValue('Shipping', '25');
    // The validate script rejects 500 with its own message.
    await fill('Qty', '500');
    await page.waitForSelector('[data-testid="confirm-prompt"]');
    const msg = await page.textContent('[data-testid="confirm-prompt"]');
    assert(msg.includes('At most 100 pieces.'), `alert text (${msg})`);
    await page.click('[data-testid="confirm-ok"]');
    const qty = Object.entries(await values()).find(([k]) => k.endsWith('::Qty'))[1];
    assert(qty === '3', `rejected value not kept (${qty})`);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const form = (await PD.load(readFileSync(await savedFile(/scripted\.pdf$/)))).getForm();
    assert(form.getTextField('Total').getText() === '37.49', `saved total (${form.getTextField('Total').getText()})`);
    assert(form.getCheckBox('Express').isChecked(), 'saved checkbox');
  });

  test('a dynamic XFA form opens laid out as a fillable form and saves back as the XFA form', async () => {
    const path = join(dir, 'xfa-dinamic.pdf');
    writeFileSync(path, await dynamicXfaPdf());
    await open(path);
    const kinds = await S(() => Object.values(window.__adika.store.getState().sources).map((s) => s.pageCount));
    assert(kinds.length === 1 && kinds[0] === 1, `one laid-out page (${kinds})`);
    const text = await page.textContent('[data-testid="page-1"]');
    assert(!/Please wait/.test(text ?? ''), 'not the placeholder page');
    await page.waitForSelector('[data-testid="page-field"][data-field="form1[0].Main[0].Name[0]"]', { timeout: 20000 });
    const shown = await page.inputValue('[data-testid="page-field"][data-field="form1[0].Main[0].Name[0]"]');
    assert(shown === 'Ana Pop', `value from the XFA data (${shown})`);
    await fill('form1[0].Main[0].Name[0]', 'Elena Dumitru');
    await page.selectOption('[data-testid="page-field"][data-field="form1[0].Main[0].Country[0]"]', 'Romania');
    await waitValue('form1[0].Main[0].Country[0]', 'Romania');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const doc = await PD.load(readFileSync(await savedFile(/xfa-dinamic\.pdf$/)), { updateMetadata: false });
    const x = xfaOf(doc);
    assert(x.kind === 'dynamic', 'still a dynamic XFA form');
    const data = x.datasets;
    assert(data.includes('<Name>Elena Dumitru</Name>') && data.includes('<Country>Romania</Country>'), `XFA data (${data})`);
    // The data as XML (what the form submits).
    await page.click('[data-testid="tab-forms"]');
    await page.click('[data-testid="btn-xfa-data"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /-data.xml$/.test(f)), null, { timeout: 30000 });
    const xml = readFileSync(await savedFile(/-data\.xml$/), 'utf8');
    assert(xml.includes('<Name>Elena Dumitru</Name>'), `exported data (${xml.slice(0, 200)})`);
  });

  test('a static XFA form keeps its XFA with the filled values in the XFA data', async () => {
    const path = join(dir, 'xfa-static.pdf');
    writeFileSync(path, await staticXfaPdf());
    await open(path);
    await fill('form1[0].Main[0].Name[0]', 'Ioana Marin');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const doc = await PD.load(readFileSync(await savedFile(/xfa-static\.pdf$/)), { updateMetadata: false });
    const x = xfaOf(doc);
    assert(x.kind === 'static', 'XFA kept');
    const data = x.datasets;
    assert(data.includes('<Name>Ioana Marin</Name>'), `XFA data (${data})`);
  });

  test('check spelling with the Windows spell checker', async () => {
    const path = join(dir, 'spell.pdf');
    const d = await PD.create();
    d.addPage([595, 842]);
    writeFileSync(path, await d.save());
    await open(path);
    await S(() => {
      const st = window.__adika.store.getState();
      st.addObject({ id: 'spell-box', type: 'text', pageId: st.pages[0].id, x: 60, y: 80, width: 300, height: 40, rotation: 0, opacity: 1, text: 'This sentense has a mistake.', fontFamily: 'sans', bold: false, italic: false, fontSize: 14, color: '#000000', align: 'left', lineHeight: 1.2, background: null });
      localStorage.setItem('adika.spellLang', 'en-US');
    });
    await page.keyboard.press('F7');
    await page.waitForSelector('[data-testid="spell-context"]', { timeout: 20000 });
    const ctxText = await page.textContent('[data-testid="spell-context"]');
    assert(ctxText.includes('sentense'), `context (${ctxText})`);
    const sugg = await page.textContent('[data-testid="spell-suggestions"]');
    assert(/sentence/.test(sugg), `suggestions (${sugg})`);
    await page.fill('[data-testid="spell-change-to"]', 'sentence');
    await page.click('[data-testid="spell-change"]');
    await page.waitForSelector('[data-testid="spell-done"]', { timeout: 15000 });
    const t = await S(() => window.__adika.store.getState().objects.find((o) => o.id === 'spell-box').text);
    assert(t === 'This sentence has a mistake.', `corrected (${t})`);
    await page.keyboard.press('Escape');
  });
}
