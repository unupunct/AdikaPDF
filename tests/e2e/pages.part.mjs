// Print layouts, replace pages, bookmarks from headings, links from URLs, export images — included by suite.mjs.
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';

export function registerPageTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, F, pdfjs, FONT_DATA } = ctx;
  const waitSaved = (re) => page.waitForFunction((src) => window.__adika.platform.e2eSavedFiles().some((p) => new RegExp(src).test(p)), re.source, { timeout: 30000 });
  const make = async (name, draw) => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    await draw(d, font);
    const path = join(dir, name);
    writeFileSync(path, await d.save());
    return path;
  };

  test('print: booklet and 2 pages per sheet are laid out as vector sheets', async () => {
    await open(F.sample);
    await page.keyboard.press('Control+p');
    await page.waitForSelector('[data-testid="print-modal"]');
    await page.click('[data-testid="print-booklet"]');
    const summary = await page.textContent('[data-testid="print-summary"]');
    assert(/3 pages on 2 sheets/.test(summary), `booklet summary (${summary})`);
    await S(() => {
      window.__e2ePrinted = null;
      window.__adika.print.e2eInterceptPrint((b) => (window.__e2ePrinted = Array.from(b)));
    });
    await page.click('[data-testid="print-go"]');
    await page.waitForFunction(() => window.__e2ePrinted, null, { timeout: 20000 });
    const bytes = new Uint8Array(await S(() => window.__e2ePrinted));
    await S(() => window.__adika.print.e2eInterceptPrint(null));
    const booklet = await PD.load(bytes);
    const [w, h] = [booklet.getPage(0).getWidth(), booklet.getPage(0).getHeight()];
    assert(booklet.getPageCount() === 2 && w > h, `booklet: 2 landscape sheets (${booklet.getPageCount()}, ${w}x${h})`);
    // Several per sheet, saved as PDF.
    await page.keyboard.press('Control+p');
    await page.waitForSelector('[data-testid="print-modal"]');
    await page.click('[data-testid="print-nup"]');
    await page.click('[data-testid="print-save"]');
    await waitSaved(/sample-2-up.pdf$/);
    const nup = await PD.load(readFileSync(await savedFile(/sample-2-up\.pdf$/)));
    assert(nup.getPageCount() === 2, `2 per sheet: 3 pages on 2 sheets (${nup.getPageCount()})`);
    const t = await pdfText(await savedFile(/sample-2-up\.pdf$/));
    assert(t[0].includes('Adika sample page 1') && t[0].includes('Adika sample page 2') && t[1].includes('Adika sample page 3'), 'pages kept as text on the sheets');
  });

  test('replace pages: page 2 comes from another PDF, its comment stays, undo restores', async () => {
    const other = await make('replacement.pdf', async (d, font) => {
      for (const s of ['Replacement A', 'Replacement B']) d.addPage([595, 842]).drawText(s, { x: 60, y: 760, size: 22, font });
    });
    await open(F.sample);
    const p2 = await S(() => {
      const s = window.__adika.store.getState();
      s.addObject({ id: 'rp-note', type: 'text', pageId: s.pages[1].id, x: 60, y: 200, width: 200, height: 20, rotation: 0, opacity: 1, text: 'Checked', fontFamily: 'sans', bold: false, italic: false, fontSize: 12, color: '#000000', align: 'left', lineHeight: 1.25, background: null });
      s.setCurrentPage(s.pages[1].id);
      return s.pages[1].id;
    });
    await page.click('[data-testid="tab-organize"]');
    await page.click('[data-testid="btn-replace-pages"]');
    await page.waitForSelector('[data-testid="replace-pages-modal"]');
    assert((await page.inputValue('[data-testid="replace-pages-range"]')) === '2', 'current page proposed');
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), other.split('\\').join('/'));
    await page.click('[data-testid="replace-pages-file"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="replace-pages-modal"]')?.textContent.includes('replacement.pdf'));
    await page.click('[data-testid="replace-pages-go"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="replace-pages-modal"]'), null, { timeout: 15000 });
    const st = await S(() => {
      const s = window.__adika.store.getState();
      return { n: s.pages.length, id: s.pages[1].id, src: s.pages[1].sourceId, first: s.pages[0].sourceId, note: s.objects.find((o) => o.id === 'rp-note')?.pageId };
    });
    assert(st.n === 3 && st.id === p2 && st.src !== st.first && st.note === p2, `page 2 replaced, comment kept (${JSON.stringify(st)})`);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const t = await pdfText(await savedFile(/sample\.pdf$/));
    assert(t[1].includes('Replacement A') && t[1].includes('Checked') && !t[1].includes('Adika sample page 2'), `saved page 2 (${t[1]})`);
    assert(t[0].includes('Adika sample page 1') && t[2].includes('Adika sample page 3'), 'other pages unchanged');
    await page.keyboard.press('Control+z');
    const back = await S(() => window.__adika.store.getState().pages.map((p) => p.sourceId));
    assert(new Set(back).size === 1, 'undo brings the original page back');
  });

  test('bookmarks from headings and links from web addresses', async () => {
    const path = await make('structured.pdf', async (d, font) => {
      const bold = await d.embedFont(StandardFonts.HelveticaBold);
      const p1 = d.addPage([595, 842]);
      p1.drawText('Annual report', { x: 60, y: 770, size: 26, font: bold });
      p1.drawText('1. Introduction', { x: 60, y: 720, size: 16, font: bold });
      for (let i = 0; i < 10; i++) p1.drawText('Regular body text of the report, long enough to be the body size.', { x: 60, y: 690 - i * 16, size: 11, font });
      p1.drawText('Details at https://example.com/adika and write to ana.pop@firma.ro today.', { x: 60, y: 500, size: 11, font });
      const p2 = d.addPage([595, 842]);
      p2.drawText('2. Results', { x: 60, y: 770, size: 16, font: bold });
      p2.drawText('Regular body text of the report, long enough to be the body size.', { x: 60, y: 740, size: 11, font });
    });
    await open(path);
    await page.click('[data-testid="tab-organize"]');
    await page.click('[data-testid="btn-auto-bookmarks"]');
    await page.waitForFunction(() => (window.__adika.store.getState().outline ?? []).length > 0, null, { timeout: 20000 });
    const tree = await S(() => {
      const flat = (t, d = 0) => t.flatMap((i) => [`${'-'.repeat(d)}${i.title}`, ...flat(i.children, d + 1)]);
      return flat(window.__adika.store.getState().outline);
    });
    assert(JSON.stringify(tree) === JSON.stringify(['Annual report', '-1. Introduction', '-2. Results']), `bookmark tree (${tree.join(' | ')})`);
    await page.click('[data-testid="btn-auto-links"]');
    await page.waitForFunction(() => window.__adika.store.getState().objects.filter((o) => o.type === 'link').length === 2, null, { timeout: 20000 });
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(await savedFile(/structured\.pdf$/))), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
    const urls = (await (await d.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Link').map((a) => a.url ?? a.unsafeUrl);
    const outline = await d.getOutline();
    await d.loadingTask.destroy();
    assert(urls.includes('https://example.com/adika') && urls.includes('mailto:ana.pop@firma.ro'), `links saved (${urls.join(', ')})`);
    assert(outline?.length === 1 && outline[0].title === 'Annual report' && outline[0].items.length === 2, 'outline saved in the PDF');
    // Running it again adds nothing new.
    await page.click('[data-testid="btn-auto-links"]');
    await page.waitForFunction(() => window.__adika.store.getState().toasts.some((t) => /No new web or e-mail addresses/.test(t.message)), null, { timeout: 20000 });
  });

  test('edit image: a picture already in the PDF is moved, saved in its new place, undo restores it', async () => {
    const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const path = await make('logo.pdf', async (d, font) => {
      const img = await d.embedJpg(new Uint8Array(jpg));
      const p = d.addPage([595, 842]);
      p.drawText('Company letter', { x: 60, y: 760, size: 20, font });
      p.drawImage(img, { x: 100, y: 500, width: 200, height: 100 }); // display: x 100..300, y 242..342
    });
    await open(path);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    const before = await S(() => window.__adika.store.getState().pages[0].sourceId);
    await page.click('[data-testid="tab-edit"]');
    await page.click('[data-testid="tool-editImage"]');
    const box = await (await page.$('[data-testid="page-1"]')).boundingBox();
    await page.mouse.click(box.x + 200, box.y + 290);
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'image'), null, { timeout: 15000 });
    const obj = await S(() => {
      const o = window.__adika.store.getState().objects.find((x) => x.type === 'image');
      return { x: Math.round(o.x), y: Math.round(o.y), w: Math.round(o.width), h: Math.round(o.height), jpeg: o.src.startsWith('data:image/jpeg'), sel: window.__adika.store.getState().selectedIds.includes(o.id) };
    });
    assert(obj.x === 100 && obj.y === 242 && obj.w === 200 && obj.h === 100 && obj.jpeg && obj.sel, `picture lifted with its exact frame (${JSON.stringify(obj)})`);
    // Move it 150 pt to the right.
    await S(() => {
      const s = window.__adika.store.getState();
      const o = s.objects.find((x) => x.type === 'image');
      s.updateObject(o.id, { x: o.x + 150 });
    });
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(await savedFile(/logo\.pdf$/))), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
    const ops = await (await d.getPage(1)).getOperatorList();
    const text = (await (await d.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    await d.loadingTask.destroy();
    // Follow the transformation to each painted image.
    const O = pdfjs.OPS;
    let m = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const placed = [];
    ops.fnArray.forEach((fn, i) => {
      const a = ops.argsArray[i];
      if (fn === O.save) stack.push(m);
      else if (fn === O.restore) m = stack.pop() ?? m;
      else if (fn === O.transform) m = [a[0] * m[0] + a[1] * m[2], a[0] * m[1] + a[1] * m[3], a[2] * m[0] + a[3] * m[2], a[2] * m[1] + a[3] * m[3], a[4] * m[0] + a[5] * m[2] + m[4], a[4] * m[1] + a[5] * m[3] + m[5]];
      else if (fn === O.paintImageXObject || fn === O.paintJpegXObject) placed.push(m.map((v) => Math.round(v)));
    });
    assert(placed.length === 1, `the picture is drawn once (${JSON.stringify(placed)})`);
    assert(placed[0][0] === 200 && placed[0][3] === 100 && placed[0][4] === 250 && placed[0][5] === 500, `at its new place (${JSON.stringify(placed[0])})`);
    assert(text.includes('Company letter'), 'text untouched');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    const after = await S(() => ({ src: window.__adika.store.getState().pages[0].sourceId, imgs: window.__adika.store.getState().objects.filter((o) => o.type === 'image').length }));
    assert(after.src === before && after.imgs === 0, `undo puts the picture back in the page (${JSON.stringify(after)})`);
  });

  test('export images: every picture into one ZIP, JPEGs as stored', async () => {
    const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const path = await make('pictures.pdf', async (d) => {
      const img = await d.embedJpg(new Uint8Array(jpg));
      for (let i = 0; i < 2; i++) d.addPage([300, 300]).drawImage(img, { x: 20, y: 20, width: 100, height: 100 });
    });
    await open(path);
    await page.click('[data-testid="tab-convert"]');
    await page.click('[data-testid="btn-export-images"]');
    await waitSaved(/pictures-images.zip$/);
    const zip = await JSZip.loadAsync(readFileSync(await savedFile(/pictures-images\.zip$/)));
    const names = Object.keys(zip.files);
    assert(names.length === 1 && names[0] === 'page1-image1.jpg', `one picture, used twice, exported once (${names.join(', ')})`);
    const out = await zip.file(names[0]).async('nodebuffer');
    assert(out.equals(jpg), 'JPEG bytes exactly as stored');
  });
}
