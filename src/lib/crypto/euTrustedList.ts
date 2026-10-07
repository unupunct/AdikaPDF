/**
 * EU Trusted Lists (eIDAS): the European Commission's list of lists (LOTL)
 * points to each member state's trusted list, which names the qualified
 * trust services — certificate authorities issuing qualified certificates
 * (CA/QC) and qualified timestamp authorities (TSA/QTST). Their certificates
 * serve as trust anchors for EU signatures.
 *
 * The lists are downloaded over HTTPS only, from the official addresses;
 * their XML signatures are not checked (the reports say so). A service
 * counts only while its status was granted: the status history is kept and
 * applied at the validation time.
 */
import type { EuTrustIndex } from './digitalSignature';

export const LOTL_URL = 'https://ec.europa.eu/tools/lotl/eu-lotl.xml';

const TYPE_URI = 'http://uri.etsi.org/TrstSvc/Svctype/';
/** Granted, and the statuses that meant the same before eIDAS (July 2016). */
const GRANTED = /^http:\/\/uri\.etsi\.org\/TrstSvc\/TrustedList\/Svcstatus\/(granted|undersupervision|accredited|supervisionincessation)$/;

export interface TrustService {
  /** Country code, e.g. "RO". */
  territory: string;
  /** Trust service provider. */
  provider: string;
  name: string;
  kind: 'ca' | 'tsa';
  /** Base64 DER certificates of the service. */
  certs: string[];
  /**
   * Status history, oldest first: from when (ISO; '' = since always) the
   * service was granted or not. Missing in lists cached by older versions.
   */
  periods?: Array<{ from: string; granted: boolean }>;
}

/** Whether a service was granted at `at`. */
export function grantedAt(s: Pick<TrustService, 'periods'>, at: Date): boolean {
  if (!s.periods) return true;
  let granted = false;
  for (const p of s.periods) {
    if (p.from && new Date(p.from).getTime() > at.getTime()) break;
    granted = p.granted;
  }
  return granted;
}

export interface TrustedListCache {
  /** ISO time of the download. */
  fetched: string;
  lists: Array<{ territory: string; url: string; error?: string; services?: number }>;
  services: TrustService[];
}

/** Namespace prefixes removed, so elements can be matched by local name. */
const plain = (xml: string) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1').replace(/<!--[\s\S]*?-->/g, '');

const unescape = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const blocks = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g')) ?? [];
const text = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? unescape(m[1]) : null;
};
/** The English name of a multilingual name list, or the first one. */
const englishName = (xml: string | null) => {
  if (!xml) return '';
  const names = xml.match(/<Name(?:\s[^>]*)?>[\s\S]*?<\/Name>/g) ?? [];
  const en = names.find((n) => /xml:lang="en"/i.test(n)) ?? names[0];
  return en ? unescape(en.replace(/^<Name[^>]*>|<\/Name>$/g, '')) : '';
};

/** National trusted list addresses named by the LOTL (XML versions only). */
export function parseLotl(xml: string): Array<{ territory: string; url: string }> {
  const out: Array<{ territory: string; url: string }> = [];
  for (const p of blocks(plain(xml), 'OtherTSLPointer')) {
    const url = text(p, 'TSLLocation');
    const territory = text(p, 'SchemeTerritory') ?? '';
    const mime = text(p, 'MimeType') ?? '';
    // HTTPS only: the lists' own signatures are not checked, so the transport must be authenticated.
    if (!url || !/^https:\/\//i.test(url) || !/xml/i.test(mime) || /eu-lotl\.xml$/i.test(url)) continue;
    if (!out.some((o) => o.url === url)) out.push({ territory, url });
  }
  return out;
}

/** Granted qualified CA and timestamp services of one national trusted list. */
export function parseTrustedList(xml: string, territory: string): TrustService[] {
  const out: TrustService[] = [];
  for (const tsp of blocks(plain(xml), 'TrustServiceProvider')) {
    const info = blocks(tsp, 'TSPInformation')[0] ?? '';
    const provider = englishName(blocks(info, 'TSPName')[0] ?? null);
    for (const svc of blocks(tsp, 'TSPService')) {
      // The first ServiceInformation is the current one (history follows).
      const si = blocks(svc, 'ServiceInformation')[0];
      if (!si) continue;
      const kindOf = (xml: string) => {
        const type = text(xml, 'ServiceTypeIdentifier') ?? '';
        return type === `${TYPE_URI}CA/QC` ? 'ca' : type === `${TYPE_URI}TSA/QTST` ? 'tsa' : null;
      };
      const history = blocks(svc, 'ServiceHistoryInstance');
      const kind = [si, ...history].map(kindOf).find(Boolean);
      if (!kind) continue;
      // Each status holds from its starting time until the next one.
      const periods = [
        { from: text(si, 'StatusStartingTime') ?? '', xml: si },
        ...history.map((h) => ({ from: text(h, 'StatusStartingTime') ?? '', xml: h })).filter((h) => h.from),
      ]
        .map((p) => ({ from: p.from, granted: kindOf(p.xml) === kind && GRANTED.test(text(p.xml, 'ServiceStatus') ?? '') }))
        .sort((a, b) => (a.from ? new Date(a.from).getTime() : -Infinity) - (b.from ? new Date(b.from).getTime() : -Infinity));
      if (!periods.some((p) => p.granted)) continue;
      const identity = blocks(si, 'ServiceDigitalIdentity')[0] ?? '';
      const certs = blocks(identity, 'X509Certificate')
        .map((c) => unescape(c.replace(/^<X509Certificate[^>]*>|<\/X509Certificate>$/g, '')).replace(/\s+/g, ''))
        .filter(Boolean);
      if (!certs.length) continue;
      out.push({ territory, provider, name: englishName(blocks(si, 'ServiceName')[0] ?? null), kind, certs, periods });
    }
  }
  return out;
}

/** Downloads the LOTL and every national list (a few at a time). */
export async function downloadTrustedLists(
  httpGet: (url: string) => Promise<Uint8Array>,
  onProgress?: (done: number, total: number) => void,
): Promise<TrustedListCache> {
  const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
  const pointers = parseLotl(decode(await httpGet(LOTL_URL)));
  if (!pointers.length) throw new Error('The EU list of trusted lists contains no national lists.');
  const cache: TrustedListCache = { fetched: new Date().toISOString(), lists: [], services: [] };
  let next = 0;
  let done = 0;
  onProgress?.(0, pointers.length);
  const worker = async () => {
    while (next < pointers.length) {
      const p = pointers[next++];
      try {
        const services = parseTrustedList(decode(await httpGet(p.url)), p.territory);
        cache.services.push(...services);
        cache.lists.push({ ...p, services: services.length });
      } catch (e) {
        cache.lists.push({ ...p, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(++done, pointers.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  cache.lists.sort((a, b) => a.territory.localeCompare(b.territory));
  if (!cache.services.length) throw new Error('No trusted list could be downloaded.');
  return cache;
}

// ---------------------------------------------------------------- index

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Offset and end of the TLV at `at` (definite lengths only, as in DER). */
function tlv(d: Uint8Array, at: number): { start: number; end: number } {
  let i = at + 1;
  let len = d[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + d[i++];
  }
  return { start: i, end: i + len };
}

/** Hex of the subject Name DER of a certificate. */
export function subjectKey(der: Uint8Array): string | null {
  try {
    const tbs = tlv(der, tlv(der, 0).start); // Certificate -> TBSCertificate
    let at = tbs.start;
    if (der[at] === 0xa0) at = tlv(der, at).end; // [0] version
    for (let k = 0; k < 4; k++) at = tlv(der, at).end; // serial, signature, issuer, validity
    const subject = der.subarray(at, tlv(der, at).end);
    return Array.from(subject, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Lookup of trusted-list certificates by subject, for chain building. */
export function trustIndex(cache: TrustedListCache): EuTrustIndex & { size: number } {
  const map = new Map<string, Array<{ der: Uint8Array; label: string; kind: 'ca' | 'tsa'; service: TrustService }>>();
  let size = 0;
  for (const s of cache.services) {
    const label = `${s.territory}: ${s.provider}${s.name && s.name !== s.provider ? ` — ${s.name}` : ''}`;
    for (const c of s.certs) {
      let der: Uint8Array;
      try {
        der = b64(c);
      } catch {
        continue;
      }
      const key = subjectKey(der);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push({ der, label, kind: s.kind, service: s });
      map.set(key, list);
      size++;
    }
  }
  return {
    size,
    find: (subjectHex, kind, at = new Date()) => (map.get(subjectHex) ?? []).filter((x) => x.kind === kind && grantedAt(x.service, at)),
  };
}
