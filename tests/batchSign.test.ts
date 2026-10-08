import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFDict } from 'pdf-lib';
import { exportP12, loadP12, signerFromIdentity, signPdf, verifyPdfSignatures, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import { encryptPdf } from '@/lib/crypto/encrypt';
import { CscClient, type CscProvider } from '@/lib/crypto/csc';
import { oneByOne, placementIn, resultsCsv, runBatchSign, tokenBatchSigner, type BatchSignIo, type BatchSignOptions, type BatchSigner, type TokenSessionApi } from '@/lib/batchSign';
import { identityOf, issue, tsaServer, type TestCa } from './helpers/sigPki';
import { CLIENT_ID, CLIENT_SECRET, MOCK_BASE, MockCsc, PIN, mockPki, type MockPki } from './helpers/cscMock';

let root: TestCa;
let tsa: TestCa;
let identity: SigningIdentity;
let pki: MockPki;
const files: Record<string, Uint8Array> = {};

async function plainPdf(pages = 1, text = 'Contract'): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`${text} ${i + 1}`, { x: 60, y: 760, size: 18, font });
  return d.save();
}

/** A PDF with an empty signature field "Approver" on page 2. */
async function withEmptyField(): Promise<Uint8Array> {
  const d = await PDFDocument.load(await plainPdf(2, 'Form'));
  const page = d.getPage(1);
  const ctx = d.context;
  const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Approver'), Rect: [300, 100, 500, 160], F: 4, P: page.ref }) as PDFDict;
  const ref = ctx.register(widget);
  page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  d.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [ref] }));
  return d.save({ useObjectStreams: false });
}

beforeAll(async () => {
  root = await issue({ cn: 'Batch Root CA', ca: true, bits: 1024 });
  const leaf = await issue({ cn: 'Ana Batch', issuer: root, bits: 1024 });
  tsa = await issue({ cn: 'Batch TSA', issuer: root, eku: ['1.3.6.1.5.5.7.3.8'], bits: 1024 });
  identity = identityOf(leaf, [root.cert]);
  pki = await mockPki();
  files['C:\\in\\a.pdf'] = await plainPdf();
  files['C:\\in\\b.pdf'] = await plainPdf(3);
  files['C:\\in\\c.pdf'] = await withEmptyField();
  files['C:\\in\\signed.pdf'] = await signPdf(await plainPdf(), { identity, pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
  files['C:\\in\\certified.pdf'] = await signPdf(await plainPdf(), { identity, pageIndex: 0, rect: [0, 0, 0, 0], certify: 1 });
  files['C:\\in\\locked.pdf'] = await encryptPdf(await plainPdf(), {
    userPassword: 'secret',
    ownerPassword: 'secret',
    permissions: { print: true, printHighQuality: true, modify: false, copy: true, annotate: true, fillForms: true, extractForAccessibility: true, assemble: false },
  });
}, 120_000);

function memoryIo(extra: Partial<BatchSignIo> = {}) {
  const disk = new Map(Object.entries(files).map(([k, v]) => [k, v.slice()]));
  const writes: string[] = [];
  const io: BatchSignIo = {
    read: async (p) => {
      const b = disk.get(p);
      if (!b) throw new Error(`missing ${p}`);
      return b.slice();
    },
    write: async (p, b) => {
      writes.push(p);
      disk.set(p, b.slice());
    },
    exists: async (p) => disk.has(p),
    fetchImpl: tsaServer(tsa),
    ...extra,
  };
  return { disk, writes, io };
}

const options = (o: Partial<BatchSignOptions> = {}): BatchSignOptions => ({
  reason: 'Approved',
  location: 'Cluj',
  contactInfo: '',
  tsaUrl: null,
  pades: true,
  certify: 0,
  ltv: false,
  archive: false,
  appearance: { visible: true, page: 'last', corner: 'bottom-right', offsetX: 28, offsetY: 28, width: 200, height: 60 },
  output: { mode: 'suffix', suffix: '-signed' },
  ...o,
});

const verify = (b: Uint8Array, roots = [root.cert]) => verifyPdfSignatures(b, { trustedRoots: roots });

describe('batch signing', () => {
  it('signs several PDFs with a .pfx (password once), skips what cannot be signed and verifies every output', async () => {
    const p12 = exportP12(identity, 'pfx-pass');
    let unlocked = 0;
    const id = (() => {
      unlocked++;
      return loadP12(p12, 'pfx-pass');
    })();
    const { disk, io } = memoryIo();
    const inputs = Object.keys(files);
    const seen: string[] = [];
    const results = await runBatchSign(inputs, oneByOne(signerFromIdentity(id)), options({ tsaUrl: 'https://tsa.test/', appearance: { ...options().appearance, fieldName: 'Approver' } }), io, {
      onResult: (r) => seen.push(r.status),
    });
    expect(unlocked).toBe(1);
    expect(seen).toHaveLength(inputs.length);
    const by = Object.fromEntries(results.map((r) => [r.input.split('\\').pop(), r]));
    expect(by['locked.pdf']).toMatchObject({ status: 'skipped', message: expect.stringMatching(/password/) });
    expect(by['certified.pdf']).toMatchObject({ status: 'skipped', message: expect.stringMatching(/no changes allowed/) });
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'signed.pdf']) {
      const r = by[name];
      expect(r.status, `${name}: ${r.message}`).toBe('done');
      expect(r.output).toBe(`C:\\in\\${name.replace('.pdf', '-signed.pdf')}`);
      const sigs = await verify(disk.get(r.output!)!);
      const last = sigs.at(-1)!;
      expect(last.integrity).toBe('valid');
      expect(last.chainStatus).toBe('trusted');
      expect(last.padesLevel).toBe('B-T');
      expect(last.signerName).toBe('Ana Batch');
      // Earlier signatures stay valid (incremental update).
      for (const s of sigs) expect(s.integrity).toBe('valid');
    }
    expect((await verify(disk.get('C:\\in\\signed-signed.pdf')!)).length).toBe(2);
    expect(by['signed.pdf'].message).toMatch(/after the existing signatures/);
    // c.pdf: signed into its empty field (page 2), no new field added.
    const c = await PDFDocument.load(disk.get('C:\\in\\c-signed.pdf')!);
    expect(c.getForm().getFields()).toHaveLength(1);
    const sigsC = await verify(disk.get('C:\\in\\c-signed.pdf')!);
    expect(sigsC).toHaveLength(1);
    expect(sigsC[0].fieldName).toBe('Approver');
    // Inputs untouched.
    for (const k of inputs) expect(disk.get(k)).toEqual(files[k]);
    const csv = resultsCsv(results);
    expect(csv.startsWith('\uFEFFFile,Status,Output,Details\r\n')).toBe(true);
    expect(csv).toContain('C:\\in\\locked.pdf,skipped,,');
  }, 120_000);

  it('places the badge at the chosen page and corner; B-B without a timestamp; certifies only unsigned files', async () => {
    const { disk, io } = memoryIo();
    const results = await runBatchSign(['C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\signed.pdf'], oneByOne(signerFromIdentity(identity)), options({ certify: 2, output: { mode: 'folder', folder: 'D:\\out', suffix: '' } }), io);
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(results.map((r) => r.output)).toEqual(['D:\\out\\a.pdf', 'D:\\out\\b.pdf', 'D:\\out\\signed.pdf']);
    const [a] = await verify(disk.get('D:\\out\\a.pdf')!);
    expect(a.padesLevel).toBe('B-B');
    expect(a.certified).toBe(2);
    const s = await verify(disk.get('D:\\out\\signed.pdf')!);
    expect(s.at(-1)!.certified ?? null).toBeNull();
    expect(results[2].message).toMatch(/approval signature/);
    // The last page of b.pdf (3 pages), bottom-right corner.
    const b = await PDFDocument.load(disk.get('D:\\out\\b.pdf')!);
    const annots = b.getPage(2).node.lookup(PDFName.of('Annots'));
    expect(annots).toBeTruthy();
    const insp = { pageCount: 3, signatureCount: 0, certification: null, emptyFields: [], pages: [0, 1, 2].map(() => ({ x: 0, y: 0, width: 595, height: 842, rotation: 0 })) };
    expect(placementIn(insp, options().appearance)).toEqual({ pageIndex: 2, rect: [367, 28, 567, 88] });
    expect(placementIn({ ...insp, pages: insp.pages.map((p) => ({ ...p, rotation: 90 })) }, { ...options().appearance, corner: 'top-left', page: 'first' }).pageIndex).toBe(0);
    expect(() => placementIn(insp, { ...options().appearance, page: 5 })).toThrow(/no page 5/);
    expect(placementIn(insp, { ...options().appearance, visible: false })).toEqual({ pageIndex: 0, rect: [0, 0, 0, 0] });
  }, 120_000);

  it('logs in to the token once for the whole batch and closes the session (mock PKCS#11)', async () => {
    const base = signerFromIdentity(identity);
    const log = { logins: 0, signs: 0, closes: 0, pins: [] as Array<string | null> };
    const api: TokenSessionApi = {
      open: async (a) => {
        log.logins++;
        log.pins.push(a.pin);
        if (a.pin !== '1234') throw new Error('Incorrect PIN.');
        return { handle: 7, alwaysAuthenticate: false };
      },
      sign: async (h, data) => {
        expect(h).toBe(7);
        log.signs++;
        return base.sign(data);
      },
      close: async () => {
        log.closes++;
      },
    };
    const token = { module: 'mock.dll', slotId: 1, certIdHex: 'ab', pin: '1234' };
    const signer = await tokenBatchSigner(api, token, base);
    const { disk, io } = memoryIo();
    const inputs = ['C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf', 'C:\\in\\signed.pdf'];
    const results = await runBatchSign(inputs, signer, options(), io);
    expect(results.every((r) => r.status === 'done')).toBe(true);
    expect(log).toMatchObject({ logins: 1, signs: 4, closes: 1 });
    for (const r of results) expect((await verify(disk.get(r.output!)!)).at(-1)!.integrity).toBe('valid');
    await expect(tokenBatchSigner(api, { ...token, pin: '0000' }, base)).rejects.toThrow(/Incorrect PIN/);
  }, 120_000);

  it('stops after a signing error, closes the session, and never touches the originals when replacing', async () => {
    const base = signerFromIdentity(identity);
    let calls = 0;
    let closed = 0;
    const flaky: BatchSigner = {
      ...oneByOne(base),
      signAll: async (d) => {
        if (++calls === 2) throw new Error('The token was removed.');
        return [await base.sign(d[0])];
      },
      close: async () => {
        closed++;
      },
    };
    const { disk, writes, io } = memoryIo();
    const inputs = ['C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf'];
    const results = await runBatchSign(inputs, flaky, options({ output: { mode: 'replace' } }), io);
    expect(results.map((r) => r.status)).toEqual(['done', 'failed', 'skipped']);
    expect(results[1].message).toBe('The token was removed.');
    expect(closed).toBe(1);
    expect(writes).toEqual(['C:\\in\\a.pdf']);
    expect(disk.get('C:\\in\\b.pdf')).toEqual(files['C:\\in\\b.pdf']);
    expect(disk.get('C:\\in\\c.pdf')).toEqual(files['C:\\in\\c.pdf']);
    // The replaced original is now the signed file.
    expect((await verify(disk.get('C:\\in\\a.pdf')!))[0].integrity).toBe('valid');

    // A failing write leaves the original as it was.
    const failing = memoryIo({
      write: async () => {
        throw new Error('Disk full');
      },
    });
    const r2 = await runBatchSign(['C:\\in\\a.pdf'], oneByOne(base), options({ output: { mode: 'replace' } }), failing.io);
    expect(r2[0]).toMatchObject({ status: 'failed', message: 'Disk full' });
    expect(failing.disk.get('C:\\in\\a.pdf')).toEqual(files['C:\\in\\a.pdf']);
  }, 120_000);

  it('cancel finishes the current file and skips the rest', async () => {
    const { io } = memoryIo();
    let done = 0;
    const results = await runBatchSign(['C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf'], oneByOne(signerFromIdentity(identity)), options(), io, {
      onResult: () => done++,
      cancelled: () => done >= 1,
    });
    expect(results.map((r) => r.status)).toEqual(['done', 'skipped', 'skipped']);
    expect(results[1].message).toBe('cancelled');
  }, 120_000);
});

describe('batch signing with a cloud signature (CSC)', () => {
  const provider: CscProvider = { id: 'p1', name: 'Mock QTSP', baseUrl: MOCK_BASE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

  async function signedIn(multisign: number) {
    const mock = new MockCsc(pki);
    mock.multisign = multisign;
    const client = new CscClient(provider, { transport: mock.transport, authorize: mock.authorizer });
    await client.signIn();
    const creds = await client.listCredentials();
    return { mock, client, cred: (id: string) => creds.find((c) => c.id === id)! };
  }
  const signHashCalls = (mock: MockCsc) => mock.log.filter((l) => l.url.endsWith('/signatures/signHash'));
  const inputs = ['C:\\in\\a.pdf', 'C:\\in\\b.pdf', 'C:\\in\\c.pdf', 'C:\\in\\signed.pdf'];

  it('authorizes all files once (PIN + OTP once, SAD bound to all hashes) and signs them in one call', async () => {
    const { mock, client, cred } = await signedIn(10);
    const rsa = cred('rsa-qes');
    expect(rsa.multisign).toBe(10);
    await client.sendOtp(rsa);
    const authorized: number[] = [];
    const signer = client.batchSigner(rsa, { pin: PIN, otp: mock.otpSent! }, undefined, (_m, n) => authorized.push(n));
    expect(signer.groupSize).toBe(10);
    const { disk, io } = memoryIo();
    const results = await runBatchSign(inputs, signer, options({ tsaUrl: 'https://tsa.test/' }), io);
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(mock.authorizations).toBe(1);
    expect(authorized).toEqual([4]);
    const calls = signHashCalls(mock);
    expect(calls).toHaveLength(1);
    expect((JSON.parse(calls[0].body!) as { hashes: string[] }).hashes).toHaveLength(4);
    for (const r of results) {
      const last = (await verify(disk.get(r.output!)!, [pki.root.cert, root.cert])).at(-1)!;
      expect(last.integrity).toBe('valid');
      expect(last.signerName).toBe('Maria Popescu');
      expect(last.padesLevel).toBe('B-T');
    }
    // A SAD for other hashes is refused.
    const h = new Uint8Array(32).fill(1);
    await client.sendOtp(rsa);
    const auth = await client.authorizeHashes(rsa, [h], { pin: PIN, otp: mock.otpSent! });
    await expect(client.signHashes(rsa, [h, new Uint8Array(32).fill(2)], auth)).rejects.toThrow(/SAD not valid/);
  }, 120_000);

  it('chunks by the provider limit and authorizes again for each chunk (a new OTP each time)', async () => {
    const { mock, client, cred } = await signedIn(2);
    const rsa = cred('rsa-qes');
    await client.sendOtp(rsa);
    const rounds: number[] = [];
    const signer = client.batchSigner(rsa, { pin: PIN, otp: mock.otpSent! }, async (round) => {
      rounds.push(round);
      await client.sendOtp(rsa);
      return { otp: mock.otpSent! };
    });
    const { disk, io } = memoryIo();
    const five = [...inputs, 'C:\\in\\a.pdf'];
    const results = await runBatchSign(five, signer, options(), io);
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(mock.authorizations).toBe(3);
    expect(rounds).toEqual([1, 2]);
    expect(signHashCalls(mock).map((c) => (JSON.parse(c.body!) as { hashes: string[] }).hashes.length)).toEqual([2, 2, 1]);
    for (const r of results) expect((await verify(disk.get(r.output!)!, [pki.root.cert])).at(-1)!.integrity).toBe('valid');
    // Two copies of a.pdf: the second is not overwritten.
    expect(results[4].output).toBe('C:\\in\\a-signed (2).pdf');

    // Without a code for the next chunk, the rest stops.
    const m2 = await signedIn(2);
    const r2 = m2.cred('rsa-qes');
    await m2.client.sendOtp(r2);
    const stop = m2.client.batchSigner(r2, { pin: PIN, otp: m2.mock.otpSent! }, async () => null);
    const res2 = await runBatchSign(five, stop, options(), memoryIo().io);
    expect(res2.map((r) => r.status)).toEqual(['done', 'done', 'failed', 'failed', 'skipped']);
  }, 120_000);

  it('one browser confirmation for several files (OAuth credential scope with all hashes)', async () => {
    const { mock, client, cred } = await signedIn(5);
    const ec = cred('ec-oauth');
    const { disk, io } = memoryIo();
    const results = await runBatchSign(inputs.slice(0, 3), client.batchSigner(ec, {}), options(), io);
    expect(results.every((r) => r.status === 'done')).toBe(true);
    expect(mock.authorizations).toBe(1);
    for (const r of results) {
      const [v] = await verify(disk.get(r.output!)!, [pki.root.cert]);
      expect(v.integrity).toBe('valid');
      expect(v.signerName).toBe('Elena Ec');
    }
  }, 120_000);
});
