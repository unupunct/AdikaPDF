// v1.1 formats, font rendering and Romanian OCR — included by suite.mjs.
// `ctx` provides the suite helpers so this file stays declarative.
export function registerFormatTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, pdfText, join, writeFileSync, readFileSync, JSZip, PDFDocument, F, pdfjs, FONT_DATA } = ctx;

  /** The open document's bytes, opened with pdf.js in Node (structures are compressed, so no byte search). */
  async function currentPdfjs() {
    const bytes = await S(() => Array.from(Object.values(window.__adika.store.getState().sources)[0].bytes));
    return pdfjs.getDocument({ data: Uint8Array.from(bytes), disableFontFace: true, standardFontDataUrl: FONT_DATA }).promise;
  }

  test('saved text renders visibly (font embedding regression)', async () => {
    await open(F.second);
    // Draw red text, count its pixels in the editor, save, reopen, count again.
    await S(() => {
      const s = window.__adika.store.getState();
      const pageId = s.pages[0].id;
      const base = { type: 'text', pageId, rotation: 0, opacity: 1, width: 360, height: 30, bold: false, italic: false, color: '#ff0000', align: 'left', lineHeight: 1.25, background: null };
      s.addObject({ ...base, id: 'rt1', x: 20, y: 30, text: 'Semnat în Cluj ăâîșț 0123456789', fontFamily: 'sans', fontSize: 18 });
      s.addObject({ ...base, id: 'rt2', x: 20, y: 70, text: 'Serif bold — țară și câmpie', fontFamily: 'serif', bold: true, fontSize: 18 });
      s.addObject({ ...base, id: 'rt3', x: 20, y: 110, text: 'mono italic: const x = 42;', fontFamily: 'mono', italic: true, fontSize: 16 });
    });
    await page.waitForTimeout(400);
    const redPixels = () =>
      S(() => {
        const canvases = [...document.querySelectorAll('[data-testid="page-1"] canvas')];
        let red = 0;
        for (const c of canvases) {
          if (!c.width) continue;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 128) red++;
        }
        return red;
      });
    const before = await redPixels();
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const path = await savedFile(/second\.pdf$/);
    await open(path);
    await page.waitForTimeout(600);
    const after = await redPixels();
    assert(before > 2000, `editor shows the text (${before} red px)`);
    assert(after > before * 0.6, `saved PDF renders the text (${after} red px vs ${before} in the editor)`);
  });

  test('Romanian OCR keeps ă â î ș ț', async () => {
    const scan = join(dir, 'scan-ro.pdf');
    await S(async (p) => {
      const c = document.createElement('canvas');
      c.width = 2480;
      c.height = 900;
      const x = c.getContext('2d');
      x.fillStyle = '#fff';
      x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#000';
      x.font = '96px "Segoe UI", Arial';
      x.fillText('Știință și țară în câmpie', 120, 380);
      x.fillText('Contract încheiat astăzi', 120, 600);
      const bytes = await window.__adika.convert.imagesToPdf([{ src: c.toDataURL('image/png'), width: c.width, height: c.height }], { pageSize: 'fit', orientation: 'auto', marginMm: 0 });
      await window.__adika.platform.writeFile(p, bytes);
    }, scan);
    await open(scan);
    await S(() => window.__adika.convert.runOcr({ pageNumbers: [1], dpi: 200, lang: 'ron+eng' }));
    await idle(300000);
    const t = (await pdfText(await savedFile(/scan-ro-ocr\.pdf$/)))[0].normalize('NFC').replace(/ş/g, 'ș').replace(/ţ/g, 'ț');
    // OCR is statistical: require most words, all with their diacritics intact.
    const words = ['Știință', 'țară', 'câmpie', 'încheiat', 'astăzi'];
    const found = words.filter((w) => t.includes(w));
    console.log(`      OCR: ${found.length}/${words.length} words exact — “${t.slice(0, 90)}”`);
    assert(found.length >= 4, `OCR found ${found.join(', ')} in “${t.slice(0, 120)}”`);
  });

  test('export to ODT, RTF, CSV, JSON and EPUB, then EPUB → PDF round trip', async () => {
    await open(F.sample);
    for (const format of ['odt', 'rtf', 'csv', 'json', 'epub']) {
      await S((f) => window.__adika.convert.exportAs({ format: f, dpi: 72 }), format);
      await idle();
    }
    const odt = await JSZip.loadAsync(readFileSync(await savedFile(/sample\.odt$/)));
    assert((await odt.file('mimetype').async('string')) === 'application/vnd.oasis.opendocument.text', 'ODT mimetype');
    assert((await odt.file('content.xml').async('string')).includes('Invoice Total'), 'ODT content');
    const rtf = readFileSync(await savedFile(/sample\.rtf$/), 'latin1');
    assert(rtf.startsWith('{\\rtf1') && rtf.includes('Invoice Total'), 'RTF content');
    const csv = readFileSync(await savedFile(/sample\.csv$/), 'utf8');
    assert(csv.includes('Invoice'), `CSV content (${csv.slice(0, 300)})`);
    const json = JSON.parse(readFileSync(await savedFile(/sample\.json$/), 'utf8'));
    assert(json.pages?.length === 3 && JSON.stringify(json).includes('Invoice Total'), 'JSON pages');
    const epubPath = await savedFile(/sample\.epub$/);
    const epub = await JSZip.loadAsync(readFileSync(epubPath));
    assert(Object.keys(epub.files)[0] === 'mimetype', 'EPUB mimetype first');
    // Re-import the EPUB we just made.
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), epubPath.split('\\').join('/'));
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S(() => window.__adika.convert.importDocuments({ pageSize: 'A4', landscape: false, marginMm: 15 }, false));
    await idle(180000);
    const hits = await S(async () => {
      const st = window.__adika.store.getState();
      return window.__adika.search.searchDocument(st.pages, 'Invoice Total', { cancelled: false }).then((h) => h.length);
    });
    assert(hits >= 1, `EPUB → PDF contains the text (${hits} hits)`);
  });

  test('e-mail (.eml) → PDF keeps the attachment inside the PDF', async () => {
    const eml = join(dir, 'mesaj.eml');
    const b64 = (s) => Buffer.from(s).toString('base64');
    writeFileSync(
      eml,
      [
        'From: Ana Pop <ana@example.com>',
        'To: Ion <ion@example.com>',
        `Subject: =?UTF-8?B?${b64('Ofertă și contract')}?=`,
        'Date: Fri, 25 Sep 2026 10:00:00 +0300',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B1"',
        '',
        '--B1',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64('<html><body><h2>Bună ziua</h2><p>Vă trimit oferta pentru țară.</p><script>alert(1)</script></body></html>'),
        '--B1',
        'Content-Type: text/plain; name="note.txt"',
        'Content-Disposition: attachment; filename="note.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        b64('attached note'),
        '--B1--',
        '',
      ].join('\r\n'),
    );
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), eml.split('\\').join('/'));
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S(() => window.__adika.convert.importDocuments({ pageSize: 'A4', landscape: false, marginMm: 15 }, false));
    await idle(180000);
    const info = await S(async () => {
      const st = window.__adika.store.getState();
      const bytes = Object.values(st.sources)[0].bytes;
      const hits = await window.__adika.search.searchDocument(st.pages, 'oferta pentru țară', { cancelled: false });
      return { hits: hits.length, name: st.fileName, size: bytes.length };
    });
    assert(info.hits >= 1, `e-mail body rendered (${info.name})`);
    const doc = await currentPdfjs();
    const attachments = await doc.getAttachments();
    // pdf.js 6 returns a Map (older versions a plain object).
    const list = attachments instanceof Map ? [...attachments.values()] : Object.values(attachments ?? {});
    const names = list.map((a) => a.filename);
    assert(names.includes('note.txt'), `attachment embedded in the PDF (${names.join(', ') || 'none'})`);
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    assert(!text.includes('alert(1)'), 'script not rendered');
    await doc.loadingTask.destroy();
  });

  test('XPS from Word → PDF', async () => {
    const xps = join(process.cwd(), 'tests', 'fixtures', 'word-sample.xps');
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), xps.split('\\').join('/'));
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S(() => window.__adika.convert.importDocuments({ pageSize: 'A4', landscape: false, marginMm: 15 }, false));
    await idle(120000);
    const r = await S(async () => {
      const st = window.__adika.store.getState();
      const h = await window.__adika.search.searchDocument(st.pages, 'Raport XPS de test', { cancelled: false });
      return { pages: st.pages.length, hits: h.length };
    });
    assert(r.pages === 2 && r.hits >= 1, `XPS converted (${JSON.stringify(r)})`);
  });

  test('DXF drawing → vector PDF with layers', async () => {
    const dxf = join(dir, 'plan.dxf');
    const ent = (lines) => lines.join('\n');
    writeFileSync(
      dxf,
      ent([
        '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
        '0', 'LAYER', '2', 'Walls', '70', '0', '62', '1', '6', 'CONTINUOUS',
        '0', 'LAYER', '2', 'Text', '70', '0', '62', '5', '6', 'CONTINUOUS',
        '0', 'ENDTAB', '0', 'ENDSEC',
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'LINE', '8', 'Walls', '10', '0', '20', '0', '11', '100', '21', '0',
        '0', 'LINE', '8', 'Walls', '10', '100', '20', '0', '11', '100', '21', '60',
        '0', 'CIRCLE', '8', 'Walls', '10', '50', '20', '30', '40', '10',
        '0', 'TEXT', '8', 'Text', '10', '10', '20', '70', '40', '5', '1', 'Plan etaj ăîșț',
        '0', 'ENDSEC', '0', 'EOF', '',
      ]),
    );
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), dxf.split('\\').join('/'));
    await S(() => window.__adika.store.setState({ dirty: false }));
    await S(() => window.__adika.convert.importDxf({ paper: 'A4', orientation: 'landscape', marginMm: 10, blackOnWhite: true, lineWeightMm: 0.25, layers: true }, false));
    await idle(120000);
    const r = await S(async () => {
      const st = window.__adika.store.getState();
      const h = await window.__adika.search.searchDocument(st.pages, 'Plan etaj ăîșț', { cancelled: false });
      return { hits: h.length, w: st.pages[0].width, h: st.pages[0].height };
    });
    assert(r.hits >= 1, 'DXF text rendered');
    assert(r.w > r.h, 'landscape A4');
    const doc = await currentPdfjs();
    const config = await doc.getOptionalContentConfig();
    const layerNames = [...config].map(([, g]) => g.name);
    assert(layerNames.includes('Walls') && layerNames.includes('Text'), `CAD layers kept as PDF layers (${layerNames.join(', ')})`);
    await doc.loadingTask.destroy();
  });

  test('HEIC photo → PDF', async () => {
    const heic = join(process.cwd(), 'tests', 'fixtures', 'sample.heic');
    await S((p) => window.__adika.platform.e2eQueuePicks([p]), heic.split('\\').join('/'));
    const imgs = await S(() => window.__adika.convert.pickImagesAsDataUrls().then((l) => l.map((i) => ({ w: i.width, h: i.height, src: i.src.slice(0, 22) }))));
    assert(imgs.length >= 1 && imgs[0].w === 1440 && imgs[0].h === 960, `HEIC decoded ${JSON.stringify(imgs)}`);
    assert(/^data:image\/(jpeg|png)/.test(imgs[0].src), 'converted to a web image');
  });

  test('PDF/A-1b and PDF/A-3b with an attached source file', async () => {
    await open(F.form);
    await S(() => window.__adika.convert.runPdfA({ title: 'Arhivă', author: 'Adika', level: '1b' }));
    await idle();
    const a1 = readFileSync(await savedFile(/-pdfa1b\.pdf$/));
    assert(a1.subarray(0, 8).toString() === '%PDF-1.4', 'PDF/A-1b header is 1.4');
    assert(a1.toString('latin1').includes('<pdfaid:part>1</pdfaid:part>') || /pdfaid:part="1"/.test(a1.toString('latin1')), 'XMP part 1');
    await open(F.form);
    await S(() => window.__adika.convert.runPdfA({ title: 'Arhivă', author: 'Adika', level: '3b', attachments: [{ name: 'source.txt', mime: 'text/plain', bytes: new TextEncoder().encode('original source') }] }));
    await idle();
    const a3 = readFileSync(await savedFile(/-pdfa3b\.pdf$/)).toString('latin1');
    assert(/pdfaid:part>3<|pdfaid:part="3"/.test(a3), 'XMP part 3');
    assert(a3.includes('/AFRelationship') && a3.includes('source.txt'), 'attachment with AFRelationship');
    const doc = await PDFDocument.load(readFileSync(await savedFile(/-pdfa3b\.pdf$/)));
    assert(doc.getPageCount() === 1, 'PDF/A-3b loads');
  });
}
