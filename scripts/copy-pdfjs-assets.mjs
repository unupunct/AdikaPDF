// Copies the pdf.js runtime assets (CMaps, standard fonts, WASM decoders, ICC
// profiles) into public/pdfjs so the app renders every PDF fully offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = join(src, dir);
  if (!existsSync(from)) continue;
  cpSync(from, join(dest, dir), { recursive: true });
  console.log(`pdfjs: copied ${dir}`);
}
