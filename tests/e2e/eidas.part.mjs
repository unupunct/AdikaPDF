// eIDAS: PAdES signature levels, EU Trusted Lists, the Windows certificate store — included by suite.mjs.
import { writeFileSync } from 'node:fs';
import forge from 'node-forge';

export const STORE_TEST_NAME = 'Adika Store Test';

/** A self-signed RSA .pfx (3DES, as Windows imports it) for the in-memory test store. */
export function makeStoreTestPfx(path, password) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b2c';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 30 * 86400e3);
  const name = [{ name: 'commonName', value: STORE_TEST_NAME }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  writeFileSync(path, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  return path;
}

export function registerEidasTests(test, ctx) {
  const { S, page, open, idle, savedFile, assert, F } = ctx;

  test('PAdES signature (EU format) with a self-signed ID: level shown when signing and verifying', async () => {
    await open(F.sample);
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-cert-sign"]');
    await page.click('text=Create self-signed ID');
    await page.fill('[data-testid="selfsigned-name"]', 'Elena Pades');
    await page.click('[data-testid="selfsigned-create"]');
    await page.waitForFunction((name) => document.querySelector('[data-testid="identity-card"]')?.textContent.includes(name), 'Elena Pades', { timeout: 30000 });
    const level = await page.textContent('[data-testid="pades-level"]');
    assert(/PAdES B-B/.test(level), `level before signing (${level})`);
    await page.click('[data-testid="cert-sign-now"]');
    await idle();
    const path = await savedFile(/-signed\.pdf$/);
    const v = await S(async (p) => window.__adika.signature.verifyPdfSignatures(await window.__adika.platform.readFile(p)), path.replace(/\\/g, '/'));
    assert(v.length === 1 && v[0].integrity === 'valid' && v[0].padesLevel === 'B-B', `PAdES B-B signature (${JSON.stringify({ l: v[0]?.padesLevel, m: v[0]?.message })})`);
    await page.waitForFunction(() => window.__adika.store.getState().signatureStatus.length === 1, null, { timeout: 15000 });
    await page.click('[data-testid="btn-verify"]');
    await page.waitForSelector('[data-testid="pades-badge"]', { timeout: 15000 });
    const badge = await page.textContent('[data-testid="pades-badge"]');
    assert(/PAdES B-B/.test(badge), `badge (${badge})`);
    const tl = await page.textContent('[data-testid="eu-tl-status"]');
    assert(/not downloaded/.test(tl), `EU list status before download (${tl})`);
    await page.keyboard.press('Escape');
  });

  test('EU Trusted Lists: downloaded from the Commission and kept for offline use', async () => {
    await page.click('[data-testid="btn-verify"]');
    await page.waitForSelector('[data-testid="eu-tl-update"]');
    await page.click('[data-testid="eu-tl-update"]');
    await page.waitForFunction(() => /EU Trusted Lists: \d+ qualified services/.test(document.querySelector('[data-testid="eu-tl-status"]')?.textContent ?? ''), null, { timeout: 120000 });
    const tl = await page.textContent('[data-testid="eu-tl-status"]');
    const n = Number(/(\d+) qualified services/.exec(tl)[1]);
    assert(n > 500, `qualified services (${n})`);
    await idle();
    // Saved in the app data folder: read back through the native command.
    const saved = await S(async () => {
      const b = await window.__adika.platform.appDataRead('eu-trusted-lists.json');
      const j = JSON.parse(new TextDecoder().decode(b));
      return { lists: j.lists.length, services: j.services.length, ro: j.services.filter((s) => s.territory === 'RO' && s.kind === 'ca').length };
    });
    assert(saved.lists >= 25 && saved.services === n && saved.ro > 0, `cache (${JSON.stringify(saved)})`);
    // The self-signed signature is not made qualified by the lists.
    const status = await S(() => window.__adika.store.getState().signatureStatus[0]);
    assert(!status.euTrusted && status.chainStatus !== 'trusted', `self-signed stays untrusted (${status.chainStatus})`);
    await page.keyboard.press('Escape');
    // Only file names are accepted.
    const bad = await S(async () => window.__adika.platform.appDataRead('../x.json').then(() => 'read', (e) => String(e)));
    assert(/Invalid data file name/.test(bad), `path escape refused (${bad})`);
  });

  test('Windows certificate store: the dialog lists the certificates with a key and signs through Windows (CNG)', async () => {
    const list = await S(() => window.__adika.platform.winstoreList());
    assert(Array.isArray(list) && list.every((c) => /^[0-9a-f]{40}$/.test(c.thumbprint) && c.derBase64.length > 100), `store listing (${list.length})`);
    await open(F.second);
    await page.click('[data-testid="tab-sign"]');
    await page.click('[data-testid="btn-winstore-sign"]');
    await page.waitForSelector('[data-testid="winstore-modal"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="winstore-list"], [data-testid="winstore-empty"]'), null, { timeout: 15000 });
    const withKey = list.filter((c) => c.hasPrivateKey).length;
    const rows = await page.$$('[data-testid="winstore-list"] input[type="radio"]');
    assert(rows.length === withKey, `rows ${rows.length} = certificates with a key ${withKey}`);
    console.log(`   Windows store: ${list.length} certificates, ${withKey} with a private key`);
    // Sign with the test certificate (in-memory store): the key signs inside Windows.
    await page.click(`[data-testid="winstore-list"] label:has-text("${STORE_TEST_NAME}")`);
    await page.click('[data-testid="winstore-sign-now"]');
    await idle();
    const path = await savedFile(/-signed\.pdf$/);
    const v = await S(async (p) => window.__adika.signature.verifyPdfSignatures(await window.__adika.platform.readFile(p)), path.replace(/\\/g, '/'));
    assert(v.length === 1 && v[0].integrity === 'valid' && v[0].signerName === STORE_TEST_NAME && v[0].padesLevel === 'B-B', `signed with the Windows key (${JSON.stringify({ i: v[0]?.integrity, n: v[0]?.signerName, m: v[0]?.message })})`);
  });
}
