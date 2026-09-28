/**
 * End-to-end suite for the real Adika desktop app (release exe).
 *
 *   npm run test:e2e            (build first: npx tauri build --no-bundle)
 *
 * Every feature is exercised through the UI or the same action functions
 * the ribbon calls; outputs are verified independently in Node with pdf-lib
 * and pdf.js.
 */
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } from 'docx';
import JSZip from 'jszip';
import { launchApp, tempDir } from './harness.mjs';
import { registerFormatTests } from './formats.part.mjs';
import { makeReaderFixture, registerReaderTests } from './reader.part.mjs';
import { makeCommentFixture, registerCommentTests } from './comments.part.mjs';

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const shots = process.argv.includes('--shots');
const dir = tempDir();
const out = join(dir, 'out');
import { mkdirSync } from 'node:fs';
mkdirSync(out);
console.log(`fixtures & outputs: ${dir}`);

// ------------------------------------------------------------------ fixtures

async function makeSample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Adika sample page ${i}`, { x: 60, y: 760, size: 22, font: bold });
    page.drawText('The quick brown fox jumps over the lazy dog.', { x: 60, y: 720, size: 12, font });
    page.drawText(`Invoice Total ${1000 + i * 111}.50 EUR`, { x: 60, y: 690, size: 12, font });
    page.drawText('CONFIDENTIAL account 4242-4242', { x: 60, y: 650, size: 14, font });
    page.drawRectangle({ x: 60, y: 400, width: 200, height: 120, color: rgb(0.85, 0.92, 1) });
    if (i === 3) page.setRotation(degrees(90));
  }
  doc.setTitle('Sample');
  return doc.save();
}

async function makeForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Registration form', { x: 60, y: 780, size: 20, font });
  const form = doc.getForm();
  const name = form.createTextField('FullName');
  name.addToPage(page, { x: 60, y: 700, width: 250, height: 22 });
  form.createCheckBox('Agree').addToPage(page, { x: 60, y: 660, width: 14, height: 14 });
  const city = form.createDropdown('City');
  city.addOptions(['Cluj', 'Iasi', 'Timisoara']);
  city.addToPage(page, { x: 60, y: 620, width: 150, height: 22 });
  return doc.save();
}

async function makeSecond() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText('Second document page', { x: 40, y: 200, size: 16, font });
  return doc.save();
}

async function makeDocx() {
  const d = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Quarterly Report', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: 'Revenue grew strongly in Cluj and Iasi.', bold: false })] }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph('City')] }), new TableCell({ children: [new Paragraph('Revenue')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Cluj')] }), new TableCell({ children: [new Paragraph('1200')] })] }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(d));
}

const F = {
  sample: join(dir, 'sample.pdf'),
  form: join(dir, 'form.pdf'),
  second: join(dir, 'second.pdf'),
  docx: join(dir, 'report.docx'),
  md: join(dir, 'notes.md'),
  html: join(dir, 'page.html'),
  reader: join(dir, 'reader.pdf'),
  comments: join(dir, 'comments.pdf'),
};
writeFileSync(F.comments, await makeCommentFixture());
writeFileSync(F.reader, await makeReaderFixture());
writeFileSync(F.sample, await makeSample());
writeFileSync(F.form, await makeForm());
writeFileSync(F.second, await makeSecond());
writeFileSync(F.docx, await makeDocx());
writeFileSync(F.md, '# Markdown Title\n\nSome **bold** text and a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
writeFileSync(F.html, '<!doctype html><html><body><h1>Hello HTML</h1><p>Rendered by Adika.</p></body></html>');

// ------------------------------------------------------------------ verification helpers

const FONT_DATA = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts').split('\\').join('/') + '/';

async function pdfText(path, password) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), password, disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((it) => it.str).join(' '));
  }
  await doc.loadingTask.destroy();
  return pages;
}

async function pdfInfo(path) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    pages.push({ rotate: p.rotate, view: p.view });
  }
  const info = { numPages: doc.numPages, pages };
  await doc.loadingTask.destroy();
  return info;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ------------------------------------------------------------------ app helpers

const app = await launchApp();
const { page } = app;
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`   [console.error] ${m.text().slice(0, process.env.ADIKA_FULL_ERRORS ? 4000 : 300)}`);
});
page.on('pageerror', (e) => console.log(`   [pageerror] ${e.message}`));
await page.evaluate((d) => window.__adika.platform.e2eSetSaveDir(d), out);

const S = (fn, arg) => page.evaluate(fn, arg);
const state = () => S(() => {
  const s = window.__adika.store.getState();
  return { pages: s.pages.length, objects: s.objects.map((o) => ({ id: o.id, type: o.type, pageId: o.pageId, x: o.x, y: o.y, text: o.text, fieldKind: o.fieldKind })), dirty: s.dirty, tool: s.tool, zoom: s.zoom, fileName: s.fileName, modal: s.modal, busy: s.busy, toasts: s.toasts.map((t) => `${t.kind}:${t.message}`), readOnly: s.readOnlyReason, selected: s.selectedIds, sigs: s.signatureStatus };
});

async function idle(timeout = 120000) {
  await page.waitForFunction(() => !window.__adika.store.getState().busy, null, { timeout });
}

async function open(path) {
  await S(() => {
    const t = window.__adika.tabs;
    window.__adika.store.setState({ dirty: false });
    for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id);
  });
  await S((p) => window.__adika.document.openPdfPath(p), path);
  await idle();
  await page.waitForSelector('[data-testid="page-1"] canvas', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="page-1"]')?.textContent?.includes('Loading page'), null, { timeout: 20000 });
}

async function savedFile(pattern) {
  const files = await S(() => window.__adika.platform.e2eSavedFiles());
  const hit = [...files].reverse().find((f) => pattern.test(f));
  assert(hit, `a saved file matching ${pattern} (saved: ${files.join(', ')})`);
  return hit.replace(/\//g, '\\');
}

async function pageBox(n = 1) {
  const el = await page.$(`[data-testid="page-${n}"]`);
  await el.scrollIntoViewIfNeeded();
  return el.boundingBox();
}

/** Scrolls so display point (x, y) of page n is inside the viewer, then returns its screen position. */
async function at(n, x, y) {
  await S(({ n, y }) => {
    const pageEl = document.querySelector(`[data-testid="page-${n}"]`);
    const scroller = document.querySelector('[data-testid="pdf-canvas"]');
    const zoom = window.__adika.store.getState().zoom;
    const pr = pageEl.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const target = pr.top + y * zoom;
    if (target < sr.top + 60 || target > sr.bottom - 60) scroller.scrollTop += target - (sr.top + sr.height / 2);
  }, { n, y });
  await page.waitForTimeout(120);
  const box = await (await page.$(`[data-testid="page-${n}"]`)).boundingBox();
  const zoom = await S(() => window.__adika.store.getState().zoom);
  return { x: box.x + x * zoom, y: box.y + y * zoom };
}

async function drag(n, from, to) {
  const a = await at(n, ...from);
  const b = await at(n, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

async function clickAt(n, x, y) {
  const p = await at(n, x, y);
  await page.mouse.click(p.x, p.y);
}

async function setTool(tool) {
  await S((t) => window.__adika.store.getState().setTool(t), tool);
}

async function tab(id) {
  await page.click(`[data-testid="tab-${id}"]`);
}

async function shot(name) {
  if (shots) await page.screenshot({ path: join(dir, `${name}.png`) });
}

// ------------------------------------------------------------------ tests

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('open PDF via the Open button (file dialog path)', async () => {
  await S((p) => window.__adika.platform.e2eQueuePicks([p]), F.sample);
  await page.click('[data-testid="btn-open"]');
  await idle();
  await page.waitForSelector('[data-testid="page-3"]');
  const s = await state();
  assert(s.pages === 3, `3 pages, got ${s.pages}`);
  assert(s.fileName === 'sample.pdf', 'file name shown');
  // The page raster actually has content (not blank white).
  await page.waitForFunction(() => !document.querySelector('[data-testid="page-1"]').textContent.includes('Loading'));
  const inked = await S(() => {
    const c = document.querySelector('[data-testid="page-1"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 128) dark++;
    return dark;
  });
  assert(inked > 50, `page 1 rendered text pixels (${inked})`);
  assert(await page.$('[data-testid="thumb-3"]'), 'thumbnails listed');
  await shot('01-open');
});

test('zoom in/out and fit width', async () => {
  const z0 = (await state()).zoom;
  await page.click('[data-testid="btn-zoom-in"]');
  const z1 = (await state()).zoom;
  assert(z1 > z0 * 1.1, `zoom increased ${z0} → ${z1}`);
  await page.click('[data-testid="btn-zoom-out"]');
  await page.click('[data-testid="btn-zoom-out"]');
  assert((await state()).zoom < z1, 'zoom decreased');
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(300);
  const label = await page.textContent('[data-testid="zoom-level"]');
  assert(/\d+%/.test(label), 'zoom label');
});

test('search finds text and ignores diacritics/case', async () => {
  await page.keyboard.press('Control+f');
  await page.fill('[data-testid="search-input"]', 'invoice total');
  await page.waitForFunction(() => /\d+ \/ 3/.test(document.querySelector('[data-testid="search-count"]')?.textContent ?? ''), null, { timeout: 15000 });
  await page.keyboard.press('Enter');
  const hits = await S(() => window.__adika.store.getState().search.hits.length);
  assert(hits === 3, `3 hits, got ${hits}`);
  await page.keyboard.press('Escape');
});

test('add text with the Text tool, typing Romanian diacritics', async () => {
  await tab('edit');
  await page.click('[data-testid="tool-text"]');
  await clickAt(1, 80, 300);
  await page.waitForSelector('[data-testid="text-editor"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
  await page.keyboard.type('Semnat în Cluj-Napoca: ăâîșț');
  await clickAt(1, 400, 820); // click away commits
  await page.waitForTimeout(200);
  const s = await state();
  const t = s.objects.find((o) => o.type === 'text');
  assert(t && t.text === 'Semnat în Cluj-Napoca: ăâîșț', `text object with typed content (${t?.text})`);
});

test('draw rectangle, ellipse, arrow, freehand and highlight by mouse', async () => {
  await page.click('[data-testid="tool-rect"]');
  await S(() => window.__adika.store.getState().setZoom(1, null));
  await drag(1, [300, 380], [450, 460]);
  await page.click('[data-testid="tool-ellipse"]');
  await drag(1, [300, 480], [420, 540]);
  await page.click('[data-testid="tool-arrow"]');
  await drag(1, [80, 560], [250, 600]);
  await page.click('[data-testid="tool-pen"]');
  await drag(1, [300, 600], [400, 650]);
  await page.click('[data-testid="tool-highlight"]');
  await drag(1, [58, 120], [320, 136]);
  await setTool('select');
  const types = (await state()).objects.map((o) => o.type).sort();
  for (const t of ['rect', 'ellipse', 'arrow', 'pen', 'highlight']) assert(types.includes(t), `${t} created (have ${types})`);
  await shot('02-drawn');
});

test('select, move by dragging, delete, undo and redo', async () => {
  const before = (await state()).objects.find((o) => o.type === 'rect');
  await clickAt(1, 375, 420);
  let s = await state();
  assert(s.selected.includes(before.id), 'rect selected by click');
  await drag(1, [375, 420], [395, 440]);
  s = await state();
  const moved = s.objects.find((o) => o.id === before.id);
  assert(Math.abs(moved.x - before.x - 20) < 3 && Math.abs(moved.y - before.y - 20) < 3, `rect moved by 20pt (${moved.x - before.x}, ${moved.y - before.y})`);
  await page.keyboard.press('Delete');
  s = await state();
  assert(!s.objects.some((o) => o.id === before.id), 'deleted');
  await page.keyboard.press('Control+z');
  s = await state();
  assert(s.objects.some((o) => o.id === before.id), 'undo restores');
  await page.keyboard.press('Control+y');
  s = await state();
  assert(!s.objects.some((o) => o.id === before.id), 'redo deletes again');
  await page.keyboard.press('Control+z');
});

test('edit existing text (click on a text run)', async () => {
  await page.click('[data-testid="tool-editText"]');
  // "The quick brown fox" baseline at y=842-720=122 in display space.
  await clickAt(1, 100, 117);
  await page.waitForSelector('[data-testid="text-editor"]', { timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Edited sentence by Adika.');
  await clickAt(1, 400, 820);
  const t = (await state()).objects.find((o) => o.type === 'text' && o.text === 'Edited sentence by Adika.');
  assert(t, 'replacement text object created');
});

test('insert an image and place a drawn signature', async () => {
  await S(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    const x = c.getContext('2d');
    x.fillStyle = '#10b981';
    x.fillRect(0, 0, 120, 80);
    x.fillStyle = '#fff';
    x.fillText('IMG', 50, 45);
    window.__adika.store.getState().setPendingImage({ src: c.toDataURL('image/png'), width: 120, height: 80 });
  });
  await clickAt(1, 480, 250);
  // Signature: draw on the pad in the Fill & Sign dialog.
  await tab('sign');
  await page.click('[data-testid="btn-sign"]');
  await page.waitForSelector('[data-testid="signature-modal"]');
  await page.fill('[data-testid="signer-name"]', 'Maria Ștefănescu');
  const pad = await (await page.$('[data-testid="signature-pad"]')).boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + 130);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(pad.x + 60 + i * 12, pad.y + 130 - Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.click('[data-testid="signature-create"]');
  await clickAt(1, 420, 760);
  const s = await state();
  assert(s.objects.some((o) => o.type === 'image'), 'image placed');
  assert(s.objects.some((o) => o.type === 'signature'), 'signature placed');
  const saved = await S(() => window.__adika.store.getState().savedSignatures.length);
  assert(saved >= 1, 'signature saved for reuse');
  await shot('03-signed');
});

test('save as: every edit lands in the PDF', async () => {
  await page.keyboard.press('Control+Shift+s');
  await idle();
  const path = await savedFile(/sample\.pdf$/);
  const texts = await pdfText(path);
  assert(texts[0].includes('Semnat în Cluj-Napoca: ăâîșț'), 'typed text with diacritics in output');
  assert(texts[0].includes('Edited sentence by Adika.'), 'edited text in output');
  assert(texts[0].includes('Maria Ștefănescu'), 'signature caption in output');
  const doc = await PDFDocument.load(readFileSync(path));
  assert(doc.getPageCount() === 3, '3 pages kept');
  assert(!(await state()).dirty, 'document marked clean');
});

test('page operations: rotate, insert blank, duplicate, reorder, delete, merge', async () => {
  await open(F.sample);
  const ids = await S(() => window.__adika.store.getState().pages.map((p) => p.id));
  await tab('organize');
  await page.click('[data-testid="thumb-1"]');
  await page.click('[data-testid="btn-rotate-right"]');
  await page.click('[data-testid="btn-insert-blank"]');
  assert((await state()).pages === 4, `blank page inserted (${(await state()).pages})`);
  await S((id) => window.__adika.store.getState().duplicatePages([id]), ids[1]);
  assert((await state()).pages === 5, `page duplicated (${(await state()).pages})`);
  // Reorder: move page 3 (original) to the front through the store action the sidebar uses.
  const order = await S(() => window.__adika.store.getState().pages.map((p) => p.id));
  const reordered = [ids[2], ...order.filter((id) => id !== ids[2])];
  await S((o) => window.__adika.store.getState().reorderPages(o), reordered);
  await S((p) => window.__adika.platform.e2eQueuePicks([p]), F.second);
  await page.click('[data-testid="btn-merge"]');
  await page.waitForFunction(() => window.__adika.store.getState().pages.length === 6, null, { timeout: 15000 });
  await idle();
  let s = await state();
  assert(s.pages === 6, `6 pages after ops, got ${s.pages} (${s.toasts.join(' | ')})`);
  await S(() => {
    const st = window.__adika.store.getState();
    st.deletePages([st.pages[st.pages.length - 2].id]);
  });
  s = await state();
  assert(s.pages === 5, 'deleted one');
  await page.keyboard.press('Control+Shift+s');
  await idle();
  const path = await savedFile(/sample\.pdf$/);
  const texts = await pdfText(path);
  const info = await pdfInfo(path);
  assert(info.numPages === 5, `5 pages in output, got ${info.numPages}`);
  assert(texts[0].includes('page 3'), `page 3 moved first: ${texts[0].slice(0, 40)}`);
  assert(texts[4].includes('Second document'), 'merged page last');
  assert(info.pages[1].rotate === 90, `page 1 rotated to 90 (${info.pages[1].rotate})`);
  assert(texts[2] === '', 'blank page present');
});

test('organizer dialog opens and rotates a page', async () => {
  await open(F.sample);
  await page.click('[data-testid="tab-organize"]');
  await page.click('[data-testid="btn-organizer"]');
  await page.waitForSelector('[data-testid="organizer-modal"]');
  await page.click('[data-testid="org-page-2"]');
  await page.click('[data-testid="org-rotate-right"]');
  const rot = await S(() => window.__adika.store.getState().pages[1].userRotation);
  assert(rot === 90, 'page 2 rotated in organizer');
  await page.keyboard.press('Escape');
});

test('split into parts and extract pages', async () => {
  await open(F.sample);
  const t0 = Date.now();
  await S(() => window.__adika.convert.splitDocument([[1], [2, 3]]));
  await idle();
  console.log(`   split took ${Date.now() - t0} ms`);
  const zip = await savedFile(/-split\.zip$/);
  const z = await JSZip.loadAsync(readFileSync(zip));
  assert(Object.keys(z.files).length === 2, 'two parts in ZIP');
  await S(() => window.__adika.convert.extractPages([2]));
  await idle();
  const ex = await savedFile(/-extract\.pdf$/);
  const t = await pdfText(ex);
  assert(t.length === 1 && t[0].includes('page 2'), 'extracted page 2');
});

test('form builder: create text, checkbox, radio, dropdown and signature fields', async () => {
  await open(F.second);
  await tab('forms');
  await page.click('[data-testid="tool-field-text"]');
  await drag(1, [30, 30], [200, 52]);
  await page.click('[data-testid="tool-field-checkbox"]');
  await clickAt(1, 40, 80);
  await page.click('[data-testid="tool-field-radio"]');
  await clickAt(1, 40, 110);
  await clickAt(1, 70, 110); // field tools stay active for the next field
  await page.click('[data-testid="tool-field-dropdown"]');
  await clickAt(1, 120, 150);
  await page.click('[data-testid="tool-field-signature"]');
  await drag(1, [200, 200], [360, 260]);
  await setTool('select');
  const kinds = (await state()).objects.filter((o) => o.type === 'field').map((o) => o.fieldKind).sort();
  assert(kinds.join() === 'checkbox,dropdown,radio,radio,signature,text', `fields: ${kinds}`);
  await page.keyboard.press('Control+Shift+s');
  await idle();
  const path = await savedFile(/second\.pdf$/);
  const form = (await PDFDocument.load(readFileSync(path))).getForm();
  const names = form.getFields().map((f) => `${f.constructor.name}:${f.getName()}`).sort();
  assert(names.some((n) => n.startsWith('PDFTextField:Text')), `text field (${names})`);
  assert(names.some((n) => n.startsWith('PDFRadioGroup:Group')), 'radio group');
  assert(form.getRadioGroup(names.find((n) => n.startsWith('PDFRadioGroup')).split(':')[1]).getOptions().length === 2, 'two radio options in one group');
  assert(names.some((n) => n.startsWith('PDFSignature:')), 'signature field');
});

test('fill an existing form in the inspector, save and export CSV', async () => {
  await open(F.form);
  await page.waitForSelector('[data-testid="form-fill"]', { timeout: 10000 });
  await page.fill('[data-testid="form-fill"] input[aria-label="FullName"]', 'Ion Popescu');
  await page.keyboard.press('Enter');
  await page.check('[data-testid="form-fill"] input[type="checkbox"]');
  await page.selectOption('[data-testid="form-fill"] select[aria-label="City"]', 'Iasi');
  await page.keyboard.press('Control+Shift+s');
  await idle();
  const path = await savedFile(/form\.pdf$/);
  const form = (await PDFDocument.load(readFileSync(path))).getForm();
  assert(form.getTextField('FullName').getText() === 'Ion Popescu', 'text field filled');
  assert(form.getCheckBox('Agree').isChecked(), 'checkbox checked');
  assert(form.getDropdown('City').getSelected()[0] === 'Iasi', 'dropdown selected');
  await S(() => window.__adika.security.exportFormCsv());
  await idle();
  const csv = readFileSync(await savedFile(/form-data\.csv$/), 'utf8');
  assert(csv.includes('Ion Popescu') && csv.includes('Iasi') && csv.includes('Yes'), `CSV content: ${csv}`);
});

test('redaction permanently removes covered text', async () => {
  await open(F.sample);
  await tab('security');
  await page.click('[data-testid="tool-redact"]');
  // "CONFIDENTIAL account 4242-4242" at y = 842-650 = 192 (baseline).
  await drag(1, [55, 176], [320, 198]);
  await setTool('select');
  await page.click('[data-testid="btn-apply-redactions"]');
  await idle();
  const path = await savedFile(/sample\.pdf$/);
  const t = await pdfText(path);
  assert(!t[0].includes('4242'), 'redacted text gone from page 1');
  assert(t[1].includes('4242'), 'other pages untouched');
  assert(!readFileSync(path).includes(Buffer.from('CONFIDENTIAL account 4242-4242')), 'no plaintext in bytes of page 1 content');
});

test('password protection (AES-256) and reopening with the password prompt', async () => {
  await open(F.second);
  await tab('security');
  await page.click('[data-testid="btn-protect"]');
  await page.fill('[data-testid="protect-user"]', 'secret-123');
  await page.fill('[data-testid="protect-user2"]', 'secret-123');
  await page.fill('[data-testid="protect-owner"]', 'owner-456');
  await page.click('[data-testid="protect-run"]');
  await idle();
  const path = await savedFile(/-protected\.pdf$/);
  let failed = false;
  try {
    await pdfText(path);
  } catch {
    failed = true;
  }
  assert(failed, 'cannot open without password');
  const t = await pdfText(path, 'secret-123');
  assert(t[0].includes('Second document'), 'opens with the password');
  // Reopen in the app: the prompt appears, a wrong password is rejected, the right one works.
  await S(() => window.__adika.store.setState({ dirty: false }));
  const opening = S((p) => window.__adika.document.openPdfPath(p), path);
  await page.waitForSelector('[data-testid="password-input"]');
  await page.fill('[data-testid="password-input"]', 'wrong');
  await page.click('[data-testid="password-submit"]');
  await page.waitForSelector('text=Incorrect password');
  await page.fill('[data-testid="password-input"]', 'secret-123');
  await page.click('[data-testid="password-submit"]');
  await opening;
  const s = await state();
  assert(s.pages === 1 && s.readOnly, 'opened read-only with password');
});

test('digital signature with a self-signed ID, then verification', async () => {
  await open(F.sample);
  await tab('sign');
  await page.click('[data-testid="btn-cert-sign"]');
  await page.click('text=Create self-signed ID');
  await page.fill('[data-testid="selfsigned-name"]', 'Andrei Test');
  await page.click('[data-testid="selfsigned-create"]');
  await page.waitForSelector('[data-testid="identity-card"]', { timeout: 30000 });
  await page.click('[data-testid="cert-sign-now"]');
  await idle();
  const path = await savedFile(/-signed\.pdf$/);
  const v = await S(async (p) => {
    const bytes = await window.__adika.platform.readFile(p);
    return window.__adika.signature.verifyPdfSignatures(bytes);
  }, path.replace(/\\/g, '/'));
  assert(v.length === 1 && v[0].integrity === 'valid' && v[0].coversWholeFile, `signature valid (${JSON.stringify(v[0]?.message)})`);
  assert(v[0].signerName.includes('Andrei Test'), 'signer name');
  // The signed file is reopened; the verify dialog shows it.
  await page.waitForFunction(() => window.__adika.store.getState().signatureStatus.length === 1, null, { timeout: 15000 });
  await page.click('[data-testid="btn-verify"]');
  await page.waitForSelector('[data-testid="signature-card"]', { timeout: 15000 });
  await shot('04-verify');
  await page.keyboard.press('Escape');
  // Tampering is detected.
  // Flip one byte inside the first content stream (inside the signed range).
  const bytes = readFileSync(path);
  const idx = bytes.indexOf(Buffer.from('stream\n')) + 40;
  bytes[idx] ^= 0x01;
  const tampered = join(dir, 'tampered.pdf');
  writeFileSync(tampered, bytes);
  const tv = await S(async (p) => window.__adika.signature.verifyPdfSignatures(await window.__adika.platform.readFile(p)), tampered.replace(/\\/g, '/'));
  assert(tv[0].integrity === 'invalid', `tampering detected (${tv[0].integrity})`);
});

test('token signing dialog lists PKCS#11 drivers gracefully', async () => {
  await open(F.second);
  await tab('sign');
  await page.click('[data-testid="btn-token-sign"]');
  await page.waitForSelector('[data-testid="token-modal"]');
  await page.waitForTimeout(1500);
  const text = await page.textContent('[data-testid="token-modal"]');
  assert(/driver|token/i.test(text), 'token dialog rendered');
  await page.keyboard.press('Escape');
});

test('export to Word, Excel, PowerPoint, PNG, TIFF, SVG, HTML, Markdown, text', async () => {
  await open(F.sample);
  for (const format of ['docx', 'xlsx', 'pptx', 'png', 'tiff', 'svg', 'html', 'md', 'txt']) {
    await S((f) => window.__adika.convert.exportAs({ format: f, dpi: 72 }), format);
    await idle();
  }
  const files = await S(() => window.__adika.platform.e2eSavedFiles());
  const find = (re) => files.find((f) => re.test(f));
  for (const [re, check] of [
    [/\.docx$/, async (p) => (await JSZip.loadAsync(readFileSync(p))).file('word/document.xml').async('string').then((x) => x.includes('Invoice Total'))],
    [/\.xlsx$/, async (p) => (await JSZip.loadAsync(readFileSync(p))).file('xl/worksheets/sheet1.xml').async('string').then((x) => x.includes('Invoice'))],
    [/\.pptx$/, async (p) => Object.keys((await JSZip.loadAsync(readFileSync(p))).files).some((n) => n.startsWith('ppt/slides/slide3'))],
    [/sample\.zip$/, async (p) => Object.keys((await JSZip.loadAsync(readFileSync(p))).files).length >= 3],
    [/\.tif$/, async (p) => readFileSync(p).subarray(0, 2).toString() === 'II'],
    [/\.html$/, async (p) => readFileSync(p, 'utf8').includes('Invoice Total')],
    [/\.md$/, async (p) => readFileSync(p, 'utf8').includes('Invoice Total')],
    [/\.txt$/, async (p) => readFileSync(p, 'utf8').includes('quick brown fox')],
  ]) {
    const p = find(re);
    assert(p, `exported ${re}`);
    assert(await check(p.replace(/\//g, '\\')), `content check ${re}`);
  }
});

test('Word document → PDF through Microsoft Office', async () => {
  await S((p) => window.__adika.platform.e2eQueuePicks([p]), F.docx);
  await S(() => window.__adika.convert.importOfficeDocuments(false));
  await idle(300000);
  const s = await state();
  assert(s.fileName === 'report.pdf' && s.pages >= 1, `converted doc opened (${s.fileName}, ${s.toasts.join(' | ')})`);
  for (const needle of ['Quarterly Report', 'Revenue grew strongly', 'Cluj']) {
    const hits = await S(async (q) => {
      const st = window.__adika.store.getState();
      return window.__adika.search.searchDocument(st.pages, q, { cancelled: false }).then((h) => h.length);
    }, needle);
    assert(hits >= 1, `converted PDF contains “${needle}”`);
  }
});

test('images → PDF, Markdown → PDF, HTML → PDF', async () => {
  const png = await S(() => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const x = c.getContext('2d');
    x.fillStyle = '#e0f2fe';
    x.fillRect(0, 0, 800, 600);
    x.fillStyle = '#0369a1';
    x.font = 'bold 60px Segoe UI';
    x.fillText('Picture page', 200, 320);
    return c.toDataURL('image/png');
  });
  const imgPdf = await S((src) => window.__adika.convert.imagesToPdf([{ src, width: 800, height: 600 }, { src, width: 800, height: 600 }], { pageSize: 'a4', orientation: 'auto', marginMm: 10 }).then((b) => Array.from(b)), png);
  const imgDoc = await PDFDocument.load(Uint8Array.from(imgPdf));
  assert(imgDoc.getPageCount() === 2 && imgDoc.getPage(0).getWidth() > imgDoc.getPage(0).getHeight(), 'two landscape A4 pages');
  for (const [kind, file, needle] of [['markdown', F.md, 'Markdown Title'], ['html', F.html, 'Hello HTML']]) {
    // A freshly created PDF is unsaved; creating the next one would ask to discard it.
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), file);
    await S(({ k }) => window.__adika.convert.importTextLike(k, { pageSize: 'A4', landscape: false, marginMm: 15 }, false), { k: kind });
    await idle(120000);
    const hits = await S(async (q) => {
      const st = window.__adika.store.getState();
      return window.__adika.search.searchDocument(st.pages, q, { cancelled: false }).then((h) => h.length);
    }, needle);
    assert(hits >= 1, `${kind} rendered with “${needle}” (${(await state()).toasts.join(' | ')})`);
  }
});

test('OCR makes an image-only page searchable', async () => {
  const png = await S(() => {
    const c = document.createElement('canvas');
    c.width = 2480;
    c.height = 1200;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#000';
    x.font = '96px Arial';
    x.fillText('Scanned contract number 58213', 120, 400);
    x.fillText('Signed on the first of May', 120, 600);
    return c.toDataURL('image/png');
  });
  const bytes = await S((src) => window.__adika.convert.imagesToPdf([{ src, width: 2480, height: 1200 }], { pageSize: 'fit', orientation: 'auto', marginMm: 0 }).then((b) => Array.from(b)), png);
  const scan = join(dir, 'scan.pdf');
  writeFileSync(scan, Uint8Array.from(bytes));
  await open(scan);
  await S(() => window.__adika.convert.runOcr({ pageNumbers: [1], dpi: 200, lang: 'eng' }));
  await idle(300000);
  const path = await savedFile(/-ocr\.pdf$/);
  const t = (await pdfText(path))[0];
  assert(/contract/i.test(t) && /58213/.test(t), `OCR text found: “${t.slice(0, 120)}”`);
});

test('compress reduces a heavy image PDF', async () => {
  const src = await S(() => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const x = c.getContext('2d');
    const img = x.createImageData(3000, 2000);
    for (let i = 0; i < img.data.length; i += 4) {
      const p = i / 4;
      img.data[i] = (p * 7) % 255;
      img.data[i + 1] = ((p / 3000) * 90) % 255;
      img.data[i + 2] = (Math.sin(p / 900) * 127 + 128) | 0;
      img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 1).length;
  });
  const heavy = join(dir, 'heavy.pdf');
  await S(async (p) => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const x = c.getContext('2d');
    const img = x.createImageData(3000, 2000);
    for (let i = 0; i < img.data.length; i += 4) {
      const q = i / 4;
      img.data[i] = (q * 7) % 255;
      img.data[i + 1] = ((q / 3000) * 90) % 255;
      img.data[i + 2] = (Math.sin(q / 900) * 127 + 128) | 0;
      img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    const bytes = await window.__adika.convert.imagesToPdf([{ src: c.toDataURL('image/jpeg', 1), width: 3000, height: 2000 }], { pageSize: 'a4', orientation: 'auto', marginMm: 0 });
    await window.__adika.platform.writeFile(p, bytes);
  }, heavy);
  assert(src > 1e6, 'large source image');
  await open(heavy);
  const r = await S(() => window.__adika.convert.runCompress({ imageQuality: 0.6, maxImageDpi: 100, stripMetadata: true }));
  await idle();
  assert(r && r.after < r.before * 0.6, `compressed ${r?.before} → ${r?.after}`);
  const path = await savedFile(/-compressed\.pdf$/);
  assert(statSync(path).size === r.after, 'saved compressed file');
});

test('PDF/A-2b conversion and flatten', async () => {
  await open(F.form);
  const warnings = await S(() => window.__adika.convert.runPdfA({ title: 'Archive', author: 'Adika' }));
  await idle();
  const path = await savedFile(/-pdfa2b\.pdf$/);
  const doc = await PDFDocument.load(readFileSync(path));
  assert(doc.getPageCount() === 1, 'PDF/A output loads');
  const raw = readFileSync(path).toString('latin1');
  assert(raw.includes('/OutputIntents') && raw.includes('pdfaid:part'), 'OutputIntents + XMP present');
  assert(Array.isArray(warnings), 'warnings returned');
  await open(F.form);
  await S(() => window.__adika.convert.flattenCurrent());
  await idle();
  const flat = await savedFile(/-flattened\.pdf$/);
  assert((await PDFDocument.load(readFileSync(flat))).getForm().getFields().length === 0, 'no fields after flatten');
});

test('scanner reports a clear message when no scanner is attached', async () => {
  const res = await S(async () => {
    try {
      const b = await window.__adika.platform.scanPage();
      return `ok:${b.length}`;
    } catch (e) {
      return `err:${e}`;
    }
  });
  assert(/scanner|cancel|ok:0|err:/i.test(res), `scan result: ${res}`);
  console.log(`   scan → ${res.slice(0, 120)}`);
});

registerReaderTests(test, { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, readFileSync, JSZip, PDFDocument, F, pdfjs, FONT_DATA });
registerCommentTests(test, { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, F, pdfjs, FONT_DATA });
registerFormatTests(test, { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, readFileSync, JSZip, PDFDocument, F, pdfjs, FONT_DATA });

test('dark mode toggle and welcome after close', async () => {
  await page.click('[data-testid="theme-toggle"]');
  assert(await S(() => document.documentElement.classList.contains('dark')), 'dark mode on');
  await shot('05-dark');
  await page.click('[data-testid="theme-toggle"]');
  assert(!(await S(() => document.documentElement.classList.contains('dark'))), 'dark mode off');
  await S(() => window.__adika.store.getState().closeDocument());
  await page.waitForSelector('[data-testid="welcome"]');
});

// ------------------------------------------------------------------ runner

let passed = 0;
const failed = [];
for (const t of tests) {
  if (only.length && !only.some((o) => t.name.toLowerCase().includes(o.toLowerCase()))) continue;
  const t0 = Date.now();
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed.push(t.name);
    console.log(`  ✗ ${t.name}\n      ${String(e?.message ?? e).split('\n').slice(0, 4).join('\n      ')}`);
    await page.screenshot({ path: join(dir, `FAIL-${failed.length}.png`) }).catch(() => {});
    const crash = await S(() => window.__adikaLastCrash ?? null).catch(() => null);
    if (crash) {
      const top = (text, n) => String(text).split('\n').slice(0, n).join('\n        ');
      console.log(`      CRASH: ${crash.message}\n        ${top(crash.stack, 8)}\n      components:${top(crash.componentStack, 10)}`);
    }
    // Recover: close modals, clear busy state.
    await page.keyboard.press('Escape').catch(() => {});
    await S(() => window.__adika.store.setState({ modal: null, busy: null, editingTextId: null, tool: 'select' })).catch(() => {});
    await S(() => window.__adika.dialogs.setState({ password: null, confirm: null })).catch(() => {});
  }
}
console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
await app.close();
process.exit(failed.length ? 1 : 0);
