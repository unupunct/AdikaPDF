import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  ANAF_API,
  ANAF_AUTHORIZE_URL,
  ANAF_TOKEN_URL,
  ANAF_VALIDATE_URL,
  ANAF_VAT_URL,
  AnafAuthError,
  AnafClient,
  AnafCompanyLookup,
  AnafError,
  anafCity,
  anafCounty,
  anafCui,
  checkAnafApp,
  loopbackRedirect,
  messageKind,
  parseCallback,
  parseMessageList,
  parseStatusReply,
  parseUploadReply,
  parseValidation,
  parseVatReply,
  partyFromCompany,
  pollUpload,
  readUploadLog,
  ruleOf,
  uploadCif,
  uploadStandard,
  upsertUpload,
  validateWithAnaf,
  validationStandard,
  type AnafApp,
  type AnafReply,
  type AnafTransport,
  type UploadRecord,
} from '@/lib/einvoice/anaf';
import { pkceChallenge } from '@/lib/crypto/csc';
import { calculate, emptyDraft, emptyLine, type InvoiceDraft } from '@/lib/einvoice/model';
import { validateInvoice } from '@/lib/einvoice/rules';
import { checkEInvoice, parseEInvoice, pickInvoiceXml } from '@/lib/einvoice/parse';
import { writeCii } from '@/lib/einvoice/write';

type Req = Parameters<AnafTransport>[0];

/** A transport that records requests and answers from a handler. */
function mock(handler: (r: Req) => AnafReply | Promise<AnafReply>) {
  const calls: Req[] = [];
  const transport: AnafTransport = async (r) => {
    calls.push(r);
    return handler(r);
  };
  return { calls, transport };
}

const json = (v: unknown, status = 200): AnafReply => ({ status, body: JSON.stringify(v) });

// Shapes as documented by ANAF for PlatitorTvaRest v9.
const company = (over: { cui: number; denumire: string; judetAuto: string; judet: string; localitate: string; scpTVA?: boolean; eFactura?: boolean; inactive?: boolean; radiere?: string }) => ({
  date_generale: {
    cui: over.cui,
    data: '2026-10-09',
    denumire: over.denumire,
    adresa: 'adresa',
    nrRegCom: 'J12/1/2020',
    telefon: '0264000000',
    codPostal: '',
    stare_inregistrare: over.radiere ? 'RADIERE din data 01.02.2025' : 'INREGISTRAT din data 01.01.2020',
    statusRO_e_Factura: over.eFactura ?? true,
  },
  inregistrare_scop_Tva: { scpTVA: over.scpTVA ?? true, perioade_TVA: [] },
  inregistrare_RTVAI: { statusTvaIncasare: false },
  stare_inactiv: { dataInactivare: over.inactive ? '2024-03-01' : '', dataReactivare: '', dataPublicare: '', dataRadiere: over.radiere ?? '', statusInactivi: over.inactive ?? false },
  inregistrare_SplitTVA: { statusSplitTVA: false },
  adresa_sediu_social: {
    sdenumire_Strada: 'Str. Memorandumului',
    snumar_Strada: '28',
    sdenumire_Localitate: over.localitate,
    scod_Localitate: '1',
    sdenumire_Judet: over.judet,
    scod_Judet: '12',
    scod_JudetAuto: over.judetAuto,
    stara: 'România',
    sdetalii_Adresa: 'Et. 2',
    scod_Postal: '400114',
  },
  adresa_domiciliu_fiscal: {},
});

describe('ANAF company lookup (VAT register)', () => {
  const reply = {
    cod: 200,
    message: 'SUCCESS',
    found: [
      company({ cui: 12345674, denumire: 'TEST CLUJ SRL', judetAuto: 'CJ', judet: 'CLUJ', localitate: 'Mun. Cluj-Napoca' }),
      company({ cui: 11111110, denumire: 'FIRMĂ ŞTEFĂNEŞTI SRL', judetAuto: 'B', judet: 'MUNICIPIUL BUCUREŞTI', localitate: 'Sector 3 Mun. Bucureşti', scpTVA: false, eFactura: false }),
      company({ cui: 22222229, denumire: 'INACTIVĂ SRL', judetAuto: '', judet: 'IAŞI', localitate: 'Iaşi', inactive: true, radiere: '2025-02-01' }),
    ],
    notFound: [33333338],
  };

  it('reads name, address, county code, Bucharest sector, VAT and e-Factura status, warnings', () => {
    const { found, notFound } = parseVatReply(JSON.stringify(reply), '2026-10-09');
    expect(notFound).toEqual(['33333338']);
    expect(found[0]).toMatchObject({ cui: '12345674', name: 'TEST CLUJ SRL', street: 'Str. Memorandumului nr. 28, Et. 2', city: 'Cluj-Napoca', county: 'RO-CJ', postalCode: '400114', vatPayer: true, eFactura: true, inactive: false, deregistered: false, warnings: [] });
    expect(found[1]).toMatchObject({ name: 'FIRMĂ ȘTEFĂNEȘTI SRL', city: 'SECTOR3', county: 'RO-B', vatPayer: false, eFactura: false });
    expect(found[2]).toMatchObject({ county: 'RO-IS', city: 'Iași', inactive: true, deregistered: true });
    expect(found[2].warnings).toEqual(['ANAF lists the company as deregistered (radiată) since 2025-02-01.', 'ANAF lists the company as inactive since 2024-03-01.']);
    expect([anafCounty('', 'jud. Argeş'), anafCounty('XX', 'Atlantis'), anafCity('Oraş Câmpina', 'RO-PH'), anafCity('Sectorul 6', 'RO-B')]).toEqual(['RO-AG', '', 'Câmpina', 'SECTOR6']);
  });

  it('fills a party: VAT number only for VAT payers, contact details kept', () => {
    const { found } = parseVatReply(JSON.stringify(reply), '2026-10-09');
    const keep = { ...emptyDraft().buyer, email: 'a@b.ro', phone: '07' };
    expect(partyFromCompany(found[0], keep)).toMatchObject({ name: 'TEST CLUJ SRL', vatId: 'RO12345674', companyId: 'J12/1/2020', region: 'RO-CJ', city: 'Cluj-Napoca', country: 'RO', email: 'a@b.ro', phone: '07' });
    const p = partyFromCompany(found[1]);
    expect(p).toMatchObject({ vatId: '', companyId: '11111110', city: 'SECTOR3', region: 'RO-B' });
    // A looked-up buyer passes the address and fiscal code rules.
    const d: InvoiceDraft = { ...emptyDraft('ro', '2026-10-09'), number: 'T-1', dueDate: '2026-10-20', seller: partyFromCompany(found[0]), buyer: p, payment: { ...emptyDraft().payment, iban: 'RO08TEST0000000000000001' }, lines: [{ ...emptyLine(), name: 'x', price: 10 }] };
    expect(validateInvoice(calculate(d)).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('checks CUIs before asking, batches 100 per request, waits a second between requests and caches answers', async () => {
    let clock = 0;
    const waits: number[] = [];
    const { calls, transport } = mock((r) => {
      const asked = JSON.parse(r.body!) as Array<{ cui: number; data: string }>;
      return json({ cod: 200, message: 'SUCCESS', found: asked.filter((a) => a.cui !== 33333338).map((a) => company({ cui: a.cui, denumire: `F${a.cui}`, judetAuto: 'CJ', judet: 'CLUJ', localitate: 'Cluj-Napoca' })), notFound: asked.filter((a) => a.cui === 33333338).map((a) => a.cui) });
    });
    const lookup = new AnafCompanyLookup(transport, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    await expect(lookup.lookup(['RO12345678'])).rejects.toBeInstanceOf(AnafError);
    expect(calls).toHaveLength(0);

    const valid: string[] = [];
    for (let n = 10000000; valid.length < 150; n++) {
      const c = anafCui(String(n));
      if (c) valid.push(c);
    }
    const m = await lookup.lookup(valid, '2026-10-09');
    expect(calls.map((c) => (JSON.parse(c.body!) as unknown[]).length)).toEqual([100, 50]);
    expect(calls[0]).toMatchObject({ url: ANAF_VAT_URL, method: 'POST', contentType: 'application/json' });
    expect((JSON.parse(calls[0].body!) as Array<{ data: string }>)[0].data).toBe('2026-10-09');
    expect(waits).toEqual([1000]);
    expect(m.size).toBe(150);

    // Cached for the session: no new request.
    expect((await lookup.lookupOne(`RO ${valid[3]}`, '2026-10-09'))?.name).toBe(`F${valid[3]}`);
    expect(calls).toHaveLength(2);
    // Unknown to ANAF: null (and cached as such).
    clock += 5000;
    expect(await lookup.lookupOne('33333338', '2026-10-09')).toBeNull();
    expect(await lookup.lookupOne('33333338', '2026-10-09')).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('runs parallel lookups one after another', async () => {
    let clock = 0;
    const starts: number[] = [];
    const { transport } = mock((r) => {
      starts.push(clock);
      const asked = JSON.parse(r.body!) as Array<{ cui: number }>;
      return json({ found: asked.map((a) => company({ cui: a.cui, denumire: 'X', judetAuto: 'CJ', judet: 'CLUJ', localitate: 'Cluj' })), notFound: [] });
    });
    const lookup = new AnafCompanyLookup(transport, { now: () => clock, sleep: async (ms) => { clock += ms; } });
    await Promise.all(['12345674', '11111110', '22222229'].map((c) => lookup.lookupOne(c)));
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('reports rate limiting and errors', async () => {
    const lookup = new AnafCompanyLookup(mock(() => ({ status: 429, body: '' })).transport, { sleep: async () => undefined });
    await expect(lookup.lookupOne('12345674')).rejects.toThrow(/limits/);
    expect(() => parseVatReply('<!DOCTYPE html><title>Request Rejected</title>', '2026-10-09')).toThrow(/firewall/);
    expect(() => parseVatReply('{"cod":500,"message":"Eroare"}', '2026-10-09')).toThrow(/Eroare/);
  });
});

describe('ANAF validation', () => {
  it('picks FACT1 / FCN and the upload standard', () => {
    const fx = (n: string) => readFileSync(join('tests', 'fixtures', 'anaf', n), 'utf8');
    expect([validationStandard(fx('ron-two-rates.xml')), validationStandard(fx('credit-note.xml'))]).toEqual(['FACT1', 'FCN']);
    expect([uploadStandard(fx('eur.xml')), uploadStandard(fx('credit-note.xml'))]).toEqual(['UBL', 'CN']);
    const d: InvoiceDraft = { ...emptyDraft('facturx', '2026-10-09'), number: 'C-1', lines: [{ ...emptyLine(), name: 'x', price: 1 }] };
    expect(uploadStandard(writeCii(calculate(d)))).toBe('CII');
  });

  it('reads ok / nok answers with the rules named in the messages', () => {
    expect(parseValidation(200, '{"stare":"ok","trace_id":"t-1"}')).toEqual({ ok: true, messages: [], traceId: 't-1' });
    const nok = parseValidation(200, JSON.stringify({ stare: 'nok', Messages: [{ message: 'E: validari globale eroare regula: BR-RO-110, Daca Codul tarii Vanzatorului (BT-40) este RO...' }, { message: '[BR-CO-15]-Invoice total amount with VAT' }, { message: 'Fisierul transmis nu este valid.' }], trace_id: 't-2' }));
    expect(nok.ok).toBe(false);
    expect(nok.messages.map((m) => m.rule)).toEqual(['BR-RO-110', 'BR-CO-15', '']);
    expect([ruleOf('[BR-RO-L200]-Numarul maxim'), ruleOf('regula: BR-S-08, x'), ruleOf('BR-61')]).toEqual(['BR-RO-L200', 'BR-S-08', 'BR-61']);
    expect(() => parseValidation(200, '<html><body>The requested URL was rejected. Request Rejected</body></html>')).toThrow(/firewall/);
    expect(() => parseValidation(400, '{"timestamp":"x","status":400,"error":"Bad Request","message":"Standard invalid"}')).toThrow(/Standard invalid/);
  });

  it('posts the XML as text/plain to the public service', async () => {
    const { calls, transport } = mock(() => json({ stare: 'ok', trace_id: 'x' }));
    const xml = readFileSync(join('tests', 'fixtures', 'anaf', 'credit-note.xml'), 'utf8');
    expect((await validateWithAnaf(transport, xml)).ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: `${ANAF_VALIDATE_URL}FCN`, method: 'POST', contentType: 'text/plain', body: xml });
  });
});

describe('ANAF live-check fixtures', () => {
  // Made with obviously fake data (TEST SRL, invented CUIs and IBAN with valid check digits) and
  // sent once to ANAF's public validation service; its answers are stored next to them.
  for (const name of ['ron-two-rates', 'eur', 'credit-note']) {
    it(`${name} still passes Adika's checks and ANAF accepted it`, () => {
      const xml = readFileSync(join('tests', 'fixtures', 'anaf', `${name}.xml`), 'utf8');
      const inv = parseEInvoice(xml);
      expect(checkEInvoice(inv)).toEqual([]);
      expect(inv.seller.name).toBe('TEST SRL');
      expect(uploadCif(xml)).toBe('11111110');
      const answer = parseValidation(200, readFileSync(join('tests', 'fixtures', 'anaf', `${name}.anaf.json`), 'utf8'));
      expect(answer.ok).toBe(true);
    });
  }

  it('covers two VAT rates, a foreign currency and a credit note', () => {
    const fx = (n: string) => parseEInvoice(readFileSync(join('tests', 'fixtures', 'anaf', n), 'utf8'));
    expect(fx('ron-two-rates.xml').vat.map((v) => v.percent).sort()).toEqual([11, 21]);
    expect(fx('eur.xml').currency).toBe('EUR');
    expect(fx('credit-note.xml').kind).toBe('credit');
  });
});

// ---------------------------------------------------------------- SPV

const app: AnafApp = { clientId: 'client-1', clientSecret: 's3cret', redirectUri: 'http://localhost:8765/callback', test: true };

/** ANAF as seen by the client: OAuth and the e-Factura API. */
function anafMock(opts: { expiresIn?: number } = {}) {
  const state = { codes: new Map<string, string>(), access: 'acc-1', refreshCount: 0, uploads: new Map<string, number>(), lastAuthUrl: '' };
  const { calls, transport } = mock(async (r) => {
    if (r.url === ANAF_TOKEN_URL) {
      expect(r.authorization).toBe(`Basic ${btoa('client-1:s3cret')}`);
      const f = new URLSearchParams(r.body);
      expect(f.get('token_content_type')).toBe('jwt');
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = state.codes.get(f.get('code')!);
        if (!challenge || pkceChallenge(f.get('code_verifier')!) !== challenge || f.get('redirect_uri') !== app.redirectUri) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: state.access, refresh_token: 'ref-1', expires_in: opts.expiresIn ?? 7776000, token_type: 'Bearer' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (f.get('refresh_token') !== 'ref-1') return json({ error: 'invalid_grant', error_description: 'Token expired' }, 400);
        state.refreshCount++;
        state.access = `acc-${state.refreshCount + 1}`;
        return json({ access_token: state.access, refresh_token: 'ref-1', expires_in: 7776000 });
      }
    }
    expect(r.url.startsWith(ANAF_API.test)).toBe(true);
    if (r.authorization !== `Bearer ${state.access}`) return { status: 401, body: '' };
    const u = new URL(r.url);
    const path = u.pathname.split('/').pop();
    if (path === 'upload') {
      if (u.searchParams.get('cif') === '12345674') return { status: 200, body: '<?xml version="1.0"?><header xmlns="mfp:anaf:dgti:spv:respUploadFisier:v1" dateResponse="202610091200" ExecutionStatus="1"><Errors errorMessage="Nu exista niciun CIF petru care sa aveti drept in SPV"/></header>' };
      state.uploads.set('5001', 0);
      return { status: 200, body: `<?xml version="1.0"?><header xmlns="mfp:anaf:dgti:spv:respUploadFisier:v1" dateResponse="202610091200" ExecutionStatus="0" index_incarcare="5001"/>` };
    }
    if (path === 'stareMesaj') {
      const id = u.searchParams.get('id_incarcare')!;
      const n = (state.uploads.get(id) ?? 0) + 1;
      state.uploads.set(id, n);
      return { status: 200, body: n < 3 ? '<header xmlns="mfp:anaf:dgti:efactura:stareMesajFactura:v1" stare="in prelucrare"/>' : '<header xmlns="mfp:anaf:dgti:efactura:stareMesajFactura:v1" stare="ok" id_descarcare="3001"/>' };
    }
    if (path === 'listaMesajeFactura') {
      if (u.searchParams.get('zile') === '1') return json({ eroare: 'Nu exista mesaje in ultimele 1 zile', titlu: 'Lista Mesaje' });
      return json({
        mesaje: [
          { data_creare: '202610081015', cif: '11111110', id_solicitare: '5000', detalii: 'Factura cu id_incarcare=5000 emisa de cif_emitent=22222229 pentru cif_beneficiar=11111110', tip: 'FACTURA PRIMITA', id: '3000' },
          { data_creare: '202610091210', cif: '11111110', id_solicitare: '5001', detalii: 'Factura cu id_incarcare=5001 emisa de cif_emitent=11111110 pentru cif_beneficiar=22222229', tip: 'FACTURA TRIMISA', id: '3001' },
          { data_creare: '202610071000', cif: '11111110', id_solicitare: '4999', detalii: 'Erori de validare identificate la factura primita cu id_incarcare=4999', tip: 'ERORI FACTURA', id: '2999' },
        ],
        serial: '1234AA456',
        cui: '11111110',
        titlu: 'Lista Mesaje disponibile din ultimele 30 zile',
      });
    }
    if (path === 'descarcare') {
      expect(r.binary).toBe(true);
      if (u.searchParams.get('id') === '42') return json({ eroare: 'Nu mai puteti descarca acest fisier deoarece a depasit perioada de 60 de zile', titlu: 'Descarcare mesaj' });
      const zip = new JSZip();
      zip.file('5001.xml', readFileSync(join('tests', 'fixtures', 'anaf', 'ron-two-rates.xml'), 'utf8'));
      zip.file('semnatura_5001.xml', '<Signature/>');
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      return { status: 200, body: '', bytes };
    }
    return { status: 404, body: '' };
  });
  /** The browser: ANAF's login page redirects with a code bound to the PKCE challenge. */
  const authorize = async (url: string, redirect: string) => {
    state.lastAuthUrl = url;
    const q = new URL(url).searchParams;
    expect(redirect).toBe(app.redirectUri);
    const code = `code-${state.codes.size + 1}`;
    state.codes.set(code, q.get('code_challenge')!);
    return { code, state: q.get('state')! };
  };
  return { state, calls, transport, authorize };
}

const seq = (n: number) => new Uint8Array(n).map((_, i) => i + 1);

describe('ANAF OAuth', () => {
  it('signs in with PKCE S256, a checked state and JWT tokens', async () => {
    const m = anafMock();
    const seen: Array<unknown> = [];
    const c = new AnafClient(app, { transport: m.transport, authorize: m.authorize, random: seq, now: () => 1000, onTokens: (t) => seen.push(t) });
    await c.signIn();
    const q = new URL(m.state.lastAuthUrl).searchParams;
    expect(m.state.lastAuthUrl.startsWith(`${ANAF_AUTHORIZE_URL}?`)).toBe(true);
    expect(Object.fromEntries(q)).toMatchObject({ response_type: 'code', client_id: 'client-1', redirect_uri: app.redirectUri, code_challenge_method: 'S256', token_content_type: 'jwt' });
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(c.tokens).toEqual({ access: 'acc-1', refresh: 'ref-1', expiresAt: 1000 + 7776000 * 1000 });
    expect(seen).toHaveLength(1);
  });

  it('refuses a mismatched state and reports refusals', async () => {
    const m = anafMock();
    const bad = new AnafClient(app, { transport: m.transport, authorize: async () => ({ code: 'x', state: 'other' }) });
    await expect(bad.signIn()).rejects.toThrow(/did not match/);
    const denied = new AnafClient(app, { transport: m.transport, authorize: async () => ({ error: 'access_denied', errorDescription: 'no certificate' }) });
    await expect(denied.signIn()).rejects.toBeInstanceOf(AnafAuthError);
    expect(m.calls.filter((c) => c.url === ANAF_TOKEN_URL)).toHaveLength(0);
  });

  it('refreshes an expired token, retries once after 401, and drops tokens ANAF no longer accepts', async () => {
    const m = anafMock({ expiresIn: 10 });
    let clock = 0;
    const c = new AnafClient(app, { transport: m.transport, authorize: m.authorize, now: () => clock });
    await c.signIn();
    clock = 60_000;
    await c.messages('RO11111110', 30);
    expect(m.state.refreshCount).toBe(1);
    // ANAF revokes the access token: one refresh and the call goes through.
    m.state.access = 'changed-on-server';
    c.tokens!.access = 'stale';
    c.tokens!.expiresAt = Infinity;
    await expect(c.messages('11111110', 30)).resolves.toHaveLength(3);
    expect(m.state.refreshCount).toBe(2);
    // A refresh token ANAF refuses: sign in again.
    c.tokens!.refresh = 'gone';
    c.tokens!.access = 'stale';
    await expect(c.messages('11111110', 30)).rejects.toBeInstanceOf(AnafAuthError);
    expect(c.tokens).toBeNull();
  });

  it('starts from a remembered refresh token', async () => {
    const m = anafMock();
    const c = new AnafClient(app, { transport: m.transport, authorize: async () => { throw new Error('no browser'); } });
    c.useRefreshToken('ref-1');
    await c.status('5001');
    expect(m.state.refreshCount).toBe(1);
  });

  it('checks the application settings and callbacks', () => {
    expect(checkAnafApp(app)).toBeNull();
    expect(checkAnafApp({ ...app, clientSecret: '' })).toMatch(/secret/);
    expect(checkAnafApp({ ...app, redirectUri: 'http://example.com/cb' })).toMatch(/https/);
    expect(checkAnafApp({ ...app, redirectUri: 'https://example.com/cb' })).toBeNull();
    expect(loopbackRedirect('http://localhost:8765/callback')).toEqual({ port: 8765, path: '/callback' });
    expect(loopbackRedirect('https://localhost:8765/callback')).toBeNull();
    expect(parseCallback('https://example.com/cb?code=a%2Fb&state=s1')).toEqual({ code: 'a/b', state: 's1', error: undefined, errorDescription: undefined });
    expect(parseCallback('code=x&state=y').code).toBe('x');
  });
});

describe('ANAF SPV upload, status, messages, download', () => {
  it('uploads, polls the status until ok and downloads the ZIP that opens as an invoice', async () => {
    const m = anafMock();
    const c = new AnafClient(app, { transport: m.transport, authorize: m.authorize });
    await c.signIn();
    const xml = readFileSync(join('tests', 'fixtures', 'anaf', 'credit-note.xml'), 'utf8');
    const receipt = await c.upload(xml, 'RO11111110');
    expect(receipt).toEqual({ index: '5001', date: '202610091200' });
    const up = m.calls.find((r) => r.url.includes('/upload?'))!;
    expect(up).toMatchObject({ method: 'POST', contentType: 'text/plain', body: xml });
    expect(Object.fromEntries(new URL(up.url).searchParams)).toEqual({ standard: 'CN', cif: '11111110' });

    const states: string[] = [];
    let clock = 0;
    const done = await pollUpload(c, receipt.index, { intervalMs: 30_000, now: () => clock, sleep: async (ms) => { clock += ms; }, onStatus: (s) => states.push(s.state) });
    expect(states).toEqual(['processing', 'processing', 'ok']);
    expect(done).toEqual({ state: 'ok', downloadId: '3001', errors: [] });

    const zip = await c.download(done.downloadId);
    const files = await JSZip.loadAsync(zip);
    const entry = pickInvoiceXml(Object.keys(files.files));
    expect(entry).toBe('5001.xml');
    expect(parseEInvoice(await files.files[entry!].async('string')).number).toBe('TEST-2026-0001');
    await expect(c.download('42')).rejects.toThrow(/60 de zile/);
  });

  it('stops polling after the time limit or when asked', async () => {
    let clock = 0;
    const client = { status: async () => ({ state: 'processing' as const, downloadId: '', errors: [] }) };
    const s = await pollUpload(client, '1', { intervalMs: 30_000, maxMs: 10 * 60_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(s.state).toBe('processing');
    expect(clock).toBe(10 * 60_000);
    const ctrl = new AbortController();
    ctrl.abort();
    clock = 0;
    await pollUpload(client, '1', { signal: ctrl.signal, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(clock).toBe(0);
  });

  it('reports refused uploads and missing rights', async () => {
    const m = anafMock();
    const c = new AnafClient(app, { transport: m.transport, authorize: m.authorize });
    await expect(c.upload('<Invoice/>', '11111110')).rejects.toBeInstanceOf(AnafAuthError);
    await c.signIn();
    await expect(c.upload('<Invoice/>', '12345674')).rejects.toThrow(/Nu exista niciun CIF/);
    await expect(c.upload('<Invoice/>', '123')).rejects.toThrow(/Not a valid CUI/);
    const forbidden = new AnafClient(app, { transport: async (r) => (r.url === ANAF_TOKEN_URL ? m.transport(r) : { status: 403, body: '' }), authorize: m.authorize });
    await forbidden.signIn();
    await expect(forbidden.status('1')).rejects.toThrow(/SPV rights/);
  });

  it('parses upload, status and message list answers', async () => {
    expect(() => parseUploadReply(200, '<header ExecutionStatus="1"><Errors errorMessage="Fisierul nu este XML"/></header>')).toThrow(/Fisierul nu este XML/);
    expect(parseStatusReply(200, '<header stare="nok" id_descarcare="77"/>')).toEqual({ state: 'nok', downloadId: '77', errors: [] });
    expect(parseStatusReply(200, '<header stare="XML cu erori nepreluat de sistem"/>').state).toBe('rejected');
    expect(() => parseStatusReply(200, '<header><Errors errorMessage="Nu aveti dreptul de inteorgare pentru id_incarcare= 1"/></header>')).toThrow(/dreptul/);
    expect(parseMessageList(200, '{"eroare":"Nu exista mesaje in ultimele 5 zile","titlu":"Lista Mesaje"}')).toEqual([]);
    expect(() => parseMessageList(200, '{"eroare":"CIF introdus= abc nu este un numar"}')).toThrow(/nu este un numar/);
    expect([messageKind('FACTURA TRIMISA'), messageKind('FACTURA PRIMITA'), messageKind('ERORI FACTURA'), messageKind('MESAJ CUMPARATOR PRIMIT / MESAJ CUMPARATOR TRANSMIS')]).toEqual(['sent', 'received', 'errors', 'buyer-message']);

    const m = anafMock();
    const c = new AnafClient(app, { transport: m.transport, authorize: m.authorize });
    await c.signIn();
    const list = await c.messages('11111110', 90);
    expect(new URL(m.calls[m.calls.length - 1].url).searchParams.get('zile')).toBe('60');
    expect(list.map((x) => [x.id, x.kind, x.created])).toEqual([
      ['3001', 'sent', '2026-10-09 12:10'],
      ['3000', 'received', '2026-10-08 10:15'],
      ['2999', 'errors', '2026-10-07 10:00'],
    ]);
    expect(await c.messages('11111110', 1)).toEqual([]);
  });
});

describe('upload log and CUI of an invoice', () => {
  it('keeps the newest entry per upload index and environment', () => {
    const rec = (index: string, state: UploadRecord['state'], test = false): UploadRecord => ({ at: '2026-10-09T10:00:00Z', cif: '11111110', number: 'T-1', standard: 'UBL', index, test, state, downloadId: '', errors: [] });
    let log = upsertUpload([], rec('1', 'sent'));
    log = upsertUpload(log, rec('2', 'sent'));
    log = upsertUpload(log, { ...rec('1', 'ok'), downloadId: '9' });
    log = upsertUpload(log, rec('1', 'sent', true));
    expect(log.map((u) => `${u.index}:${u.state}:${u.test}`)).toEqual(['1:sent:true', '1:ok:false', '2:sent:false']);
    expect(readUploadLog(JSON.stringify({ uploads: log }))).toEqual(log);
    expect(readUploadLog('not json')).toEqual([]);
  });

  it('finds the seller CUI in UBL and CII (the buyer for self-billing)', () => {
    const d: InvoiceDraft = { ...emptyDraft('facturx', '2026-10-09'), number: 'C-1', seller: { ...emptyDraft().seller, name: 'S', vatId: 'RO12345674' }, buyer: { ...emptyDraft().buyer, name: 'B', vatId: 'RO11111110' }, lines: [{ ...emptyLine(), name: 'x', price: 1 }] };
    expect(uploadCif(writeCii(calculate(d)))).toBe('12345674');
    const xml = readFileSync(join('tests', 'fixtures', 'anaf', 'eur.xml'), 'utf8');
    expect(uploadCif(xml.replace('<cbc:InvoiceTypeCode>380<', '<cbc:InvoiceTypeCode>389<'))).toBe('22222229');
  });
});

describe('official CIUS-RO rule ids', () => {
  const base = (): InvoiceDraft => {
    const d = emptyDraft('ro', '2026-10-09');
    return {
      ...d,
      number: 'T-1',
      dueDate: '2026-10-20',
      seller: { ...d.seller, name: 'TEST SRL', vatId: 'RO11111110', street: 'Str. Test 1', city: 'Cluj-Napoca', region: 'RO-CJ' },
      buyer: { ...d.buyer, name: 'B SRL', vatId: 'RO22222229', street: 'Str. B 2', city: 'SECTOR1', region: 'RO-B' },
      payment: { ...d.payment, iban: 'RO08TEST0000000000000001' },
      lines: [{ ...emptyLine(), name: 'x', price: 10 }],
    };
  };
  const rules = (d: InvoiceDraft) => validateInvoice(calculate(d)).filter((i) => i.severity === 'error').map((i) => i.rule);

  it('names the rules ANAF reports', () => {
    const d = base();
    expect(rules(d)).toEqual([]);
    expect(rules({ ...d, seller: { ...d.seller, street: '' } })).toContain('BR-RO-080');
    expect(rules({ ...d, buyer: { ...d.buyer, city: '' } })).toContain('BR-RO-090');
    expect(rules({ ...d, buyer: { ...d.buyer, vatId: '', companyId: '' } })).toContain('BR-RO-120');
    expect(rules({ ...d, seller: { ...d.seller, postalCode: '1'.repeat(21) } })).toContain('BR-RO-L020');
    expect(rules({ ...d, payment: { ...d.payment, reference: 'r'.repeat(141) } })).toContain('BR-RO-L140');
    expect(rules({ ...d, notes: ['n'.repeat(301)] })).toContain('BR-RO-L300');
    // Payment terms may be up to 300 characters (BR-RO-L300).
    expect(rules({ ...d, payment: { ...d.payment, terms: 't'.repeat(250) } })).toEqual([]);
    expect(rules({ ...d, payment: { ...d.payment, terms: 't'.repeat(301) } })).toContain('BR-RO-L300');
    // No limit on the number of lines since schematron 1.0.8 (BR-RO-A999 removed).
    expect(rules({ ...d, lines: Array.from({ length: 1000 }, () => ({ ...emptyLine(), name: 'x', price: 1 })) })).toEqual([]);
  });
});
