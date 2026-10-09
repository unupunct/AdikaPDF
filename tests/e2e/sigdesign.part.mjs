// Round 14: signature appearance designer, rich text in typewriter comments — included by suite.mjs.
// NOTE: written without a release build at hand: not run yet.
import { readFileSync } from 'node:fs';
import { PDFDocument as PD, PDFName } from 'pdf-lib';

export function registerSigDesignTests(test, ctx) {
  const { S, page, open, idle, savedFile, assert, F, setTool } = ctx;

  test('signature appearance designer: a profile with a custom line signs as real text', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-cert-sign"]');
    await page.click('text=Create self-signed ID');
    await page.fill('[data-testid="selfsigned-name"]', 'Ștefan Țăran');
    await page.click('[data-testid="selfsigned-create"]');
    await page.waitForSelector('[data-testid="identity-card"]', { timeout: 30000 });
    await page.click('[data-testid="sig-design-open"]');
    await page.waitForSelector('[data-testid="sig-designer"]');
    await page.fill('[data-testid="sig-profile-name"]', 'Firmă');
    await page.fill('[data-testid="sig-custom-line"]', 'Pentru {o} — {cn}');
    // The preview is the real appearance, drawn by pdf.js.
    await page.waitForFunction(() => (document.querySelector('[data-testid="sig-preview"]')?.width ?? 0) > 50, null, { timeout: 10000 });
    await page.click('[data-testid="sig-designer-default"]');
    await page.keyboard.press('Escape');
    const chosen = await S(() => JSON.parse(localStorage.getItem('adika.sigAppearances') ?? '{}'));
    assert(chosen.profiles?.length === 1 && chosen.defaultId === chosen.profiles[0].id, `profile saved as default (${JSON.stringify(chosen.defaultId)})`);
    await page.click('[data-testid="cert-sign-now"]');
    await idle();
    const path = await savedFile(/-signed\.pdf$/);
    const v = await S(async (p) => window.__adika.signature.verifyPdfSignatures(await window.__adika.platform.readFile(p)), path.replace(/\\/g, '/'));
    assert(v.length === 1 && v[0].integrity === 'valid', `signature valid (${JSON.stringify(v[0]?.message)})`);
    const doc = await PD.load(readFileSync(path));
    const widget = doc
      .getPages()
      .flatMap((p) => (p.node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r)))
      .find((d) => d.lookup(PDFName.of('FT'))?.decodeText?.() === 'Sig');
    const ap = widget.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
    const fonts = ap.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'));
    assert(fonts && fonts.keys().length >= 1, 'the appearance is text in an embedded font');
  });

  test('typewriter comment: part of the text in bold is kept as rich text', async () => {
    await open(F.sample);
    await setTool('typewriter');
    const box = await (await page.$('[data-testid="page-1"]')).boundingBox();
    await page.mouse.click(box.x + 80, box.y + 300);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'text-editor');
    await page.keyboard.type('Normal ');
    await page.click('[data-testid="rich-bold"]');
    await page.keyboard.type('aldin');
    await page.mouse.click(box.x + 400, box.y + 780);
    const obj = await S(() => window.__adika.store.getState().objects.find((o) => o.type === 'text' && o.annotation));
    assert(obj?.text === 'Normal aldin', `text (${obj?.text})`);
    assert(obj.runs?.some((r) => r.bold && r.text.includes('aldin')), `bold run (${JSON.stringify(obj.runs)})`);
  });
}
