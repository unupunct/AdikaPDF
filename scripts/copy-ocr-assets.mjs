// Copies the tesseract.js runtime (worker, WASM cores, LSTM language data) into
// public/tesseract so OCR runs fully offline.
//
// tesseract.js v7 (src/worker-script/browser/getCore.js) loads, when corePath
// is a directory, exactly one of:
//   tesseract-core-relaxedsimd-lstm.wasm.js | tesseract-core-simd-lstm.wasm.js
//   | tesseract-core-lstm.wasm.js            (OEM LSTM_ONLY)
//   tesseract-core-relaxedsimd.wasm.js | tesseract-core-simd.wasm.js
//   | tesseract-core.wasm.js                 (legacy / combined OEM)
// The *.wasm.js builds embed their WASM, so they are self-contained. Language
// data is fetched as `${langPath}/${lang}.traineddata.gz` when gzip is true;
// every installed @tesseract.js-data/<lang> package is copied.
//
// Default copies only what OEM.LSTM_ONLY needs (~12 MB of cores). Pass --all
// to copy every core variant (*.js and *.wasm, ~44 MB).
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const dest = join(root, 'public', 'tesseract');
const langDest = join(dest, 'lang');
const all = process.argv.includes('--all');
mkdirSync(langDest, { recursive: true });

let failed = false;
function copy(from, to) {
  if (!existsSync(from)) {
    console.error(`tesseract: MISSING ${from}`);
    failed = true;
    return;
  }
  copyFileSync(from, to);
  const kb = Math.round(statSync(to).size / 1024);
  console.log(`tesseract: ${to.slice(root.length + 1)} (${kb} KB)`);
}

copy(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(dest, 'worker.min.js'));

const coreDir = join(nm, 'tesseract.js-core');
const cores = existsSync(coreDir)
  ? readdirSync(coreDir).filter((f) =>
      all ? /^tesseract-core.*\.(js|wasm)$/.test(f) : /^tesseract-core(-relaxedsimd|-simd)?-lstm\.wasm\.js$/.test(f),
    )
  : [];
if (!cores.length) {
  console.error('tesseract: no core files found in node_modules/tesseract.js-core');
  failed = true;
}
for (const f of cores) copy(join(coreDir, f), join(dest, f));

const dataDir = join(nm, '@tesseract.js-data');
const langs = existsSync(dataDir)
  ? readdirSync(dataDir).filter((l) => existsSync(join(dataDir, l, '4.0.0_best_int', `${l}.traineddata.gz`)))
  : [];
if (!langs.includes('eng')) {
  console.error('tesseract: English data missing (node_modules/@tesseract.js-data/eng)');
  failed = true;
}
for (const l of langs) {
  copy(join(dataDir, l, '4.0.0_best_int', `${l}.traineddata.gz`), join(langDest, `${l}.traineddata.gz`));
}

if (failed) process.exit(1);
