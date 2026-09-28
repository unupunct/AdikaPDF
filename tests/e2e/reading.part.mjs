// Reading aids: read aloud, snapshot, magnifier — included by suite.mjs.
import { readFileSync } from 'node:fs';

export function registerReadingTests(test, ctx) {
  const { S, page, open, savedFile, assert, F, at } = ctx;
  const status = () => S(() => window.__adika.readAloud.useReadAloud.getState().status);

  test('reading: read aloud speaks the page with a Windows voice, pauses, resumes and stops', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-view"]');
    const voices = await S(async () => {
      // Voices can arrive a moment after start-up.
      for (let k = 0; k < 20 && !speechSynthesis.getVoices().length; k++) await new Promise((r) => setTimeout(r, 150));
      return speechSynthesis.getVoices().map((v) => `${v.name} (${v.lang})`);
    });
    console.log(`      voices: ${voices.length} — ${voices.slice(0, 4).join(', ')}`);
    assert(voices.length > 0, 'Windows offers at least one speech voice');
    await page.click('[data-testid="btn-read-page"]');
    await page.waitForFunction(() => window.__adika.readAloud.useReadAloud.getState().status === 'speaking', null, { timeout: 8000 });
    await page.waitForFunction(() => speechSynthesis.speaking, null, { timeout: 8000 });
    const reading = await S(() => {
      const st = window.__adika.store.getState();
      return window.__adika.readAloud.useReadAloud.getState().pageId === st.pages[0].id;
    });
    assert(reading, 'page 1 is being read');
    await page.click('[data-testid="btn-read-page"]'); // pause
    assert((await status()) === 'paused', 'paused');
    await page.keyboard.press('Control+Shift+c'); // resume
    assert((await status()) === 'speaking', 'resumed with Ctrl+Shift+C');
    await page.click('[data-testid="btn-read-stop"]');
    assert((await status()) === 'idle', 'stopped');
    await page.waitForFunction(() => !speechSynthesis.speaking, null, { timeout: 5000 });
    // Read to the end follows the pages.
    await page.keyboard.press('Control+Shift+b');
    await page.waitForFunction(() => window.__adika.readAloud.useReadAloud.getState().status === 'speaking', null, { timeout: 8000 });
    await page.keyboard.press('Control+Shift+e');
    assert((await status()) === 'idle', 'Ctrl+Shift+E stops');
  });

  test('reading: snapshot copies an area of the page as a picture and saves it as PNG', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-view"]');
    await page.click('[data-testid="tool-snapshot"]');
    const a = await at(1, 50, 40);
    const b = await at(1, 350, 140);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__adika.readingAids.useSnapshot.getState().last !== null, null, { timeout: 15000 });
    const snap = await S(() => {
      const l = window.__adika.readingAids.useSnapshot.getState().last;
      return { w: l.width, h: l.height, toasts: window.__adika.store.getState().toasts.map((t) => t.message) };
    });
    assert(Math.abs(snap.w - 600) <= 4 && Math.abs(snap.h - 200) <= 4, `snapshot is 2× the box (${snap.w}×${snap.h})`);
    assert(snap.toasts.some((t) => /Snapshot copied/.test(t)), `copied to the clipboard (${snap.toasts.join(' | ')})`);
    const clip = await S(async () => {
      try {
        const items = await navigator.clipboard.read();
        return items.flatMap((i) => i.types);
      } catch (e) {
        return [`error: ${e.message}`];
      }
    });
    assert(clip.includes('image/png'), `clipboard holds a PNG (${clip.join(',')})`);
    // The picture shows the page: dark text pixels in the title area.
    const dark = await S(async () => {
      const bmp = await createImageBitmap(window.__adika.readingAids.useSnapshot.getState().last.blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) n++;
      return n;
    });
    assert(dark > 500, `snapshot contains the page text (${dark} dark px)`);
    await page.click('[data-testid="btn-save-snapshot"]');
    await page.waitForFunction(() => window.__adika.platform.e2eSavedFiles().some((f) => /snapshot\.png$/.test(f)), null, { timeout: 10000 });
    const png = readFileSync(await savedFile(/snapshot\.png$/));
    assert(png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG', 'saved file is a PNG');
    await S(() => window.__adika.store.getState().setTool('selectText'));
  });

  test('reading: magnifier shows a sharp close-up under the mouse and closes with Esc', async () => {
    await open(F.sample);
    await S(() => window.__adika.store.getState().setZoom(1, null));
    await page.click('[data-testid="tab-view"]');
    await page.click('[data-testid="btn-magnifier"]');
    const p = await at(1, 150, 75); // over the title "Adika sample page 1"
    await page.mouse.move(p.x - 20, p.y);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForSelector('[data-testid="magnifier"]', { timeout: 5000 });
    // Wait for the sharp render, then look for text strokes in the lens.
    await page.waitForTimeout(700);
    await page.mouse.move(p.x + 1, p.y);
    const lens = await S(() => {
      const c = document.querySelector('[data-testid="magnifier"] canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
      return { dark, w: c.width };
    });
    assert(lens.dark > 800, `the lens shows the page text (${lens.dark} dark px in ${lens.w}px lens)`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="magnifier"]'), null, { timeout: 3000 });
    const on = await S(() => window.__adika.readingAids.useMagnifier.getState().on);
    assert(!on, 'Esc closes the magnifier');
  });
}
