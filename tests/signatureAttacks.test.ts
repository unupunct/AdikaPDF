/**
 * Attacks on signature verification (each failed against 1.10.0): hidden
 * object copies after an incremental update, validation data pointing at
 * page content, fake signature fields, appearance swaps, byte range tricks,
 * certificate misuse, forged or backdated timestamps, bogus OCSP / CRL
 * answers, lenient RSA padding, weak algorithms and certificate substitution.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFArray, PDFDocument, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import {
  addValidationData,
  certIssuedBy,
  certificateToDer,
  identityFromCertificateDer,
  insertTimestampToken,
  signPdf,
  signerSignatureValue,
  verifyPdfSignatures,
  type SigningIdentity,
  type VerifyOptions,
} from '@/lib/crypto/digitalSignature';
import { loadRevision } from '@/lib/crypto/pdfRevisions';
import { incrementalUpdate } from '@/lib/pdf/incremental';
import {
  NULL,
  OIDS,
  byteRange,
  cmsSign,
  contentsOf,
  der,
  gen,
  hashOf,
  identityOf,
  int,
  issue,
  oid,
  replaceContents,
  resign,
  rsaSign,
  rsaSignWithoutNull,
  toDer,
  tsaServer,
  tsaToken,
  utc,
  type TestCa,
} from './helpers/sigPki';

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const OCSP_URL = 'http://ocsp.attack.test/';
const CRL_URL = 'http://crl.attack.test/inter.crl';

let root: TestCa;
let inter: TestCa;
let leaf: TestCa;
let signer: SigningIdentity;
let pdf: Uint8Array;
let signed: Uint8Array;
const trusted = (o: VerifyOptions = {}): VerifyOptions => ({ trustedRoots: [root.cert], ...o });

beforeAll(async () => {
  root = await issue({ cn: 'Attack Test Root', ca: true, notAfter: new Date(Date.now() + 10 * 365 * 86400_000) });
  inter = await issue({ cn: 'Attack Test Intermediate', ca: true, issuer: root });
  leaf = await issue({ cn: 'Ana Popescu', issuer: inter, ocspUrl: OCSP_URL, crlUrl: CRL_URL, eku: [OIDS.emailProtection] });
  signer = identityOf(leaf, [inter.cert, root.cert]);
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText('Pay 100 EUR', { x: 60, y: 760, size: 18, font });
  d.getForm().createTextField('Amount').addToPage(d.getPage(0), { x: 60, y: 600, width: 200, height: 22 });
  d.getForm().createTextField('Note').addToPage(d.getPage(0), { x: 60, y: 560, width: 200, height: 22 });
  pdf = await d.save();
  signed = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0] });
}, 60000);

const first = async (b: Uint8Array, o?: VerifyOptions) => (await verifyPdfSignatures(b, o ?? trusted()))[0];

/** Page 1's content stream reference. */
async function contentRef(file: Uint8Array): Promise<PDFRef> {
  const c = (await PDFDocument.load(file)).getPage(0).node.get(PDFName.of('Contents'));
  return (c instanceof PDFArray ? c.get(0) : c) as PDFRef;
}

/** Appends a revision whose xref lists `objects`, with `hidden` raw bytes (not in the xref) after them. */
function appendRevision(file: Uint8Array, objects: Array<[number, string]>, hidden: Uint8Array[] = []): Uint8Array {
  const s = latin1(file);
  const prev = Number([...s.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]);
  const rootRef = [...s.matchAll(/\/Root (\d+ \d+ R)/g)].at(-1)![1];
  const size = Math.max(...[...s.matchAll(/\/Size (\d+)/g)].map((m) => Number(m[1])));
  const parts: Buffer[] = [Buffer.from(file), Buffer.from('\n')];
  let pos = file.length + 1;
  const push = (b: Buffer) => {
    parts.push(b);
    pos += b.length;
  };
  const offsets: Array<[number, number]> = [];
  for (const [num, body] of objects) {
    offsets.push([num, pos]);
    push(Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'));
  }
  for (const h of hidden) push(Buffer.from(h));
  const xrefAt = pos;
  let x = 'xref\n';
  for (const [num, off] of offsets) x += `${num} 1\n${String(off).padStart(10, '0')} 00000 n\r\n`;
  push(Buffer.from(`${x}trailer\n<< /Size ${size} /Root ${rootRef} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

describe('changes after signing are read through the cross-reference chain', () => {
  it('a changed page stream followed by a hidden copy of the original is detected', async () => {
    const ref = await contentRef(signed);
    const view = loadRevision(signed);
    const [s, e] = view.spans.get(ref.objectNumber)!;
    const original = signed.subarray(s, e);
    const evil = 'BT /F1 24 Tf 60 700 Td (Pay 9999 EUR) Tj ET';
    const attacked = appendRevision(signed, [[ref.objectNumber, `<< /Length ${evil.length} >>\nstream\n${evil}\nendstream`]], [Buffer.from('\n'), original, Buffer.from('\n')]);
    // Viewers follow the xref: the malicious stream is what they show.
    const finalView = loadRevision(attacked);
    expect(latin1((finalView.context.lookup(ref) as unknown as { contents: Uint8Array }).contents)).toContain('9999');
    const r = await first(attacked);
    expect(r.integrity).toBe('valid');
    expect(r.laterChanges?.other).toBe(true);
    expect(r.modifiedAfterSigning).toBe(true);
  });

  it('validation data pointing at a page stream does not hide its change', async () => {
    const ref = await contentRef(signed);
    const out = (
      await incrementalUpdate(signed, (d) => {
        d.context.assign(ref, d.context.flateStream('BT /F1 24 Tf 60 700 Td (Pay 9999 EUR) Tj ET'));
        d.catalog.set(PDFName.of('DSS'), d.context.obj({ Certs: [ref], OCSPs: [], CRLs: [] }));
      })
    ).bytes;
    const r = await first(out);
    expect(r.laterChanges?.other).toBe(true);
    expect(r.modifiedAfterSigning).toBe(true);
  });

  it('real validation data is still allowed', async () => {
    const crl = buildCrl({});
    const { bytes } = await addValidationData(signed, { trustedRoots: [root.cert], httpGet: async () => crl.forInter, httpPost: async () => { throw new Error('offline'); } });
    const r = await first(bytes);
    expect(r.laterChanges).toEqual({ ltv: true, signatures: false, form: false, other: false });
    expect(r.modifiedAfterSigning).toBe(false);
  });
});

describe('form fields and signature fields after signing', () => {
  it('an unsigned signature field with a visible appearance counts as a modification', async () => {
    const out = (
      await incrementalUpdate(signed, (d) => {
        const page = d.getPage(0);
        const ap = d.context.register(d.context.stream('BT /Helv 30 Tf 10 10 Td (APPROVED 9999 EUR) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 60] }));
        const w = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Fake'), Rect: [60, 650, 360, 710], F: 4, P: page.ref, AP: { N: ap } }));
        page.node.set(PDFName.of('Annots'), d.context.obj([...(page.node.lookup(PDFName.of('Annots'), PDFArray)?.asArray() ?? []), w]));
        d.getForm().acroForm.dict.lookup(PDFName.of('Fields'), PDFArray).push(w);
      })
    ).bytes;
    const r = await first(out);
    expect(r.laterChanges?.other).toBe(true);
    expect(r.modifiedAfterSigning).toBe(true);
  });

  it('an appearance swapped without changing the value counts as a modification; filling in does not', async () => {
    const out = (
      await incrementalUpdate(signed, (d) => {
        const w = d.getForm().getTextField('Amount').acroField.getWidgets()[0];
        const ap = d.context.register(d.context.stream('BT /Helv 12 Tf 2 6 Td (9999) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 22] }));
        w.dict.set(PDFName.of('AP'), d.context.obj({ N: ap }));
      })
    ).bytes;
    const r = await first(out);
    expect(r.laterChanges?.other).toBe(true);
    expect(r.modifiedAfterSigning).toBe(true);
    const filled = (await incrementalUpdate(signed, (d) => d.getForm().getTextField('Amount').setText('100'))).bytes;
    const f = await first(filled);
    expect(f.laterChanges?.form).toBe(true);
    expect(f.modifiedAfterSigning).toBe(false);
  });

  it('fields locked by the signature (FieldMDP) may not be filled in', async () => {
    const locked = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], lock: { action: 'Include', fields: ['Amount'] } });
    const amount = await first((await incrementalUpdate(locked, (d) => d.getForm().getTextField('Amount').setText('9999'))).bytes);
    expect(amount.laterChanges?.other).toBe(true);
    expect(amount.modifiedAfterSigning).toBe(true);
    const note = await first((await incrementalUpdate(locked, (d) => d.getForm().getTextField('Note').setText('ok'))).bytes);
    expect(note.modifiedAfterSigning).toBe(false);
    const all = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], lock: { action: 'All' } });
    expect((await first((await incrementalUpdate(all, (d) => d.getForm().getTextField('Note').setText('x'))).bytes)).modifiedAfterSigning).toBe(true);
  });

  const addComment = (file: Uint8Array) =>
    incrementalUpdate(file, (d) => {
      const page = d.getPage(0);
      const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [400, 700, 420, 720], Contents: PDFString.of('Please check'), P: page.ref }));
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (annots instanceof PDFArray) annots.push(note);
      else page.node.set(PDFName.of('Annots'), d.context.obj([note]));
    }).then((r) => r.bytes);

  it('certified with comments allowed (P=3): a comment is a permitted change; P=2 does not permit it', async () => {
    const p3 = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], certify: 3 });
    const r3 = await first(await addComment(p3));
    expect(r3.certified).toBe(3);
    expect(r3.laterChanges?.annotations).toBe(true);
    expect(r3.laterChanges?.other).toBe(false);
    expect(r3.modifiedAfterSigning).toBe(false);
    const p2 = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], certify: 2 });
    expect((await first(await addComment(p2))).modifiedAfterSigning).toBe(true);
  });
});

describe('ByteRange', () => {
  it('re-signing the same range stays valid (the test helper itself is sound)', async () => {
    const r = await first(resign(signed, byteRange(signed).range, { signer: leaf, chain: [inter.cert] }));
    expect(r.integrity).toBe('valid');
  });

  it('must start at 0, leave exactly the /Contents value unsigned and end at a revision end', async () => {
    const [, b, c, d] = byteRange(signed).range;
    for (const range of [
      [1, b - 1, c, d],
      [0, b, c + 3, d - 3],
      [0, b + 2, c, d],
      [0, b, c, d - 7],
    ]) {
      const r = await first(resign(signed, range, { signer: leaf, chain: [inter.cert] }));
      expect(r.integrity, String(range)).toBe('invalid');
    }
  });
});

describe('certificate chain rules', () => {
  const signWith = async (l: TestCa, chain: forge.pki.Certificate[], roots: forge.pki.Certificate[] = [root.cert]) =>
    first(await signPdf(pdf, { identity: identityOf(l, chain), pageIndex: 0, rect: [0, 0, 0, 0] }), { trustedRoots: roots });

  it('an issuer that is not a CA, or may not sign certificates, breaks the chain', async () => {
    const notCa = await issue({ cn: 'End entity posing as CA', issuer: root, ca: false });
    const r1 = await signWith(await issue({ cn: 'Victim', issuer: notCa }), [notCa.cert, root.cert]);
    expect(r1.chainStatus).not.toBe('trusted');
    expect(r1.chainDetails?.join(' ')).toMatch(/not a certificate authority/);
    const noKeyCertSign = await issue({ cn: 'CA without keyCertSign', issuer: root, ca: true, keyUsage: { digitalSignature: true } });
    const r2 = await signWith(await issue({ cn: 'Victim 2', issuer: noKeyCertSign }), [noKeyCertSign.cert, root.cert]);
    expect(r2.chainStatus).not.toBe('trusted');
    expect(r2.chainDetails?.join(' ')).toMatch(/may not sign certificates/);
  });

  it('path length constraints are enforced', async () => {
    const strictRoot = await issue({ cn: 'Root pathLen 0', ca: true, pathLen: 0 });
    const sub = await issue({ cn: 'Sub CA', issuer: strictRoot, ca: true });
    const r = await signWith(await issue({ cn: 'Too deep', issuer: sub }), [sub.cert, strictRoot.cert], [strictRoot.cert]);
    expect(r.chainStatus).not.toBe('trusted');
    expect(r.chainDetails?.join(' ')).toMatch(/path length/);
  });

  it('the signer certificate must allow signing (key usage, extended key usage)', async () => {
    const encOnly = await signWith(await issue({ cn: 'Encryption only', issuer: inter, keyUsage: { keyEncipherment: true } }), [inter.cert, root.cert]);
    expect(encOnly.chainStatus).toBe('untrusted');
    expect(encOnly.warnings?.join(' ')).toMatch(/key usage/);
    const tls = await signWith(await issue({ cn: 'TLS server', issuer: inter, eku: [OIDS.serverAuth] }), [inter.cert, root.cert]);
    expect(tls.chainStatus).toBe('untrusted');
    expect(tls.warnings?.join(' ')).toMatch(/not meant for signing/);
    const ok = await first(signed);
    expect(ok.chainStatus).toBe('trusted');
    expect(ok.warnings).toEqual([]);
  });
});

describe('timestamps', () => {
  let tsa: TestCa;
  let rogueTsa: TestCa;
  let oldRoot: TestCa;
  let oldInter: TestCa;
  let expiredLeaf: TestCa;
  beforeAll(async () => {
    tsa = await issue({ cn: 'Trusted TSA', issuer: inter, eku: [OIDS.timeStamping], keyUsage: null });
    const rogueRoot = await issue({ cn: 'Rogue Root', ca: true });
    rogueTsa = await issue({ cn: 'Rogue TSA', issuer: rogueRoot, eku: [OIDS.timeStamping], keyUsage: null });
    const since2019 = new Date('2019-01-01T00:00:00Z');
    oldRoot = await issue({ cn: 'Old Root', ca: true, notBefore: since2019, notAfter: new Date(Date.now() + 5 * 365 * 86400_000) });
    oldInter = await issue({ cn: 'Old Intermediate', ca: true, issuer: oldRoot, notBefore: since2019 });
    expiredLeaf = await issue({ cn: 'Expired Signer', issuer: oldInter, notBefore: since2019, notAfter: new Date('2021-01-01T00:00:00Z') });
  });

  it('the signing side refuses tokens from a certificate that is not a timestamping one', async () => {
    const notTsa = await issue({ cn: 'Not a TSA', issuer: inter });
    await expect(signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], tsaUrl: 'https://tsa.test/', fetchImpl: tsaServer(notTsa) })).rejects.toThrow(/timestamping/);
  });

  it('a verified timestamp sets the signing time and B-T; an untrusted one does not', async () => {
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
    const good = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true, tsaUrl: 'https://tsa.test/', fetchImpl: tsaServer(tsa, { genTime: () => stamp }) });
    const g = await first(good);
    expect(g.timestampVerified).toBe(true);
    expect(g.signedAt).toBe(stamp.toISOString());
    expect(g.padesLevel).toBe('B-T');
    const rogue = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true, tsaUrl: 'https://tsa.test/', fetchImpl: tsaServer(rogueTsa, { genTime: () => stamp }) });
    const r = await first(rogue);
    expect(r.hasTimestamp).toBe(true);
    expect(r.timestampVerified).toBe(false);
    expect(r.signedAt).not.toBe(stamp.toISOString());
    expect(r.padesLevel).toBe('B-B');
    expect(r.message).toMatch(/timestamp could not be verified/);
  });

  it('a backdated timestamp (untrusted, or over something else) does not make an expired certificate valid', async () => {
    const out = await signPdf(pdf, { identity: identityOf(expiredLeaf, [oldInter.cert, oldRoot.cert]), pageIndex: 0, rect: [0, 0, 0, 0] });
    const cms = contentsOf(out);
    const when = new Date('2020-06-01T00:00:00Z');
    const imprint = hashOf('sha256', signerSignatureValue(cms));
    // A rogue TSA's token, and a token of the trusted TSA over other data (copied from elsewhere).
    for (const token of [tsaToken(rogueTsa, imprint, when), tsaToken(tsa, hashOf('sha256', new Uint8Array([1, 2, 3])), when, undefined, [inter.cert])]) {
      const attacked = replaceContents(out, insertTimestampToken(cms, token));
      const r = await first(attacked, { trustedRoots: [oldRoot.cert, root.cert] });
      expect(r.integrity).toBe('valid');
      expect(r.timestampVerified).toBe(false);
      expect(r.chainStatus).toBe('expired');
    }
  });
});

describe('revocation answers', () => {
  /** OCSP response for the CertID in the request (or `certId`), signed by `by`. */
  function ocsp(o: { by: TestCa; include?: forge.pki.Certificate[]; state?: 'good' | 'revoked'; thisUpdate?: Date; nextUpdate?: Date; certId?: (req: Uint8Array) => Uint8Array }) {
    return async (_url: string, _ct: string, body: Uint8Array) => {
      const req = forge.asn1.fromDer(Buffer.from(body).toString('binary'));
      const certId = o.certId?.(body) ?? toDer(((((req.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0]);
      const status = o.state === 'revoked' ? der(0xa1, gen(new Date(Date.now() - 86400_000))) : new Uint8Array([0x80, 0x00]);
      const single = der(0x30, certId, status, gen(o.thisUpdate ?? new Date()), ...(o.nextUpdate ? [der(0xa0, gen(o.nextUpdate))] : []));
      const tbs = der(0x30, der(0xa1, toDer(forge.pki.distinguishedNameToAsn1(o.by.cert.subject))), gen(new Date()), der(0x30, single));
      const alg = der(0x30, oid('1.2.840.113549.1.1.11'), NULL);
      const certs = o.include?.length ? [der(0xa0, der(0x30, ...o.include.map(certificateToDer)))] : [];
      const basic = der(0x30, tbs, alg, der(0x03, new Uint8Array([0]), rsaSign(o.by.key, tbs)), ...certs);
      return der(0x30, der(0x0a, new Uint8Array([0])), der(0xa0, der(0x30, oid('1.3.6.1.5.5.7.48.1.1'), der(0x04, basic))));
    };
  }
  const online = (httpPost: VerifyOptions['httpPost']) => trusted({ checkRevocation: true, httpPost });

  it('the OCSP answer must come from the issuer or its delegated OCSP responder', async () => {
    expect((await first(signed, online(ocsp({ by: inter })))).revocationStatus).toBe('good');
    // The signer vouching for itself.
    expect((await first(signed, online(ocsp({ by: leaf, include: [leaf.cert] })))).revocationStatus).toBe('unknown');
    const responder = await issue({ cn: 'OCSP responder', issuer: inter, eku: [OIDS.ocspSigning] });
    expect((await first(signed, online(ocsp({ by: responder, include: [responder.cert] })))).revocationStatus).toBe('good');
    const noEku = await issue({ cn: 'Some other cert', issuer: inter });
    expect((await first(signed, online(ocsp({ by: noEku, include: [noEku.cert] })))).revocationStatus).toBe('unknown');
  });

  it('stale answers and answers for another issuer are not accepted', async () => {
    const old = await first(signed, online(ocsp({ by: inter, thisUpdate: new Date(Date.now() - 20 * 86400_000), nextUpdate: new Date(Date.now() - 13 * 86400_000) })));
    expect(old.revocationStatus).toBe('unknown');
    // Right serial, but the CertID names another issuer key.
    const otherIssuer = (req: Uint8Array) => {
      const id = ((((forge.asn1.fromDer(Buffer.from(req).toString('binary')).value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[])[0];
      const k = id.value as forge.asn1.Asn1[];
      return der(0x30, toDer(k[0]), toDer(k[1]), der(0x04, new Uint8Array(20)), toDer(k[3]));
    };
    const r = await first(signed, online(ocsp({ by: inter, certId: otherIssuer })));
    expect(r.revocationStatus).toBe('unknown');
    expect(r.revocationDetails).toMatch(/does not cover/);
  });

  it('CRLs must be current and from the issuer', async () => {
    const opts = (crl: Uint8Array) => trusted({ checkRevocation: true, httpGet: async () => crl });
    expect((await first(signed, opts(buildCrl({}).forInter))).revocationStatus).toBe('good');
    expect((await first(signed, opts(buildCrl({ nextUpdate: new Date(Date.now() - 86400_000), thisUpdate: new Date(Date.now() - 8 * 86400_000) }).forInter))).revocationStatus).toBe('unknown');
    expect((await first(signed, opts(buildCrl({ issuerName: root }).forInter))).revocationStatus).toBe('unknown');
  });

  it('an online check the user asked for takes priority over saved answers', async () => {
    const { bytes } = await addValidationData(signed, { trustedRoots: [root.cert], httpPost: ocsp({ by: inter }) });
    expect((await first(bytes)).revocationDetails).toMatch(/saved in the file/);
    const r = await first(bytes, online(ocsp({ by: inter, state: 'revoked' })));
    expect(r.revocationStatus).toBe('revoked');
  });
});

describe('algorithms and signed attributes', () => {
  const data = (file: Uint8Array) => {
    const [a, b, c, d] = byteRange(file).range;
    return [file.subarray(a, a + b), file.subarray(c, c + d)];
  };

  it('RSA padding is checked strictly (DigestInfo without NULL is rejected)', async () => {
    const lenient = replaceContents(signed, cmsSign(data(signed), { signer: leaf, chain: [inter.cert], sigFn: (attrs) => rsaSignWithoutNull(leaf.key, attrs) }));
    expect((await first(lenient)).integrity).toBe('invalid');
  });

  it('SHA-1 and short keys give a warning, MD5 is invalid', async () => {
    const sha1 = await first(replaceContents(signed, cmsSign(data(signed), { signer: leaf, chain: [inter.cert], hash: 'sha1' })));
    expect(sha1.integrity).toBe('valid');
    expect(sha1.warnings?.join(' ')).toMatch(/SHA-1/);
    const md5 = await first(replaceContents(signed, cmsSign(data(signed), { signer: leaf, chain: [inter.cert], hash: 'md5' })));
    expect(md5.integrity).toBe('invalid');
    const short = await issue({ cn: 'Short key', issuer: inter, bits: 1024 });
    const r = await first(await signPdf(pdf, { identity: identityOf(short, [inter.cert, root.cert]), pageIndex: 0, rect: [0, 0, 0, 0] }));
    expect(r.integrity).toBe('valid');
    expect(r.warnings?.join(' ')).toMatch(/too short/);
  });

  it('a signing-certificate attribute naming another certificate makes the signature invalid', async () => {
    const other = await issue({ cn: 'Someone else', issuer: inter });
    const swapped = replaceContents(signed, cmsSign(data(signed), { signer: leaf, chain: [inter.cert], essCert: other.cert }));
    const r = await first(swapped);
    expect(r.integrity).toBe('invalid');
    expect(r.message).toMatch(/signing-certificate/);
    const right = replaceContents(signed, cmsSign(data(signed), { signer: leaf, chain: [inter.cert], essCert: leaf.cert }));
    expect((await first(right)).integrity).toBe('valid');
  });
});

describe('issuer lookup when signing', () => {
  it('certIssuedBy checks RSA and ECDSA issuers with the strict verifier', async () => {
    expect(await certIssuedBy(leaf.cert, inter.cert)).toBe(true);
    expect(await certIssuedBy(leaf.cert, root.cert)).toBe(false);
    // ECDSA (forge's issuer.verify cannot check these, so their CA chains were never embedded).
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    const alg = der(0x30, oid('1.2.840.10045.4.3.2'));
    const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, new Uint8Array(Buffer.from('EC CA'))))));
    const tbs = der(0x30, der(0xa0, der(0x02, new Uint8Array([2]))), der(0x02, new Uint8Array([5])), alg, name, der(0x30, utc(new Date(Date.now() - 86400_000)), utc(new Date(Date.now() + 86400_000))), name, spki);
    const rs = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, tbs as BufferSource));
    const ec = identityFromCertificateDer(der(0x30, tbs, alg, der(0x03, new Uint8Array([0]), der(0x30, int(rs.slice(0, 32)), int(rs.slice(32)))))).certificate;
    expect(await certIssuedBy(ec, ec)).toBe(true);
    expect(await certIssuedBy(leaf.cert, ec)).toBe(false);
  });
});

/** CRL signed by the intermediate (optionally claiming another issuer name, or with other dates). */
function buildCrl(o: { issuerName?: TestCa; thisUpdate?: Date; nextUpdate?: Date }): { forInter: Uint8Array } {
  const alg = der(0x30, oid('1.2.840.113549.1.1.11'), NULL);
  const name = toDer(forge.pki.distinguishedNameToAsn1((o.issuerName ?? inter).cert.subject));
  const tbs = der(0x30, int(new Uint8Array([1])), alg, name, utc(o.thisUpdate ?? new Date(Date.now() - 3600_000)), utc(o.nextUpdate ?? new Date(Date.now() + 7 * 86400_000)));
  return { forInter: der(0x30, tbs, alg, der(0x03, new Uint8Array([0]), rsaSign(inter.key, tbs))) };
}
