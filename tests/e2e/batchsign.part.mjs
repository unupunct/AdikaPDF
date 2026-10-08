// Sign many files: a folder signed with one .pfx (password once), the Windows store into a folder — included by suite.mjs.
import { existsSync, mkdirSync } from 'node:fs';
import { PDFDocument as PD, StandardFonts } from 'pdf-lib';

async function textPdf(pages) {
  const d = await PD.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of pages) d.addPage([595, 842]).drawText(t, { x: 60, y: 760, size: 16, font: f });
  return d.save();
}

export function registerBatchSignTests(test, ctx) {
  const { S, page, dir, assert, join, writeFileSync, pfxPath } = ctx;
  const slash = (p) => p.split('\\').join('/');
  const verify = (p) => S(async (f) => window.__adika.signature.verifyPdfSignatures(await window.__adika.platform.readFile(f)), slash(p));

  test('sign many files: a folder with subfolders, .pfx password once, PAdES B-B, results list', async () => {
    const src = join(dir, 'batchsign');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'contract.pdf'), await textPdf(['Contract', 'Anexa 1']));
    writeFileSync(join(src, 'proces-verbal.pdf'), await textPdf(['Proces-verbal']));
    writeFileSync(join(src, 'sub', 'factura.pdf'), await textPdf(['Factura']));
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-batch-sign"]');
    await page.waitForSelector('[data-testid="batchsign-modal"]');
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), src);
    await page.click('[data-testid="batchsign-add-folder"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batchsign-files"] li').length === 3, null, { timeout: 10000 });
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), pfxPath);
    await page.click('[data-testid="batchsign-modal"] button:has-text("Choose certificate…")');
    await page.fill('[data-testid="batchsign-pfx-password"]', 'adika-e2e');
    await page.click('[data-testid="batchsign-unlock"]');
    await page.waitForSelector('[data-testid="batchsign-identity"]');
    const level = await page.textContent('[data-testid="batchsign-level"]');
    assert(/PAdES B-B/.test(level), `level (${level})`);
    await page.click('[data-testid="batchsign-run"]');
    await page.waitForSelector('[data-testid="batchsign-summary"]', { timeout: 60000 });
    const summary = await page.textContent('[data-testid="batchsign-summary"]');
    assert(/3 of 3 file\(s\) signed/.test(summary), `summary (${summary})`);
    for (const f of [join(src, 'contract-signed.pdf'), join(src, 'proces-verbal-signed.pdf'), join(src, 'sub', 'factura-signed.pdf')]) {
      assert(existsSync(f), `output ${f}`);
      const v = await verify(f);
      assert(v.length === 1 && v[0].integrity === 'valid' && v[0].padesLevel === 'B-B', `signature in ${f} (${JSON.stringify({ l: v[0]?.padesLevel, m: v[0]?.message })})`);
    }
    // The originals are unchanged (no signature).
    const orig = await verify(join(src, 'contract.pdf'));
    assert(orig.length === 0, 'original untouched');
    await page.waitForSelector('[data-testid="batchsign-csv"]');
    await page.keyboard.press('Escape');
  });

  test('sign many files: Windows store certificate, already signed files get a second signature, output into a folder', async () => {
    const src = join(dir, 'batchsign');
    const out = join(dir, 'batchsign-out');
    mkdirSync(out, { recursive: true });
    await S(() => window.__adika.store.getState().openModal('batchsign'));
    await page.waitForSelector('[data-testid="batchsign-modal"]');
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), join(src, 'contract-signed.pdf'));
    await page.click('[data-testid="batchsign-add"]');
    await page.click('[data-testid="batchsign-modal"] [role="tab"]:has-text("Windows certificate")');
    await page.waitForSelector('[data-testid="batchsign-modal"] input[name="batchsign-store"]', { timeout: 15000 });
    await page.click('[data-testid="batchsign-out-folder"]');
    await S((f) => window.__adika.platform.e2eQueuePicks([f]), out);
    await page.click('[data-testid="batchsign-modal"] button:has-text("Choose…")');
    await page.click('[data-testid="batchsign-run"]');
    await page.waitForSelector('[data-testid="batchsign-summary"]', { timeout: 60000 });
    const f = join(out, 'contract-signed-signed.pdf');
    assert(existsSync(f), 'output in the chosen folder');
    const v = await verify(f);
    assert(v.length === 2 && v.every((s) => s.integrity === 'valid'), `both signatures valid (${JSON.stringify(v.map((s) => s.integrity))})`);
    await page.keyboard.press('Escape');
  });
}
