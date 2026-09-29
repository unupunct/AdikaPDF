import { beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { addDocumentTimestamp, addValidationData, qcStatementsOf, signPdf, verifyPdfSignatures, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import { downloadTrustedLists, LOTL_URL, parseLotl, parseTrustedList, subjectKey, trustIndex } from '@/lib/crypto/euTrustedList';

const a = forge.asn1;
const CRL_URL = 'http://crl.adika.test/root.crl';
const bin = (b: Uint8Array) => Buffer.from(b).toString('binary');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'binary'));
const seq = (...v: forge.asn1.Asn1[]) => a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, v);
const set = (...v: forge.asn1.Asn1[]) => a.create(a.Class.UNIVERSAL, a.Type.SET, true, v);
const oid = (o: string) => a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(o).getBytes());
const int = (s: string) => a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, s);
const oct = (s: string) => a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, s);
const ctx0 = (...v: forge.asn1.Asn1[]) => a.create(a.Class.CONTEXT_SPECIFIC, 0, true, v);
const sha256 = (s: string) => {
  const md = forge.md.sha256.create();
  md.update(s);
  return md.digest().getBytes();
};

let root: forge.pki.Certificate;
let rootKey: forge.pki.rsa.PrivateKey;
let signer: SigningIdentity;
let tsaCert: forge.pki.Certificate;
let tsaKey: forge.pki.rsa.PrivateKey;
let crl: Uint8Array;
let pdf: Uint8Array;

function issue(cn: string, extra: object[] = []) {
  const k = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(4)).replace(/^[89a-f]/, '1');
  c.validity.notBefore = new Date(Date.now() - 86400e3);
  c.validity.notAfter = new Date(Date.now() + 180 * 86400e3);
  c.setSubject([{ name: 'commonName', value: cn }]);
  c.setIssuer(root.subject.attributes);
  c.setExtensions([{ name: 'cRLDistributionPoints', altNames: [{ type: 6, value: CRL_URL }] }, ...extra]);
  c.sign(rootKey, forge.md.sha256.create());
  return { cert: c, key: k.privateKey };
}

function makeCrl(): Uint8Array {
  const algo = () => seq(oid('1.2.840.113549.1.1.11'), a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''));
  const now = Date.now();
  const tbs = seq(int('\x01'), algo(), forge.pki.distinguishedNameToAsn1(root.subject), a.create(a.Class.UNIVERSAL, a.Type.UTCTIME, false, a.dateToUtcTime(new Date(now - 3600e3))), a.create(a.Class.UNIVERSAL, a.Type.UTCTIME, false, a.dateToUtcTime(new Date(now + 7 * 86400e3))));
  const tbsDer = a.toDer(tbs).getBytes();
  const md = forge.md.sha256.create();
  md.update(tbsDer);
  return bytes(a.toDer(seq(a.fromDer(tbsDer), algo(), a.create(a.Class.UNIVERSAL, a.Type.BITSTRING, false, '\x00' + rootKey.sign(md)))).getBytes());
}

/** A timestamp authority that really signs its tokens (RFC 3161 / CMS). */
const tsa = (async (_url: string, init?: RequestInit) => {
  const req = a.fromDer(bin(init!.body as Uint8Array)).value as forge.asn1.Asn1[];
  const mi = req[1];
  const nonce = req[2].value as string;
  const tst = a.toDer(seq(int('\x01'), oid('1.2.3.4.5'), mi, int('\x42'), a.create(a.Class.UNIVERSAL, a.Type.GENERALIZEDTIME, false, a.dateToGeneralizedTime(new Date())), int(nonce))).getBytes();
  const attrs = [
    seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.9.16.1.4'))),
    seq(oid('1.2.840.113549.1.9.4'), set(oct(sha256(tst)))),
  ];
  const signedSet = a.toDer(set(...attrs)).getBytes();
  const md = forge.md.sha256.create();
  md.update(signedSet);
  const signature = tsaKey.sign(md);
  const certAsn = forge.pki.certificateToAsn1(tsaCert);
  const signerInfo = seq(
    int('\x01'),
    seq(forge.pki.distinguishedNameToAsn1(tsaCert.issuer), int(forge.util.hexToBytes(tsaCert.serialNumber))),
    seq(oid('2.16.840.1.101.3.4.2.1')),
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, attrs),
    seq(oid('1.2.840.113549.1.1.11')),
    oct(signature),
  );
  const sd = seq(int('\x03'), set(seq(oid('2.16.840.1.101.3.4.2.1'))), seq(oid('1.2.840.113549.1.9.16.1.4'), ctx0(oct(tst))), ctx0(certAsn), set(signerInfo));
  const token = seq(oid('1.2.840.113549.1.7.2'), ctx0(sd));
  const body = bytes(a.toDer(seq(seq(int('\x00')), token)).getBytes());
  return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
}) as unknown as typeof fetch;

const httpGet = async (url: string) => {
  if (url !== CRL_URL) throw new Error(`unexpected ${url}`);
  return crl;
};
const opts = () => ({ trustedRoots: [root] });

beforeAll(async () => {
  const rk = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  rootKey = rk.privateKey;
  root = forge.pki.createCertificate();
  root.publicKey = rk.publicKey;
  root.serialNumber = '01';
  root.validity.notBefore = new Date(Date.now() - 86400e3);
  root.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const rootName = [{ name: 'commonName', value: 'Adika Test Root CA' }];
  root.setSubject(rootName);
  root.setIssuer(rootName);
  root.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  root.sign(rootKey, forge.md.sha256.create());
  // QcStatements: QcCompliance + QcSSCD (qualified signature).
  const qc = a.toDer(seq(seq(oid('0.4.0.1862.1.1')), seq(oid('0.4.0.1862.1.4')))).getBytes();
  const leaf = issue('Maria Ionescu', [{ id: '1.3.6.1.5.5.7.1.3', value: qc }]);
  signer = { name: 'Maria Ionescu', email: null, certificate: leaf.cert, privateKey: leaf.key, chain: [root], subject: 'CN=Maria Ionescu', issuer: 'CN=Adika Test Root CA', validFrom: leaf.cert.validity.notBefore, validTo: leaf.cert.validity.notAfter, selfSigned: false };
  const t = issue('Adika Test TSA', [{ name: 'extKeyUsage', timeStamping: true }]);
  tsaCert = t.cert;
  tsaKey = t.key;
  crl = makeCrl();
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText('Contract', { x: 60, y: 760, size: 18, font });
  pdf = await d.save();
}, 60000);

describe('PAdES baseline signatures (eIDAS)', () => {
  it('B-B: ETSI.CAdES.detached without a signing-time attribute; qualified certificate reported', async () => {
    const out = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
    expect(Buffer.from(out).toString('latin1')).toMatch(/\/SubFilter \/ETSI\.CAdES\.detached/);
    const [r] = await verifyPdfSignatures(out, opts());
    expect(r.integrity).toBe('valid');
    expect(r.padesLevel).toBe('B-B');
    expect(r.qualified).toBe('qscd');
    expect(r.message).toMatch(/PAdES baseline B-B/);
    expect(r.message).toMatch(/declares itself EU qualified/);
    // Classic signatures are not PAdES.
    const [c] = await verifyPdfSignatures(await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0] }), opts());
    expect(c.padesLevel).toBeNull();
  });

  it('B-T, then B-LT (validation data for signer and TSA), then B-LTA (document timestamp)', async () => {
    const bt = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true, tsaUrl: 'https://tsa.adika.test/', fetchImpl: tsa });
    const [r1] = await verifyPdfSignatures(bt, opts());
    expect(r1.padesLevel).toBe('B-T');
    expect(r1.hasTimestamp).toBe(true);

    const { bytes: blt, notes, complete } = await addValidationData(bt, { ...opts(), httpGet });
    expect(notes).toEqual([]);
    expect(complete).toBe(true);
    const doc = await PDFDocument.load(blt);
    const dss = doc.catalog.lookup(PDFName.of('DSS'))!.toString();
    // Signer, TSA and root certificates.
    expect(dss.match(/\d+ 0 R/g)!.length).toBeGreaterThanOrEqual(5);
    const [r2] = await verifyPdfSignatures(blt, opts());
    expect(r2.padesLevel).toBe('B-LT');
    expect(r2.ltv).toBe(true);

    const blta = await addDocumentTimestamp(blt, { tsaUrl: 'https://tsa.adika.test/', fetchImpl: tsa });
    expect(Buffer.from(blta.subarray(0, blt.length)).equals(Buffer.from(blt))).toBe(true);
    const rs = await verifyPdfSignatures(blta, opts());
    const sig = rs.find((x) => !x.documentTimestamp)!;
    const ts = rs.find((x) => x.documentTimestamp)!;
    expect(ts.fieldName).toBe('DocTimeStamp1');
    expect(ts.integrity).toBe('valid');
    expect(ts.signerName).toBe('Adika Test TSA');
    expect(ts.coversWholeFile).toBe(true);
    expect(ts.chainStatus).toBe('trusted');
    expect(ts.message).toMatch(/Document timestamp by Adika Test TSA/);
    expect(sig.integrity).toBe('valid');
    expect(sig.laterChanges).toEqual({ ltv: true, signatures: false, form: false, other: false });
    expect(sig.modifiedAfterSigning).toBe(false);
    expect(sig.padesLevel).toBe('B-LTA');
  });

  it('a document timestamp is allowed on a "no changes" certified document and detects tampering', async () => {
    const certified = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true, certify: 1 });
    const stamped = await addDocumentTimestamp(certified, { tsaUrl: 'https://tsa.adika.test/', fetchImpl: tsa });
    const s1 = (await verifyPdfSignatures(stamped, opts())).find((x) => !x.documentTimestamp)!;
    expect(s1.certified).toBe(1);
    expect(s1.modifiedAfterSigning).toBe(false);
    // Flip a byte inside the timestamped range (the second signature's own objects).
    const bad = stamped.slice();
    const at = Buffer.from(bad).lastIndexOf('DocTimeStamp1');
    bad[at] = 'X'.charCodeAt(0);
    const ts = (await verifyPdfSignatures(bad, opts())).find((x) => x.documentTimestamp);
    expect(ts?.integrity).toBe('invalid');
  });

  it('reads QcStatements', () => {
    expect(qcStatementsOf(signer.certificate)).toEqual({ compliance: true, qscd: true });
    expect(qcStatementsOf(tsaCert)).toEqual({ compliance: false, qscd: false });
  });
});

describe('EU Trusted Lists', () => {
  const b64 = (c: forge.pki.Certificate) => forge.util.encode64(a.toDer(forge.pki.certificateToAsn1(c)).getBytes());
  const service = (type: string, status: string, cert: string, name: string) => `
      <tsl:TSPService><tsl:ServiceInformation>
        <tsl:ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/${type}</tsl:ServiceTypeIdentifier>
        <tsl:ServiceName><tsl:Name xml:lang="ro">Serviciu</tsl:Name><tsl:Name xml:lang="en">${name}</tsl:Name></tsl:ServiceName>
        <tsl:ServiceDigitalIdentity><tsl:DigitalId><tsl:X509Certificate>
${cert.replace(/(.{64})/g, '$1\n')}
        </tsl:X509Certificate></tsl:DigitalId></tsl:ServiceDigitalIdentity>
        <tsl:ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/${status}</tsl:ServiceStatus>
      </tsl:ServiceInformation>
      <tsl:ServiceHistory><tsl:ServiceHistoryInstance><tsl:ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted</tsl:ServiceStatus></tsl:ServiceHistoryInstance></tsl:ServiceHistory>
      </tsl:TSPService>`;
  const nationalTl = () => `<?xml version="1.0" encoding="UTF-8"?>
<tsl:TrustServiceStatusList xmlns:tsl="http://uri.etsi.org/02231/v2#">
  <tsl:TrustServiceProviderList>
    <tsl:TrustServiceProvider>
      <tsl:TSPInformation><tsl:TSPName><tsl:Name xml:lang="en">Adika Trust &amp; Co</tsl:Name></tsl:TSPName></tsl:TSPInformation>
      <tsl:TSPServices>
        ${service('CA/QC', 'granted', b64(root), 'Adika Qualified CA')}
        ${service('TSA/QTST', 'granted', b64(tsaCert), 'Adika QTSA')}
        ${service('CA/QC', 'withdrawn', b64(tsaCert), 'Old CA')}
        ${service('CA/PKC', 'granted', b64(tsaCert), 'Non-qualified CA')}
      </tsl:TSPServices>
    </tsl:TrustServiceProvider>
  </tsl:TrustServiceProviderList>
</tsl:TrustServiceStatusList>`;
  const lotl = `<?xml version="1.0"?>
<TrustServiceStatusList xmlns="http://uri.etsi.org/02231/v2#" xmlns:ns3="http://uri.etsi.org/02231/v2/additionaltypes#">
 <SchemeInformation><PointersToOtherTSL>
  <OtherTSLPointer><TSLLocation>https://ec.europa.eu/tools/lotl/eu-lotl.xml</TSLLocation><AdditionalInformation><OtherInformation><ns3:MimeType>application/vnd.etsi.tsl+xml</ns3:MimeType></OtherInformation><OtherInformation><SchemeTerritory>EU</SchemeTerritory></OtherInformation></AdditionalInformation></OtherTSLPointer>
  <OtherTSLPointer><TSLLocation>https://tl.adika.test/ro.xml</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>RO</SchemeTerritory></OtherInformation><OtherInformation><ns3:MimeType>application/vnd.etsi.tsl+xml</ns3:MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
  <OtherTSLPointer><TSLLocation>https://tl.adika.test/ro.pdf</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>RO</SchemeTerritory></OtherInformation><OtherInformation><ns3:MimeType>application/pdf</ns3:MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
  <OtherTSLPointer><TSLLocation>https://tl.adika.test/xx.xml</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>XX</SchemeTerritory></OtherInformation><OtherInformation><ns3:MimeType>application/vnd.etsi.tsl+xml</ns3:MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
 </PointersToOtherTSL></SchemeInformation>
</TrustServiceStatusList>`;

  it('reads the list of lists and the granted qualified services', () => {
    expect(parseLotl(lotl)).toEqual([
      { territory: 'RO', url: 'https://tl.adika.test/ro.xml' },
      { territory: 'XX', url: 'https://tl.adika.test/xx.xml' },
    ]);
    const services = parseTrustedList(nationalTl(), 'RO');
    expect(services.map((s) => [s.kind, s.provider, s.name])).toEqual([
      ['ca', 'Adika Trust & Co', 'Adika Qualified CA'],
      ['tsa', 'Adika Trust & Co', 'Adika QTSA'],
    ]);
    expect(services[0].certs).toEqual([b64(root)]);
    const der = new Uint8Array(Buffer.from(b64(root), 'base64'));
    expect(subjectKey(der)).toBe(Buffer.from(a.toDer(forge.pki.distinguishedNameToAsn1(root.subject)).getBytes(), 'binary').toString('hex'));
  });

  it('downloads every list (failures recorded) and trusts qualified signatures and timestamps through it', async () => {
    const seen: string[] = [];
    const get = async (url: string) => {
      seen.push(url);
      if (url === LOTL_URL) return new TextEncoder().encode(lotl);
      if (url.endsWith('ro.xml')) return new TextEncoder().encode(nationalTl());
      throw new Error('HTTP 404');
    };
    const progress: string[] = [];
    const cache = await downloadTrustedLists(get, (d, t) => progress.push(`${d}/${t}`));
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    expect(cache.lists).toEqual([
      { territory: 'RO', url: 'https://tl.adika.test/ro.xml', services: 2 },
      { territory: 'XX', url: 'https://tl.adika.test/xx.xml', error: 'HTTP 404' },
    ]);
    const euTrust = trustIndex(JSON.parse(JSON.stringify(cache)));
    expect(euTrust.size).toBe(2);

    const signed = await signPdf(pdf, { identity: signer, pageIndex: 0, rect: [0, 0, 0, 0], pades: true });
    const stamped = await addDocumentTimestamp(signed, { tsaUrl: 'https://tsa.adika.test/', fetchImpl: tsa });
    // No Windows roots: trust comes from the EU list only.
    const rs = await verifyPdfSignatures(stamped, { euTrust });
    const sig = rs.find((x) => !x.documentTimestamp)!;
    const ts = rs.find((x) => x.documentTimestamp)!;
    expect(sig.chainStatus).toBe('trusted');
    expect(sig.euTrusted).toBe('RO: Adika Trust & Co — Adika Qualified CA');
    expect(sig.message).toMatch(/Qualified electronic signature/);
    expect(ts.euTrusted).toBe('RO: Adika Trust & Co — Adika QTSA');
    expect(ts.message).toMatch(/Qualified timestamp authority/);
    // Without the list the root is unknown.
    const [plainSig] = await verifyPdfSignatures(signed, {});
    expect(plainSig.chainStatus).toBe('untrusted');
    expect(plainSig.euTrusted).toBeUndefined();
  });
});
