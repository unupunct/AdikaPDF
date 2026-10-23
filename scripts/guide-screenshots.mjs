/**
 * Screenshots for the user guide (docs/guide/img/<lang>/*.png).
 *
 *   node --import ./tests/e2e/tsResolve.mjs scripts/guide-screenshots.mjs [en|ro ...]
 *
 * Launches the release exe through the E2E harness (fresh profile and data
 * folder; ADIKA_EXE picks another exe), builds sample documents and invoices
 * with invented data (TEST SRL, CUIs and IBANs with valid check digits that
 * belong to nobody), opens the dialogs the guide talks about and saves cropped
 * PNGs, once in English and once in Romanian. ANAF is faked inside the app
 * (the E2E hooks of actions/anaf.ts): nothing is sent anywhere.
 */
import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import forge from 'node-forge';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// App modules use the "@/" alias; Node resolves it to src/.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) return next(pathToFileURL(join(ROOT, 'src', `${specifier.slice(2)}.ts`)).href, context);
    return next(specifier, context);
  },
});

const { launchApp, tempDir } = await import('../tests/e2e/harness.mjs');
const { calculate, emptyDraft, emptyLine, emptyParty } = await import('../src/lib/einvoice/model.ts');
const { writeUbl } = await import('../src/lib/einvoice/write.ts');
const { cuiValid, ibanValid } = await import('../src/lib/einvoice/rules.ts');

const LANGS = process.argv.slice(2).filter((a) => ['en', 'ro'].includes(a));
if (!LANGS.length) LANGS.push('en', 'ro');

// ------------------------------------------------------------------ invented data

/** A CUI with a valid check digit (the base digits are invented). */
function cui(base) {
  const d = base.padStart(9, '0');
  const key = '753217532';
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * Number(key[i]);
  return `${base}${((sum * 10) % 11) % 10}`;
}

/** A Romanian IBAN of the invented bank "TEST" with valid check digits. */
function iban(account) {
  const bban = `TEST${account.padStart(16, '0')}`;
  const moved = `${bban}RO00`;
  let r = 0;
  for (const ch of moved) for (const d of ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch) r = (r * 10 + Number(d)) % 97;
  return `RO${String(98 - r).padStart(2, '0')}${bban}`;
}

const SELLER_CUI = cui('1234567');
const CLIENT_CUI = cui('7654321');
const SUPPLIER_CUI = cui('1111222');
const LOOKUP_CUI = cui('2468024');
const SELLER_IBAN = iban('1234567890');
for (const c of [SELLER_CUI, CLIENT_CUI, SUPPLIER_CUI, LOOKUP_CUI]) if (!cuiValid(c)) throw new Error(`CUI ${c}`);
if (!ibanValid(SELLER_IBAN)) throw new Error(`IBAN ${SELLER_IBAN}`);

const party = (p) => ({ ...emptyParty('RO'), ...p });
const SELLER = party({ name: 'TEST SRL', vatId: `RO${SELLER_CUI}`, companyId: 'J12/0000/2020', street: 'Strada Exemplului nr. 1', city: 'Cluj-Napoca', postalCode: '400000', region: 'RO-CJ', email: 'facturi@test.example', phone: '0700 000 000' });
const CLIENT = party({ name: 'CLIENT TEST SRL', vatId: `RO${CLIENT_CUI}`, companyId: 'J40/0000/2021', street: 'Bulevardul Demonstrației nr. 2', city: 'SECTOR3', postalCode: '030000', region: 'RO-B', email: 'contabilitate@client.example' });
const SUPPLIER = party({ name: 'FURNIZOR EXEMPLU SRL', vatId: `RO${SUPPLIER_CUI}`, companyId: 'J22/0000/2019', street: 'Strada Modelului nr. 3', city: 'Iași', postalCode: '700000', region: 'RO-IS' });

const year = new Date().getFullYear();
const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

function invoiceXml({ seller, buyer, number, lines }) {
  const d = emptyDraft('ro', day(-3));
  Object.assign(d, { number, dueDate: day(27), seller, buyer, lines: lines.map((l) => ({ ...emptyLine(), ...l })) });
  d.payment = { ...d.payment, meansCode: '30', iban: iban('9876543210'), terms: 'Plata în 30 de zile' };
  return writeUbl(calculate(d));
}

const BOOK = {
  version: 1,
  sellers: [
    {
      id: 'seller-test',
      party: SELLER,
      accounts: [{ iban: SELLER_IBAN, bic: '', bank: 'Banca TEST' }],
      logo: '',
      series: [{ prefix: `TEST-${year}-`, next: 8, digits: 4 }],
      profile: 'ro',
      currency: 'RON',
      paymentDays: 30,
      terms: 'Plata în 30 de zile de la emitere',
    },
  ],
  customers: [{ ...CLIENT, id: 'cust-1', lastUsed: day(-10) }],
  products: [
    { id: 'p1', name: 'Servicii de consultanță', description: '', itemId: 'CONS', unit: 'HUR', price: 250, vatCategory: 'S', vatPercent: 21 },
    { id: 'p2', name: 'Licență software (anual)', description: '', itemId: 'LIC', unit: 'H87', price: 1200, vatCategory: 'S', vatPercent: 21 },
  ],
  lastSellerId: 'seller-test',
};

/** A self-signed RSA .pfx with an invented name (3DES, as Windows imports it). */
function makePfx(path, password, name) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0b1c2d';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const subject = [{ name: 'commonName', value: name }, { name: 'organizationName', value: 'TEST SRL' }, { name: 'countryName', value: 'RO' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  writeFileSync(path, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  return path;
}

async function contractPdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 60, y: 760, size: 22, font: bold });
  page.drawText('TEST SRL  -  CLIENT TEST SRL', { x: 60, y: 728, size: 12, font });
  const lines = ['Sample document with invented content, made for the user guide.', 'Article 1. The parties agree to test the signing features.', 'Article 2. Nothing in this document is real.'];
  lines.forEach((t, i) => page.drawText(t, { x: 60, y: 690 - i * 20, size: 11, font }));
  page.drawRectangle({ x: 60, y: 120, width: 200, height: 1, color: rgb(0.4, 0.4, 0.4) });
  page.drawText('Signature', { x: 60, y: 104, size: 9, font });
  doc.setTitle(title);
  return doc.save();
}

// ------------------------------------------------------------------ files

const work = tempDir('adika-guide-');
const out = join(work, 'out');
const dataDir = join(work, 'data');
mkdirSync(out);
mkdirSync(dataDir);
writeFileSync(join(dataDir, 'einvoice-book.json'), JSON.stringify(BOOK));
const RECEIVED = join(work, `F-EX-${year}-0042.xml`);
writeFileSync(RECEIVED, invoiceXml({ seller: SUPPLIER, buyer: SELLER, number: `F-EX-${year}-0042`, lines: [{ name: 'Hârtie copiator A4 (top)', quantity: 20, unit: 'H87', price: 24.5 }, { name: 'Toner imprimantă', quantity: 2, unit: 'H87', price: 310, vatPercent: 21 }] }));
const ISSUED = join(work, `TEST-${year}-0007.xml`);
writeFileSync(ISSUED, invoiceXml({ seller: SELLER, buyer: CLIENT, number: `TEST-${year}-0007`, lines: [{ name: 'Servicii de consultanță', quantity: 8, unit: 'HUR', price: 250 }] }));
const CONTRACT = join(work, 'Contract TEST.pdf');
writeFileSync(CONTRACT, await contractPdf('Contract TEST nr. 1'));
const BATCH = join(work, 'batch');
mkdirSync(BATCH);
for (const n of ['Contract TEST nr. 2', 'Proces-verbal TEST', 'Anexa TEST']) writeFileSync(join(BATCH, `${n}.pdf`), await contractPdf(n));
const PFX = makePfx(join(work, 'test-signer.pfx'), 'adika-guide', 'Maria TEST');
process.env.ADIKA_WINSTORE_TEST_PFX = PFX;
process.env.ADIKA_WINSTORE_TEST_PASSWORD = 'adika-guide';

// ------------------------------------------------------------------ app

const app = await launchApp({ dataDir, port: 9351 });
const { page } = app;
page.on('pageerror', (e) => console.log(`   [pageerror] ${e.message}`));
const S = (fn, arg) => page.evaluate(fn, arg);
const slash = (p) => p.split('\\').join('/');
await S((d) => window.__adika.platform.e2eSetSaveDir(d), out);
await page.setViewportSize({ width: 1280, height: 860 });

async function idle(timeout = 120000) {
  await page.waitForFunction(() => !window.__adika.store.getState().busy && !window.__adika.document.isSaving?.(), null, { timeout });
}
async function closeAll() {
  await S(() => {
    const t = window.__adika.tabs;
    window.__adika.store.setState({ dirty: false, modal: null });
    for (const tab of [...t.useTabs.getState().tabs]) t.removeTab(tab.id);
  });
  await page.waitForTimeout(200);
}
async function open(path) {
  await closeAll();
  await S((p) => window.__adika.document.openPdfPath(p), slash(path));
  await idle();
  await page.waitForSelector('[data-testid="page-1"] canvas', { timeout: 20000 });
  await page.waitForTimeout(600);
}
async function modal(id) {
  await S((m) => window.__adika.store.getState().openModal(m), id);
}
async function escape() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}
async function settle(ms = 350) {
  // Tooltips, toasts and focus rings out of the way.
  await S(() => window.__adika.store.setState({ toasts: [] }));
  await page.mouse.move(2, 600);
  await page.waitForTimeout(ms);
}

let lang = 'en';
let count = 0;
async function shot(name, target, opts = {}) {
  const dir = join(ROOT, 'docs', 'guide', 'img', lang);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await settle(opts.wait ?? 350);
  if (!target) await page.screenshot({ path, clip: opts.clip });
  else await (typeof target === 'string' ? page.locator(target).first() : target).screenshot({ path });
  count++;
  console.log(`  ${lang}/${name}.png`);
}

/** One picture around several elements (all visible in the viewport). */
async function shotAround(name, locators, pad = 4) {
  const boxes = [];
  for (const l of locators) {
    await l.scrollIntoViewIfNeeded();
    boxes.push(await l.boundingBox());
  }
  const x = Math.min(...boxes.map((b) => b.x)) - pad;
  const y = Math.min(...boxes.map((b) => b.y)) - pad;
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const b = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  await shot(name, null, { clip: { x, y, width: r - x, height: b - y } });
}
const aside = () => [page.locator(`${newInvoice} aside > section`).nth(0), page.locator(`${newInvoice} aside > section`).nth(1)];

/** The fake ANAF: OAuth, validation, upload, status, messages and the VAT register, answered inside the app. */
async function fakeAnaf({ validationErrors = false } = {}) {
  await S(
    ({ errors, lookupCui, sellerCui }) => {
      let polls = 0;
      const json = (v, status = 200) => ({ status, body: JSON.stringify(v) });
      window.__adika.anaf.e2eAnaf({
        authorize: async (url) => ({ code: 'c1', state: new URL(url).searchParams.get('state') }),
        transport: async (r) => {
          if (r.url.includes('/anaf-oauth2/v1/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 7776000 });
          if (r.url.includes('PlatitorTvaRest')) {
            return json({
              found: [
                {
                  date_generale: { cui: Number(lookupCui), denumire: 'EXEMPLU DISTRIBUȚIE SRL', nrRegCom: 'J05/0000/2018', telefon: '0700 000 001', stare_inregistrare: 'INREGISTRAT', statusRO_e_Factura: true },
                  inregistrare_scop_Tva: { scpTVA: true },
                  stare_inactiv: { statusInactivi: false },
                  inregistrare_RTVAI: { statusTvaIncasare: false },
                  adresa_sediu_social: { sdenumire_Strada: 'Str. Testului', snumar_Strada: '5', sdenumire_Localitate: 'Mun. Oradea', scod_JudetAuto: 'BH', sdenumire_Judet: 'BIHOR', scod_Postal: '410000' },
                },
              ],
              notFound: [],
            });
          }
          if (r.url.includes('/validare/')) {
            return errors
              ? json({
                  stare: 'nok',
                  trace_id: 'guide-example',
                  Messages: [
                    { message: 'E: validari globale  eroare regula: BR-RO-110 Daca Codul tarii vanzatorului este RO, atunci codul subdiviziunii tarii trebuie sa fie codificat folosind lista ISO 3166-2:RO' },
                    { message: 'E: validari globale  eroare regula: BR-RO-100 Daca Codul tarii cumparatorului este RO si subdiviziunea este RO-B, orasul trebuie sa fie SECTOR1 ... SECTOR6' },
                  ],
                })
              : json({ stare: 'ok', trace_id: 'guide-example' });
          }
          if (r.url.includes('/upload?')) return { status: 200, body: '<header ExecutionStatus="0" index_incarcare="5001234567"/>' };
          if (r.url.includes('/stareMesaj?')) return { status: 200, body: ++polls < 2 ? '<header stare="in prelucrare"/>' : '<header stare="ok" id_descarcare="4009876543"/>' };
          if (r.url.includes('/listaMesajeFactura?')) {
            return json({
              mesaje: [
                { data_creare: '202610141030', cif: sellerCui, id_solicitare: '5001234567', detalii: `Factura cu id_incarcare=5001234567 emisa de cif_emitent=${sellerCui} pentru cif_beneficiar=7654321x`, tip: 'FACTURA TRIMISA', id: '4009876543' },
                { data_creare: '202610131512', cif: sellerCui, id_solicitare: '5001230000', detalii: `Factura primita de la cif_emitent=1111222x pentru cif_beneficiar=${sellerCui}`, tip: 'FACTURA PRIMITA', id: '4009870000' },
                { data_creare: '202610120901', cif: sellerCui, id_solicitare: '5001220000', detalii: 'Erori de validare identificate la factura transmisa cu id_incarcare=5001220000', tip: 'ERORI FACTURA', id: '4009860000' },
              ],
            });
          }
          return { status: 404, body: '' };
        },
      });
    },
    { errors: validationErrors, lookupCui: LOOKUP_CUI, sellerCui: SELLER_CUI },
  );
}

const newInvoice = '[data-testid="einvoice-new-modal"]';
const section = (i) => page.locator(`${newInvoice} section`).nth(i);

async function run() {
  // ---------------------------------------------------------------- start
  await closeAll();
  await page.click('[data-testid="tab-home"]');
  await shot('start-screen');

  await open(CONTRACT);
  await page.click('[data-testid="tab-convert"]');
  await shot('ribbon-convert', null, { clip: { x: 0, y: 0, width: 1280, height: 172 } });
  await page.click('[data-testid="tab-sign"]');
  await shot('ribbon-sign', null, { clip: { x: 0, y: 0, width: 1280, height: 172 } });
  // Simple ribbon and the welcome window (E2E mode starts in the full ribbon without the welcome).
  await S(() => window.__adika.uiMode.getState().setMode('simple'));
  await settle();
  await shot('ribbon-simple', null, { clip: { x: 0, y: 0, width: 1280, height: 172 } });
  await S(() => window.__adika.uiMode.getState().setMode('full'));
  await closeAll();
  await S(() => window.__adika.uiMode.getState().openWelcome());
  await shot('welcome', '[data-testid="first-run"]', { wait: 500 });
  await page.click('[data-testid="first-run-close"]');
  await settle();

  // ---------------------------------------------------------------- reading a received invoice
  await closeAll();
  await S((p) => window.__adika.document.openPdfPath(p), slash(RECEIVED));
  await idle();
  await page.waitForSelector('[data-testid="page-1"] canvas', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot('einvoice-readable');
  await modal('einvoice');
  await page.waitForSelector('[data-testid="einvoice-summary"]', { timeout: 20000 });
  await shot('einvoice-dialog', '[data-testid="einvoice-modal"]');
  await escape();

  // ---------------------------------------------------------------- creating an invoice
  await fakeAnaf();
  await page.setViewportSize({ width: 1280, height: 1500 });
  await closeAll();
  await page.click('[data-testid="tab-convert"]');
  await page.click('[data-testid="btn-einvoice-new"]');
  await page.waitForSelector(newInvoice);
  await page.waitForFunction(() => document.querySelector('[data-testid="einv-number"]')?.value?.startsWith('TEST-'), null, { timeout: 10000 });
  await page.locator(`${newInvoice} section`).first().locator('button:has-text("Edit"), button:has-text("Editare")').first().click();
  await shot('einvoice-seller', section(0));
  // Buyer: a saved customer, then a CUI looked up at the (fake) register.
  await page.fill('[data-testid="einv-buyer-search"]', 'CLIENT');
  await page.click('[data-testid="einv-buyer-match"]');
  await page.waitForTimeout(200);
  await shot('einvoice-buyer', section(1));
  await page.fill('[data-testid="einv-buyer-vat"]', '');
  await page.fill('[data-testid="einv-buyer-reg"]', LOOKUP_CUI);
  await page.click('[data-testid="einv-buyer-anaf"]');
  await page.waitForSelector('[data-testid="einv-buyer-anaf-notes"]', { timeout: 10000 });
  await shot('einvoice-buyer-lookup', section(1));
  // Lines: one typed, one from the catalogue, a document discount.
  await page.fill('[data-testid="einv-line-name"]', 'Servicii de consultanță');
  await page.locator('[data-testid="einv-line-qty"]').first().fill('8');
  await page.locator('[data-testid="einv-line-price"]').first().fill('250');
  await section(3).locator('select:has(option[value="p2"])').selectOption('p2');
  await page.waitForTimeout(200);
  await section(3).locator('button').filter({ hasText: /Document discount|Reducere la nivel de document/ }).click();
  const discount = section(3).locator('div.mt-1.flex').last();
  await discount.locator('input').nth(0).fill(lang === 'ro' ? 'Discount client fidel' : 'Loyal customer discount');
  await discount.locator('input').nth(1).fill('100');
  await shot('einvoice-lines', section(3));
  await shotAround('einvoice-totals', aside());
  // ANAF's own check (fake: no errors).
  await page.click('[data-testid="einv-anaf-check"]');
  await page.waitForSelector(`${newInvoice} [data-testid="anaf-validation"]`, { timeout: 10000 });
  await shotAround('einvoice-anaf-check', aside());
  // A mistake: the buyer's county removed.
  await section(1).locator('select:has(option[value="RO-B"])').selectOption('');
  await page.waitForTimeout(250);
  await shotAround('einvoice-checks-errors', aside());
  await escape();

  // Foreign currency and an exempt line on a fresh draft.
  await page.click('[data-testid="btn-einvoice-new"]');
  await page.waitForSelector(newInvoice);
  await page.fill('[data-testid="einv-buyer-search"]', 'CLIENT');
  await page.click('[data-testid="einv-buyer-match"]');
  await page.fill('[data-testid="einv-currency"]', 'EUR');
  await page.fill('[data-testid="einv-rate"]', '5.0812');
  await page.fill('[data-testid="einv-line-name"]', 'Licență software (anual)');
  await page.locator('[data-testid="einv-line-price"]').first().fill('240');
  await shot('einvoice-currency', section(2));
  await shotAround('einvoice-currency-totals', aside());
  await page.locator(`${newInvoice} [data-testid="einv-outputs"]`).locator('..').screenshot({ path: join(ROOT, 'docs', 'guide', 'img', lang, 'einvoice-outputs.png') });
  console.log(`  ${lang}/einvoice-outputs.png`);
  count++;
  await escape();

  // ---------------------------------------------------------------- credit note
  await page.setViewportSize({ width: 1280, height: 860 });
  await closeAll();
  await S((p) => window.__adika.document.openPdfPath(p), slash(ISSUED));
  await idle();
  await modal('einvoice');
  await page.waitForSelector('[data-testid="einvoice-credit-note"]', { timeout: 20000 });
  await page.setViewportSize({ width: 1280, height: 1500 });
  await page.click('[data-testid="einvoice-credit-note"]');
  await page.waitForSelector(newInvoice);
  await page.waitForFunction(() => document.querySelector('[data-testid="einv-preceding"]')?.value, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('credit-note', page.locator(`${newInvoice}`), { wait: 500 });
  await escape();
  await page.setViewportSize({ width: 1280, height: 860 });

  // ---------------------------------------------------------------- ANAF dialog
  await closeAll();
  await S(() => window.__adika.anaf.disconnectAnaf());
  await S(() => window.__adika.anaf.useAnafSettings.getState().update({ clientId: '', redirectUri: '', test: true }));
  await S(() => window.__adika.anaf.saveClientSecret(''));
  await S(() => window.__adika.anaf.useAnafOutbox.setState({ xml: null, number: '', name: '' }));
  await S(() => window.__adika.anaf.openAnafDialog());
  await page.waitForSelector('[data-testid="anaf-client-id"]');
  await page.fill('[data-testid="anaf-client-id"]', '0123456789abcdef-test-client-id');
  await page.fill('[data-testid="anaf-client-secret"]', 'test-secret-not-real');
  await page.fill('[data-testid="anaf-redirect"]', 'http://localhost:8765/callback');
  await shot('anaf-settings', '[data-testid="anaf-modal"]');
  await page.click('[data-testid="anaf-modal"] button:has-text("Save settings"), [data-testid="anaf-modal"] button:has-text("Salvare setări")');
  await escape();
  const xml = (await import('node:fs')).readFileSync(ISSUED, 'utf8');
  await S((x) => window.__adika.anaf.openAnafDialog({ xml: x.xml, number: x.number }), { xml, number: `TEST-${year}-0007` });
  await page.waitForSelector('[data-testid="anaf-modal"]');
  await page.click('[data-testid="anaf-connect"]');
  await page.waitForSelector('[data-testid="anaf-disconnect"]', { timeout: 10000 });
  await page.click('[data-testid="anaf-validate"]');
  await page.waitForSelector('[data-testid="anaf-modal"] [data-testid="anaf-validation"]', { timeout: 10000 });
  await page.click('[data-testid="anaf-upload"]');
  await page.waitForSelector('[data-testid="anaf-current"]', { timeout: 10000 });
  await page.locator('[data-testid="anaf-current"] button').first().click();
  await page.waitForFunction(() => /Accepted|Acceptat/.test(document.querySelector('[data-testid="anaf-current"]')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  await shot('anaf-send', '[data-testid="anaf-modal"]');
  await page.locator('[data-testid="anaf-modal"] [role="tab"]').nth(1).click();
  await page.click('[data-testid="anaf-list"]');
  await page.waitForSelector('[data-testid="anaf-messages"]', { timeout: 10000 });
  await shot('anaf-messages', '[data-testid="anaf-modal"]');
  await page.locator('[data-testid="anaf-modal"] [role="tab"]').nth(2).click();
  await page.waitForSelector('[data-testid="anaf-uploads"]', { timeout: 10000 });
  await shot('anaf-log', '[data-testid="anaf-modal"]');
  await page.locator('[data-testid="anaf-modal"] [role="tab"]').nth(0).click();
  await fakeAnaf({ validationErrors: true });
  await page.click('[data-testid="anaf-validate"]');
  await page.waitForFunction(() => /BR-RO-110/.test(document.querySelector('[data-testid="anaf-modal"] [data-testid="anaf-validation"]')?.textContent ?? ''), null, { timeout: 10000 });
  await shot('anaf-validation-errors', '[data-testid="anaf-modal"] [data-testid="anaf-validation"]');
  await escape();
  await S(() => window.__adika.anaf.disconnectAnaf());
  await S(() => window.__adika.anaf.e2eAnaf(null));

  // ---------------------------------------------------------------- signing
  await page.setViewportSize({ width: 1280, height: 1300 });
  await open(CONTRACT);
  await page.click('[data-testid="tab-sign"]');
  await page.click('[data-testid="btn-cert-sign"]');
  await page.waitForSelector('[data-testid="certificate-modal"]');
  await page.locator('[data-testid="certificate-modal"] [role="tab"]').nth(1).click();
  await page.fill('[data-testid="selfsigned-name"]', 'Maria TEST');
  await page.click('[data-testid="selfsigned-create"]');
  await page.waitForSelector('[data-testid="identity-card"]', { timeout: 60000 });
  // The certificate-file tab is what most people use: show it with a file "unlocked".
  await page.locator('[data-testid="certificate-modal"] [role="tab"]').nth(0).click();
  await S((f) => window.__adika.platform.e2eQueuePicks([f]), slash(PFX));
  await page.locator('[data-testid="certificate-modal"] button').filter({ hasText: /Choose certificate|Alegeți certificatul|Alegere certificat/ }).first().click();
  await page.fill('[data-testid="certificate-modal"] input[type="password"]', 'adika-guide');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="identity-card"]', { timeout: 30000 });
  await shot('sign-certificate', '[data-testid="certificate-modal"]');
  await page.click('[data-testid="cert-sign-now"]');
  await idle();
  await page.waitForTimeout(500);
  const signed = await S(() => [...window.__adika.platform.e2eSavedFiles()].reverse().find((f) => /-signed\.pdf$/i.test(f)));
  await escape();

  await modal('token');
  await page.waitForSelector('[data-testid="token-modal"]');
  await page.waitForTimeout(1500);
  await shot('sign-token', '[data-testid="token-modal"]');
  await escape();

  await modal('winstore');
  await page.waitForSelector('[data-testid="winstore-list"]', { timeout: 20000 });
  await shot('sign-winstore', '[data-testid="winstore-modal"]');
  await page.click('[data-testid="sig-design-open"]');
  await page.waitForSelector('[data-testid="sig-designer"]');
  await page.waitForTimeout(1200);
  await shot('sig-designer', '[data-testid="sig-designer"]', { wait: 800 });
  await escape();
  await escape();

  await S(() => {
    localStorage.removeItem('adika.cscProviders');
  });
  await modal('cloudsign');
  await page.waitForSelector('[data-testid="cloudsign-modal"]');
  if (!(await page.$('[data-testid="csc-name"]'))) await page.click('[data-testid="cloudsign-add-provider"]');
  await page.fill('[data-testid="csc-name"]', lang === 'ro' ? 'Furnizorul meu (exemplu)' : 'My provider (example)');
  await page.fill('[data-testid="csc-url"]', 'https://csc.provider.example/csc/v2');
  await shot('sign-cloud-provider', '[data-testid="cloudsign-modal"]');
  await escape();

  // Verification of the signed file.
  if (signed) {
    await open(signed.replace(/\//g, '\\'));
    await modal('verify');
    await page.waitForSelector('[data-testid="signature-card"]', { timeout: 30000 });
    await page.waitForTimeout(800);
    await shot('verify', '[data-testid="verify-modal"]');
    await escape();
    // Editing the signed file: saving asks first.
    await S(() => {
      const s = window.__adika.store.getState();
      const pageId = s.pages[0].id;
      s.addObject?.({ id: `guide-${Date.now()}`, type: 'rect', pageId, x: 300, y: 300, width: 120, height: 40, stroke: '#dc2626', fill: null, strokeWidth: 2, opacity: 1, rotation: 0 });
    });
    await page.waitForTimeout(300);
    await page.click('[data-testid="tab-home"]');
    await page.click('[data-testid="btn-save"]').catch(() => undefined);
    const prompt = await page.waitForSelector('[data-testid="confirm-prompt"]', { timeout: 8000 }).catch(() => null);
    if (prompt) {
      await shot('save-signed-warning', '[data-testid="confirm-prompt"]');
      await escape();
    } else console.log('  (no save warning: skipped)');
    await S(() => window.__adika.store.setState({ dirty: false }));
  }

  // ---------------------------------------------------------------- sign many files
  await closeAll();
  await modal('batchsign');
  await page.waitForSelector('[data-testid="batchsign-modal"]');
  await S((f) => window.__adika.platform.e2eQueuePicks([f]), slash(BATCH));
  await page.click('[data-testid="batchsign-add-folder"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="batchsign-files"] li').length >= 3, null, { timeout: 10000 });
  await page.locator('[data-testid="batchsign-modal"] [role="tab"]').nth(1).click();
  await page.waitForTimeout(1500);
  await page.click('[data-testid="batchsign-run"]');
  await page.waitForSelector('[data-testid="batchsign-summary"]', { timeout: 90000 });
  await page.waitForTimeout(400);
  await shot('batchsign', '[data-testid="batchsign-modal"]');
  await escape();
  await page.setViewportSize({ width: 1280, height: 860 });
}

try {
  for (const l of LANGS) {
    lang = l;
    console.log(`[${l}]`);
    rmSync(join(ROOT, 'docs', 'guide', 'img', l), { recursive: true, force: true });
    await S((x) => window.__adika.i18n.useLang.getState().setLang(x), l);
    await page.waitForTimeout(500);
    await run();
  }
  console.log(`${count} screenshots`);
} finally {
  await app.close();
}
