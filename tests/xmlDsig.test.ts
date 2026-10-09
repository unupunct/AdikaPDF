import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import forge from 'node-forge';
import { canonicalize, parseXmlTree, sha256Hex, verifyEnvelopedSignature } from '@/lib/crypto/xmlDsig';
import { buildTrustedLists, downloadTrustedLists, LOTL_PINS, LOTL_URL, verifyLotl, type TrustedListSources } from '@/lib/crypto/euTrustedList';
import { certificateToDer } from '@/lib/crypto/digitalSignature';
import { descendants } from '@/lib/xml';
import { issue, type TestCa } from './helpers/sigPki';
import { signXml } from './helpers/xmlSign';

const c14n = (xml: string, o: Parameters<typeof canonicalize>[2] = {}) => {
  const t = parseXmlTree(xml);
  return canonicalize(t, t.doc, o);
};
const subtree = (xml: string, local: string, o: Parameters<typeof canonicalize>[2] = {}) => {
  const t = parseXmlTree(xml);
  return canonicalize(t, descendants(t.doc, local)[0], o);
};

// Test vectors from W3C Canonical XML 1.0 (section 3) and Exclusive XML Canonicalization 1.0 (section 2.2).
describe('Canonical XML', () => {
  it('3.1 PIs, comments and outside of the document element', () => {
    const input = `<?xml version="1.0"?>\n\n<?xml-stylesheet   href="doc.xsl"\n   type="text/xsl"   ?>\n\n<!DOCTYPE doc SYSTEM "doc.dtd">\n\n<doc>Hello, world!<!-- Comment 1 --></doc>\n\n<?pi-without-data     ?>\n\n<!-- Comment 2 -->\n\n<!-- Comment 3 -->\n`;
    expect(c14n(input)).toBe(`<?xml-stylesheet href="doc.xsl"\n   type="text/xsl"   ?>\n<doc>Hello, world!</doc>\n<?pi-without-data?>`);
    expect(c14n(input, { comments: true })).toBe(
      `<?xml-stylesheet href="doc.xsl"\n   type="text/xsl"   ?>\n<doc>Hello, world!<!-- Comment 1 --></doc>\n<?pi-without-data?>\n<!-- Comment 2 -->\n<!-- Comment 3 -->`,
    );
  });

  it('3.2 whitespace in document content', () => {
    const doc = `<doc>\n   <clean>   </clean>\n   <dirty>   A   B   </dirty>\n   <mixed>\n      A\n      <clean>   </clean>\n      B\n      <dirty>   A   B   </dirty>\n      C\n   </mixed>\n</doc>`;
    expect(c14n(doc)).toBe(doc);
  });

  it('3.3 start and end tags (without the DTD default attribute)', () => {
    const input = `<doc>
   <e1   />
   <e2   ></e2>
   <e3   name = "elem3"   id="elem3"   />
   <e4   name="elem4"   id="elem4"   ></e4>
   <e5 a:attr="out" b:attr="sorted" attr2="all" attr="I'm"
      xmlns:b="http://www.ietf.org"
      xmlns:a="http://www.w3.org"
      xmlns="http://example.org"/>
   <e6 xmlns="" xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="" xmlns:a="http://www.w3.org">
            <e9 xmlns="" xmlns:a="http://www.ietf.org"/>
         </e8>
      </e7>
   </e6>
</doc>`;
    expect(c14n(input)).toBe(`<doc>
   <e1></e1>
   <e2></e2>
   <e3 id="elem3" name="elem3"></e3>
   <e4 id="elem4" name="elem4"></e4>
   <e5 xmlns="http://example.org" xmlns:a="http://www.w3.org" xmlns:b="http://www.ietf.org" attr="I'm" attr2="all" b:attr="sorted" a:attr="out"></e5>
   <e6 xmlns:a="http://www.w3.org">
      <e7 xmlns="http://www.ietf.org">
         <e8 xmlns="">
            <e9 xmlns:a="http://www.ietf.org"></e9>
         </e8>
      </e7>
   </e6>
</doc>`);
  });

  it('3.4 character modifications and character references (CDATA attributes)', () => {
    const input = `<doc>
   <text>First line&#x0d;&#10;Second line</text>
   <value>&#x32;</value>
   <compute><![CDATA[value>"0" && value<"10" ?"valid":"error"]]></compute>
   <compute expr='value>"0" &amp;&amp; value&lt;"10" ?"valid":"error"'>valid</compute>
   <norm attr=' &apos;   &#x20;&#13;&#xa;&#9;   &apos; '/>
</doc>`;
    expect(c14n(input)).toBe(`<doc>
   <text>First line&#xD;
Second line</text>
   <value>2</value>
   <compute>value&gt;"0" &amp;&amp; value&lt;"10" ?"valid":"error"</compute>
   <compute expr="value>&quot;0&quot; &amp;&amp; value&lt;&quot;10&quot; ?&quot;valid&quot;:&quot;error&quot;">valid</compute>
   <norm attr=" '    &#xD;&#xA;&#x9;   ' "></norm>
</doc>`);
  });

  it('3.6 UTF-8 and line ends', () => {
    expect(c14n('<doc>&#169;</doc>')).toBe('<doc>©</doc>');
    expect(c14n('<doc a="x\r\ny">1\r\n2\r3</doc>')).toBe('<doc a="x y">1\n2\n3</doc>');
  });

  const ns = `<n0:local xmlns:n0="foo:bar" xmlns:n3="ftp://example.org">
  <n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
     <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n0:local>`;
  const ns2 = `<n2:pdu xmlns:n1="http://example.com"
           xmlns:n2="http://foo.example"
           xml:lang="fr"
           xml:space="retain">
  <n1:elem2 xmlns:n1="http://example.net"
            xml:lang="en">
     <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n2:pdu>`;

  it('exclusive C14N renders only the namespaces a subtree uses', () => {
    const want = `<n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
     <n3:stuff xmlns:n3="ftp://example.org"></n3:stuff>
  </n1:elem2>`;
    expect(subtree(ns, 'elem2', { exclusive: true })).toBe(want);
    expect(subtree(ns2, 'elem2', { exclusive: true })).toBe(want);
  });

  it('inclusive C14N of a subtree takes the namespaces and xml: attributes in scope', () => {
    expect(subtree(ns, 'elem2')).toBe(`<n1:elem2 xmlns:n0="foo:bar" xmlns:n1="http://example.net" xmlns:n3="ftp://example.org" xml:lang="en">
     <n3:stuff></n3:stuff>
  </n1:elem2>`);
    expect(subtree(ns2, 'elem2')).toBe(`<n1:elem2 xmlns:n1="http://example.net" xmlns:n2="http://foo.example" xml:lang="en" xml:space="retain">
     <n3:stuff xmlns:n3="ftp://example.org"></n3:stuff>
  </n1:elem2>`);
  });

  it('InclusiveNamespaces PrefixList and the default namespace', () => {
    const doc = `<r xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b"><s><t a:x="1"/></s></r>`;
    expect(subtree(doc, 's', { exclusive: true })).toBe('<s xmlns="urn:d"><t xmlns:a="urn:a" a:x="1"></t></s>');
    expect(subtree(doc, 's', { exclusive: true, inclusivePrefixes: ['b'] })).toBe('<s xmlns="urn:d" xmlns:b="urn:b"><t xmlns:a="urn:a" a:x="1"></t></s>');
    expect(c14n('<a xmlns="urn:x"><b xmlns=""><c/></b></a>', { exclusive: true })).toBe('<a xmlns="urn:x"><b xmlns=""><c></c></b></a>');
  });
});

// ---------------------------------------------------------------- trusted lists

const b64 = (c: TestCa) => Buffer.from(certificateToDer(c.cert)).toString('base64');
const enc = (s: string) => new TextEncoder().encode(s);

let ec1: TestCa; // pinned LOTL signer
let ec2: TestCa; // announced by a pivot
let ro: TestCa; // Romanian TL signer
let rogue: TestCa;
let pins: string[];

const tl = (territory: string, provider = 'Adika Trust') => `<?xml version="1.0" encoding="UTF-8"?>
<tsl:TrustServiceStatusList xmlns:tsl="http://uri.etsi.org/02231/v2#" Id="tl">
  <tsl:SchemeInformation><tsl:SchemeTerritory>${territory}</tsl:SchemeTerritory></tsl:SchemeInformation>
  <tsl:TrustServiceProviderList><tsl:TrustServiceProvider>
    <tsl:TSPInformation><tsl:TSPName><tsl:Name xml:lang="en">${provider}</tsl:Name></tsl:TSPName></tsl:TSPInformation>
    <tsl:TSPServices><tsl:TSPService><tsl:ServiceInformation>
      <tsl:ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/CA/QC</tsl:ServiceTypeIdentifier>
      <tsl:ServiceName><tsl:Name xml:lang="en">Qualified CA</tsl:Name></tsl:ServiceName>
      <tsl:ServiceDigitalIdentity><tsl:DigitalId><tsl:X509Certificate>${b64(rogue)}</tsl:X509Certificate></tsl:DigitalId></tsl:ServiceDigitalIdentity>
      <tsl:ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted</tsl:ServiceStatus>
    </tsl:ServiceInformation></tsl:TSPService></tsl:TSPServices>
  </tsl:TrustServiceProvider></tsl:TrustServiceProviderList>
</tsl:TrustServiceStatusList>`;

const pointer = (url: string, territory: string, certs: TestCa[], type = 'EUgeneric') => `
  <OtherTSLPointer><ServiceDigitalIdentities>${certs.map((c) => `<ServiceDigitalIdentity><DigitalId><X509Certificate>${b64(c)}</X509Certificate></DigitalId></ServiceDigitalIdentity>`).join('')}</ServiceDigitalIdentities>
  <TSLLocation>${url}</TSLLocation><AdditionalInformation><OtherInformation><TSLType>http://uri.etsi.org/TrstSvc/TrustedList/TSLType/${type}</TSLType></OtherInformation>
  <OtherInformation><SchemeTerritory>${territory}</SchemeTerritory></OtherInformation><OtherInformation><ns3:MimeType>application/vnd.etsi.tsl+xml</ns3:MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>`;

const lotl = (lotlSigners: TestCa[], pivots: string[] = []) => `<?xml version="1.0" encoding="UTF-8"?>
<TrustServiceStatusList xmlns="http://uri.etsi.org/02231/v2#" xmlns:ns3="http://uri.etsi.org/02231/v2/additionaltypes#" Id="lotl">
 <SchemeInformation>
  <SchemeInformationURI>${pivots.map((p) => `<URI xml:lang="en">${p}</URI>`).join('')}<URI xml:lang="en">https://eur-lex.europa.eu/eli/C/2026/1944/oj</URI></SchemeInformationURI>
  <PointersToOtherTSL>${pointer(LOTL_URL, 'EU', lotlSigners, 'EUlistofthelists')}${pointer('https://tl.adika.test/ro.xml', 'RO', [ro])}</PointersToOtherTSL>
 </SchemeInformation>
</TrustServiceStatusList>`;

const PIVOT = 'https://ec.europa.eu/tools/lotl/eu-lotl-pivot-400.xml';

describe('XML signatures of the EU trusted lists', () => {
  beforeAll(async () => {
    [ec1, ec2, ro, rogue] = await Promise.all(['EC LOTL 1', 'EC LOTL 2', 'RO TL signer', 'Rogue'].map((cn) => issue({ cn, bits: 1024 })));
    pins = [await sha256Hex(certificateToDer(ec1.cert))];
  });

  it('a signed list verifies; a changed element, a changed signature or the wrong signer fail', async () => {
    const signed = signXml(tl('RO'), ro);
    const ok = await verifyEnvelopedSignature(signed, { certs: [certificateToDer(ro.cert)] });
    expect(ok.ok).toBe(true);
    expect(ok.signedXml).toContain('<tsl:Name xml:lang="en">Adika Trust</tsl:Name>');
    expect(ok.signedXml).not.toContain('Signature');
    // Re-indenting, CRLF line ends and comments do not change what was signed.
    const reformatted = signed.replace(/\n/g, '\r\n').replace('<tsl:TSPServices>', '<tsl:TSPServices><!-- note -->');
    expect((await verifyEnvelopedSignature(reformatted, { certs: [certificateToDer(ro.cert)] })).ok).toBe(true);

    const tampered = signed.replace('Adika Trust', 'Evil Trust');
    expect(await verifyEnvelopedSignature(tampered, { certs: [certificateToDer(ro.cert)] })).toMatchObject({ ok: false, error: 'The list was changed after it was signed.' });
    const badValue = signed.replace(/<ds:SignatureValue>(.)/, (_, c) => `<ds:SignatureValue>${c === 'A' ? 'B' : 'A'}`);
    expect(await verifyEnvelopedSignature(badValue, { certs: [certificateToDer(ro.cert)] })).toMatchObject({ ok: false, error: 'The signature value is not valid.' });
    const wrong = await verifyEnvelopedSignature(signXml(tl('RO'), rogue), { certs: [certificateToDer(ro.cert)] });
    expect(wrong).toMatchObject({ ok: false, unauthorised: true });
    // Inclusive canonicalisation works too.
    expect((await verifyEnvelopedSignature(signXml(tl('RO'), ro, { inclusive: true }), { certs: [certificateToDer(ro.cert)] })).ok).toBe(true);
    // Unsigned, two signatures, or a DOCTYPE: refused.
    expect((await verifyEnvelopedSignature(tl('RO'), { certs: [certificateToDer(ro.cert)] })).ok).toBe(false);
    expect((await verifyEnvelopedSignature(signXml(signed, ro), { certs: [certificateToDer(ro.cert)] })).error).toMatch(/more than one signature/);
    expect((await verifyEnvelopedSignature(signed.replace('<tsl:Trust', '<!DOCTYPE x><tsl:Trust'), { certs: [certificateToDer(ro.cert)] })).error).toMatch(/DOCTYPE/);
  });

  it('LOTL: pinned signer accepted, unknown signer refused, a new signer accepted through a pivot signed by the pinned one', async () => {
    const direct = await verifyLotl(signXml(lotl([ec1]), ec1), async () => null, pins);
    expect(direct).toMatchObject({ ok: true, signer: 'EC LOTL 1', pivots: [] });

    const byEc2 = signXml(lotl([ec2], [PIVOT]), ec2);
    expect(await verifyLotl(byEc2, async () => null, pins)).toMatchObject({ ok: false, error: expect.stringMatching(/not among the published LOTL-signing certificates/) });

    // The pivot announces EC 2 and is signed by the pinned EC 1.
    const pivot = signXml(lotl([ec2]), ec1);
    const viaPivot = await verifyLotl(byEc2, async (u) => (u === PIVOT ? pivot : null), pins);
    expect(viaPivot).toMatchObject({ ok: true, signer: 'EC LOTL 2', pivots: [{ url: PIVOT }] });
    // A pivot signed by someone else does not hand over trust.
    const forged = signXml(lotl([ec2]), rogue);
    expect((await verifyLotl(byEc2, async () => forged, pins)).ok).toBe(false);
    // An older pivot (signed before the pins) is skipped; the chain continues from the pinned one.
    const OLD = 'https://ec.europa.eu/tools/lotl/eu-lotl-pivot-300.xml';
    const old = signXml(lotl([ec1]), rogue);
    const withOld = signXml(lotl([ec2], [PIVOT, OLD]), ec2);
    expect(await verifyLotl(withOld, async (u) => (u === PIVOT ? pivot : old), pins)).toMatchObject({ ok: true, pivots: [{ url: PIVOT }] });
    // Only pivot addresses on ec.europa.eu are followed.
    const elsewhere = signXml(lotl([ec2], ['https://evil.test/eu-lotl-pivot-400.xml']), ec2);
    expect((await verifyLotl(elsewhere, async () => pivot, pins)).ok).toBe(false);
  });

  it('downloads, verifies each national list with the certificates the LOTL names, and re-verifies saved lists', async () => {
    const files: Record<string, string> = {
      [LOTL_URL]: signXml(lotl([ec2], [PIVOT]), ec2),
      [PIVOT]: signXml(lotl([ec2]), ec1),
      'https://tl.adika.test/ro.xml': signXml(tl('RO'), ro),
    };
    const get = async (url: string) => {
      if (!(url in files)) throw new Error('HTTP 404');
      return enc(files[url]);
    };
    const cache = await downloadTrustedLists(get, undefined, { pins });
    expect(cache.lists).toEqual([{ territory: 'RO', url: 'https://tl.adika.test/ro.xml', services: 1 }]);
    expect(cache.rejected).toEqual([]);
    expect(cache.lotl).toMatchObject({ signer: 'EC LOTL 2', pivots: [PIVOT] });
    expect(cache.verified).toBeTruthy();

    // Saved and loaded again: verified again from the saved files (no network).
    const saved = JSON.parse(JSON.stringify(cache.sources)) as TrustedListSources;
    expect((await buildTrustedLists(saved, { pins })).services).toHaveLength(1);
    // A locally edited national list is rejected; the rest is kept.
    const edited = { ...saved, lists: saved.lists.map((l) => ({ ...l, xml: l.xml!.replace('Adika Trust', 'Edited Trust') })) };
    const rebuilt = await buildTrustedLists(edited, { pins });
    expect(rebuilt.services).toHaveLength(0);
    expect(rebuilt.rejected).toEqual(['RO']);
    expect(rebuilt.lists[0].error).toMatch(/^Signature not valid: The list was changed/);
    // An edited LOTL (e.g. a pointer swapped to another signer) is refused entirely.
    await expect(buildTrustedLists({ ...saved, lotl: saved.lotl.replace('tl.adika.test', 'tl.evil.test') }, { pins })).rejects.toThrow(/failed its signature check/);
    // A national list signed by another key than the LOTL names.
    const swapped = { ...saved, lists: saved.lists.map((l) => ({ ...l, xml: signXml(tl('RO', 'Fake'), rogue) })) };
    expect((await buildTrustedLists(swapped, { pins })).rejected).toEqual(['RO']);
    // A list of another territory served at RO's address.
    const other = { ...saved, lists: saved.lists.map((l) => ({ ...l, xml: signXml(tl('BG'), ro) })) };
    expect((await buildTrustedLists(other, { pins })).lists[0].error).toMatch(/for BG, not RO/);
  });
});

// ---------------------------------------------------------------- the real LOTL

const REAL = 'tests/fixtures/eu-lotl';
const real = (f: string) => gunzipSync(readFileSync(`${REAL}/${f}.gz`)).toString('utf8');

describe.skipIf(!existsSync(`${REAL}/eu-lotl.xml.gz`))('the real EU LOTL (fixture fetched 2026-10-09)', () => {
  it('is signed by a certificate published in the Official Journal', async () => {
    const r = await verifyLotl(real('eu-lotl.xml'), async () => null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signedXml).toContain('<TSLType>http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUlistofthelists</TSLType>');
    // A changed byte in the content breaks it.
    expect((await verifyLotl(real('eu-lotl.xml').replace('<TSLSequenceNumber>', '<TSLSequenceNumber>1'), async () => null)).ok).toBe(false);
  });

  it('the real pivot chain hands trust from an earlier LOTL-signing certificate to the current ones', async () => {
    const p335 = real('eu-lotl-pivot-335.xml');
    const signer335 = forge.util.decode64(/<ds:X509Certificate>([^<]+)</.exec(p335)![1].replace(/\s+/g, ''));
    const oldPin = await sha256Hex(new Uint8Array(Buffer.from(signer335, 'binary')));
    expect(LOTL_PINS).not.toContain(oldPin);
    const files: Record<string, string> = {
      'https://ec.europa.eu/tools/lotl/eu-lotl-pivot-335.xml': p335,
      'https://ec.europa.eu/tools/lotl/eu-lotl-pivot-341.xml': real('eu-lotl-pivot-341.xml'),
      'https://ec.europa.eu/tools/lotl/eu-lotl-pivot-378.xml': real('eu-lotl-pivot-378.xml'),
    };
    const r = await verifyLotl(real('eu-lotl.xml'), async (u) => files[u] ?? null, [oldPin]);
    expect(r).toMatchObject({ ok: true, pivots: [{ url: expect.stringMatching(/335/) }, { url: expect.stringMatching(/341/) }, { url: expect.stringMatching(/378/) }] });
  });
});
