// Phase 1 "real reader" tests — included by suite.mjs.
import { PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts } from 'pdf-lib';

/** 3 pages: bookmarks, internal + external links, page labels i/1/2, an attachment. */
export async function makeReaderFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3].map((i) => {
    const p = doc.addPage([595, 842]);
    p.drawText(`Chapter ${i} heading`, { x: 60, y: 760, size: 24, font });
    p.drawText(`Body text of chapter ${i}: Invoice Total and invoices.`, { x: 60, y: 720, size: 12, font });
    return p;
  });
  pages[0].drawText('Go to chapter 3', { x: 60, y: 660, size: 14, font });
  pages[0].drawText('Visit example.com', { x: 60, y: 620, size: 14, font });
  const ctx = doc.context;
  const internal = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [55, 655, 200, 675], Border: [0, 0, 0], Dest: [pages[2].ref, PDFName.of('XYZ'), 0, 842, 0] }));
  const external = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [55, 615, 200, 635], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') } }));
  pages[0].node.set(PDFName.of('Annots'), ctx.obj([internal, external]));
  const outlineRef = ctx.nextRef();
  const items = pages.map(() => ctx.nextRef());
  pages.forEach((p, i) => {
    const d = { Title: PDFHexString.fromText(`Chapter ${i + 1}`), Parent: outlineRef, Dest: [p.ref, PDFName.of('Fit')] };
    if (i > 0) d.Prev = items[i - 1];
    if (i < 2) d.Next = items[i + 1];
    ctx.assign(items[i], ctx.obj(d));
  });
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: items[0], Last: items[2], Count: 3 }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, ctx.obj({ S: 'r' }), 1, ctx.obj({ S: 'D' })] }));
  await doc.attach(new TextEncoder().encode('invoice data,42\n'), 'data.csv', { mimeType: 'text/csv', description: 'Source data' });
  return doc.save();
}

export function registerReaderTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, readFileSync, PDFDocument: PD, F, pdfjs, FONT_DATA } = ctx;
  const state = () => S(() => { const s = window.__adika.store.getState(); return { page: s.pages.findIndex((p) => p.id === s.currentPageId) + 1, pages: s.pages.length, toasts: s.toasts.map((t) => t.message), tool: s.tool, modal: s.modal }; });
  const currentPage = async () => (await state()).page;
  const waitPage = (n) => page.waitForFunction((k) => { const s = window.__adika.store.getState(); return s.pages.findIndex((p) => p.id === s.currentPageId) + 1 === k; }, n, { timeout: 8000 });

  test('reader: selects and copies text with the Select text tool', async () => {
    await open(F.reader);
    assert((await state()).tool === 'selectText', 'documents open in the Select text tool');
    await page.waitForSelector('[data-page-id] .textLayer span', { timeout: 10000 });
    const span = await page.$('[data-testid="page-1"] .textLayer span');
    const box = await span.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const selected = await S(() => window.getSelection().toString());
    assert(/Chapter 1/.test(selected), `drag-selected “${selected}”`);
    const copied = await S(() => new Promise((resolve) => {
      document.addEventListener('copy', () => resolve(window.getSelection().toString()), { once: true });
      document.execCommand('copy');
    }));
    assert(/Chapter 1/.test(copied), 'Ctrl+C copies the selection');
    await page.keyboard.press('Control+a');
    const all = await S(() => window.getSelection().toString());
    assert(all.includes('Body text of chapter 1') && all.includes('Visit example.com'), 'Ctrl+A selects all text on the page');
  });

  test('reader: internal link jumps, Back/Forward return, external link asks first', async () => {
    await open(F.reader);
    const link = await page.waitForSelector('[data-testid="page-1"] [data-testid="pdf-link"]', { timeout: 10000 });
    await link.click();
    await waitPage(3);
    await page.keyboard.press('Alt+ArrowLeft');
    await waitPage(1);
    await page.keyboard.press('Alt+ArrowRight');
    await waitPage(3);
    await S(() => window.__adika.store.getState().scrollToPage(window.__adika.store.getState().pages[0].id));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="page-1"] [data-testid="pdf-link"]').length === 2, null, { timeout: 8000 });
    const links = await page.$$('[data-testid="page-1"] [data-testid="pdf-link"]');
    assert(links.length === 2, `two links on page 1 (${links.length})`);
    await links[1].click();
    await page.waitForSelector('[data-testid="confirm-prompt"]');
    assert((await page.textContent('[data-testid="confirm-prompt"]')).includes('https://example.com/'), 'asks before opening the web link');
    await page.keyboard.press('Escape');
  });

  test('reader: bookmarks panel navigates by chapter', async () => {
    await open(F.reader);
    await page.click('[data-testid="sidebar-bookmarks"]');
    await page.waitForSelector('[data-testid="outline-item"]');
    const titles = await page.$$eval('[data-testid="outline-item"]', (els) => els.map((e) => e.textContent));
    assert(titles.join() === 'Chapter 1,Chapter 2,Chapter 3', `bookmarks ${titles}`);
    await page.click('[data-testid="outline-item"]:has-text("Chapter 3")');
    await waitPage(3);
  });

  test('reader: page labels in thumbnails and the go-to-page box (label or number)', async () => {
    await open(F.reader);
    await page.click('[data-testid="sidebar-pages"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="thumb-label-1"]')?.textContent === 'i', null, { timeout: 8000 });
    await page.click('[data-testid="tab-home"]');
    await page.fill('[data-testid="page-input"]', '2');
    await page.keyboard.press('Enter');
    await waitPage(3); // label "2" is the third page
    await page.keyboard.press('Control+g');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'page-input');
    await page.keyboard.type('i');
    await page.keyboard.press('Enter');
    await waitPage(1);
    const count = await page.textContent('[data-testid="page-count"]');
    assert(/1 of 3/.test(count), `shows position next to the label (${count})`);
  });

  test('reader: attachments panel lists and saves embedded files', async () => {
    await open(F.reader);
    await page.click('[data-testid="sidebar-attachments"]');
    await page.waitForSelector('[data-testid="attachment-name"]');
    assert((await page.textContent('[data-testid="attachment-name"]')) === 'data.csv', 'attachment listed');
    // The content is read lazily from pdf.js; retry the click once if the first
    // one landed while the panel was still re-rendering after the tab switch.
    const before = await page.evaluate(() => window.__adika.platform.e2eSavedFiles().length);
    const saved = () => page.waitForFunction((n) => window.__adika.platform.e2eSavedFiles().slice(n).some((p) => /data( \(\d+\))?\.csv$/.test(p)), before, { timeout: 6000 });
    await page.click('[data-testid="attachments-panel"] button:has-text("Save")');
    await saved().catch(async () => {
      await page.click('[data-testid="attachments-panel"] button:has-text("Save")');
      await saved();
    });
    const path = await savedFile(/data( \(\d+\))?\.csv$/);
    assert(readFileSync(path, 'utf8').includes('invoice data'), 'attachment saved');
  });

  test('reader: layers panel hides a CAD layer', async () => {
    const dxf = join(dir, 'layers.dxf');
    writeFileSync(dxf, ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '0', 'LAYER', '2', 'Walls', '70', '0', '62', '7', '6', 'CONTINUOUS', '0', 'LAYER', '2', 'Notes', '70', '0', '62', '7', '6', 'CONTINUOUS', '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      ...Array.from({ length: 40 }, (_, k) => ['0', 'LINE', '8', 'Walls', '10', String(k * 5), '20', '0', '11', String(k * 5), '21', '100']).flat(),
      '0', 'TEXT', '8', 'Notes', '10', '10', '20', '110', '40', '6', '1', 'Note', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), dxf.split('\\').join('/'));
    await S(() => window.__adika.convert.importDxf({ paper: 'A4', orientation: 'landscape', marginMm: 10, blackOnWhite: true, lineWeightMm: 0.5, layers: true }, false));
    await idle();
    const dark = () => S(() => { const c = document.querySelector('[data-testid="page-1"] canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; });
    await page.waitForFunction(() => !document.querySelector('[data-testid="page-1"]')?.textContent?.includes('Loading'));
    await page.waitForTimeout(500);
    const before = await dark();
    await page.click('[data-testid="sidebar-layers"]');
    await page.waitForSelector('[data-testid="layer-toggle"]');
    const names = await page.$$eval('[data-testid="layer-row"]', (els) => els.map((e) => e.textContent.trim()));
    assert(names.includes('Walls') && names.includes('Notes'), `layers listed ${names}`);
    await page.click('[data-testid="layer-row"]:has-text("Walls") input');
    await page.waitForTimeout(900);
    const after = await dark();
    assert(after < before * 0.5, `hiding “Walls” removes its lines (${before} → ${after} dark px)`);
  });

  test('reader: search options (match case, whole word) and results list', async () => {
    await open(F.reader);
    const count = (q, o) => S(({ q, o }) => { const st = window.__adika.store.getState(); return window.__adika.search.searchDocument(st.pages, q, { cancelled: false }, o).then((h) => h.length); }, { q, o });
    assert((await count('invoice', {})) === 6, 'case-insensitive finds Invoice + invoices');
    assert((await count('invoice', { caseSensitive: true })) === 3, 'match case finds only “invoice…”');
    assert((await count('invoice', { wholeWord: true })) === 3, 'whole word skips “invoices”');
    await page.keyboard.press('Control+f');
    await page.fill('[data-testid="search-input"]', 'chapter 2');
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector('[data-testid="search-count"]')?.textContent ?? ''));
    await page.click('[data-testid="search-list"]');
    await page.waitForSelector('[data-testid="search-result"]');
    const n = await page.$$eval('[data-testid="search-result"]', (e) => e.length);
    assert(n >= 1, 'results listed in the sidebar');
    assert((await page.textContent('[data-testid="search-result"] mark')).toLowerCase() === 'chapter 2', 'match highlighted in the snippet');
    await page.keyboard.press('Escape');
  });

  test('reader: tabs keep documents and edits separate', async () => {
    await open(F.reader);
    await S((p) => window.__adika.document.openPdfPath(p), F.sample);
    await idle();
    let tabs = await page.$$('[data-testid="doc-tab"]');
    assert(tabs.length === 2, `two tabs (${tabs.length})`);
    await S(() => { const s = window.__adika.store.getState(); s.addObject({ id: 'tab-rect', type: 'rect', pageId: s.pages[0].id, x: 20, y: 20, width: 40, height: 40, rotation: 0, opacity: 1, stroke: '#ff0000', strokeWidth: 2, fill: null }); });
    await tabs[0].click();
    const first = await S(() => ({ name: window.__adika.store.getState().fileName, objects: window.__adika.store.getState().objects.length }));
    assert(first.name === 'reader.pdf' && first.objects === 0, `first tab untouched (${JSON.stringify(first)})`);
    await page.keyboard.press('Control+Tab');
    const second = await S(() => ({ name: window.__adika.store.getState().fileName, objects: window.__adika.store.getState().objects.length, dirty: window.__adika.store.getState().dirty }));
    assert(second.name === 'sample.pdf' && second.objects === 1 && second.dirty, 'second tab keeps its edit');
    await page.keyboard.press('Control+w');
    await page.waitForSelector('[data-testid="confirm-prompt"]');
    await page.click('[data-testid="confirm-ok"]');
    tabs = await page.$$('[data-testid="doc-tab"]');
    assert(tabs.length === 1 && (await S(() => window.__adika.store.getState().fileName)) === 'reader.pdf', 'closing the dirty tab asked, then closed it');
  });

  test('reader: recent files on the welcome screen reopen documents', async () => {
    await open(F.reader);
    await S(() => { const t = window.__adika.tabs; for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id); });
    await page.waitForSelector('[data-testid="recent-item"]');
    const names = await page.$$eval('[data-testid="recent-item"]', (els) => els.map((e) => e.textContent));
    assert(names[0].includes('reader.pdf'), `most recent first (${names[0]})`);
    await page.click('[data-testid="recent-item"]');
    await page.waitForFunction(() => window.__adika.store.getState().fileName === 'reader.pdf');
  });

  test('reader: two-page, book and single-page layouts, night mode, rotate view', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-view"]');
    const top = async (n) => {
      // Vertical centre: pages of different heights are centred within their row.
      const b = await (await page.$(`[data-testid="page-${n}"]`))?.boundingBox();
      return b ? b.y + b.height / 2 : NaN;
    };
    const left = async (n) => (await (await page.$(`[data-testid="page-${n}"]`))?.boundingBox())?.x;
    await page.click('[data-testid="view-two"]');
    await page.waitForTimeout(300);
    assert(Math.abs((await top(1)) - (await top(2))) < 2 && (await left(2)) > (await left(1)), 'two pages side by side');
    await page.click('[data-testid="view-book"]');
    await page.waitForTimeout(300);
    assert(Math.abs((await top(2)) - (await top(3))) < 2 && (await top(1)) < (await top(2)), 'book view: cover alone, then 2+3');
    await page.click('[data-testid="view-single"]');
    await page.waitForTimeout(300);
    assert((await page.$$('[data-page-id]')).length === 1, 'single page shows one page');
    await page.keyboard.press('PageDown');
    await waitPage(2);
    await page.click('[data-testid="view-continuous"]');
    await page.click('[data-testid="btn-night"]');
    const filter = await S(() => getComputedStyle(document.querySelector('[data-testid="page-1"] canvas')).filter);
    assert(/invert/.test(filter), 'night mode inverts page colours');
    await page.click('[data-testid="btn-night"]');
    await page.click('[data-testid="btn-rotate-view-right"]');
    await page.waitForTimeout(300);
    const rot = await S(() => document.querySelector('[data-testid="page-1"]').parentElement.style.transform);
    assert(rot.includes('90deg'), `view rotated (${rot})`);
    await S(() => window.__adika.store.getState().setTool('rect'));
    assert((await state()).tool !== 'rect', 'editing tools are blocked while the view is rotated');
    const saved = await S(() => window.__adika.store.getState().pages[0].userRotation);
    assert(saved === 0, 'the file rotation is untouched');
    await S(() => window.__adika.store.getState().setView({ viewRotation: 0 }));
  });

  test('reader: full screen and presentation mode', async () => {
    await open(F.sample);
    await page.keyboard.press('F11');
    await page.waitForFunction(() => window.__adika.store.getState().fullscreen && !document.querySelector('[data-testid="tab-home"]'));
    await page.keyboard.press('F11');
    await page.waitForSelector('[data-testid="tab-home"]');
    await S(() => window.__adika.store.getState().scrollToPage(window.__adika.store.getState().pages[0].id));
    await page.keyboard.press('F5');
    await page.waitForSelector('[data-testid="presentation"]');
    await page.keyboard.press('ArrowRight');
    await waitPage(2);
    await page.keyboard.press('ArrowRight');
    await waitPage(3);
    await page.keyboard.press('ArrowLeft');
    await waitPage(2);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="presentation"]'));
  });

  test('reader: print prepares the edited PDF, and the PDF print engine is available', async () => {
    await open(F.sample);
    await S(() => { const s = window.__adika.store.getState(); s.addObject({ id: 'pr-text', type: 'text', pageId: s.pages[0].id, x: 50, y: 50, width: 300, height: 24, rotation: 0, opacity: 1, text: 'Printed edit', fontFamily: 'sans', bold: false, italic: false, fontSize: 16, color: '#000000', align: 'left', lineHeight: 1.25, background: null }); });
    const printed = await S(async () => {
      let got = null;
      window.__adika.print.e2eInterceptPrint((b) => (got = b));
      await window.__adika.print.printDocument();
      window.__adika.print.e2eInterceptPrint(null);
      return got ? Array.from(got) : null;
    });
    assert(printed, 'print produced a PDF');
    const d = await pdfjs.getDocument({ data: Uint8Array.from(printed), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
    const t = (await (await d.getPage(1)).getTextContent()).items.map((x) => x.str).join(' ');
    assert(d.numPages === 3 && t.includes('Printed edit'), 'printed PDF includes the edits');
    await d.loadingTask.destroy();
    // The Edge PDF engine loads blob PDFs in a frame (what the real print path uses).
    const engine = await S(async (bytes) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-2000px;width:600px;height:400px';
      document.body.append(f);
      const loaded = await new Promise((r) => { f.onload = () => r(true); setTimeout(() => r(false), 8000); f.src = url; });
      const embed = !!f.contentDocument?.querySelector('embed, iframe');
      f.remove();
      return { loaded, embed };
    }, printed);
    assert(engine.loaded, `PDF engine frame loaded (${JSON.stringify(engine)})`);
  });

  test('reader: document properties show metadata and fonts; edits are saved', async () => {
    await open(F.sample);
    await page.keyboard.press('Control+d');
    await page.waitForSelector('[data-testid="properties-modal"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="properties-list"]')?.textContent?.includes('PDF version'));
    const txt = await page.textContent('[data-testid="properties-list"]');
    assert(txt.includes('3') && /210 × 297 mm/.test(txt), `properties list (${txt.slice(0, 160)})`);
    await page.click('[data-testid="properties-modal"] [role="tab"]:has-text("Fonts")');
    await page.waitForSelector('[data-testid="properties-fonts"] td');
    const fonts = await page.textContent('[data-testid="properties-fonts"]');
    assert(/Helvetica/.test(fonts) && /Not embedded/.test(fonts), `fonts listed (${fonts.slice(0, 120)})`);
    await page.click('[data-testid="properties-modal"] [role="tab"]:has-text("Description")');
    await page.fill('[data-testid="prop-title"]', 'Raport trimestrial');
    await page.fill('[data-testid="prop-author"]', 'Ana Pop');
    await page.click('[data-testid="properties-apply"]');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/sample\.pdf$/)));
    assert(out.getTitle() === 'Raport trimestrial' && out.getAuthor() === 'Ana Pop', `saved metadata (${out.getTitle()}, ${out.getAuthor()})`);
  });

  test('reader: reloads automatically when the file changes on disk', async () => {
    const live = join(dir, 'live.pdf');
    const make = async (n) => { const d = await PD.create(); const f = await d.embedFont(StandardFonts.Helvetica); for (let i = 0; i < n; i++) d.addPage([300, 300]).drawText(`Live version ${n}`, { x: 20, y: 150, size: 14, font: f }); return d.save(); };
    writeFileSync(live, await make(1));
    await open(live);
    assert((await state()).pages === 1, 'opened version 1');
    await new Promise((r) => setTimeout(r, 1200));
    writeFileSync(live, await make(4));
    await page.waitForFunction(() => window.__adika.store.getState().pages.length === 4, null, { timeout: 10000 });
    await page.waitForFunction(() => window.__adika.store.getState().toasts.some((t) => /Reloaded/.test(t.message)), null, { timeout: 5000 });
    assert((await state()).pages === 4, 'reloaded the new version');
  });

  test('reader: repairs a damaged PDF that would not open', async () => {
    const good = readFileSync(F.sample);
    const noXref = join(dir, 'no-xref.pdf');
    const text = good.toString('latin1');
    const cut = text.lastIndexOf('xref');
    writeFileSync(noXref, cut > 0 ? good.subarray(0, cut) : good.subarray(0, Math.floor(good.length * 0.9)));
    await open(noXref);
    const s = await state();
    assert(s.pages >= 1, `damaged file opened with ${s.pages} page(s)`);
    assert(s.toasts.some((m) => /repaired/i.test(m)), `user told it was repaired (${s.toasts.join(' | ')})`);
  });
}
