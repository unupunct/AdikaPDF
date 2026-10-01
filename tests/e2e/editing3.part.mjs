// Deeper editing: drawings, restyled text, layers, page size, XMP metadata — included by suite.mjs.
import { readFileSync, writeFileSync as writeFs, mkdtempSync, mkdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument as PD, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { analyzePageText } from '../../src/lib/pdf/textRemoval.ts';

// The app's drawing reader, with its relative import pointed at the file (Node needs the extension).
const removalUrl = pathToFileURL(joinPath(process.cwd(), 'src/lib/pdf/textRemoval.ts')).href;
// Inside the project (git-ignored .tools), so its packages resolve.
mkdirSync(joinPath(process.cwd(), '.tools'), { recursive: true });
const vectorCopy = joinPath(mkdtempSync(joinPath(process.cwd(), '.tools', 'e2e-vec-')), 'vectorEdit.ts');
writeFs(vectorCopy, readFileSync(joinPath(process.cwd(), 'src/lib/pdf/vectorEdit.ts'), 'utf8').replace("from './textRemoval'", `from '${removalUrl}'`));
const { vectorPaths } = await import(pathToFileURL(vectorCopy).href);

export function registerEditing3Tests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync, pageBox } = ctx;
  const clickAt = async (x, y) => {
    const b = await pageBox(1);
    const z = await S(() => window.__adika.store.getState().zoom);
    await page.mouse.click(b.x + x * z, b.y + y * z);
  };

  test('Edit drawing: a box from the page is moved, recoloured and saved back', async () => {
    const d = await PD.create();
    const p = d.addPage([400, 400]);
    p.drawRectangle({ x: 50, y: 250, width: 100, height: 50, color: rgb(1, 0, 0) });
    p.drawRectangle({ x: 250, y: 250, width: 60, height: 60, color: rgb(0, 0, 1) });
    const path = join(dir, 'desen.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-edit"]');
    await page.click('[data-testid="tool-editVector"]');
    // Display y = 400 - PDF y: the red box spans y 100..150.
    await clickAt(100, 125);
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'vector'), null, { timeout: 15000 });
    const v = await S(() => window.__adika.store.getState().objects.find((o) => o.type === 'vector'));
    assert(v.fill === '#ff0000' && Math.round(v.width) === 100 && Math.round(v.x) === 50, `lifted box (${JSON.stringify(v)})`);
    await S((id) => window.__adika.store.getState().updateObject(id, { fill: '#00aa00', x: 80 }), v.id);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/desen\.pdf$/)));
    const paths = vectorPaths(out, out.getPage(0));
    const fills = paths.map((x) => x.fill).sort();
    assert(JSON.stringify(fills) === JSON.stringify(['#0000ff', '#00aa00']), `fills (${fills})`);
    const green = paths.find((x) => x.fill === '#00aa00');
    assert(Math.abs(green.box.x0 - 80) < 0.5 && Math.abs(green.box.y0 - 250) < 0.5, `moved box (${JSON.stringify(green.box)})`);
  });

  test('restyled text keeps the document font in its new colour', async () => {
    const d = await PD.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([400, 300]).drawText('Total due 1500 lei', { x: 40, y: 250, size: 14, font: f });
    const path = join(dir, 'restil.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-edit"]');
    await page.click('[data-testid="tool-editText"]');
    await clickAt(70, 45);
    await page.waitForFunction(() => window.__adika.store.getState().objects.some((o) => o.type === 'text' && o.original), null, { timeout: 15000 });
    await page.keyboard.press('Escape');
    const t = await S(() => window.__adika.store.getState().objects.find((o) => o.type === 'text'));
    assert(t.original.color === '#000000', `original colour read from the page (${t.original.color})`);
    await S((id) => window.__adika.store.getState().updateObject(id, { color: '#cc0000' }), t.id);
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/restil\.pdf$/)));
    const glyphs = analyzePageText(out, out.getPage(0)).glyphs.filter((g) => g.text.trim());
    const fonts = new Set(glyphs.map((g) => g.font));
    assert(glyphs.length && glyphs.every((g) => g.color === '#cc0000'), `colours (${[...new Set(glyphs.map((g) => g.color))]})`);
    assert([...fonts].every((n) => /Helvetica/.test(n)), `written in the document's font (${[...fonts]})`);
  });

  test('layers are renamed, deleted and flattened in the Layers panel', async () => {
    const d = await PD.create();
    const pg = d.addPage([400, 400]);
    const font = await d.embedFont(StandardFonts.Helvetica);
    pg.drawText('Always', { x: 20, y: 350, size: 12, font });
    const plan = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Plan') }));
    const dims = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Dimensions') }));
    const fontName = pg.node.Resources().lookup(PDFName.of('Font')).keys()[0].decodeText();
    const extra = d.context.flateStream(`/OC /L1 BDC BT /${fontName} 12 Tf 20 300 Td (PlanText) Tj ET EMC /OC /L2 BDC BT /${fontName} 12 Tf 20 250 Td (DimText) Tj ET EMC`);
    pg.node.lookup(PDFName.of('Contents')).push(d.context.register(extra));
    pg.node.Resources().set(PDFName.of('Properties'), d.context.obj({ L1: plan, L2: dims }));
    d.catalog.set(PDFName.of('OCProperties'), d.context.obj({ OCGs: [plan, dims], D: { Order: [plan, dims], ON: [plan, dims], OFF: [] } }));
    const path = join(dir, 'straturi.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="sidebar-layers"]');
    await page.waitForSelector('[data-testid="layer-row"]');
    // Rename "Plan".
    await page.click('[data-testid="layer-row"] >> nth=0');
    await page.click('[data-testid="layer-rename"]');
    await page.fill('[data-testid="layer-name-input"]', 'Floor plan');
    await page.keyboard.press('Enter');
    await idle();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="layer-row"]')].some((r) => r.textContent.includes('Floor plan')), null, { timeout: 15000 });
    // Delete "Dimensions".
    await page.click('[data-testid="layer-row"] >> nth=1');
    await page.click('[data-testid="layer-delete"]');
    await page.click('[data-testid="confirm-ok"]');
    await idle();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="layer-row"]').length === 1, null, { timeout: 15000 });
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/straturi\.pdf$/)));
    const ocgs = out.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs'));
    assert(ocgs instanceof PDFArray && ocgs.size() === 1 && ocgs.lookup(0).lookup(PDFName.of('Name')).decodeText() === 'Floor plan', 'one renamed layer left');
    const text = analyzePageText(out, out.getPage(0)).text;
    assert(text.includes('PlanText') && text.includes('Always') && !text.includes('DimText'), `text (${text})`);
    // Flatten: no layers left, the content stays.
    await page.click('[data-testid="layer-flatten"]');
    await page.click('[data-testid="confirm-ok"]');
    await idle();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="layer-row"]').length === 0, null, { timeout: 15000 });
  });

  test('pages get a paper size, content scaled to fit', async () => {
    const d = await PD.create();
    d.addPage([400, 300]).drawRectangle({ x: 0, y: 0, width: 400, height: 300, borderWidth: 2 });
    const path = join(dir, 'format.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await page.click('[data-testid="tab-organize"]');
    await page.click('[data-testid="btn-pagesize"]');
    await page.waitForSelector('[data-testid="pagesize-modal"]');
    await page.click('[data-testid="pagesize-apply"]');
    await idle();
    const size = await S(() => {
      const p = window.__adika.store.getState().pages[0];
      return [Math.round(p.width), Math.round(p.height)];
    });
    assert(size[0] === 842 && size[1] === 595, `A4 landscape (${size})`);
  });

  test('copyright and custom properties are written into the XMP metadata', async () => {
    const d = await PD.create();
    d.addPage([300, 300]);
    const path = join(dir, 'metadate.pdf');
    writeFileSync(path, await d.save());
    await open(path);
    await S(() => window.__adika.store.getState().openModal('properties'));
    await page.waitForSelector('[data-testid="properties-modal"]');
    await page.fill('[data-testid="prop-title"]', 'Raport anual');
    await page.click('[data-testid="properties-modal"] button:has-text("Copyright & custom")');
    await page.selectOption('select[aria-label="Copyright status"]', 'copyrighted');
    await page.fill('[data-testid="prop-copyright"]', '© 2026 Adika SRL');
    await page.click('[data-testid="prop-custom-add"]');
    await page.fill('[data-testid="prop-custom-name"]', 'Department');
    await page.fill('[data-testid="prop-custom-value"]', 'Juridic');
    await page.click('[data-testid="properties-apply"]');
    await page.keyboard.press('Control+Shift+s');
    await idle();
    const out = await PD.load(readFileSync(await savedFile(/metadate\.pdf$/)));
    const xmp = new TextDecoder().decode(out.catalog.lookup(PDFName.of('Metadata')).getContents());
    assert(xmp.includes('Raport anual') && xmp.includes('<xmpRights:Marked>True</xmpRights:Marked>') && xmp.includes('© 2026 Adika SRL'), `XMP (${xmp.slice(0, 400)})`);
    const info = out.context.lookup(out.context.trailerInfo.Info);
    assert(info instanceof PDFDict && info.lookup(PDFName.of('Department')).decodeText() === 'Juridic', 'custom Info property');
  });
}
