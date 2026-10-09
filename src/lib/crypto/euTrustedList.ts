/**
 * EU Trusted Lists (eIDAS): the European Commission's list of lists (LOTL)
 * points to each member state's trusted list, which names the qualified
 * trust services — certificate authorities issuing qualified certificates
 * (CA/QC) and qualified timestamp authorities (TSA/QTST). Their certificates
 * serve as trust anchors for EU signatures.
 *
 * The lists are downloaded over HTTPS only, from the official addresses,
 * and their XML signatures are verified: the LOTL with the LOTL-signing
 * certificates published in the Official Journal (pinned below, or newer
 * ones announced by a chain of "pivot" LOTLs each signed by the previous
 * keys), each national list with the certificates the LOTL names for it. A
 * list whose signature fails is not used. Services are read from the signed
 * (canonical) content only. A service counts only while its status was
 * granted: the status history is kept and applied at the validation time.
 */
import { identityFromCertificateDer, type EuTrustIndex } from './digitalSignature';
import { base64Bytes, verifyEnvelopedSignature, type XmlSignatureCheck } from './xmlDsig';

export const LOTL_URL = 'https://ec.europa.eu/tools/lotl/eu-lotl.xml';

/**
 * LOTL-signing certificates (SHA-256 of the DER), as published by the
 * European Commission in the Official Journal: "Information related to data
 * on Member States' trusted lists", OJ C/2026/1944 of 15.4.2026
 * (https://eur-lex.europa.eu/eli/C/2026/1944/oj), section 1, which replaces
 * OJ C 276, 16.8.2019. The current LOTL lists the same six certificates.
 * An app update refreshes these after a new OJ publication; in between,
 * pivot LOTLs carry the change (see `verifyLotl`).
 */
export const LOTL_PINS = [
  'c0641c4f7d56c431b1c924742db7fce9c1eef7d7fd212113a2768486b3abcdc5',
  'e0a620fbb6747362bb933ac44169d676a553444716cf5f31605f12a22b8396b1',
  'df7e29360c34b2b8d6d5f40325c1d4d12c9922cecd33b7407674a74b2b3ca1e5',
  'b63d416744e7098bf9ec2caa596a93bc2468e37f8284ba65ecc061711bcbaa18',
  '236103f03a8031ae8f47f9059bf8de38564cdbfebedde4a597d50f8980aa653b',
  'd2064fdd70f6982dcc516b86d9d5c56aea939417c624b2e478c0b29de54f8474',
];
export const LOTL_PINS_SOURCE = 'OJ C/2026/1944';
const PIVOT_URL = /^https:\/\/ec\.europa\.eu\/tools\/lotl\/eu-lotl-pivot-\d+\.xml$/i;

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

/** The downloaded files, kept so the signatures can be checked again whenever they are loaded. */
export interface TrustedListSources {
  /** ISO time of the download. */
  fetched: string;
  lotl: string;
  /** Pivot LOTLs that were needed to reach the LOTL's signer. */
  pivots: Array<{ url: string; xml: string }>;
  lists: Array<{ territory: string; url: string; xml?: string; error?: string }>;
}

export interface TrustedListCache {
  /** ISO time of the download. */
  fetched: string;
  lists: Array<{ territory: string; url: string; error?: string; services?: number }>;
  services: TrustService[];
  /** The LOTL's signature: who signed it, through which pivot LOTLs. */
  lotl?: { signer: string; pivots: string[]; signedAt?: string };
  /** ISO time the signatures were verified (every list in `lists` without an error). */
  verified?: string;
  /** Territories whose list was dropped because its signature failed. */
  rejected?: string[];
  sources?: TrustedListSources;
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
  for (const p of lotlPointers(xml)) {
    // HTTPS only, besides the lists' signatures.
    if (!p.url || !/^https:\/\//i.test(p.url) || !/xml/i.test(p.mime) || isLotlPointer(p)) continue;
    if (!out.some((o) => o.url === p.url)) out.push({ territory: p.territory, url: p.url });
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

// ---------------------------------------------------------------- signatures

/** Pointers of the LOTL: territory, address, MIME type, list type and the certificates that may sign that list. */
export function lotlPointers(xml: string): Array<{ territory: string; url: string; mime: string; tslType: string; certs: string[] }> {
  return blocks(plain(xml), 'OtherTSLPointer').map((p) => ({
    url: text(p, 'TSLLocation') ?? '',
    territory: text(p, 'SchemeTerritory') ?? '',
    mime: text(p, 'MimeType') ?? '',
    tslType: text(p, 'TSLType') ?? '',
    certs: blocks(blocks(p, 'ServiceDigitalIdentities')[0] ?? '', 'X509Certificate')
      .map((c) => unescape(c.replace(/^<X509Certificate[^>]*>|<\/X509Certificate>$/g, '')).replace(/\s+/g, ''))
      .filter(Boolean),
  }));
}

const isLotlPointer = (p: { url: string; tslType: string }) => /EUlistofthelists$/.test(p.tslType) || /\/eu-lotl\.xml$/i.test(p.url);

/** The LOTL-signing certificates a LOTL announces (its pointer to itself). */
export function lotlSigningCerts(xml: string): string[] {
  return lotlPointers(xml)
    .filter(isLotlPointer)
    .flatMap((p) => p.certs);
}

/** Pivot LOTL addresses in the LOTL's scheme information, newest first (as listed). */
export function lotlPivotUrls(xml: string): string[] {
  const info = blocks(plain(xml), 'SchemeInformationURI')[0] ?? '';
  return blocks(info, 'URI')
    .map((u) => unescape(u.replace(/^<URI[^>]*>|<\/URI>$/g, '')))
    .filter((u) => PIVOT_URL.test(u));
}

const certName = (der: Uint8Array | undefined) => {
  if (!der) return 'unknown';
  try {
    return identityFromCertificateDer(der).name || 'unknown';
  } catch {
    return 'unknown';
  }
};

export type LotlCheck =
  | { ok: true; signedXml: string; signer: string; signedAt?: string; pivots: Array<{ url: string; xml: string }> }
  | { ok: false; error: string };

/**
 * Verifies the LOTL. Signed by a pinned certificate: accepted. Otherwise the
 * pivot LOTLs it lists are followed from the oldest: the first one signed by
 * a pinned certificate, and each later one signed by a certificate the
 * previous pivot announced, hand trust on to the certificates they announce;
 * the LOTL must then be signed by one of those. Pivots older than the pins
 * (signed by earlier keys) are skipped.
 */
export async function verifyLotl(xml: string, getPivot: (url: string) => Promise<string | null>, pins: string[] = LOTL_PINS): Promise<LotlCheck> {
  const direct = await verifyEnvelopedSignature(xml, { sha256: pins });
  if (direct.ok) return { ok: true, signedXml: direct.signedXml!, signer: certName(direct.signer), signedAt: direct.signingTime, pivots: [] };
  if (!direct.unauthorised) return { ok: false, error: direct.error ?? 'Signature not valid.' };
  let trusted: { certs?: Uint8Array[]; sha256?: string[] } = { sha256: pins };
  const used: Array<{ url: string; xml: string }> = [];
  for (const url of lotlPivotUrls(xml).reverse()) {
    let pivot: string | null = null;
    try {
      pivot = await getPivot(url);
    } catch {
      pivot = null;
    }
    const r = pivot ? await verifyEnvelopedSignature(pivot, trusted) : null;
    if (!r?.ok) {
      if (used.length) return { ok: false, error: `The pivot list ${url} is not signed by the certificates announced before it.` };
      continue;
    }
    const certs = lotlSigningCerts(r.signedXml!).map(base64Bytes);
    if (!certs.length) return { ok: false, error: `The pivot list ${url} announces no signing certificates.` };
    trusted = { certs };
    used.push({ url, xml: pivot! });
  }
  if (!used.length) return { ok: false, error: `The list is signed by a certificate (${certName(direct.keyInfoCert)}) that is not among the published LOTL-signing certificates (${LOTL_PINS_SOURCE}).` };
  const last = await verifyEnvelopedSignature(xml, trusted);
  if (!last.ok) return { ok: false, error: last.error ?? 'Signature not valid.' };
  return { ok: true, signedXml: last.signedXml!, signer: certName(last.signer), signedAt: last.signingTime, pivots: used };
}

/** Same territory, allowing the ISO codes beside the EU ones (EL/GR, UK/GB). */
const sameTerritory = (a: string, b: string) => {
  const norm = (s: string) => ({ GR: 'EL', GB: 'UK' })[s.toUpperCase()] ?? s.toUpperCase();
  return norm(a) === norm(b);
};

/**
 * Verifies every signature of downloaded (or saved) lists and reads the
 * services from the signed content. Throws when the LOTL fails; a national
 * list that fails is recorded as rejected and not used.
 */
export async function buildTrustedLists(
  src: TrustedListSources,
  opts: { pins?: string[]; getPivot?: (url: string) => Promise<string | null> } = {},
): Promise<TrustedListCache> {
  const saved = new Map(src.pivots.map((p) => [p.url, p.xml]));
  const lotl = await verifyLotl(src.lotl, async (u) => saved.get(u) ?? (opts.getPivot ? opts.getPivot(u) : null), opts.pins);
  if (!lotl.ok) throw new Error(`The EU list of trusted lists failed its signature check: ${lotl.error}`);
  const pointers = lotlPointers(lotl.signedXml).filter((p) => !isLotlPointer(p));
  const cache: TrustedListCache = {
    fetched: src.fetched,
    lists: [],
    services: [],
    lotl: { signer: lotl.signer, pivots: lotl.pivots.map((p) => p.url), signedAt: lotl.signedAt },
    verified: new Date().toISOString(),
    rejected: [],
    sources: { ...src, pivots: lotl.pivots },
  };
  for (const l of src.lists) {
    const entry = { territory: l.territory, url: l.url };
    if (l.xml === undefined) {
      cache.lists.push({ ...entry, error: l.error ?? 'Not downloaded.' });
      continue;
    }
    const certs = pointers.filter((p) => p.url === l.url && sameTerritory(p.territory, l.territory)).flatMap((p) => p.certs);
    const r: XmlSignatureCheck = certs.length
      ? await verifyEnvelopedSignature(l.xml, { certs: certs.map(base64Bytes) })
      : { ok: false, error: 'The EU list of trusted lists names no signing certificate for it.' };
    const territory = r.ok ? text(plain(r.signedXml!), 'SchemeTerritory') : null;
    const error = !r.ok ? r.error : territory && !sameTerritory(territory, l.territory) ? `The list is for ${territory}, not ${l.territory}.` : null;
    if (error) {
      cache.lists.push({ ...entry, error: `Signature not valid: ${error}` });
      cache.rejected!.push(l.territory);
      continue;
    }
    const services = parseTrustedList(r.signedXml!, l.territory);
    cache.services.push(...services);
    cache.lists.push({ ...entry, services: services.length });
  }
  cache.lists.sort((a, b) => a.territory.localeCompare(b.territory));
  return cache;
}

/** Downloads the LOTL (and the pivots it needs) and every national list (a few at a time), then verifies them. */
export async function downloadTrustedLists(
  httpGet: (url: string) => Promise<Uint8Array>,
  onProgress?: (done: number, total: number) => void,
  opts: { pins?: string[] } = {},
): Promise<TrustedListCache> {
  const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
  const lotl = decode(await httpGet(LOTL_URL));
  // The LOTL is checked before any address in it is followed.
  const check = await verifyLotl(lotl, async (u) => decode(await httpGet(u)), opts.pins);
  if (!check.ok) throw new Error(`The EU list of trusted lists failed its signature check: ${check.error}`);
  const pointers = parseLotl(check.signedXml);
  if (!pointers.length) throw new Error('The EU list of trusted lists contains no national lists.');
  const src: TrustedListSources = { fetched: new Date().toISOString(), lotl, pivots: check.pivots, lists: [] };
  let next = 0;
  let done = 0;
  onProgress?.(0, pointers.length);
  const worker = async () => {
    while (next < pointers.length) {
      const p = pointers[next++];
      try {
        src.lists.push({ ...p, xml: decode(await httpGet(p.url)) });
      } catch (e) {
        src.lists.push({ ...p, error: e instanceof Error ? e.message : String(e) });
      }
      onProgress?.(++done, pointers.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const cache = await buildTrustedLists(src, opts);
  if (!cache.services.length) throw new Error('No trusted list could be downloaded and verified.');
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
    verified: cache.verified,
    find: (subjectHex, kind, at = new Date()) => (map.get(subjectHex) ?? []).filter((x) => x.kind === kind && grantedAt(x.service, at)),
  };
}
