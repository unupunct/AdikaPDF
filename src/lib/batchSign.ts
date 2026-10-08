/**
 * Signing many PDF files with one identity. Each file is prepared
 * (placeholder + signed attributes), the signatures are made by the signer
 * (one PIN / authorization for the whole batch, or one per group of files for
 * remote signing), then each file is finished (CMS, timestamp, validation
 * data) and written. Files that cannot be signed are skipped with a reason.
 */
import { addDocumentTimestamp, inspectForSigning, prepareSignature, type ExternalSigner, type PreparedSignature, type SignerCertificates } from './crypto/digitalSignature';
import { isPdfEncrypted } from './crypto/encrypt';
import { BatchSkip, outputPath } from './batch';
import { displayToPdfMatrix, normalizeRotation, transformRectBounds } from './geometry';

/** Signs prepared signatures; `groupSize` files share one call (and one authorization). */
export interface BatchSigner extends SignerCertificates {
  groupSize: number;
  /** Signatures over each DER signed-attributes SET, in the same order. */
  signAll(signedAttrs: Uint8Array[]): Promise<Uint8Array[]>;
  /** Ends the session (token login, held PIN). Called once, also after cancel or errors. */
  close?(): Promise<void>;
}

/** A signer that signs one file at a time (.pfx identity, Windows certificate store). */
export function oneByOne(signer: ExternalSigner, close?: () => Promise<void>): BatchSigner {
  return {
    certificate: signer.certificate,
    chain: signer.chain,
    keyAlgorithm: signer.keyAlgorithm,
    rsaPss: signer.rsaPss,
    groupSize: 1,
    signAll: async (items) => {
      const out: Uint8Array[] = [];
      for (const d of items) out.push(await signer.sign(d));
      return out;
    },
    close,
  };
}

/** The native token session (PKCS#11), injected so tests can count logins. */
export interface TokenSessionApi {
  open(args: { module: string; slotId: number; certIdHex: string; pin: string | null }): Promise<{ handle: number; alwaysAuthenticate: boolean }>;
  sign(handle: number, data: Uint8Array): Promise<Uint8Array>;
  close(handle: number): Promise<void>;
}

/**
 * Logs in to the token once for the whole batch. Keys that demand the PIN
 * for every signature (CKA_ALWAYS_AUTHENTICATE) get it from the native
 * session, which holds it until close.
 */
export async function tokenBatchSigner(
  api: TokenSessionApi,
  token: { module: string; slotId: number; certIdHex: string; pin: string | null },
  certs: SignerCertificates,
): Promise<BatchSigner & { alwaysAuthenticate: boolean }> {
  const { handle, alwaysAuthenticate } = await api.open(token);
  let closed = false;
  return {
    ...certs,
    alwaysAuthenticate,
    groupSize: 1,
    signAll: async (items) => {
      const out: Uint8Array[] = [];
      for (const d of items) out.push(await api.sign(handle, d));
      return out;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await api.close(handle);
    },
  };
}

export type SignCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface BatchAppearance {
  visible: boolean;
  /** 'first', 'last' or a page number (1-based). */
  page: 'first' | 'last' | number;
  corner: SignCorner;
  /** Distance from the corner, in points. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  /** Sign into the empty signature field with this name when the file has one (otherwise as above). */
  fieldName?: string;
}

export type BatchOutput = { mode: 'suffix'; suffix: string } | { mode: 'folder'; folder: string; suffix: string } | { mode: 'replace' };

export interface BatchSignOptions {
  reason: string;
  location: string;
  contactInfo: string;
  tsaUrl: string | null;
  pades: boolean;
  /** Certify files that are not signed yet (1 no changes, 2 forms and signing, 3 also comments). */
  certify: 0 | 1 | 2 | 3;
  ltv: boolean;
  archive: boolean;
  appearance: BatchAppearance;
  output: BatchOutput;
}

export interface BatchSignIo {
  read(path: string): Promise<Uint8Array>;
  /** Writes the whole file (the app writes a temp file and renames it). */
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** PNG of the visible signature (app: the signature badge). */
  badge?(size: { width: number; height: number }, when: Date): Promise<Uint8Array>;
  /** Long-term validation data (chain, OCSP / CRL answers). */
  ltv?(bytes: Uint8Array): Promise<{ bytes: Uint8Array; complete: boolean; notes: string[] }>;
}

export interface BatchSignResult {
  input: string;
  status: 'done' | 'skipped' | 'failed';
  output?: string;
  message?: string;
}

export interface BatchSignHooks {
  onProgress?(done: number, total: number, current: string): void;
  onResult?(result: BatchSignResult, index: number): void;
  /** Checked between files: the current file is finished, the rest are skipped. */
  cancelled?(): boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The PAdES level the options aim for (null for the classic format). */
export function targetLevel(o: Pick<BatchSignOptions, 'pades' | 'tsaUrl' | 'ltv' | 'archive'>): 'B-B' | 'B-T' | 'B-LT' | 'B-LTA' | null {
  if (!o.pades) return null;
  if (!o.tsaUrl) return 'B-B';
  if (!o.ltv) return 'B-T';
  return o.archive ? 'B-LTA' : 'B-LT';
}

type Inspection = Awaited<ReturnType<typeof inspectForSigning>>;

/** Page and rectangle (PDF user space) of the signature in one file. */
export function placementIn(insp: Inspection, ap: BatchAppearance): { pageIndex: number; rect: [number, number, number, number]; intoField?: string } {
  const field = ap.fieldName ? insp.emptyFields.find((f) => f.name === ap.fieldName) : undefined;
  if (field) return { pageIndex: field.pageIndex, rect: field.rect, intoField: field.name };
  const n = insp.pageCount;
  const pageIndex = ap.page === 'first' ? 0 : ap.page === 'last' ? n - 1 : ap.page - 1;
  if (!ap.visible) return { pageIndex: 0, rect: [0, 0, 0, 0] };
  if (pageIndex < 0 || pageIndex >= n) throw new BatchSkip(`has no page ${ap.page} (${n} page${n === 1 ? '' : 's'})`);
  const box = insp.pages[pageIndex];
  const rotation = normalizeRotation(box.rotation);
  const disp = rotation % 180 === 0 ? { w: box.width, h: box.height } : { w: box.height, h: box.width };
  const x = ap.corner.endsWith('right') ? disp.w - ap.width - ap.offsetX : ap.offsetX;
  const y = ap.corner.startsWith('bottom') ? disp.h - ap.height - ap.offsetY : ap.offsetY;
  const b = transformRectBounds(displayToPdfMatrix(rotation, box), { x, y, width: ap.width, height: ap.height });
  return { pageIndex, rect: [b.x, b.y, b.x + b.width, b.y + b.height] };
}

async function targetPath(input: string, out: BatchOutput, exists: (p: string) => Promise<boolean>): Promise<string> {
  if (out.mode === 'replace') return input;
  if (out.mode === 'suffix') {
    if (!out.suffix.trim()) throw new Error('A suffix is needed to save next to the originals.');
    return outputPath(input, out.suffix, exists);
  }
  const sep = out.folder.includes('\\') || !out.folder.includes('/') ? '\\' : '/';
  return outputPath(`${out.folder.replace(/[\\/]+$/, '')}${sep}${baseName(input)}`, out.suffix, exists);
}

interface Pending {
  index: number;
  input: string;
  prepared: PreparedSignature;
  notes: string[];
}

/**
 * Signs every file in `inputs`. Results arrive through `onResult` as they are
 * known and are returned in input order. The signer is closed at the end.
 */
export async function runBatchSign(inputs: string[], signer: BatchSigner, opts: BatchSignOptions, io: BatchSignIo, hooks: BatchSignHooks = {}): Promise<BatchSignResult[]> {
  const results: BatchSignResult[] = new Array(inputs.length);
  const record = (index: number, r: BatchSignResult) => {
    results[index] = r;
    hooks.onResult?.(r, index);
  };
  const cancelled = () => hooks.cancelled?.() ?? false;
  const level = targetLevel(opts);
  let pending: Pending[] = [];
  let stopped: string | null = null;

  const finishOne = async (p: Pending, signature: Uint8Array) => {
    let bytes = await p.prepared.finish(signature);
    if (opts.ltv && io.ltv) {
      try {
        const r = await io.ltv(bytes);
        bytes = r.bytes;
        if (!r.complete) p.notes.push(`validation data incomplete: ${r.notes.join(' ')}`);
        if (opts.archive && opts.tsaUrl) {
          try {
            bytes = await addDocumentTimestamp(bytes, { tsaUrl: opts.tsaUrl, fetchImpl: io.fetchImpl });
          } catch (e) {
            p.notes.push(`archive timestamp not added: ${message(e)}`);
          }
        }
      } catch (e) {
        p.notes.push(`validation data not added: ${message(e)}`);
      }
    }
    const output = await targetPath(p.input, opts.output, io.exists);
    await io.write(output, bytes);
    record(p.index, { input: p.input, status: 'done', output, message: [level ? `PAdES ${level}` : '', ...p.notes].filter(Boolean).join('; ') || undefined });
  };

  const flush = async () => {
    const group = pending;
    pending = [];
    if (!group.length) return;
    // A group still waiting for its (remote) authorization is dropped on cancel.
    if (group.length > 1 && cancelled()) {
      for (const p of group) record(p.index, { input: p.input, status: 'skipped', message: 'cancelled' });
      return;
    }
    let signatures: Uint8Array[];
    try {
      signatures = await signer.signAll(group.map((p) => p.prepared.signedAttributes));
      if (signatures.length !== group.length) throw new Error('The signer returned the wrong number of signatures.');
    } catch (e) {
      // PIN, token or service problems repeat for every file: stop the batch.
      stopped = message(e);
      for (const p of group) record(p.index, { input: p.input, status: 'failed', message: stopped });
      return;
    }
    for (let i = 0; i < group.length; i++) {
      try {
        await finishOne(group[i], signatures[i]);
      } catch (e) {
        record(group[i].index, { input: group[i].input, status: 'failed', message: message(e) });
      }
    }
  };

  try {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (stopped) {
        record(i, { input, status: 'skipped', message: 'not signed: signing stopped after the error above' });
        continue;
      }
      if (cancelled()) {
        record(i, { input, status: 'skipped', message: 'cancelled' });
        continue;
      }
      hooks.onProgress?.(i, inputs.length, baseName(input));
      try {
        const bytes = await io.read(input);
        if (isPdfEncrypted(bytes)) throw new BatchSkip('password-protected: open it, remove the password and sign it on its own');
        const insp = await inspectForSigning(bytes);
        if (insp.certification === 1) throw new BatchSkip('certified with “no changes allowed”: another signature would break it');
        const notes: string[] = [];
        const certify = opts.certify && insp.signatureCount === 0 ? opts.certify : undefined;
        if (opts.certify && insp.signatureCount > 0) notes.push('already signed: added as an approval signature');
        else if (insp.signatureCount > 0) notes.push('added after the existing signatures');
        const place = placementIn(insp, opts.appearance);
        if (opts.appearance.fieldName && !place.intoField) notes.push(`no empty field “${opts.appearance.fieldName}”`);
        const when = new Date();
        const w = place.rect[2] - place.rect[0];
        const h = place.rect[3] - place.rect[1];
        const appearancePng = w > 0 && h > 0 && io.badge ? await io.badge({ width: w, height: h }, when) : undefined;
        const prepared = await prepareSignature(bytes, {
          signer,
          pageIndex: place.pageIndex,
          rect: place.rect,
          intoField: place.intoField,
          appearancePng,
          reason: opts.reason || undefined,
          location: opts.location || undefined,
          contactInfo: opts.contactInfo || undefined,
          signingTime: when,
          tsaUrl: opts.tsaUrl,
          fetchImpl: io.fetchImpl,
          allowInvalidatingExisting: false,
          certify,
          pades: opts.pades,
        });
        pending.push({ index: i, input, prepared, notes });
      } catch (e) {
        record(i, { input, status: e instanceof BatchSkip ? 'skipped' : 'failed', message: message(e) });
      }
      if (pending.length >= Math.max(1, signer.groupSize)) await flush();
    }
    await flush();
  } finally {
    await signer.close?.().catch(() => undefined);
  }
  hooks.onProgress?.(inputs.length, inputs.length, '');
  return results;
}

/** The result list as CSV (UTF-8 with BOM, so Excel shows the diacritics). */
export function resultsCsv(results: BatchSignResult[]): string {
  const q = (s: string) => (/[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [['File', 'Status', 'Output', 'Details'], ...results.map((r) => [r.input, r.status, r.output ?? '', r.message ?? ''])];
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
