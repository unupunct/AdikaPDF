/**
 * XML signatures (XMLDSig) as the EU trusted lists use them: an enveloped
 * signature over the whole document (plus XAdES signed properties), Exclusive
 * or Inclusive Canonical XML 1.0 / 1.1, RSA (PKCS#1 v1.5 or PSS) and ECDSA
 * with SHA-256/384/512. The signature value goes through the app's strict
 * Web Crypto verifier (`verifyRawSignature`).
 *
 * The canonicaliser works on lib/xml.ts trees parsed with `infoset` (line
 * ends, attribute white space, comments and PIs as an XML processor reports
 * them). DTDs are not processed, so documents with a DOCTYPE are refused.
 */
import { isEl, kids, localName, parseXmlDoc, prefixOf, textOf, type XEl } from '@/lib/xml';
import { verifyRawSignature } from './digitalSignature';

export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export const C14N_ALGS = {
  inclusive: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  inclusive11: 'http://www.w3.org/2006/12/xml-c14n11',
  exclusive: 'http://www.w3.org/2001/10/xml-exc-c14n#',
} as const;

export interface C14nOptions {
  exclusive?: boolean;
  /** Canonical XML 1.1 (xml:base is not inherited onto the apex). */
  version11?: boolean;
  comments?: boolean;
  /** Exclusive C14N InclusiveNamespaces PrefixList ('#default' for the default namespace). */
  inclusivePrefixes?: string[];
  /** A subtree left out (the enveloped signature). */
  omit?: XEl | null;
}

export interface XmlTree {
  doc: XEl;
  parent: Map<XEl, XEl>;
}

/** Parses for canonicalisation; every element knows its parent. */
export function parseXmlTree(xml: string): XmlTree {
  const doc = parseXmlDoc(xml, { infoset: true });
  const parent = new Map<XEl, XEl>();
  const stack: XEl[] = [doc];
  while (stack.length) {
    const e = stack.pop()!;
    for (const c of e.children) {
      if (!isEl(c)) continue;
      parent.set(c, e);
      stack.push(c);
    }
  }
  return { doc, parent };
}

function declare(scope: Map<string, string>, e: XEl): void {
  for (const [k, v] of e.attrs) {
    if (k === 'xmlns') scope.set('', v);
    else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v);
  }
}

/** Namespaces in scope at `e` (prefix '' is the default namespace). */
export function scopeOf(t: XmlTree, e: XEl): Map<string, string> {
  const chain: XEl[] = [];
  for (let c: XEl | undefined = e; c && c !== t.doc; c = t.parent.get(c)) chain.unshift(c);
  const scope = new Map<string, string>();
  for (const c of chain) declare(scope, c);
  return scope;
}

/** Namespace URI of an element. */
export function nsOf(t: XmlTree, e: XEl): string {
  const p = prefixOf(e.name);
  return p === 'xml' ? XML_NS : (scopeOf(t, e).get(p) ?? '');
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical XML of a document (`t.doc`) or of an element subtree, in its document context. */
export function canonicalize(t: XmlTree, node: XEl, o: C14nOptions = {}): string {
  const out: string[] = [];
  const special = (e: XEl): boolean => {
    if (e.name === '#comment') {
      if (o.comments) out.push('<!--', textOf(e), '-->');
      return true;
    }
    if (e.name === '#pi') {
      const data = textOf(e);
      out.push('<?', e.attrs[0]?.[0] ?? '', data ? ` ${data}` : '', '?>');
      return true;
    }
    return false;
  };
  const inclusive = new Set((o.inclusivePrefixes ?? []).map((p) => (p === '#default' ? '' : p)));

  const element = (e: XEl, scope: Map<string, string>, rendered: Map<string, string>, apex: boolean) => {
    if (e === o.omit || special(e)) return;
    const local = new Map(scope);
    declare(local, e);
    const attrs = e.attrs.filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:'));
    if (apex && !o.exclusive) {
      // xml:* attributes of ancestors outside the subset are inherited by its apex.
      const names = o.version11 ? ['xml:lang', 'xml:space'] : ['xml:lang', 'xml:space', 'xml:base'];
      for (let a = t.parent.get(e); a && a !== t.doc; a = t.parent.get(a)) {
        for (const [k, v] of a.attrs) if (names.includes(k) && !attrs.some(([x]) => x === k)) attrs.push([k, v]);
      }
    }
    let want: Iterable<string>;
    if (o.exclusive) {
      const used = new Set<string>([prefixOf(e.name)]);
      for (const [k] of attrs) {
        const p = prefixOf(k);
        if (p && p !== 'xml') used.add(p);
      }
      for (const p of inclusive) if (local.has(p)) used.add(p);
      want = used;
    } else want = local.keys();
    const decls: Array<[string, string]> = [];
    const next = new Map(rendered);
    for (const p of want) {
      if (p === 'xml') continue;
      const uri = local.get(p);
      if (p === '') {
        const had = rendered.get('') ?? '';
        if ((uri ?? '') !== had) {
          decls.push(['', uri ?? '']);
          next.set('', uri ?? '');
        }
        continue;
      }
      if (uri === undefined) throw new Error(`Unbound namespace prefix "${p}".`);
      if (rendered.get(p) !== uri) {
        decls.push([p, uri]);
        next.set(p, uri);
      }
    }
    decls.sort((a, b) => byKey(a[0], b[0]));
    const uriOf = (k: string) => {
      const p = prefixOf(k);
      if (!p) return '';
      if (p === 'xml') return XML_NS;
      const u = local.get(p);
      if (u === undefined) throw new Error(`Unbound namespace prefix "${p}".`);
      return u;
    };
    const sorted = attrs.map(([k, v]) => ({ k, v, ns: uriOf(k), l: localName(k) })).sort((a, b) => byKey(a.ns, b.ns) || byKey(a.l, b.l));
    out.push('<', e.name);
    for (const [p, uri] of decls) out.push(p ? ` xmlns:${p}="` : ' xmlns="', escAttr(uri), '"');
    for (const a of sorted) out.push(' ', a.k, '="', escAttr(a.v), '"');
    out.push('>');
    for (const c of e.children) {
      if (typeof c === 'string') out.push(escText(c));
      else element(c, local, next, false);
    }
    out.push('</', e.name, '>');
  };

  if (node === t.doc) {
    let afterRoot = false;
    for (const c of node.children) {
      if (!isEl(c) || c === o.omit) continue;
      if (c.name === '#comment' || c.name === '#pi') {
        if (c.name === '#comment' && !o.comments) continue;
        if (afterRoot) out.push('\n');
        special(c);
        if (!afterRoot) out.push('\n');
      } else {
        element(c, new Map(), new Map(), true);
        afterRoot = true;
      }
    }
  } else {
    const parent = t.parent.get(node);
    element(node, parent ? scopeOf(t, parent) : new Map(), new Map(), true);
  }
  return out.join('');
}

// ---------------------------------------------------------------- verification

const DIGESTS: Record<string, string> = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'SHA-256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'SHA-384',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'SHA-512',
};
const HASH_OIDS: Record<string, string> = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
};
const SIGNATURES: Record<string, { oid: string; pss?: string }> = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': { oid: '1.2.840.113549.1.1.11' },
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': { oid: '1.2.840.113549.1.1.12' },
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': { oid: '1.2.840.113549.1.1.13' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': { oid: '1.2.840.10045.4.3.2' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384': { oid: '1.2.840.10045.4.3.3' },
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512': { oid: '1.2.840.10045.4.3.4' },
  'http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1': { oid: '1.2.840.113549.1.1.10', pss: HASH_OIDS['SHA-256'] },
  'http://www.w3.org/2007/05/xmldsig-more#sha384-rsa-MGF1': { oid: '1.2.840.113549.1.1.10', pss: HASH_OIDS['SHA-384'] },
  'http://www.w3.org/2007/05/xmldsig-more#sha512-rsa-MGF1': { oid: '1.2.840.113549.1.1.10', pss: HASH_OIDS['SHA-512'] },
};

/** Canonicalisation options for an algorithm URI (null: not supported). */
export function c14nOptionsFor(alg: string, method?: XEl): C14nOptions | null {
  const comments = alg.endsWith('#WithComments');
  const base = comments ? alg.slice(0, -'#WithComments'.length) : alg;
  if (base === C14N_ALGS.inclusive) return { comments };
  if (base === C14N_ALGS.inclusive11) return { comments, version11: true };
  if (base === C14N_ALGS.exclusive || base === C14N_ALGS.exclusive.slice(0, -1)) {
    const list = kids(method).find((k) => localName(k.name) === 'InclusiveNamespaces');
    const prefixes = list?.attrs.find(([k]) => k === 'PrefixList')?.[1].trim();
    return { comments, exclusive: true, inclusivePrefixes: prefixes ? prefixes.split(/\s+/) : [] };
  }
  return null;
}

export function base64Bytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Who may have signed: certificates, or SHA-256 fingerprints of certificates the signature carries in KeyInfo. */
export interface XmlSigners {
  certs?: Uint8Array[];
  sha256?: string[];
}

export interface XmlSignatureCheck {
  ok: boolean;
  error?: string;
  /** The certificate the signature verified with (DER). */
  signer?: Uint8Array;
  /** The signature is intact but made with a certificate that is not authorised. */
  unauthorised?: boolean;
  /** The certificate in KeyInfo (also when it is not authorised). */
  keyInfoCert?: Uint8Array;
  /** The signed document: the canonical form of the whole-document reference (without the signature). */
  signedXml?: string;
  /** XAdES SigningTime, when present. */
  signingTime?: string;
}

/**
 * Verifies the enveloped signature of a whole document: one ds:Signature
 * child of the document element, a reference to the whole document
 * (URI="" with the enveloped transform) and every other reference (same-
 * document "#id"), and the signature value with an authorised certificate.
 */
export async function verifyEnvelopedSignature(xml: string, signers: XmlSigners): Promise<XmlSignatureCheck> {
  try {
    return await verify(xml, signers);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function verify(xml: string, signers: XmlSigners): Promise<XmlSignatureCheck> {
  if (/<!DOCTYPE/i.test(xml)) return { ok: false, error: 'The document has a DOCTYPE (not allowed in a signed list).' };
  const t = parseXmlTree(xml);
  const tops = t.doc.children.filter((c): c is XEl => isEl(c) && c.name !== '#comment' && c.name !== '#pi');
  if (tops.length !== 1) return { ok: false, error: 'The document must have exactly one root element.' };
  const root = tops[0];
  const isDs = (e: XEl, local: string) => localName(e.name) === local && nsOf(t, e) === DSIG_NS;
  const dsKids = (e: XEl | undefined, local: string) => kids(e).filter((k) => isDs(k, local));
  const sigs = dsKids(root, 'Signature');
  if (!sigs.length) return { ok: false, error: 'The document is not signed.' };
  if (sigs.length > 1) return { ok: false, error: 'The document has more than one signature.' };
  const sig = sigs[0];
  const [signedInfo] = dsKids(sig, 'SignedInfo');
  const [sigValueEl] = dsKids(sig, 'SignatureValue');
  if (!signedInfo || !sigValueEl) return { ok: false, error: 'The signature is incomplete.' };
  const [c14nEl] = dsKids(signedInfo, 'CanonicalizationMethod');
  const [methodEl] = dsKids(signedInfo, 'SignatureMethod');
  const alg = (e: XEl | undefined) => e?.attrs.find(([k]) => k === 'Algorithm')?.[1] ?? '';
  const siOpts = c14nOptionsFor(alg(c14nEl), c14nEl);
  if (!siOpts) return { ok: false, error: `Unsupported canonicalisation ${alg(c14nEl)}.` };
  const method = SIGNATURES[alg(methodEl)];
  if (!method) return { ok: false, error: `Unsupported signature algorithm ${alg(methodEl) || '(none)'}.` };

  // Elements by Id, for same-document references (an Id used twice is refused).
  const ids = new Map<string, XEl | null>();
  const collect = (e: XEl) => {
    for (const [k, v] of e.attrs) if (k === 'Id' || k === 'ID' || k === 'id') ids.set(v, ids.has(v) ? null : e);
    for (const c of kids(e)) collect(c);
  };
  collect(root);

  let signedXml: string | undefined;
  const refs = dsKids(signedInfo, 'Reference');
  if (!refs.length) return { ok: false, error: 'The signature has no references.' };
  for (const ref of refs) {
    const uri = ref.attrs.find(([k]) => k === 'URI')?.[1];
    const transforms = dsKids(dsKids(ref, 'Transforms')[0], 'Transform');
    const [dm] = dsKids(ref, 'DigestMethod');
    const hash = DIGESTS[alg(dm)];
    if (!hash) return { ok: false, error: `Unsupported digest algorithm ${alg(dm) || '(none)'}.` };
    let target: XEl;
    let opts: C14nOptions = {};
    let enveloped = false;
    let c14n = false;
    if (uri === '') target = t.doc;
    else if (uri?.startsWith('#')) {
      const hit = ids.get(uri.slice(1));
      if (!hit) return { ok: false, error: `Reference ${uri} not found or not unique.` };
      target = hit;
    } else return { ok: false, error: `Unsupported reference "${uri ?? ''}".` };
    for (const tr of transforms) {
      const a = alg(tr);
      if (a === ENVELOPED && !c14n) enveloped = true;
      else {
        const co = c14nOptionsFor(a, tr);
        if (!co || c14n) return { ok: false, error: `Unsupported transform ${a}.` };
        opts = co;
        c14n = true;
      }
    }
    // Same-document references never include comments.
    opts = { ...opts, comments: false, omit: enveloped ? sig : null };
    const canon = canonicalize(t, target, opts);
    const digest = new Uint8Array(await crypto.subtle.digest(hash, new TextEncoder().encode(canon) as BufferSource));
    const [dv] = dsKids(ref, 'DigestValue');
    if (!dv || !sameBytes(digest, base64Bytes(textOf(dv)))) {
      return { ok: false, error: uri === '' ? 'The list was changed after it was signed.' : `The signed properties (${uri}) were changed.` };
    }
    if (uri === '' && enveloped) signedXml = canon;
  }
  if (signedXml === undefined) return { ok: false, error: 'The signature does not cover the whole document.' };

  const signed = new TextEncoder().encode(canonicalize(t, signedInfo, siOpts));
  const value = base64Bytes(textOf(sigValueEl));
  const [keyInfo] = dsKids(sig, 'KeyInfo');
  const keyInfoCerts = keyInfo
    ? (function find(e: XEl): XEl[] {
        return kids(e).flatMap((k) => (isDs(k, 'X509Certificate') ? [k] : find(k)));
      })(keyInfo).map((e) => base64Bytes(textOf(e)))
    : [];
  const pins = new Set((signers.sha256 ?? []).map((h) => h.toLowerCase()));
  const candidates = [...(signers.certs ?? [])];
  for (const c of keyInfoCerts) if (pins.has(await sha256Hex(c)) && !candidates.some((x) => sameBytes(x, c))) candidates.push(c);
  const signingTime = (function find(e: XEl): string | undefined {
    for (const k of kids(e)) {
      if (localName(k.name) === 'SigningTime') return textOf(k).trim();
      const r = find(k);
      if (r) return r;
    }
    return undefined;
  })(sig);
  for (const c of candidates) {
    if (await verifyRawSignature(c, method.oid, signed, value, method.pss)) return { ok: true, signer: c, keyInfoCert: keyInfoCerts[0], signedXml, signingTime };
  }
  for (const c of keyInfoCerts) {
    if (await verifyRawSignature(c, method.oid, signed, value, method.pss)) {
      return { ok: false, unauthorised: true, keyInfoCert: c, error: 'The list is signed by a certificate that is not authorised to sign it.' };
    }
  }
  return { ok: false, keyInfoCert: keyInfoCerts[0], error: 'The signature value is not valid.' };
}
