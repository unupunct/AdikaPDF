import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { FontVariant } from '@/lib/fonts';
import { checkPdfUa } from '@/lib/pdf/pdfua';
import { reportHtml, reportPdf, reportText } from '@/lib/pdf/pdfuaReport';
import { uaDoc } from './helpers/uaDoc';

const fontsDir = join(process.cwd(), 'node_modules', '@expo-google-fonts');
const loadFont = (v: FontVariant) => {
  const weight = v.bold ? '700Bold' : '400Regular';
  return Promise.resolve(new Uint8Array(readFileSync(join(fontsDir, 'noto-sans', weight, `NotoSans_${weight}.ttf`))));
};

describe('PDF/UA report', () => {
  it('text, HTML and PDF list the failures by checkpoint and the human checks', async () => {
    const r = await checkPdfUa(await uaDoc({ lang: null, displayDocTitle: null, tree: [{ S: 'H1', mcid: 0 }, { S: 'Figure', mcid: 1 }] }));
    const meta = { fileName: 'guide.pdf', checkedAt: new Date('2026-10-09T10:00:00Z') };
    const text = reportText(r, meta);
    expect(text).toMatch(/07-001 .*Adika can fix it/);
    expect(text).toMatch(/13-004 .*page 1, <Figure>.*needs a person/);
    expect(text).toMatch(/\[FAIL\] 11 Declared natural language/);
    expect(text).toMatch(/Colour and contrast/);
    const html = reportHtml(r, meta);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<th scope="col">Condition<\/th>/);
    expect(html).toContain('&lt;Figure&gt;');
    const pdf = await reportPdf(r, { ...meta, loadFont });
    const doc = await pdfjs.getDocument({ data: pdf, verbosity: 0 }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const all = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(all).toContain('PDF/UA accessibility report');
    expect(all).toContain('13-004');
    await doc.loadingTask.destroy();
  });
});
