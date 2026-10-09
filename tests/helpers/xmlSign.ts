/**
 * Signs XML the way the EU trusted lists are signed (enveloped XMLDSig, Exclusive
 * C14N, RSA-SHA256, SHA-256 digests, the certificate in KeyInfo) for tests.
 */
import forge from 'node-forge';
import { canonicalize, parseXmlTree } from '@/lib/crypto/xmlDsig';
import { kids, localName } from '@/lib/xml';
import { certificateToDer } from '@/lib/crypto/digitalSignature';
import type { TestCa } from './sigPki';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const sha256 = (s: string) => new Uint8Array(Buffer.from(forge.md.sha256.create().update(s, 'utf8').digest().getBytes(), 'binary'));

export function signXml(xml: string, signer: TestCa, o: { inclusive?: boolean } = {}): string {
  const alg = o.inclusive ? 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315' : 'http://www.w3.org/2001/10/xml-exc-c14n#';
  const unsigned = parseXmlTree(xml);
  const digest = b64(sha256(canonicalize(unsigned, unsigned.doc, { exclusive: !o.inclusive })));
  const signedInfo =
    `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${alg}"/>` +
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
    '<ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>' +
    `<ds:Transform Algorithm="${alg}"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const sig =
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="sig">${signedInfo}<ds:SignatureValue>VALUE</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${b64(certificateToDer(signer.cert))}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`;
  const end = xml.lastIndexOf('</');
  const signed = xml.slice(0, end) + sig + xml.slice(end);
  const t = parseXmlTree(signed);
  const root = t.doc.children.find((c) => typeof c === 'object' && c.name !== '#comment' && c.name !== '#pi') as Parameters<typeof kids>[0];
  const si = kids(kids(root).find((k) => localName(k.name) === 'Signature'), 'SignedInfo')[0];
  const md = forge.md.sha256.create();
  md.update(canonicalize(t, si, { exclusive: !o.inclusive }), 'utf8');
  return signed.replace('VALUE', forge.util.encode64(signer.key.sign(md)));
}
