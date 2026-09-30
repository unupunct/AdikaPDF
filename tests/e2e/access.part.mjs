// Accessibility checker and fixer — included by suite.mjs.
import { PDFDocument as PD, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';

// 2x2 red PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));

export function registerAccessTests(test, ctx) {
  const { S, page, dir, open, idle, savedFile, assert, join, writeFileSync } = ctx;

  test('accessibility: the checker lists the problems; tagging, title, language and a picture description fix them', async () => {
    const d = await PD.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const bold = await d.embedFont(StandardFonts.HelveticaBold);
    const p = d.addPage([595, 842]);
    p.drawRectangle({ x: 40, y: 800, width: 515, height: 3, color: rgb(0.1, 0.3, 0.7) });
    p.drawText('Ghid de acces', { x: 60, y: 760, size: 24, font: bold });
    for (let i = 0; i < 4; i++) p.drawText(`Randul ${i + 1} al paragrafului despre accesul in cladire si programul zilnic.`, { x: 60, y: 720 - i * 14, size: 11, font });
    p.drawImage(await d.embedPng(PNG), { x: 60, y: 520, width: 120, height: 120 });
    const path = join(dir, 'ghid.pdf');
    writeFileSync(path, await d.save());

    await open(path);
    await page.click('[data-testid="tab-security"]');
    await page.click('[data-testid="btn-accessibility"]');
    await page.waitForSelector('[data-testid="a11y-checks"]', { timeout: 20000 });
    const status = async (id) => page.getAttribute(`[data-testid="a11y-check-${id}"]`, 'data-status');
    for (const id of ['tagged', 'title', 'language', 'figures']) assert((await status(id)) === 'fail', `${id} fails before`);
    assert((await status('text')) === 'pass', 'real text');
    // The picture is shown for describing (a crop of the page).
    await page.waitForSelector('[data-testid="a11y-figure"] img', { timeout: 15000 });
    await page.fill('[data-testid="a11y-title"]', 'Ghid de acces în clădire');
    await page.selectOption('[data-testid="accessibility-modal"] select[aria-label="Document language"]', 'ro-RO');
    await page.fill('[data-testid="a11y-alt-0"]', 'Pătrat roșu, sigla clădirii');
    await page.click('[data-testid="a11y-fix"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /ghid-accessible.pdf$/.test(f)), null, { timeout: 30000 });
    await idle();
    const out = await savedFile(/ghid-accessible\.pdf$/);
    // Re-checked on the saved copy (it is opened).
    await page.waitForFunction(() => document.querySelector('[data-testid="a11y-check-tagged"]')?.getAttribute('data-status') === 'pass', null, { timeout: 20000 });
    for (const id of ['tagged', 'title', 'language', 'figures']) assert((await status(id)) === 'pass', `${id} passes after`);
    // Independent reading of the saved file.
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(out)), verbosity: 0 }).promise;
    const tree = await (await pdf.getPage(1)).getStructTree();
    const kids = tree.children[0].children;
    assert(kids.map((k) => k.role).join(',') === 'H1,P,Figure', `structure (${kids.map((k) => k.role)})`);
    assert(kids[2].alt === 'Pătrat roșu, sigla clădirii', `figure description (${kids[2].alt})`);
    const meta = await pdf.getMetadata();
    assert(meta.info.Title === 'Ghid de acces în clădire', 'title');
    await pdf.loadingTask.destroy();
    await page.keyboard.press('Escape');
  });
}
