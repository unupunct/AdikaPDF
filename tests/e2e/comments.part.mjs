// Comment tab, one-click Tools, and logging — included by suite.mjs.
import { PDFDocument as PD, PDFName, PDFHexString, StandardFonts } from 'pdf-lib';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import JSZip from 'jszip';

/** Text page + one "foreign" sticky note written by another app. */
export async function makeCommentFixture() {
  const doc = await PD.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Contract terms and conditions', { x: 60, y: 760, size: 22, font });
  p.drawText('The supplier delivers the goods within thirty days of the order.', { x: 60, y: 720, size: 12, font });
  const ctx = doc.context;
  const foreign = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], Contents: PDFHexString.fromText('Reviewed by legal'), T: PDFHexString.fromText('Foxit user'), M: '(D:20260901120000Z)', Name: 'Comment' }));
  p.node.set(PDFName.of('Annots'), ctx.obj([foreign]));
  return doc.save();
}

export function registerCommentTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, F, pdfjs, FONT_DATA } = ctx;

  const annotsOf = async (path) => {
    const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
    const a = await (await d.getPage(1)).getAnnotations();
    await d.loadingTask.destroy();
    return a;
  };
  const pagePoint = async (x, y) => {
    const b = await (await page.$('[data-testid="page-1"]')).boundingBox();
    const z = await S(() => window.__adika.store.getState().zoom);
    return { x: b.x + x * z, y: b.y + y * z };
  };

  test('comments: note, typewriter and text markup are saved as real PDF annotations', async () => {
    await open(F.comments);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-comment"]');
    // Note
    await page.click('[data-testid="tool-note"]');
    let pt = await pagePoint(300, 300);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('[data-testid="note-text"]');
    await page.keyboard.type('Check the delivery term — termen de livrare');
    await page.keyboard.press('Control+Enter');
    // Typewriter
    await page.click('[data-testid="tool-typewriter"]');
    pt = await pagePoint(60, 400);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('[data-testid="text-editor"]');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
    await page.keyboard.type('Aprobat, semnat: Ana');
    pt = await pagePoint(400, 780);
    await page.mouse.click(pt.x, pt.y);
    // Highlight via tool: select the second line with the Highlight tool active.
    await page.click('[data-testid="tool-markup-highlight"]');
    await page.waitForSelector('[data-testid="page-1"] .textLayer span');
    const spans = await page.$$('[data-testid="page-1"] .textLayer span');
    const b = await spans[1].boundingBox();
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'markup'));
    // Underline via the selection toolbar in Select text mode.
    await page.click('[data-testid="tool-selectText"]');
    const b0 = await spans[0].boundingBox();
    await page.mouse.move(b0.x + 2, b0.y + b0.height / 2);
    await page.mouse.down();
    await page.mouse.move(b0.x + b0.width - 2, b0.y + b0.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('[data-testid="selection-toolbar"]');
    await page.click('[data-testid="sel-underline"]');
    const objs = await S(() => window.__adika.store.getState().objects.map((o) => ({ type: o.type, kind: o.kind, text: o.text, sel: o.selectedText, author: o.author, annotation: o.annotation })));
    assert(objs.some((o) => o.type === 'note' && o.text.includes('termen de livrare')), `note created (${JSON.stringify(objs)})`);
    assert(objs.some((o) => o.type === 'text' && o.annotation && o.text === 'Aprobat, semnat: Ana'), 'typewriter created');
    assert(objs.some((o) => o.type === 'markup' && o.kind === 'highlight' && /supplier/.test(o.sel)), 'highlight created from the selection');
    assert(objs.some((o) => o.type === 'markup' && o.kind === 'underline' && /Contract/.test(o.sel)), 'underline created from the selection toolbar');
    // Comments panel lists new + existing (foreign) comments.
    await page.click('[data-testid="btn-comments"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-row"]').length >= 5, null, { timeout: 8000 });
    const panel = await page.textContent('[data-testid="comments-panel"]');
    assert(panel.includes('Reviewed by legal') && panel.includes('Foxit user'), 'existing comment from another app listed');
    // Save and check the annotations with pdf.js (what other readers see).
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const annots = await annotsOf(await savedFile(/comments\.pdf$/));
    const byType = (t) => annots.filter((a) => a.subtype === t);
    const note = byType('Text').find((a) => /termen de livrare/.test(a.contentsObj?.str ?? ''));
    assert(note && note.titleObj?.str, `Text annotation with author (${annots.map((a) => a.subtype).join(',')})`);
    assert(byType('Text').some((a) => a.contentsObj?.str === 'Reviewed by legal'), 'foreign note kept');
    assert(byType('FreeText').some((a) => a.contentsObj?.str === 'Aprobat, semnat: Ana'), 'FreeText (typewriter) annotation');
    const hl = byType('Highlight')[0];
    assert(hl && hl.quadPoints?.length >= 1, 'Highlight annotation with QuadPoints');
    assert(byType('Underline').length === 1, 'Underline annotation');
    assert(byType('Popup').length >= 1, 'note has a popup');
  });

  test('comments: saved annotations render and reappear as comments after reopening', async () => {
    const path = await savedFile(/comments\.pdf$/);
    await open(path);
    await page.click('[data-testid="sidebar-comments"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-row"]').length >= 5, null, { timeout: 8000 });
    const kinds = await page.$$eval('[data-testid="comment-row"]', (els) => els.map((e) => e.textContent));
    assert(kinds.some((k) => /Note.*termen de livrare/.test(k)) && kinds.some((k) => /Typewriter/.test(k)) && kinds.some((k) => /Highlight/.test(k)), `comments after reopen: ${kinds.join(' | ').slice(0, 300)}`);
    // The highlight's appearance is drawn on the page (yellow pixels near the text).
    const yellow = await S(() => {
      const c = document.querySelector('[data-testid="page-1"] canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      // Translucent highlight on white paper: pale yellow (high R/G, clearly lower B).
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 200 && d[i + 2] < 200 && d[i] - d[i + 2] > 50) n++;
      return n;
    });
    assert(yellow > 300, `highlight is visible after reopening (${yellow} yellow px)`);
  });

  // Not run yet (added in 1.11.0 without a release build).
  test('comments: edit and delete comments already in the file, with undo', async () => {
    const before = await annotsOf(await savedFile(/comments\.pdf$/));
    const foreign = before.find((a) => a.contentsObj?.str === 'Reviewed by legal');
    const rowWith = (re) => page.evaluateHandle((src) => [...document.querySelectorAll('[data-testid="comment-row"]')].find((e) => new RegExp(src).test(e.textContent)), re.source);
    // Edit: the foreign note becomes an editor object; the original is hidden in the viewer.
    await (await (await rowWith(/Reviewed by legal/)).asElement().$('[data-testid="comment-edit"]')).click();
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.fileAnnot && o.type === 'note'), null, { timeout: 8000 });
    assert(await S(() => window.__adika.store.getState().pages[0].takenAnnots?.length === 1), 'note taken over');
    await page.waitForSelector('[data-testid="inspector-file-comment"]');
    await page.click('[data-testid="inspector-note-text"]', { clickCount: 3 });
    await page.keyboard.type('Reviewed by legal, approved');
    // Move it with the keyboard-free path: the store, as a drag would.
    await S(() => {
      const s = window.__adika.store.getState();
      const o = s.objects.find((x) => x.fileAnnot);
      s.updateObject(o.id, { x: o.x - 100 });
    });
    // Delete the highlight (with any replies).
    await (await (await rowWith(/Highlight/)).asElement().$('[data-testid="comment-delete"]')).click();
    await page.waitForFunction(() => window.__adika.store.getState().pages[0].takenAnnots?.length >= 2, null, { timeout: 8000 });
    // Undo brings the highlight back, redo deletes it again.
    await page.keyboard.press('Control+z');
    assert(await S(() => window.__adika.store.getState().pages[0].takenAnnots?.length === 1), 'undo restores the highlight');
    await page.keyboard.press('Control+y');
    assert(await S(() => window.__adika.store.getState().pages[0].takenAnnots?.length >= 2), 'redo deletes it again');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const after = await annotsOf(await savedFile(/comments\.pdf$/));
    const note = after.find((a) => a.id === foreign.id);
    assert(note && note.contentsObj?.str === 'Reviewed by legal, approved' && note.titleObj?.str === 'Foxit user', `edited in place (${note?.contentsObj?.str})`);
    assert(note.rect[0] < foreign.rect[0] - 50, 'moved');
    assert(!after.some((a) => a.subtype === 'Highlight'), 'highlight deleted');
    assert(after.some((a) => a.subtype === 'FreeText' && a.contentsObj?.str === 'Aprobat, semnat: Ana'), 'other comments untouched');
  });

  test('tools: PDF to Word / JPG / PPT / Excel from the Tools hub', async () => {
    await S(() => { const t = window.__adika.tabs; for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id); });
    await page.click('[data-testid="tab-home"]');
    for (const [tool, re, check] of [
      ['pdf-word', /sample\.docx$/, async (p) => (await (await JSZip.loadAsync(readFileSync(p))).file('word/document.xml').async('string')).includes('Invoice Total')],
      ['pdf-excel', /sample\.xlsx$/, async (p) => (await (await JSZip.loadAsync(readFileSync(p))).file('xl/worksheets/sheet1.xml').async('string')).includes('Invoice')],
      ['pdf-ppt', /sample\.pptx$/, async (p) => Object.keys((await JSZip.loadAsync(readFileSync(p))).files).some((n) => n.startsWith('ppt/slides/slide3'))],
      ['pdf-jpg', /sample-jpg\.zip$/, async (p) => Object.keys((await JSZip.loadAsync(readFileSync(p))).files).filter((n) => /\.jpe?g$/.test(n)).length === 3],
    ]) {
      await S((p) => window.__adika.platform.e2eQueuePicks([p]), F.sample.split('\\').join('/'));
      await page.click('[data-testid="btn-tools"]');
      await page.click(`[data-testid="tools-modal"] [data-testid="quick-${tool}"]`);
      await page.waitForFunction((r) => window.__adika.platform.e2eSavedFiles().some((f) => new RegExp(r).test(f)), re.source, { timeout: 60000 });
      await idle();
      assert(await check(await savedFile(re)), `${tool} output is valid`);
    }
  });

  test('tools: Word, Excel and PowerPoint to PDF through Microsoft Office', async () => {
    const pptx = await savedFile(/sample\.pptx$/);
    const csv = join(dir, 'table.csv');
    writeFileSync(csv, 'City,Revenue\r\nCluj,1200\r\nIasi,900\r\n');
    for (const [tool, file, re, needle] of [
      ['word-pdf', F.docx, /report\.pdf$/, 'Quarterly Report'],
      ['excel-pdf', csv, /table\.pdf$/, 'Revenue'],
      ['ppt-pdf', pptx, /sample\.pdf$/, null],
    ]) {
      await S(() => window.__adika.store.setState({ dirty: false }));
      await S((p) => window.__adika.platform.e2eQueuePicks([p]), file.split('\\').join('/'));
      await page.click('[data-testid="btn-tools"]');
      await page.click(`[data-testid="tools-modal"] [data-testid="quick-${tool}"]`);
      const ok = await page.waitForFunction((r) => window.__adika.platform.e2eSavedFiles().some((f) => new RegExp(r).test(f)), re.source, { timeout: 180000 }).then(() => true, () => false);
      if (!ok) throw new Error(`${tool} produced nothing: ${(await S(() => window.__adika.store.getState().toasts.map((t) => t.kind + ': ' + t.message))).join(' | ')} saved=${(await S(() => window.__adika.platform.e2eSavedFiles())).slice(-3).join(', ')}`);
      await idle(180000);
      const out = await savedFile(re);
      assert(statSync(out).size > 1000 && readFileSync(out).subarray(0, 5).toString() === '%PDF-', `${tool} produced a PDF`);
      if (needle) {
        const d = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(out)), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
        const t = (await (await d.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
        await d.loadingTask.destroy();
        assert(t.includes(needle), `${tool} text “${needle}”`);
      }
    }
  });

  test('tools: JPG to PDF, Merge (with reordering) and Compress', async () => {
    const png = join(dir, 'photo.png');
    await S(async (p) => {
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 600;
      const x = c.getContext('2d');
      x.fillStyle = '#0ea5e9';
      x.fillRect(0, 0, 900, 600);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await window.__adika.platform.writeFile(p, new Uint8Array(await blob.arrayBuffer()));
    }, png);
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), png.split('\\').join('/'));
    await page.click('[data-testid="btn-tools"]');
    await page.click('[data-testid="tools-modal"] [data-testid="quick-jpg-pdf"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /photo\.pdf$/.test(f)), null, { timeout: 30000 });
    await idle();
    assert((await PD.load(readFileSync(await savedFile(/photo\.pdf$/)))).getPageCount() === 1, 'JPG to PDF');
    // Merge: pick sample (3 pages) + second (1 page), move "second" to the top, merge.
    await S(({ a, b }) => window.__adika.platform.e2eQueuePicks([a, b]), { a: F.sample.split('\\').join('/'), b: F.second.split('\\').join('/') });
    await page.click('[data-testid="btn-tools"]');
    await page.click('[data-testid="tools-modal"] [data-testid="quick-merge"]');
    await page.waitForSelector('[data-testid="merge-list"]');
    const ups = await page.$$('[data-testid="merge-up"]');
    await ups[1].click();
    const order = await page.$$eval('[data-testid="merge-item"]', (els) => els.map((e) => e.textContent));
    assert(order[0] === 'second.pdf', `reordered (${order})`);
    await page.click('[data-testid="merge-run"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /second-merged\.pdf$/.test(f)), null, { timeout: 30000 });
    await idle();
    const merged = await PD.load(readFileSync(await savedFile(/second-merged\.pdf$/)));
    assert(merged.getPageCount() === 4 && merged.getPage(0).getWidth() === 400, 'merged 1 + 3 pages in the chosen order');
    // Compress
    const heavy = join(dir, 'heavy.pdf');
    if (!existsSync(heavy)) return; // produced by the compress test earlier in the suite
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), heavy.split('\\').join('/'));
    await page.click('[data-testid="btn-tools"]');
    await page.click('[data-testid="tools-modal"] [data-testid="quick-compress"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /heavy-compressed\.pdf$/.test(f)), null, { timeout: 60000 });
    await idle();
    assert(statSync(await savedFile(/heavy-compressed\.pdf$/)).size < statSync(heavy).size * 0.6, 'compressed');
  });

  test('logs: daily log and crash reports are written; About shows the folder', async () => {
    const folder = await S(() => window.__adika.log?.logsFolder?.() ?? null);
    assert(folder && existsSync(folder), `logs folder exists (${folder})`);
    const daily = readdirSync(folder).find((f) => /^adika-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    assert(daily, 'daily log file');
    assert(/started/.test(readFileSync(join(folder, daily), 'utf8')), 'start-up is logged');
    const report = await S(() => window.__adika.log.logCrash('e2e test', 'Simulated crash for the test suite'));
    assert(report && existsSync(report) && readFileSync(report, 'utf8').includes('Simulated crash'), `crash report written (${report})`);
    await page.click('[aria-label="About"]');
    await page.waitForSelector('[data-testid="logs-path"]');
    assert((await page.textContent('[data-testid="logs-path"]')) === folder, 'About shows the logs folder');
    await page.keyboard.press('Escape');
  });
}
