/**
 * Sign → Sign many files: one identity (.pfx, Windows certificate, token,
 * cloud signature) applied to many PDFs with one PIN / authorization.
 */
import { identityFromCertificateDer, signerFromIdentity, addValidationData, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import { oneByOne, resultsCsv, runBatchSign, tokenBatchSigner, type BatchSignOptions, type BatchSignResult, type BatchSigner } from '@/lib/batchSign';
import type { CscClient, CscCredential, CscSecrets } from '@/lib/crypto/csc';
import { base64ToBytes, fileStamp, httpGet, httpPost, isDesktop, listDir, pkcs11CloseSession, pkcs11OpenSession, pkcs11SessionSign, readFile, winstoreSign, writeFile, type StoreCertificate, type TokenCertificate } from '@/lib/platform';
import { cnOf, issuerChain, nativeFetch, renderSignatureBadge, trustedRoots } from './sign';
import { saveFileQuiet } from './saveGuard';

export type BatchIdentity =
  | { kind: 'pfx'; identity: SigningIdentity }
  | { kind: 'store'; cert: StoreCertificate }
  | { kind: 'token'; module: string; slotId: number; certificate: TokenCertificate; pin: string | null }
  | { kind: 'cloud'; client: CscClient; credential: CscCredential; secrets: CscSecrets; moreSecrets: (round: number) => Promise<CscSecrets | null> };

/** PDF files in a folder (and its subfolders), sorted by path. */
export async function collectPdfs(folder: string, subfolders: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const e of await listDir(dir)) {
      if (e.isDir) {
        if (subfolders && depth < 32) await walk(e.path, depth + 1);
      } else if (/\.pdf$/i.test(e.name)) out.push(e.path);
    }
  };
  await walk(folder, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

function certSigner(derBase64: string, unsupported: string) {
  const info = identityFromCertificateDer(base64ToBytes(derBase64));
  if (info.keyAlgorithm !== 'rsa' && info.keyAlgorithm !== 'ecdsa') throw new Error(unsupported);
  return info;
}

/** The signer for the batch; for a token this logs in (once). */
export async function openBatchSigner(id: BatchIdentity, onAuthorize?: (message: string) => void): Promise<{ signer: BatchSigner; name: string; issuer: string; note?: string }> {
  switch (id.kind) {
    case 'pfx':
      return { signer: oneByOne(signerFromIdentity(id.identity)), name: id.identity.name, issuer: id.identity.selfSigned ? 'Self-signed' : cnOf(id.identity.issuer) };
    case 'store': {
      const info = certSigner(id.cert.derBase64, 'The certificate uses an unsupported key type.');
      const signer = oneByOne({ certificate: info.certificate, chain: await issuerChain(info.certificate), keyAlgorithm: info.keyAlgorithm, sign: (data) => winstoreSign(id.cert.thumbprint, data) });
      return { signer, name: info.name, issuer: cnOf(info.issuer) };
    }
    case 'token': {
      const info = certSigner(id.certificate.derBase64, 'The token certificate uses an unsupported key type.');
      const api = { open: pkcs11OpenSession, sign: pkcs11SessionSign, close: pkcs11CloseSession };
      const signer = await tokenBatchSigner(api, { module: id.module, slotId: id.slotId, certIdHex: id.certificate.idHex, pin: id.pin }, { certificate: info.certificate, chain: [], keyAlgorithm: info.keyAlgorithm });
      return {
        signer,
        name: info.name,
        issuer: cnOf(info.issuer),
        note: signer.alwaysAuthenticate ? 'This key asks for the PIN for every signature: Adika gives the token the PIN you entered for each file and forgets it when the batch ends.' : undefined,
      };
    }
    case 'cloud': {
      const s = id.client.batchSigner(id.credential, id.secrets, id.moreSecrets, (mode, n) => {
        if (mode === 'oauth2code') onAuthorize?.(`Confirm ${n} signature(s) in the browser window that opened.`);
      });
      const chain = s.chain.length ? s.chain : await issuerChain(s.certificate);
      const subject = s.certificate.subject.getField('CN')?.value as string | undefined;
      const issuer = s.certificate.issuer.getField('CN')?.value as string | undefined;
      return { signer: { ...s, chain }, name: subject ?? 'Signer', issuer: issuer ?? '' };
    }
  }
}

export async function signFiles(
  paths: string[],
  signer: BatchSigner,
  display: { name: string; issuer: string },
  opts: BatchSignOptions,
  inkSrc: string | null,
  hooks: { onProgress: (done: number, total: number, current: string) => void; onResult: (r: BatchSignResult, index: number) => void; cancelled: () => boolean },
): Promise<BatchSignResult[]> {
  return runBatchSign(
    paths,
    signer,
    opts,
    {
      read: readFile,
      // write_file writes a temporary file and renames it over the target.
      write: writeFile,
      exists: async (p) => (await fileStamp(p)) !== null,
      fetchImpl: isDesktop ? nativeFetch : undefined,
      badge: (size, when) => renderSignatureBadge({ ...size, signerName: display.name, when, reason: opts.reason, issuer: display.issuer, inkSrc }),
      ltv: async (bytes) => addValidationData(bytes, { trustedRoots: await trustedRoots(), httpGet: isDesktop ? httpGet : undefined, httpPost: isDesktop ? httpPost : undefined }),
    },
    hooks,
  );
}

export async function saveResultsCsv(results: BatchSignResult[]): Promise<void> {
  await saveFileQuiet(new TextEncoder().encode(resultsCsv(results)), 'signing-results.csv', [{ name: 'CSV', extensions: ['csv'] }]);
}
