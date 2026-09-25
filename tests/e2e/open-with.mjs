// "Open with Adika" from Explorer: the installed exe receives the PDF path as an argument.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchApp, tempDir } from './harness.mjs';
const doc = await PDFDocument.create();
doc.addPage([300, 300]).drawText('Opened from Explorer', { x: 20, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
const file = join(tempDir(), 'explorer test.pdf');
writeFileSync(file, await doc.save());
const app = await launchApp({ exe: process.env.ADIKA_EXE, args: [file] });
await app.page.waitForFunction(() => window.__adika.store.getState().fileName === 'explorer test.pdf', null, { timeout: 15000 });
console.log('opened:', await app.page.evaluate(() => window.__adika.store.getState().filePath));
await app.close();
