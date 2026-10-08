/**
 * Certificate-based (cryptographic) signing with a .pfx/.p12 file, a
 * self-signed ID, or a hardware token over PKCS#11; and signature
 * verification with chain building and revocation checks.
 */
import forge from 'node-forge';
import { usePDFStore } from '@/store/usePDFStore';
import { exportCurrentPdf, primarySourceBytes, refreshSignatureStatus, saveDerived, withBusy } from './document';
import {
  identityFromCertificateDer,
  signPdf,
  addDocumentTimestamp,
  addValidationData,
  certIssuedBy,
  signerFromIdentity,
  verifyPdfSignatures,
  type ExternalSigner,
  type SigningIdentity,
} from '@/lib/crypto/digitalSignature';
import { appDataRead, appDataWrite, base64ToBytes, httpGet, httpPost, isDesktop, pkcs11Sign, systemCertificates, winstoreSign, type StoreCertificate, type TokenCertificate } from '@/lib/platform';
import { downloadTrustedLists, trustIndex, type TrustedListCache } from '@/lib/crypto/euTrustedList';
import type { SignatureValidation } from '@/types';
import { PDFDocument } from 'pdf-lib';
import { displaySize, displayToPdfMatrix, normalizeRotation, transformRectBounds } from '@/lib/geometry';

export interface SignPlacement {
  pageIndex: number;
  /** Display-space rect on the page (points), or null for an invisible signature. */
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface SignMeta {
  reason: string;
  location: string;
  contactInfo: string;
  tsaUrl: string | null;
  /** Certify the document (first signature): 1 no changes, 2 forms and signing, 3 also comments. */
  certify?: 0 | 1 | 2 | 3;
  /** Store the chain and OCSP/CRL answers in the file (long-term validation; needs internet). */
  ltv?: boolean;
  /** PAdES baseline format (EU eIDAS): ETSI.CAdES.detached. */
  pades?: boolean;
  /** After the validation data, a document timestamp (PAdES B-LTA). Needs tsaUrl and ltv. */
  archive?: boolean;
}

/** The PAdES level the options produce (null for the classic format). */
export function padesLevelOf(meta: SignMeta): 'B-B' | 'B-T' | 'B-LT' | 'B-LTA' | null {
  if (!meta.pades) return null;
  if (!meta.tsaUrl) return 'B-B';
  if (!meta.ltv) return 'B-T';
  return meta.archive ? 'B-LTA' : 'B-LT';
}

/** Converts a display-space rect on page `pageIndex` of `bytes` to PDF user space. */
async function toPdfRect(bytes: Uint8Array, pageIndex: number, rect: SignPlacement['rect']): Promise<[number, number, number, number]> {
  if (!rect) return [0, 0, 0, 0];
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const box = page.getCropBox();
  const m = displayToPdfMatrix(normalizeRotation(page.getRotation().angle), box);
  const b = transformRectBounds(m, rect);
  return [b.x, b.y, b.x + b.width, b.y + b.height];
}

/** Renders the visible signature badge (the appearance of the signature widget). */
export async function renderSignatureBadge(opts: {
  width: number;
  height: number;
  signerName: string;
  when: Date;
  reason: string;
  issuer: string;
  inkSrc: string | null;
}): Promise<Uint8Array> {
  const scale = 4;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(opts.width * scale);
  canvas.height = Math.round(opts.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.scale(scale, scale);
  const w = opts.width;
  const h = opts.height;
  ctx.fillStyle = 'rgba(240,249,255,0.92)';
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 4);
  ctx.fill();
  ctx.stroke();
  // Emerald check badge.
  const r = Math.min(9, h / 5);
  ctx.fillStyle = '#059669';
  ctx.beginPath();
  ctx.arc(6 + r, 6 + r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = r / 4;
  ctx.beginPath();
  ctx.moveTo(6 + r * 0.5, 6 + r);
  ctx.lineTo(6 + r * 0.9, 6 + r * 1.4);
  ctx.lineTo(6 + r * 1.55, 6 + r * 0.6);
  ctx.stroke();
  let textLeft = 12 + r * 2;
  if (opts.inkSrc) {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = opts.inkSrc!;
    });
    const inkW = Math.min(w * 0.42, (img.naturalWidth / img.naturalHeight) * (h - 8));
    const inkH = inkW / (img.naturalWidth / img.naturalHeight);
    ctx.drawImage(img, textLeft, (h - inkH) / 2, inkW, inkH);
    textLeft += inkW + 6;
  }
  const lines = [
    { t: `Digitally signed by ${opts.signerName}`, bold: true },
    { t: opts.when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }), bold: false },
    ...(opts.reason ? [{ t: `Reason: ${opts.reason}`, bold: false }] : []),
    { t: `Issuer: ${opts.issuer}`, bold: false },
  ];
  const size = Math.max(5, Math.min(9, (h - 8) / (lines.length * 1.3)));
  ctx.fillStyle = '#0f172a';
  ctx.textBaseline = 'top';
  let y = (h - lines.length * size * 1.3) / 2;
  for (const line of lines) {
    ctx.font = `${line.bold ? '600' : '400'} ${size}px "Adika Sans", "Segoe UI", sans-serif`;
    let text = line.t;
    while (text.length > 4 && ctx.measureText(text).width > w - textLeft - 4) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, textLeft, y);
    y += size * 1.3;
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Badge rendering failed');
  return new Uint8Array(await blob.arrayBuffer());
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function signWith(
  signer: { identity: SigningIdentity } | { signer: ExternalSigner },
  display: { name: string; issuer: string },
  placement: SignPlacement,
  meta: SignMeta,
  inkSrc: string | null,
  consumeId: string | null,
  onAbort?: () => void,
): Promise<void> {
  const store = usePDFStore.getState();
  const hadSignatures = store.signatureStatus.length > 0;
  if (hadSignatures && store.dirty) {
    throw new Error(
      'This PDF already carries digital signatures and has unsaved edits. Editing a signed PDF invalidates its signatures; save a copy first if that is intended.',
    );
  }
  const run = async (progress: (msg: string, fraction: number | null) => void) => {
    const bytes = hadSignatures && !store.dirty ? primarySourceBytes()! : await exportCurrentPdf({}, progress, consumeId ? [consumeId] : []);
    const when = new Date();
    const size = placement.rect ?? { width: 0, height: 0 };
    const appearancePng = placement.rect
      ? await renderSignatureBadge({ width: size.width, height: size.height, signerName: display.name, when, reason: meta.reason, issuer: display.issuer, inkSrc })
      : undefined;
    progress('Waiting for signature…', null);
    return signPdf(bytes, {
      ...signer,
      pageIndex: placement.pageIndex,
      rect: await toPdfRect(bytes, placement.pageIndex, placement.rect),
      appearancePng,
      reason: meta.reason || undefined,
      location: meta.location || undefined,
      contactInfo: meta.contactInfo || undefined,
      signingTime: when,
      tsaUrl: meta.tsaUrl,
      fetchImpl: isDesktop ? nativeFetch : undefined,
      allowInvalidatingExisting: false,
      // Only the first signature can certify (the option is hidden for signed files).
      certify: meta.certify && !hadSignatures ? meta.certify : undefined,
      pades: !!meta.pades,
    });
  };
  // Remote signing waits for the browser: that wait can be cancelled.
  const out = await withBusy(
    'Signing…',
    onAbort
      ? (progress, signal) => {
          signal.addEventListener('abort', onAbort);
          return run(progress);
        }
      : (progress) => run(progress),
  );
  if (!out) return;
  let final = out;
  if (meta.ltv) {
    const ltv = await withBusy('Adding long-term validation data…', async () => {
      try {
        return await addValidationData(out, { trustedRoots: await trustedRoots(), httpGet: isDesktop ? httpGet : undefined, httpPost: isDesktop ? httpPost : undefined });
      } catch (e) {
        store.toast(`Signed, but the validation data could not be added: ${e instanceof Error ? e.message : String(e)}`, 'info');
        return null;
      }
    });
    if (ltv) {
      final = ltv.bytes;
      if (!ltv.complete) store.toast(`Signed. Long-term validation is incomplete: ${ltv.notes.join(' ')}`, 'info');
    }
    if (ltv && meta.archive && meta.tsaUrl) {
      const tsaUrl = meta.tsaUrl;
      const stamped = await withBusy('Adding the archive timestamp…', async () => {
        try {
          return await addDocumentTimestamp(final, { tsaUrl, fetchImpl: isDesktop ? nativeFetch : undefined });
        } catch (e) {
          store.toast(`Signed, but the archive timestamp could not be added: ${e instanceof Error ? e.message : String(e)}`, 'info');
          return null;
        }
      });
      if (stamped) final = stamped;
    }
  }
  await saveDerived(final, '-signed', true);
  await refreshSignatureStatus();
}

/**
 * Verify → Add archive timestamp (PAdES B-LTA): validation data, then a
 * document timestamp over everything. Repeating it before the timestamp
 * authority's certificate expires keeps the signatures verifiable.
 */
export async function addArchiveTimestamp(tsaUrl: string): Promise<void> {
  const store = usePDFStore.getState();
  const bytes = primarySourceBytes();
  if (!bytes || !store.signatureStatus.length) return;
  if (store.dirty) {
    store.toast('Save or undo the changes first: the timestamp is added to the signed file as it is.', 'info');
    return;
  }
  const res = await withBusy('Adding the archive timestamp…', async () => {
    const opts = { trustedRoots: await trustedRoots(), httpGet: isDesktop ? httpGet : undefined, httpPost: isDesktop ? httpPost : undefined };
    const ltv = await addValidationData(bytes, opts);
    return { ...ltv, bytes: await addDocumentTimestamp(ltv.bytes, { tsaUrl, fetchImpl: isDesktop ? nativeFetch : undefined }) };
  });
  if (!res) return;
  if (!(await saveDerived(res.bytes, '-lta', true))) return;
  await refreshSignatureStatus();
  await verifyCurrentSignatures(false);
  usePDFStore.getState().toast(res.complete ? 'Archive timestamp added (PAdES B-LTA).' : `Archive timestamp added, but the validation data is incomplete: ${res.notes.join(' ')}`, res.complete ? 'success' : 'info');
}

/** Verify → Add long-term validation: stores the validation data in an already signed PDF (the signatures stay valid). */
export async function addLongTermValidation(): Promise<void> {
  const store = usePDFStore.getState();
  const bytes = primarySourceBytes();
  if (!bytes || !store.signatureStatus.length) return;
  if (store.dirty) {
    store.toast('Save or undo the changes first: validation data is added to the signed file as it is.', 'info');
    return;
  }
  const res = await withBusy('Fetching validation data…', async () =>
    addValidationData(bytes, { trustedRoots: await trustedRoots(), httpGet: isDesktop ? httpGet : undefined, httpPost: isDesktop ? httpPost : undefined }),
  );
  if (!res) return;
  if (!(await saveDerived(res.bytes, '-ltv', true))) return;
  await refreshSignatureStatus();
  usePDFStore.getState().toast(res.complete ? 'Long-term validation data added: the signatures can be verified offline, years from now.' : `Validation data added, but incomplete: ${res.notes.join(' ')}`, res.complete ? 'success' : 'info');
}


/** fetch() shim routed through the native HTTP command (no CORS for TSAs). */
const nativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body instanceof Uint8Array ? init.body : init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : new Uint8Array(0);
  const headers = new Headers(init?.headers);
  const bytes = (init?.method ?? 'GET').toUpperCase() === 'POST' ? await httpPost(url, headers.get('content-type') ?? 'application/octet-stream', body) : await httpGet(url);
  return new Response(bytes.slice().buffer, { status: 200 });
};

export async function signWithIdentity(identity: SigningIdentity, placement: SignPlacement, meta: SignMeta, inkSrc: string | null, consumeId: string | null = null): Promise<void> {
  await signWith({ identity }, { name: identity.name, issuer: identity.selfSigned ? 'Self-signed' : cnOf(identity.issuer) }, placement, meta, inkSrc, consumeId);
}

export async function signWithToken(
  token: { module: string; slotId: number; certificate: TokenCertificate; pin: string | null },
  placement: SignPlacement,
  meta: SignMeta,
  inkSrc: string | null,
  consumeId: string | null = null,
): Promise<void> {
  const info = identityFromCertificateDer(base64ToBytes(token.certificate.derBase64));
  if (info.keyAlgorithm !== 'rsa' && info.keyAlgorithm !== 'ecdsa') throw new Error('The token certificate uses an unsupported key type.');
  const signer: ExternalSigner = {
    certificate: info.certificate,
    chain: [],
    keyAlgorithm: info.keyAlgorithm,
    sign: async (data) => {
      const res = await pkcs11Sign({ module: token.module, slotId: token.slotId, certIdHex: token.certificate.idHex, pin: token.pin, data });
      return base64ToBytes(res.signatureBase64);
    },
  };
  await signWith({ signer }, { name: info.name, issuer: cnOf(info.issuer) }, placement, meta, inkSrc, consumeId);
}

/** Signs with a certificate of the Windows certificate store (Windows asks for the PIN). */
export async function signWithStoreCert(cert: StoreCertificate, placement: SignPlacement, meta: SignMeta, inkSrc: string | null, consumeId: string | null = null): Promise<void> {
  const info = identityFromCertificateDer(base64ToBytes(cert.derBase64));
  if (info.keyAlgorithm !== 'rsa' && info.keyAlgorithm !== 'ecdsa') throw new Error('The certificate uses an unsupported key type.');
  const signer: ExternalSigner = {
    certificate: info.certificate,
    chain: await issuerChain(info.certificate),
    keyAlgorithm: info.keyAlgorithm,
    sign: (data) => winstoreSign(cert.thumbprint, data),
  };
  await signWith({ signer }, { name: info.name, issuer: cnOf(info.issuer) }, placement, meta, inkSrc, consumeId);
}

/** Signs with a key held elsewhere (remote signing service); the chain is completed from Windows when the signer has none. */
export async function signWithExternalSigner(
  signer: ExternalSigner,
  placement: SignPlacement,
  meta: SignMeta,
  inkSrc: string | null,
  consumeId: string | null = null,
  onAbort?: () => void,
): Promise<void> {
  const chain = signer.chain.length ? signer.chain : await issuerChain(signer.certificate);
  const subject = signer.certificate.subject.getField('CN')?.value as string | undefined;
  const issuer = signer.certificate.issuer.getField('CN')?.value as string | undefined;
  await signWith({ signer: { ...signer, chain } }, { name: subject ?? 'Signer', issuer: issuer ?? '' }, placement, meta, inkSrc, consumeId, onAbort);
}

/** Intermediate certificates from the Windows CA store, so verifiers can build the chain. */
async function issuerChain(leaf: forge.pki.Certificate): Promise<forge.pki.Certificate[]> {
  const certs = await systemCertificates();
  const pool: forge.pki.Certificate[] = [];
  for (const b64 of certs.intermediates) {
    try {
      pool.push(identityFromCertificateDer(base64ToBytes(b64)).certificate);
    } catch {
      /* skip */
    }
  }
  const chain: forge.pki.Certificate[] = [];
  for (let cur = leaf; chain.length < 5; ) {
    let next: forge.pki.Certificate | null = null;
    // The same strict verifier as verification (RSA and ECDSA issuers).
    for (const c of pool) {
      if (!chain.includes(c) && (await certIssuedBy(cur, c))) {
        next = c;
        break;
      }
    }
    if (!next || next.subject.hash === next.issuer.hash) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}

// ---------------------------------------------------------------- EU Trusted Lists

const TL_FILE = 'eu-trusted-lists.json';
let tlCache: TrustedListCache | null = null;
let tlIndex: ReturnType<typeof trustIndex> | null = null;

/** The downloaded EU Trusted Lists (null until downloaded once). */
export async function euTrustedLists(): Promise<TrustedListCache | null> {
  if (tlCache) return tlCache;
  try {
    const raw = await appDataRead(TL_FILE);
    tlCache = raw.length ? (JSON.parse(new TextDecoder().decode(raw)) as TrustedListCache) : null;
  } catch {
    tlCache = null; // missing or damaged: download again
  }
  return tlCache;
}

async function euTrust() {
  const cache = await euTrustedLists();
  if (!cache) return undefined;
  tlIndex ??= trustIndex(cache);
  return tlIndex;
}

/** Downloads the EU list of trusted lists and every national list, and keeps them for offline use. */
export async function updateEuTrustedLists(): Promise<TrustedListCache | null> {
  const store = usePDFStore.getState();
  const res = await withBusy('Downloading the EU Trusted Lists…', (progress) =>
    downloadTrustedLists(httpGet, (done, total) => progress(`Downloading the EU Trusted Lists (${done} / ${total})…`, total ? done / total : null)),
  );
  if (!res) return null;
  await appDataWrite(TL_FILE, new TextEncoder().encode(JSON.stringify(res)));
  tlCache = res;
  tlIndex = null;
  const failed = res.lists.filter((l) => l.error).map((l) => l.territory);
  const summary = `EU Trusted Lists updated: ${res.services.length} qualified services from ${res.lists.length - failed.length} countries.`;
  store.toast(failed.length ? `${summary} Not available: ${failed.join(', ')}.` : summary, 'success');
  return res;
}

function cnOf(dn: string): string {
  const m = /CN=([^,/]+)/.exec(dn);
  return m ? m[1].trim() : dn;
}

let rootsCache: forge.pki.Certificate[] | null = null;

async function trustedRoots(): Promise<forge.pki.Certificate[]> {
  if (rootsCache) return rootsCache;
  const certs = await systemCertificates();
  const out: forge.pki.Certificate[] = [];
  for (const b64 of certs.roots) {
    try {
      out.push(identityFromCertificateDer(base64ToBytes(b64)).certificate);
    } catch {
      /* skip certificates forge cannot parse (e.g. exotic key types) */
    }
  }
  rootsCache = out;
  return out;
}

/** Full verification (chain against the Windows trust store, OCSP/CRL online). */
export async function verifyCurrentSignatures(checkRevocation: boolean): Promise<SignatureValidation[] | undefined> {
  const bytes = primarySourceBytes();
  if (!bytes) return undefined;
  const result = await withBusy('Verifying signatures…', async () =>
    verifyPdfSignatures(bytes, {
      trustedRoots: await trustedRoots(),
      euTrust: await euTrust(),
      checkRevocation,
      httpGet: isDesktop ? httpGet : undefined,
      httpPost: isDesktop ? httpPost : undefined,
    }),
  );
  if (result) usePDFStore.getState().setSignatureStatus(result);
  return result;
}

export { signerFromIdentity, displaySize };
