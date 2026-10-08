/**
 * Remote (cloud) qualified signature: a provider's signing service through
 * the Cloud Signature Consortium API. Providers are configured by the user;
 * sign-in happens in the browser; PIN / one-time code are asked here when the
 * credential needs them and are never stored.
 */
import { useEffect, useState } from 'react';
import { Cloud, Loader2, LogIn, LogOut, Pencil, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useCscProviders } from '@/store/cscProviders';
import { Button, Callout, Dialog, Field, Input } from '@/components/ui/primitives';
import { PlacementPicker, resolvePlacement } from './PlacementPicker';
import { MetaFields, usePlacement, useSignMeta } from './DigitalSignModals';
import { cancelBrowserWait, cscClient, signOutProvider, signWithCloud } from '@/actions/cloudSign';
import { checkRedirectUri, checkServiceUrl, CscAuthError, type CscClient, type CscCredential, type CscInfo, type CscProvider } from '@/lib/crypto/csc';
import { errorMessage } from '@/actions/document';
import { isDesktop } from '@/lib/platform';
import { cn } from '@/lib/cn';

const emptyProvider = (): CscProvider => ({ id: `csc-${Date.now().toString(36)}`, name: '', baseUrl: 'https://', clientId: '', clientSecret: '', oauthUrl: '', redirectUri: '' });

function usable(c: CscCredential): boolean {
  return c.keyAlgorithm !== 'other' && c.keyEnabled && c.certStatus === 'valid' && !!c.validTo && c.validTo.getTime() > Date.now();
}

export function CloudSignModal() {
  const open = usePDFStore((s) => s.modal === 'cloudsign');
  const { providers, lastProvider, lastCredential, upsert, remove, remember } = useCscProviders();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CscProvider | null>(null);
  const [client, setClient] = useState<CscClient | null>(null);
  const [info, setInfo] = useState<CscInfo | null>(null);
  const [creds, setCreds] = useState<CscCredential[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<'signin' | 'list' | 'otp' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [meta, setMeta] = useSignMeta();
  const [placement, setPlacement] = usePlacement();
  const provider = providers.find((p) => p.id === providerId) ?? null;

  const clearSecrets = () => {
    setPin('');
    setOtp('');
    setOtpSent(false);
  };
  const close = () => {
    if (busy === 'signin') cancelBrowserWait();
    clearSecrets();
    usePDFStore.getState().openModal(null);
  };

  const fail = (e: unknown) => {
    if (e instanceof CscAuthError) setCreds(null);
    setError(errorMessage(e));
  };

  const loadCreds = async (c: CscClient) => {
    setBusy('list');
    setError(null);
    try {
      const list = await c.listCredentials();
      setCreds(list);
      setSelected((list.find((x) => x.id === lastCredential && usable(x)) ?? list.find(usable) ?? list[0])?.id ?? null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    const first = providers.find((p) => p.id === lastProvider) ?? providers[0];
    setProviderId(first?.id ?? null);
    setEditing(first ? null : emptyProvider());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !provider) {
      setClient(null);
      return;
    }
    const c = cscClient(provider);
    setClient(c);
    setInfo(c.info);
    setCreds(null);
    setSelected(null);
    clearSecrets();
    setError(null);
    if (c.signedIn) void loadCreds(c);
    else if (!c.info) void c.loadInfo().then(setInfo, fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider]);

  const signIn = async () => {
    if (!client) return;
    setBusy('signin');
    setError(null);
    try {
      await client.signIn();
      setInfo(client.info);
    } catch (e) {
      setBusy(null);
      return fail(e);
    }
    await loadCreds(client);
  };

  const cred = creds?.find((c) => c.id === selected) ?? null;
  const needsPin = !!cred?.pin && !cred.pin.optional;
  const needsOtp = !!cred?.otp && !cred.otp.optional;
  const ready = !!cred && usable(cred) && (!needsPin || pin.length > 0) && (!needsOtp || otp.length > 0) && !busy;

  const sendOtp = async () => {
    if (!client || !cred) return;
    setBusy('otp');
    setError(null);
    try {
      await client.sendOtp(cred);
      setOtpSent(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const sign = async () => {
    if (!client || !cred || !provider) return;
    const { placement: p, inkSrc, consumeId } = resolvePlacement(placement);
    const secrets = { pin: cred.pin ? pin || undefined : undefined, otp: cred.otp ? otp || undefined : undefined };
    remember(provider.id, cred.id);
    clearSecrets();
    usePDFStore.getState().openModal(null);
    await signWithCloud(client, cred, secrets, p, meta, inkSrc, consumeId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Cloud signature (remote QES)"
      description="Sign with a key kept by your trust service provider (Cloud Signature Consortium API). You sign in through your browser; the key never leaves the provider's secure device."
      width={680}
      testId="cloudsign-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="accent" disabled={!ready || !!editing} onClick={() => void sign()} data-testid="cloudsign-sign-now">
            <Cloud size={14} /> Sign and save
          </Button>
        </>
      }
    >
      {!isDesktop ? <Callout kind="warn">Cloud signatures need the Adika desktop app (the browser sign-in returns to it).</Callout> : null}
      {editing ? (
        <ProviderForm
          value={editing}
          isNew={!providers.some((p) => p.id === editing.id)}
          onCancel={providers.length ? () => setEditing(null) : undefined}
          onSave={(p) => {
            upsert(p);
            setProviderId(p.id);
            setEditing(null);
          }}
        />
      ) : (
        <>
          <Field label="Signing service">
            <div className="flex gap-2">
              <select
                aria-label="Signing service"
                className="h-8 min-w-0 flex-1 rounded-md border border-app bg-panel-2 px-2 text-[13px]"
                value={providerId ?? ''}
                onChange={(e) => setProviderId(e.target.value)}
                data-testid="cloudsign-provider"
                data-no-translate
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.baseUrl}
                  </option>
                ))}
              </select>
              <Button onClick={() => setEditing(emptyProvider())} data-testid="cloudsign-add-provider">
                <Plus size={14} /> Add provider…
              </Button>
              <Button variant="ghost" size="icon" aria-label="Edit provider" disabled={!provider} onClick={() => provider && setEditing({ ...provider })}>
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove provider"
                disabled={!provider}
                onClick={() => {
                  if (!provider) return;
                  void signOutProvider(provider.id);
                  remove(provider.id);
                  setProviderId(providers.find((p) => p.id !== provider.id)?.id ?? null);
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </Field>
          {info ? (
            <p className="-mt-2 mb-3 text-[11px] text-muted" data-no-translate>
              {`${info.name} · CSC API ${info.specs || '?'}`}
            </p>
          ) : null}
          {provider && client ? (
            <div className="mb-3 flex items-center gap-2">
              {client.signedIn && creds ? (
                <>
                  <span className="flex-1 text-xs text-muted">Signed in for this session.</span>
                  <Button variant="ghost" size="icon" aria-label="Reload credentials" onClick={() => void loadCreds(client)}>
                    <RefreshCw size={14} />
                  </Button>
                  <Button
                    onClick={() => {
                      void signOutProvider(provider.id).then(() => {
                        const c = cscClient(provider);
                        setClient(c);
                        setCreds(null);
                        setSelected(null);
                        clearSecrets();
                      });
                    }}
                  >
                    <LogOut size={14} /> Sign out
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-xs text-muted">{busy === 'signin' ? 'Finish signing in in your browser…' : 'Sign in to see your signing certificates.'}</span>
                  {busy === 'signin' ? (
                    <Button onClick={cancelBrowserWait}>Cancel sign-in</Button>
                  ) : (
                    <Button variant="primary" disabled={!!busy || !isDesktop} onClick={() => void signIn()} data-testid="cloudsign-signin">
                      <LogIn size={14} /> Sign in
                    </Button>
                  )}
                </>
              )}
            </div>
          ) : null}
          {busy === 'list' || busy === 'signin' ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> {busy === 'list' ? 'Reading your certificates…' : 'Waiting for the browser…'}
            </div>
          ) : null}
          {error ? <Callout kind="error">{error}</Callout> : null}
          {creds && creds.length === 0 ? <Callout kind="info">This account has no signing credentials.</Callout> : null}
          {creds?.length ? (
            <div className="mb-3 max-h-56 overflow-auto rounded-lg border border-app" data-testid="cloudsign-credentials">
              {creds.map((c) => (
                <CredentialRow
                  key={c.id}
                  cred={c}
                  active={c.id === selected}
                  onSelect={() => {
                    setSelected(c.id);
                    clearSecrets();
                  }}
                />
              ))}
            </div>
          ) : null}
          {cred && usable(cred) ? (
            <>
              {cred.authMode === 'oauth2code' ? <Callout kind="info">Your provider asks you to confirm each signature in the browser: a window opens when you sign.</Callout> : null}
              {cred.pin ? (
                <Field label={cred.pin.label ? `PIN (${cred.pin.label})` : 'PIN'} hint="Sent only to your provider to authorise this one signature; never stored.">
                  <Input type="password" autoComplete="off" inputMode={cred.pin.format === 'N' ? 'numeric' : undefined} value={pin} onChange={(e) => setPin(e.target.value)} data-testid="cloudsign-pin" />
                </Field>
              ) : null}
              {cred.otp ? (
                <Field label="One-time code" hint={cred.otp.online ? 'Press “Send code”: your provider sends it by SMS, e-mail or its app.' : 'The code from your provider’s app or device.'}>
                  <div className="flex gap-2">
                    <Input autoComplete="one-time-code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="cloudsign-otp" />
                    {cred.otp.online ? (
                      <Button disabled={!!busy} onClick={() => void sendOtp()} data-testid="cloudsign-send-otp">
                        {busy === 'otp' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {otpSent ? 'Send again' : 'Send code'}
                      </Button>
                    ) : null}
                  </div>
                </Field>
              ) : null}
              <PlacementPicker value={placement} onChange={setPlacement} />
              <MetaFields meta={meta} onChange={setMeta} />
            </>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function CredentialRow({ cred, active, onSelect }: { cred: CscCredential; active: boolean; onSelect: () => void }) {
  const expired = !!cred.validTo && cred.validTo.getTime() < Date.now();
  const issuer = /CN=([^,]+)/.exec(cred.issuer)?.[1] ?? cred.issuer;
  return (
    <label className={cn('flex cursor-default items-start gap-2 border-b border-app px-3 py-2 text-xs last:border-b-0', active && 'bg-brand-50 dark:bg-brand-900/30', !usable(cred) && 'opacity-60')}>
      <input type="radio" name="cloudsign-cred" className="mt-0.5" checked={active} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="font-medium" data-no-translate>
          {cred.name}
        </span>
        {cred.qualified.compliance ? (
          <span className="ml-2 rounded bg-emerald-100 px-1 text-[10px] text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" data-testid="cloudsign-qualified">
            {cred.qualified.qscd ? 'Qualified (QSCD)' : 'Qualified'}
          </span>
        ) : null}
        {expired ? <span className="ml-2 rounded bg-rose-100 px-1 text-[10px] text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">Expired</span> : null}
        {cred.keyAlgorithm === 'other' ? <span className="ml-2 text-[10px] text-rose-700">Unsupported key type</span> : null}
        {!cred.keyEnabled ? <span className="ml-2 text-[10px] text-rose-700">Key disabled</span> : null}
        {cred.certStatus !== 'valid' ? <span className="ml-2 text-[10px] text-rose-700" data-no-translate>{cred.certStatus}</span> : null}
        <span className="block truncate text-muted" title={cred.issuer}>
          <span data-no-translate>{issuer}</span>
          {cred.validTo ? (
            <>
              {' · '}
              {cred.validFrom ? <span data-no-translate>{cred.validFrom.toLocaleDateString()} – </span> : null}
              <span data-no-translate>{cred.validTo.toLocaleDateString()}</span>
            </>
          ) : null}
        </span>
        <span className="block text-[11px] text-muted">
          {cred.keyAlgorithm === 'ecdsa' ? 'ECDSA' : cred.keyAlgorithm === 'rsa' ? 'RSA' : ''}
          {' · '}
          {cred.authMode === 'oauth2code' ? 'Confirm in the browser' : cred.authMode === 'explicit' ? 'PIN or one-time code' : 'No extra confirmation'}
          {cred.description ? (
            <>
              {' · '}
              <span data-no-translate>{cred.description}</span>
            </>
          ) : null}
        </span>
      </span>
    </label>
  );
}

function ProviderForm({ value, isNew, onSave, onCancel }: { value: CscProvider; isNew: boolean; onSave: (p: CscProvider) => void; onCancel?: () => void }) {
  const [p, setP] = useState<CscProvider>(value);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CscProvider>) => setP({ ...p, ...patch });
  const save = () => {
    try {
      if (!p.clientId.trim()) throw new Error('Enter the client ID your provider gave you.');
      const baseUrl = checkServiceUrl(p.baseUrl);
      const oauthUrl = p.oauthUrl?.trim() ? checkServiceUrl(p.oauthUrl) : '';
      if (p.redirectUri?.trim()) checkRedirectUri(p.redirectUri);
      const name = p.name.trim() || new URL(baseUrl).hostname;
      onSave({ ...p, name, baseUrl, oauthUrl, clientId: p.clientId.trim(), clientSecret: p.clientSecret?.trim() ?? '', redirectUri: p.redirectUri?.trim() ?? '' });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="mb-3 rounded-lg border border-app p-3" data-testid="cloudsign-provider-form">
      <div className="mb-2 text-[13px] font-semibold">{isNew ? 'Add a signing service' : 'Edit the signing service'}</div>
      <p className="mb-3 text-[11px] text-muted">Your trust service provider gives you these values when you register an application for its Cloud Signature Consortium (CSC) API.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={p.name} placeholder="e.g. My provider" onChange={(e) => set({ name: e.target.value })} data-testid="csc-name" />
        </Field>
        <Field label="Service URL (CSC API)">
          <Input value={p.baseUrl} placeholder="https://provider.example/csc/v2" onChange={(e) => set({ baseUrl: e.target.value })} data-testid="csc-url" />
        </Field>
        <Field label="Client ID">
          <Input value={p.clientId} autoComplete="off" onChange={(e) => set({ clientId: e.target.value })} data-testid="csc-client-id" />
        </Field>
        <Field label="Client secret (optional)">
          <Input type="password" autoComplete="off" value={p.clientSecret ?? ''} onChange={(e) => set({ clientSecret: e.target.value })} />
        </Field>
        <Field label="OAuth server URL (optional)" hint="Leave empty to use the one the service announces.">
          <Input value={p.oauthUrl ?? ''} placeholder="https://provider.example/oauth" onChange={(e) => set({ oauthUrl: e.target.value })} />
        </Field>
        <Field label="Redirect URI (optional)" hint="Only if your provider registered a fixed one; otherwise any free port is used.">
          <Input value={p.redirectUri ?? ''} placeholder="http://127.0.0.1:8123/callback" onChange={(e) => set({ redirectUri: e.target.value })} />
        </Field>
      </div>
      {error ? <Callout kind="error">{error}</Callout> : null}
      <div className="flex justify-end gap-2">
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        <Button variant="primary" onClick={save} data-testid="csc-save">
          Save provider
        </Button>
      </div>
    </div>
  );
}
