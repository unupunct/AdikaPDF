// Acrobat/Foxit-style tools: stamps, comment shapes, attachments, links,
// page marks, crop, bookmarks, comment import/export, summary, compare —
// included by suite.mjs. Every output is verified with pdf.js / pdf-lib.
import { readFileSync } from 'node:fs';

export function registerToolTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, PDFDocument, F, pdfjs, FONT_DATA, at } = ctx;

  const openPdf = (path) => pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  const annotsOf = async (path, n = 1) => {
    const d = await openPdf(path);
    const a = await (await d.getPage(n)).getAnnotations();
    await d.loadingTask.destroy();
    return a;
  };
  const drag = async (n, x0, y0, x1, y1) => {
    const a = await at(n, x0, y0);
    const b = await at(n, x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  const click = async (n, x, y) => {
    const p = await at(n, x, y);
    await page.mouse.click(p.x, p.y);
  };
  const saveAs = async (pattern) => {
    await page.keyboard.press('Control+Shift+s');
    await idle();
    return savedFile(pattern);
  };
  // The app keeps only the last 5 messages, so wait for a new message id, not a longer list.
  const toastSince = async (re, before) => {
    await page.waitForFunction(({ src, ids }) => window.__adika.store.getState().toasts.some((t) => !ids.includes(t.id) && new RegExp(src).test(t.message)), { src: re.source, ids: before }, { timeout: 60000 });
    await idle();
  };
  const toastCount = () => S(() => window.__adika.store.getState().toasts.map((t) => t.id));
  const objects = () => S(() => window.__adika.store.getState().objects.map((o) => ({ type: o.type, kind: o.kind, label: o.label, text: o.text, border: o.border, callout: o.callout, fileName: o.fileName, target: o.target })));

  test('tools: stamps, text box, callout, cloud, polygon and file attachment comments', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-comment"]');
    // Stamp from the menu, placed with a click.
    await page.click('[data-testid="btn-stamp"]');
    await page.getByRole('menuitem', { name: 'APPROVED' }).first().click();
    await click(1, 420, 120);
    // Text box: drag a box, type.
    await page.click('[data-testid="tool-textbox"]');
    await drag(1, 60, 520, 260, 560);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
    await page.keyboard.type('Verificat de Ana');
    await click(1, 500, 800);
    // Callout: press on the point, release where the box goes.
    await page.click('[data-testid="tool-callout"]');
    await drag(1, 150, 690, 300, 620);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
    await page.keyboard.type('Suma corectă?');
    await click(1, 500, 800);
    // Cloud around an area.
    await page.click('[data-testid="tool-cloud"]');
    await drag(1, 60, 150, 260, 200);
    // Polygon: three clicks and Enter.
    await page.click('[data-testid="tool-polygon"]');
    await click(1, 330, 300);
    await click(1, 430, 320);
    await click(1, 380, 380);
    await page.keyboard.press('Enter');
    // File attachment: click, the picker is answered by the e2e queue.
    const note = join(dir, 'notă atașată.txt');
    writeFileSync(note, 'Conținut atașat');
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), note.split('\\').join('/'));
    await page.click('[data-testid="tool-attach"]');
    await click(1, 540, 60);
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'attachment'), null, { timeout: 10000 });
    const objs = await objects();
    assert(objs.some((o) => o.type === 'stamp' && o.label === 'APPROVED'), `stamp placed (${JSON.stringify(objs)})`);
    assert(objs.some((o) => o.type === 'text' && o.border && !o.callout && o.text === 'Verificat de Ana'), 'text box created');
    assert(objs.some((o) => o.type === 'text' && o.callout && o.text === 'Suma corectă?'), 'callout created');
    assert(objs.some((o) => o.type === 'poly' && o.kind === 'cloud'), 'cloud created');
    assert(objs.some((o) => o.type === 'poly' && o.kind === 'polygon'), 'polygon created');
    assert(objs.some((o) => o.type === 'attachment' && o.fileName === 'notă atașată.txt'), 'attachment created');
    const path = await saveAs(/sample\.pdf$/);
    const annots = await annotsOf(path);
    const types = annots.map((a) => a.subtype);
    for (const t of ['Stamp', 'FreeText', 'Square', 'Polygon', 'FileAttachment']) assert(types.includes(t), `${t} annotation saved (${types.join(',')})`);
    assert(annots.filter((a) => a.subtype === 'FreeText').some((a) => a.contentsObj?.str === 'Suma corectă?'), 'callout text saved with diacritics');
    assert(annots.every((a) => a.subtype === 'Popup' || a.hasAppearance), 'every comment has an appearance');
    // Reopened: the attachment is listed in the Attachments panel and can be saved.
    await open(path);
    await page.click('[data-testid="sidebar-attachments"]');
    await page.waitForFunction(() => document.body.textContent.includes('notă atașată.txt'), null, { timeout: 10000 });
  });

  test('tools: links to a web page and to another page are saved', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-edit"]');
    await page.click('[data-testid="tool-link"]');
    await drag(1, 58, 40, 340, 62);
    await page.waitForSelector('[data-testid="link-modal"]');
    await page.fill('[data-testid="link-url"]', 'https://example.com/adika');
    await page.click('[data-testid="link-create"]');
    await page.click('[data-testid="tool-link"]');
    await drag(1, 58, 110, 300, 128);
    await page.waitForSelector('[data-testid="link-modal"]');
    await page.selectOption('select[aria-label="Link to"]', 'page');
    await page.fill('[data-testid="link-page"]', '3');
    await page.click('[data-testid="link-create"]');
    const path = await saveAs(/sample\.pdf$/);
    const d = await openPdf(path);
    const links = (await (await d.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Link');
    assert(links.some((l) => l.url === 'https://example.com/adika'), `web link saved (${JSON.stringify(links.map((l) => l.url ?? l.dest))})`);
    const pageLink = links.find((l) => Array.isArray(l.dest));
    assert(pageLink && (await d.getPageIndex(pageLink.dest[0])) === 2, 'page link goes to page 3');
    await d.loadingTask.destroy();
  });

  test('tools: watermark, header & footer with page numbers, Bates, then remove them', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-edit"]');
    await page.click('[data-testid="btn-watermark"]');
    await page.waitForSelector('[data-testid="page-marks-modal"]');
    await page.fill('[data-testid="wm-text"]', 'CONFIDENȚIAL');
    let n = await toastCount();
    await page.click('[data-testid="marks-apply"]');
    await toastSince(/Added watermark/, n);
    await page.click('[data-testid="btn-header-footer"]');
    await page.waitForSelector('[data-testid="page-marks-modal"]');
    await page.fill('[data-testid="hf-headerLeft"]', 'Raport {file}');
    await page.getByText('Bates numbering (legal page stamps)').click();
    await page.fill('[data-testid="bates-prefix"]', 'ADK-');
    n = await toastCount();
    await page.click('[data-testid="marks-apply"]');
    await toastSince(/Added header/, n);
    const path = await saveAs(/sample\.pdf$/);
    const text = await pdfText(path);
    assert(text.every((t) => t.includes('CONFIDENȚIAL')), `watermark on every page (${text.map((t) => t.slice(0, 80)).join(' | ')})`);
    assert(text[0].includes('Page 1 of 3') && text[2].includes('Page 3 of 3'), 'footer page numbers');
    assert(text[1].includes('ADK-000002') && text[0].includes('Raport sample.pdf'), 'Bates number and header');
    assert(text[0].includes('Adika sample page 1'), 'original text kept');
    // Remove everything Adika added.
    await open(path);
    await page.click('[data-testid="tab-edit"]');
    n = await toastCount();
    await page.click('[data-testid="btn-remove-marks"]');
    await toastSince(/Removed \d+ page mark/, n);
    const cleaned = await saveAs(/sample\.pdf$/);
    const after = await pdfText(cleaned);
    assert(!after.some((t) => t.includes('CONFIDENȚIAL') || t.includes('ADK-')), 'marks removed');
    assert(after[0].includes('Adika sample page 1'), 'original text still there');
  });

  test('tools: crop pages by margins', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-organize"]');
    await page.click('[data-testid="btn-crop"]');
    await page.waitForSelector('[data-testid="crop-modal"]');
    for (const [k, v] of [['top', '20'], ['bottom', '20'], ['left', '10'], ['right', '10']]) await page.fill(`[data-testid="crop-${k}"]`, v);
    const n = await toastCount();
    await page.click('[data-testid="crop-apply"]');
    await toastSince(/Cropped/, n);
    const path = await saveAs(/sample\.pdf$/);
    const doc = await PDFDocument.load(readFileSync(path));
    const box = doc.getPages()[0].getCropBox();
    const mm = 72 / 25.4;
    assert(Math.abs(box.width - (595 - 20 * mm)) < 1 && Math.abs(box.height - (842 - 40 * mm)) < 1, `page 1 cropped (${JSON.stringify(box)})`);
    // Page 3 is shown rotated 90°: on-screen top/bottom come off the PDF's left/right edges.
    const box3 = doc.getPages()[2].getCropBox();
    assert(Math.abs(box3.width - (595 - 40 * mm)) < 1 && Math.abs(box3.height - (842 - 20 * mm)) < 1, `rotated page cropped as seen (${JSON.stringify(box3)})`);
  });

  test('tools: bookmarks can be added, renamed and saved as the outline', async () => {
    await open(F.sample);
    await page.click('[data-testid="sidebar-bookmarks"]');
    await S(() => {
      const s = window.__adika.store.getState();
      s.setCurrentPage(s.pages[1].id);
    });
    await page.click('[data-testid="bm-add"]');
    await page.waitForSelector('[data-testid="bm-title-input"]');
    await page.fill('[data-testid="bm-title-input"]', 'Capitolul doi');
    await page.keyboard.press('Enter');
    await S(() => {
      const s = window.__adika.store.getState();
      s.setCurrentPage(s.pages[2].id);
    });
    await page.click('[data-testid="bm-add"]');
    await page.fill('[data-testid="bm-title-input"]', 'Detalii');
    await page.keyboard.press('Enter');
    await page.click('[data-testid="bm-indent"]');
    const path = await saveAs(/sample\.pdf$/);
    const d = await openPdf(path);
    const o = await d.getOutline();
    assert(o?.length === 1 && o[0].title === 'Capitolul doi' && o[0].items[0]?.title === 'Detalii', `outline saved (${JSON.stringify(o?.map((x) => [x.title, x.items.map((y) => y.title)]))})`);
    assert((await d.getPageIndex(o[0].dest[0])) === 1 && (await d.getPageIndex(o[0].items[0].dest[0])) === 2, 'bookmarks point at their pages');
    await d.loadingTask.destroy();
  });

  test('tools: comments export to XFDF and import into another copy; summary and compare', async () => {
    const withComments = await savedFile(/sample\.pdf$/);
    // Use the file from the first tools test (it has stamps and shapes), exported as XFDF.
    await open(F.comments);
    await S(() => window.__adika.pageTools.exportComments('xfdf'));
    await idle();
    const xfdfPath = await savedFile(/comments\.xfdf$/);
    const xfdf = readFileSync(xfdfPath, 'utf8');
    assert(xfdf.includes('<xfdf') && xfdf.includes('Reviewed by legal'), 'XFDF written');
    // Import it into a clean document.
    await open(F.sample);
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), xfdfPath.split('\\').join('/'));
    let n = await toastCount();
    await S(() => window.__adika.pageTools.importComments());
    await toastSince(/Imported/, n);
    const imported = await saveAs(/sample\.pdf$/);
    const a = await annotsOf(imported);
    assert(a.some((x) => x.subtype === 'Text' && x.contentsObj?.str === 'Reviewed by legal'), `comment imported (${a.map((x) => x.subtype).join(',')})`);
    // Summary opens as a new document.
    await S(() => window.__adika.pageTools.summarizeCommentsAction());
    await idle();
    await page.waitForFunction(() => /comments\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 30000 });
    const summaryPath = await saveAs(/comments\.pdf$/);
    const st = (await pdfText(summaryPath)).join(' ');
    assert(st.includes('Reviewed by legal') && st.includes('Foxit user'), 'summary lists the comment and its author');
    // Compare the current version with the original sample.
    await open(withComments);
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), F.sample.split('\\').join('/'));
    await S(() => window.__adika.pageTools.compareWithFile());
    await idle();
    await page.waitForFunction(() => /compared\.pdf$/.test(window.__adika.store.getState().fileName ?? ''), null, { timeout: 30000 });
    const pages = await S(() => window.__adika.store.getState().pages.length);
    assert(pages === 4, `comparison report = summary + 3 pages (${pages})`);
  });
}
