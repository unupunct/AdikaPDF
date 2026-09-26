/**
 * Hardware-token signing end to end, against a SoftHSM2 token:
 *   bash tests/token/setup-softhsm.sh   (creates the token)
 *   node tests/e2e/token.mjs
 * Drives the real Token dialog: driver selection, certificate list, wrong
 * PIN, RSA and ECDSA signing, then verification (app + chain to test CA).
 */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launchApp, tempDir } from './harness.mjs';

const ROOT = process.cwd();
const WORK = join(ROOT, '.tools', 'softhsm-test');
const MODULE = join(ROOT, '.tools', 'SoftHSM2', 'lib', 'softhsm2-x64.dll');
process.env.SOFTHSM2_CONF = join(WORK, 'softhsm2.conf');

const dir = tempDir('adika-token-');
const out = join(dir, 'out');
mkdirSync(out);
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([595, 842]).drawText('Contract to be signed with a hardware token', { x: 60, y: 760, size: 16, font });
const pdfPath = join(dir, 'contract.pdf');
writeFileSync(pdfPath, await doc.save());

const app = await launchApp({ exe: process.env.ADIKA_EXE });
const { page } = app;
page.on('pageerror', (e) => console.log(`   [pageerror] ${e.message}`));
const S = (fn, arg) => page.evaluate(fn, arg);
await S((d) => window.__adika.platform.e2eSetSaveDir(d), out);

function assert(c, m) {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}
const idle = () => page.waitForFunction(() => !window.__adika.store.getState().busy, null, { timeout: 120000 });

async function openContract() {
  await S(() => window.__adika.store.setState({ dirty: false }));
  await S((p) => window.__adika.document.openPdfPath(p), pdfPath);
  await idle();
}

async function openTokenDialog() {
  await page.click('[data-testid="tab-sign"]');
  await page.click('[data-testid="btn-token-sign"]');
  await page.waitForSelector('[data-testid="token-modal"]');
  await S((m) => window.__adika.platform.e2eQueuePicks([m]), MODULE);
  await page.click('[data-testid="token-modal"] button:has-text("Browse")');
  await page.waitForSelector('[data-testid="token-modal"] >> text=Adika Test Token', { timeout: 20000 });
}

async function sign(certLabel, pin) {
  await openTokenDialog();
  await page.click(`[data-testid="token-modal"] label:has-text("${certLabel}")`);
  await page.fill('[data-testid="token-pin"]', pin);
  await page.click('[data-testid="token-sign-now"]');
  await idle();
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split('\n')[0]}`);
    await page.screenshot({ path: join(dir, `FAIL-${results.length}.png`) }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}

await openContract();

await step('token dialog lists the SoftHSM token and both certificates', async () => {
  await openTokenDialog();
  const text = await page.textContent('[data-testid="token-modal"]');
  assert(text.includes('RSA signing key') && text.includes('ECDSA signing key'), `both certificates listed: ${text.slice(0, 300)}`);
  assert(/SoftHSM/i.test(text), 'manufacturer shown');
  await page.keyboard.press('Escape');
});

await step('wrong PIN is rejected with a clear message and nothing is saved', async () => {
  const before = (await S(() => window.__adika.platform.e2eSavedFiles())).length;
  await sign('RSA signing key', '000000');
  const toasts = await S(() => window.__adika.store.getState().toasts.map((t) => `${t.kind}:${t.message}`));
  assert(toasts.some((t) => t.startsWith('error:') && /incorrect pin/i.test(t)), `error toast: ${toasts.join(' | ')}`);
  const after = (await S(() => window.__adika.platform.e2eSavedFiles())).length;
  assert(after === before, 'no file written');
});

const caDer = Array.from(readFileSync(join(WORK, 'certs', 'ca.der')));
async function verify(path) {
  return S(
    async ({ p, ca }) => {
      const sig = window.__adika.signature;
      const bytes = await window.__adika.platform.readFile(p);
      const root = sig.identityFromCertificateDer(new Uint8Array(ca)).certificate;
      return {
        plain: await sig.verifyPdfSignatures(bytes),
        withCa: await sig.verifyPdfSignatures(bytes, { trustedRoots: [root] }),
      };
    },
    { p: path.split('\\').join('/'), ca: caDer },
  );
}

const signed = {};
for (const [label, alg] of [
  ['RSA signing key', /RSA-2048/],
  ['ECDSA signing key', /ECDSA P-256/],
]) {
  await step(`sign with the ${label} (PIN 123456) and verify`, async () => {
    await openContract();
    await sign(label, '123456');
    const files = await S(() => window.__adika.platform.e2eSavedFiles());
    const path = files[files.length - 1];
    assert(path && /-signed\.pdf$/.test(path), `signed file saved (${files.join(', ')})`);
    // Both runs save "contract-signed.pdf"; keep a copy per algorithm.
    const keep = join(out, `token-${label.split(' ')[0].toLowerCase()}-signed.pdf`);
    copyFileSync(path, keep);
    signed[label] = keep;
    const v = await verify(path);
    const s = v.plain[0];
    assert(v.plain.length === 1, 'one signature');
    assert(s.integrity === 'valid' && s.coversWholeFile, `integrity valid (${s.message})`);
    assert(alg.test(s.algorithm ?? ''), `algorithm ${s.algorithm}`);
    assert(/Ana Tokenescu/.test(s.signerName), `signer ${s.signerName}`);
    assert(s.chainStatus !== 'trusted', 'test CA is not trusted by Windows (expected)');
    assert(v.withCa[0].chainStatus === 'trusted', `chain to the test CA is trusted (${v.withCa[0].chainStatus}: ${v.withCa[0].chainDetails?.join(' / ')})`);
    console.log(`      ${s.algorithm} · ${s.signerName} · ${v.withCa[0].chainDetails?.join(' → ')}`);
  });
}

await step('the reopened signed file shows the signature as intact', async () => {
  await page.waitForFunction(() => window.__adika.store.getState().signatureStatus.length === 1, null, { timeout: 15000 });
  const st = await S(() => window.__adika.store.getState().signatureStatus[0]);
  assert(st.integrity === 'valid', 'status bar signature valid');
  await page.click('[data-testid="btn-verify"]');
  await page.waitForSelector('[data-testid="signature-card"]');
  await page.screenshot({ path: join(dir, 'token-verify.png') });
  await page.keyboard.press('Escape');
});

writeFileSync(join(dir, 'signed-files.json'), JSON.stringify(signed, null, 1));
// Independent check with pyHanko (trusting the test CA).
const { spawnSync } = await import('node:child_process');
const py = spawnSync('C:/Program Files/Python313/python.exe', [join(ROOT, 'tests', 'token', 'validate.py'), join(WORK, 'certs', 'ca.der'), ...Object.values(signed)], {
  env: { ...process.env, PYTHONPATH: join(ROOT, 'node_modules', '.cache', 'py') },
  encoding: 'utf8',
});
console.log(py.stdout.trim() || py.stderr.trim());
results.push(py.status === 0);
console.log(py.status === 0 ? '  ✓ pyHanko validates every token signature' : '  ✗ pyHanko validation failed');
console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((r) => !r).length} failed · outputs in ${dir}`);
await app.close();
process.exit(results.every(Boolean) ? 0 : 1);
