/**
 * Remote (cloud) qualified signatures through the Cloud Signature Consortium
 * API: one client per provider, kept in memory with its sign-in tokens for
 * this session; sign-in opens the system browser and waits on a loopback
 * redirect; signing goes through the common external-signer path.
 */
import { CscClient, checkRedirectUri, type CscAuthorizer, type CscCredential, type CscProvider, type CscSecrets } from '@/lib/crypto/csc';
import { apiRequest, oauthLoopbackCancel, oauthLoopbackStart, oauthLoopbackWait, openExternal } from '@/lib/platform';
import { usePDFStore } from '@/store/usePDFStore';
import { signWithExternalSigner, type SignMeta, type SignPlacement } from './sign';

const clients = new Map<string, CscClient>();
let waiting: number | null = null;

const browserAuthorizer: CscAuthorizer = async (buildUrl, fixed) => {
  const target = fixed ? checkRedirectUri(fixed) : { port: 0, path: '/callback' };
  const { id, port } = await oauthLoopbackStart(target.port, target.path);
  waiting = id;
  try {
    const redirectUri = fixed ?? `http://127.0.0.1:${port}/callback`;
    await openExternal(buildUrl(redirectUri));
    const r = await oauthLoopbackWait(id, 300);
    return { redirectUri, result: { code: r.code ?? undefined, state: r.state ?? undefined, error: r.error ?? undefined, errorDescription: r.errorDescription ?? undefined } };
  } finally {
    if (waiting === id) waiting = null;
  }
};

/** Stops waiting for the browser (the sign-in or signature then fails as cancelled). */
export function cancelBrowserWait(): void {
  if (waiting !== null) void oauthLoopbackCancel(waiting);
}

/** The session's client for a provider (a changed configuration starts a new session). */
export function cscClient(provider: CscProvider): CscClient {
  const existing = clients.get(provider.id);
  if (existing && JSON.stringify(existing.provider) === JSON.stringify(provider)) return existing;
  const client = new CscClient(provider, { transport: apiRequest, authorize: browserAuthorizer });
  clients.set(provider.id, client);
  return client;
}

/** Signs out and forgets the provider's tokens. */
export async function signOutProvider(id: string): Promise<void> {
  const c = clients.get(id);
  clients.delete(id);
  await c?.signOut();
}

export async function signWithCloud(
  client: CscClient,
  credential: CscCredential,
  secrets: CscSecrets,
  placement: SignPlacement,
  meta: SignMeta,
  inkSrc: string | null,
  consumeId: string | null = null,
): Promise<void> {
  const signer = client.signer(credential, secrets, (mode) => {
    if (mode === 'oauth2code') usePDFStore.getState().toast('Confirm the signature in the browser window that opened.', 'info');
  });
  await signWithExternalSigner(signer, placement, meta, inkSrc, consumeId, cancelBrowserWait);
}
