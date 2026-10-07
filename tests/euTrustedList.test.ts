import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { grantedAt, parseLotl, parseTrustedList, subjectKey, trustIndex } from '@/lib/crypto/euTrustedList';

const STATUS = 'http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/';
const CERT = (() => {
  const k = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 });
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = '01';
  c.setSubject([{ name: 'commonName', value: 'History CA' }]);
  c.setIssuer([{ name: 'commonName', value: 'History CA' }]);
  c.sign(k.privateKey, forge.md.sha256.create());
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes());
})();

const svc = (status: string, from: string, history: Array<[string, string]>) => `
  <tsl:TSPService><tsl:ServiceInformation>
    <tsl:ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/CA/QC</tsl:ServiceTypeIdentifier>
    <tsl:ServiceName><tsl:Name xml:lang="en">CA ${status}</tsl:Name></tsl:ServiceName>
    <tsl:ServiceDigitalIdentity><tsl:DigitalId><tsl:X509Certificate>${CERT}</tsl:X509Certificate></tsl:DigitalId></tsl:ServiceDigitalIdentity>
    <tsl:ServiceStatus>${STATUS}${status}</tsl:ServiceStatus>
    <tsl:StatusStartingTime>${from}</tsl:StatusStartingTime>
  </tsl:ServiceInformation>
  <tsl:ServiceHistory>${history
    .map(
      ([s, t]) => `<tsl:ServiceHistoryInstance>
      <tsl:ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/CA/QC</tsl:ServiceTypeIdentifier>
      <tsl:ServiceStatus>${STATUS}${s}</tsl:ServiceStatus><tsl:StatusStartingTime>${t}</tsl:StatusStartingTime></tsl:ServiceHistoryInstance>`,
    )
    .join('')}</tsl:ServiceHistory>
  </tsl:TSPService>`;

const list = (...services: string[]) => `<tsl:TrustServiceStatusList xmlns:tsl="http://uri.etsi.org/02231/v2#"><tsl:TrustServiceProviderList><tsl:TrustServiceProvider>
  <tsl:TSPInformation><tsl:TSPName><tsl:Name xml:lang="en">Provider</tsl:Name></tsl:TSPName></tsl:TSPInformation>
  <tsl:TSPServices>${services.join('')}</tsl:TSPServices></tsl:TrustServiceProvider></tsl:TrustServiceProviderList></tsl:TrustServiceStatusList>`;

describe('EU Trusted Lists: transport and status history', () => {
  it('national lists are only fetched over HTTPS', () => {
    const lotl = `<TrustServiceStatusList><SchemeInformation><PointersToOtherTSL>
      <OtherTSLPointer><TSLLocation>http://tl.example/ro.xml</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>RO</SchemeTerritory></OtherInformation><OtherInformation><MimeType>application/vnd.etsi.tsl+xml</MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
      <OtherTSLPointer><TSLLocation>https://tl.example/de.xml</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>DE</SchemeTerritory></OtherInformation><OtherInformation><MimeType>application/vnd.etsi.tsl+xml</MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
    </PointersToOtherTSL></SchemeInformation></TrustServiceStatusList>`;
    expect(parseLotl(lotl)).toEqual([{ territory: 'DE', url: 'https://tl.example/de.xml' }]);
  });

  it('a withdrawn service still counts for signatures made while it was granted, not after', () => {
    const [s] = parseTrustedList(list(svc('withdrawn', '2025-01-01T00:00:00Z', [['granted', '2016-07-01T00:00:00Z']])), 'RO');
    expect(s).toBeTruthy();
    expect(grantedAt(s, new Date('2024-06-01T00:00:00Z'))).toBe(true);
    expect(grantedAt(s, new Date('2025-06-01T00:00:00Z'))).toBe(false);
    expect(grantedAt(s, new Date('2015-01-01T00:00:00Z'))).toBe(false);
    const index = trustIndex({ fetched: '', lists: [], services: [s] });
    const subject = subjectKey(new Uint8Array(Buffer.from(CERT, 'base64')))!;
    expect(index.find(subject, 'ca', new Date('2024-06-01T00:00:00Z'))).toHaveLength(1);
    expect(index.find(subject, 'ca', new Date('2025-06-01T00:00:00Z'))).toHaveLength(0);
  });

  it('a service granted only from a future date is not trusted now', () => {
    const [s] = parseTrustedList(list(svc('granted', '2099-01-01T00:00:00Z', [['withdrawn', '2020-01-01T00:00:00Z']])), 'RO');
    expect(grantedAt(s, new Date())).toBe(false);
    expect(grantedAt(s, new Date('2100-01-01T00:00:00Z'))).toBe(true);
  });

  it('lists cached by older versions (no history) keep working', () => {
    expect(grantedAt({}, new Date())).toBe(true);
  });
});
