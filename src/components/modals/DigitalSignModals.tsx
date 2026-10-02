/**
 * Cryptographic signing dialogs: certificate file (.pfx/.p12) or a new
 * self-signed ID; hardware tokens and smart cards (PKCS#11); certificates of
 * the Windows certificate store; verification (with the EU Trusted Lists).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { BadgeCheck, BadgeX, FileKey2, FolderOpen, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Usb } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Tabs, Select } from '@/components/ui/primitives';
import { PlacementPicker, resolvePlacement, useSelectedSignatureTarget, type PlacementState } from './PlacementPicker';
import {
  addArchiveTimestamp,
  addLongTermValidation,
  euTrustedLists,
  padesLevelOf,
  signWithIdentity,
  signWithStoreCert,
  signWithToken,
  updateEuTrustedLists,
  verifyCurrentSignatures,
  type SignMeta,
} from '@/actions/sign';
import { createSelfSignedIdentity, exportP12, identityFromCertificateDer, loadP12, qcStatementsOf, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import type { TrustedListCache } from '@/lib/crypto/euTrustedList';
import { errorMessage } from '@/actions/document';
import { isDesktop, pickFiles, pickPaths, pkcs11DetectModules, pkcs11ListTokens, saveBytes, winstoreList, type Pkcs11Module, type StoreCertificate, type TokenCertificate, type TokenInfo } from '@/lib/platform';
import type { SignatureValidation } from '@/types';
import { cn } from '@/lib/cn';

function useSignMeta(): [SignMeta, (m: SignMeta) => void] {
  return useState<SignMeta>({ reason: 'I approve this document', location: '', contactInfo: '', tsaUrl: null, pades: true });
}

function usePlacement(): [PlacementState, (p: PlacementState) => void] {
  const target = useSelectedSignatureTarget();
  const current = usePDFStore((s) => s.pages.findIndex((p) => p.id === s.currentPageId));
  const [p, setP] = useState<PlacementState>({ mode: target ? 'selected' : 'bottom-right', pageNumber: Math.max(1, current + 1) });
  useEffect(() => {
    setP((prev) => ({ ...prev, mode: target ? 'selected' : prev.mode === 'selected' ? 'bottom-right' : prev.mode }));
  }, [target]);
  return [p, setP];
}

function MetaFields({ meta, onChange }: { meta: SignMeta; onChange: (m: SignMeta) => void }) {
  const [useTsa, setUseTsa] = useState(meta.tsaUrl !== null);
  const signed = usePDFStore((s) => s.signatureStatus.length > 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Reason">
          <Input value={meta.reason} onChange={(e) => onChange({ ...meta, reason: e.target.value })} />
        </Field>
        <Field label="Location">
          <Input value={meta.location} placeholder="e.g. Cluj-Napoca" onChange={(e) => onChange({ ...meta, location: e.target.value })} />
        </Field>
      </div>
      <Checkbox
        checked={useTsa}
        label="Add a trusted timestamp (RFC 3161, needs internet)"
        onChange={(v) => {
          setUseTsa(v);
          onChange({ ...meta, tsaUrl: v ? meta.tsaUrl || 'http://timestamp.digicert.com' : null });
        }}
      />
      {useTsa ? (
        <Field label="Timestamp authority URL">
          <Input value={meta.tsaUrl ?? ''} onChange={(e) => onChange({ ...meta, tsaUrl: e.target.value })} />
        </Field>
      ) : null}
      <Checkbox checked={!!meta.ltv} label="Add long-term validation data (LTV: the signature can be verified offline for years; needs internet)" onChange={(ltv) => onChange({ ...meta, ltv })} />
      {meta.ltv && useTsa ? (
        <Checkbox
          checked={!!meta.archive}
          label="Add an archive timestamp over the signature and validation data (PAdES B-LTA)"
          onChange={(archive) => onChange({ ...meta, archive })}
        />
      ) : null}
      <Checkbox checked={!!meta.pades} label="EU format: PAdES baseline (eIDAS)" onChange={(pades) => onChange({ ...meta, pades })} />
      <p className="text-[11px] text-muted" data-testid="pades-level">
        {padesLevelOf({ ...meta, tsaUrl: useTsa ? meta.tsaUrl : null })
          ? `Signature level: PAdES ${padesLevelOf({ ...meta, tsaUrl: useTsa ? meta.tsaUrl : null })}`
          : 'Classic PDF signature (adbe.pkcs7.detached)'}
      </p>
      {!signed ? (
        <Field label="Certify this document">
          <Select
            value={String(meta.certify ?? 0)}
            ariaLabel="Certify"
            onChange={(v: string) => onChange({ ...meta, certify: Number(v) as 0 | 1 | 2 | 3 })}
            options={[
              { value: '0', label: 'No: an approval signature' },
              { value: '1', label: 'Certify: no changes allowed' },
              { value: '2', label: 'Certify: filling in forms and signing allowed' },
              { value: '3', label: 'Certify: forms, signing and comments allowed' },
            ]}
          />
        </Field>
      ) : (
        <p className="text-[11px] text-muted">This PDF is already signed: the new signature is added after the existing ones, which stay valid.</p>
      )}
    </>
  );
}

// ================================================================ certificate file / self-signed

export function CertificateModal() {
  const open = usePDFStore((s) => s.modal === 'certificate');
  const close = () => usePDFStore.getState().openModal(null);
  const [tab, setTab] = useState<'file' | 'create'>('file');
  const [identity, setIdentity] = useState<SigningIdentity | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState({ name: '', email: '', organization: '', country: 'RO' });
  const [exportPass, setExportPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useSignMeta();
  const [placement, setPlacement] = usePlacement();

  const unlock = () => {
    if (!fileBytes) return;
    try {
      setIdentity(loadP12(fileBytes, password));
      setError(null);
    } catch (e) {
      setIdentity(null);
      setError(errorMessage(e));
    }
  };

  const create = async () => {
    if (!newId.name.trim()) return setError('Enter the name that should appear on the certificate.');
    setBusy(true);
    try {
      const id = await createSelfSignedIdentity({ name: newId.name.trim(), email: newId.email || undefined, organization: newId.organization || undefined, country: newId.country || undefined, years: 5 });
      setIdentity(id);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (!identity) return;
    const { placement: p, inkSrc, consumeId } = resolvePlacement(placement);
    close();
    await signWithIdentity(identity, p, meta, inkSrc, consumeId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Sign with a digital ID"
      description="A certificate-based signature proves who signed and that the document was not changed afterwards."
      width={620}
      testId="certificate-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="accent" disabled={!identity} onClick={() => void sign()} data-testid="cert-sign-now">
            <FileKey2 size={14} /> Sign and save
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={(t) => { setTab(t); setError(null); }} tabs={[{ value: 'file', label: 'Certificate file (.pfx / .p12)' }, { value: 'create', label: 'Create self-signed ID' }]} />
      {tab === 'file' ? (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Button
              onClick={async () => {
                const f = (await pickFiles([{ name: 'Digital IDs', extensions: ['pfx', 'p12'] }]))[0];
                if (f) {
                  setFileBytes(f.bytes);
                  setFileName(f.name);
                  setIdentity(null);
                }
              }}
            >
              <FolderOpen size={14} /> Choose certificate…
            </Button>
            <span className="truncate text-xs text-muted">{fileName ?? 'No file chosen'}</span>
          </div>
          {fileBytes ? (
            <div className="mb-3 flex items-end gap-2">
              <div className="flex-1">
                <Field label="Certificate password">
                  <Input type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} data-autofocus />
                </Field>
              </div>
              <Button className="mb-3" onClick={unlock}>
                <KeyRound size={14} /> Unlock
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name">
              <Input value={newId.name} onChange={(e) => setNewId({ ...newId, name: e.target.value })} data-testid="selfsigned-name" />
            </Field>
            <Field label="Email">
              <Input value={newId.email} onChange={(e) => setNewId({ ...newId, email: e.target.value })} />
            </Field>
            <Field label="Organisation">
              <Input value={newId.organization} onChange={(e) => setNewId({ ...newId, organization: e.target.value })} />
            </Field>
            <Field label="Country code">
              <Input value={newId.country} maxLength={2} onChange={(e) => setNewId({ ...newId, country: e.target.value.toUpperCase() })} />
            </Field>
          </div>
          <Callout kind="warn">
            A self-signed ID proves the document was not altered, but not <em>who</em> signed it — readers see it as “identity unknown” unless they trust your certificate. For legally qualified signatures (eIDAS QES) use a certificate from a qualified provider on a token.
          </Callout>
          <Button onClick={() => void create()} disabled={busy} data-testid="selfsigned-create">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Create ID
          </Button>
        </>
      )}
      {error ? <Callout kind="error">{error}</Callout> : null}
      {identity ? (
        <div className="mt-3">
          <IdentityCard name={identity.name} subject={identity.subject} issuer={identity.issuer} validTo={identity.validTo} selfSigned={identity.selfSigned} />
          {tab === 'create' ? (
            <div className="mb-3 flex items-end gap-2">
              <div className="flex-1">
                <Field label="Password to protect the exported ID">
                  <Input type="password" value={exportPass} onChange={(e) => setExportPass(e.target.value)} />
                </Field>
              </div>
              <Button
                className="mb-3"
                disabled={exportPass.length < 4}
                onClick={async () => {
                  const bytes = exportP12(identity, exportPass);
                  const path = await saveBytes(bytes, `${identity.name.replace(/[^\w.-]+/g, '_')}.p12`, [{ name: 'Digital ID', extensions: ['p12'] }]);
                  if (path) usePDFStore.getState().toast('Digital ID saved. Keep it and its password safe.', 'success');
                }}
              >
                Save ID as .p12
              </Button>
            </div>
          ) : null}
          <PlacementPicker value={placement} onChange={setPlacement} />
          <MetaFields meta={meta} onChange={setMeta} />
        </div>
      ) : null}
    </Dialog>
  );
}

function IdentityCard({ name, subject, issuer, validTo, selfSigned }: { name: string; subject: string; issuer: string; validTo: Date; selfSigned: boolean }) {
  const expired = validTo.getTime() < Date.now();
  return (
    <div className={cn('mb-3 flex items-start gap-3 rounded-lg border p-3', expired ? 'border-rose-300' : 'border-emerald-300 dark:border-emerald-800')} data-testid="identity-card">
      <ShieldCheck size={20} className={expired ? 'text-rose-600' : 'text-accent-600'} />
      <div className="min-w-0 text-xs">
        <div className="text-[13px] font-semibold">{name}</div>
        <div className="truncate text-muted" title={subject}>
          {subject}
        </div>
        <div className="truncate text-muted" title={issuer}>
          Issued by: {selfSigned ? 'self-signed' : issuer}
        </div>
        <div className={expired ? 'text-rose-600' : 'text-muted'}>
          {expired ? 'Expired' : 'Valid until'} {validTo.toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

// ================================================================ hardware token

export function TokenModal() {
  const open = usePDFStore((s) => s.modal === 'token');
  const close = () => usePDFStore.getState().openModal(null);
  const [modules, setModules] = useState<Pkcs11Module[]>([]);
  const [module, setModule] = useState<string>('');
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [selected, setSelected] = useState<{ slotId: number; cert: TokenCertificate } | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useSignMeta();
  const [placement, setPlacement] = usePlacement();

  const scan = async (path: string) => {
    setModule(path);
    setLoading(true);
    setError(null);
    setTokens(null);
    setSelected(null);
    try {
      const list = await pkcs11ListTokens(path);
      setTokens(list);
      const first = list.flatMap((t) => t.certificates.map((c) => ({ slotId: t.slotId, cert: c })))[0];
      if (first) setSelected(first);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !isDesktop) return;
    void pkcs11DetectModules().then((m) => {
      setModules(m);
      if (m[0] && !module) void scan(m[0].path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const token = tokens?.find((t) => t.slotId === selected?.slotId);
  const pinPad = token?.protectedAuthPath ?? false;

  const sign = async () => {
    if (!selected || !token) return;
    const { placement: p, inkSrc, consumeId } = resolvePlacement(placement);
    const thePin = pinPad ? null : pin;
    setPin('');
    close();
    await signWithToken({ module, slotId: selected.slotId, certificate: selected.cert, pin: thePin }, p, meta, inkSrc, consumeId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPin('');
          close();
        }
      }}
      title="Sign with a token or smart card"
      description="USB tokens, smart cards and national eID cards through their PKCS#11 driver. The private key never leaves the device."
      width={660}
      testId="token-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="accent" disabled={!selected || (!pinPad && pin.length < 4)} onClick={() => void sign()} data-testid="token-sign-now">
            <Usb size={14} /> Sign and save
          </Button>
        </>
      }
    >
      {!isDesktop ? <Callout kind="warn">Hardware tokens need the Adika desktop app (browsers cannot talk to smart cards).</Callout> : null}
      <Field label="Token driver (PKCS#11 module)" hint="Detected drivers are listed. Pick your vendor's .dll if it is not detected (e.g. eTPKCS11.dll for SafeNet, used by certSIGN and DigiSign).">
        <div className="flex gap-2">
          <select
            aria-label="PKCS#11 module"
            className="h-8 min-w-0 flex-1 rounded-md border border-app bg-panel-2 px-2 text-[13px]"
            value={module}
            onChange={(e) => void scan(e.target.value)}
          >
            {module && !modules.some((m) => m.path === module) ? <option value={module}>{module}</option> : null}
            {modules.length === 0 && !module ? <option value="">No driver detected</option> : null}
            {modules.map((m) => (
              <option key={m.path} value={m.path}>
                {m.vendor} — {m.path}
              </option>
            ))}
          </select>
          <Button
            onClick={async () => {
              const p = (await pickPaths([{ name: 'PKCS#11 module', extensions: ['dll', 'so', 'dylib'] }]))[0];
              if (p) void scan(p);
            }}
          >
            Browse…
          </Button>
          <Button variant="ghost" size="icon" aria-label="Rescan" disabled={!module} onClick={() => void scan(module)}>
            <RefreshCw size={14} />
          </Button>
        </div>
      </Field>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> Reading tokens…
        </div>
      ) : null}
      {error ? <Callout kind="error">{error}</Callout> : null}
      {tokens && tokens.length === 0 ? <Callout kind="warn">No token found. Insert your token or card and press refresh.</Callout> : null}
      {tokens?.map((t) => (
        <div key={t.slotId} className="mb-3 rounded-lg border border-app">
          <div className="flex items-center gap-2 border-b border-app px-3 py-2 text-xs">
            <Usb size={14} className="text-brand-600" />
            <span className="font-semibold">{t.label || 'Token'}</span>
            <span className="text-muted">
              {t.manufacturer} {t.model} · S/N {t.serial}
            </span>
          </div>
          {t.certificates.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No certificates visible on this token.</div>
          ) : (
            t.certificates.map((c) => {
              const active = selected?.slotId === t.slotId && selected.cert.idHex === c.idHex;
              return (
                <label key={c.idHex} className={cn('flex cursor-default items-center gap-2 px-3 py-2 text-xs', active && 'bg-brand-50 dark:bg-brand-900/30')}>
                  <input type="radio" name="token-cert" checked={active} onChange={() => setSelected({ slotId: t.slotId, cert: c })} />
                  <span className="font-medium">{c.label || `Certificate ${c.idHex.slice(0, 8)}`}</span>
                  <span className="text-muted">{c.keyType !== 'unknown' ? c.keyType.toUpperCase() : ''}</span>
                </label>
              );
            })
          )}
        </div>
      ))}
      {selected ? (
        <>
          {pinPad ? (
            <Callout kind="info">This reader has a PIN pad — you will enter the PIN on the device when signing.</Callout>
          ) : (
            <Field label="Token PIN" hint="Entered only to unlock the token for this one signature; never stored. Tokens lock after several wrong PINs.">
              <Input type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} data-testid="token-pin" />
            </Field>
          )}
          <PlacementPicker value={placement} onChange={setPlacement} />
          <MetaFields meta={meta} onChange={setMeta} />
        </>
      ) : null}
    </Dialog>
  );
}

// ================================================================ Windows certificate store

export function StoreCertModal() {
  const open = usePDFStore((s) => s.modal === 'winstore');
  const close = () => usePDFStore.getState().openModal(null);
  const [certs, setCerts] = useState<StoreCertificate[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useSignMeta();
  const [placement, setPlacement] = usePlacement();

  const load = async () => {
    setError(null);
    setCerts(null);
    try {
      const all = (await winstoreList()).filter((c) => c.hasPrivateKey);
      setCerts(all);
      const now = Date.now();
      const valid = all.find((c) => {
        try {
          return identityFromCertificateDer(base64Bytes(c.derBase64)).validTo.getTime() > now;
        } catch {
          return false;
        }
      });
      setSelected((valid ?? all[0])?.thumbprint ?? null);
    } catch (e) {
      setError(errorMessage(e));
      setCerts([]);
    }
  };

  useEffect(() => {
    if (open && isDesktop) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cert = certs?.find((c) => c.thumbprint === selected) ?? null;
  const sign = async () => {
    if (!cert) return;
    const { placement: p, inkSrc, consumeId } = resolvePlacement(placement);
    close();
    await signWithStoreCert(cert, p, meta, inkSrc, consumeId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Sign with a Windows certificate"
      description="Certificates installed in Windows (Personal store): qualified certificates from your card or token driver, or imported .pfx files. Windows asks for the PIN; the key never leaves its device."
      width={660}
      testId="winstore-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="accent" disabled={!cert} onClick={() => void sign()} data-testid="winstore-sign-now">
            <KeyRound size={14} /> Sign and save
          </Button>
        </>
      }
    >
      {!isDesktop ? <Callout kind="warn">The Windows certificate store needs the Adika desktop app.</Callout> : null}
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium">Certificates with a private key</span>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load()}>
          <RefreshCw size={14} />
        </Button>
      </div>
      {error ? <Callout kind="error">{error}</Callout> : null}
      {certs === null && isDesktop ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> Reading certificates…
        </div>
      ) : null}
      {certs && certs.length === 0 && !error ? (
        <div data-testid="winstore-empty">
          <Callout kind="info">No certificate with a private key is installed. Install your card or token driver, or import a .pfx file in Windows (double-click it).</Callout>
        </div>
      ) : null}
      {certs?.length ? (
        <div className="mb-3 max-h-56 overflow-auto rounded-lg border border-app" data-testid="winstore-list">
          {certs.map((c) => (
            <StoreCertRow key={c.thumbprint} cert={c} active={c.thumbprint === selected} onSelect={() => setSelected(c.thumbprint)} />
          ))}
        </div>
      ) : null}
      {cert ? (
        <>
          <PlacementPicker value={placement} onChange={setPlacement} />
          <MetaFields meta={meta} onChange={setMeta} />
        </>
      ) : null}
    </Dialog>
  );
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function StoreCertRow({ cert, active, onSelect }: { cert: StoreCertificate; active: boolean; onSelect: () => void }) {
  let info: ReturnType<typeof identityFromCertificateDer> | null = null;
  try {
    info = identityFromCertificateDer(base64Bytes(cert.derBase64));
  } catch {
    /* unreadable certificate */
  }
  const qc = info ? qcStatementsOf(info.certificate) : null;
  const expired = info ? info.validTo.getTime() < Date.now() : false;
  return (
    <label className={cn('flex cursor-default items-start gap-2 border-b border-app px-3 py-2 text-xs last:border-b-0', active && 'bg-brand-50 dark:bg-brand-900/30')}>
      <input type="radio" name="winstore-cert" className="mt-0.5" checked={active} onChange={onSelect} />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{info?.name ?? cert.thumbprint}</span>
        {qc?.compliance ? <span className="ml-2 rounded bg-emerald-100 px-1 text-[10px] text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{qc.qscd ? 'Qualified (QSCD)' : 'Qualified'}</span> : null}
        {expired ? <span className="ml-2 rounded bg-rose-100 px-1 text-[10px] text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">Expired</span> : null}
        <span className="block truncate text-muted">
          {info ? `${info.issuer} · until ${info.validTo.toLocaleDateString()}` : ''}
        </span>
      </span>
    </label>
  );
}

// ================================================================ verify

export function VerifyModal() {
  const open = usePDFStore((s) => s.modal === 'verify');
  const status = usePDFStore((s) => s.signatureStatus);
  const close = () => usePDFStore.getState().openModal(null);
  const [checkRevocation, setCheckRevocation] = useState(isDesktop);
  const [ran, setRan] = useState(false);
  const [tl, setTl] = useState<TrustedListCache | null>(null);

  useEffect(() => {
    if (open) {
      setRan(false);
      void euTrustedLists().then(setTl);
      void verifyCurrentSignatures(false).then(() => setRan(true));
    }
  }, [open]);
  const signatures = status.filter((s) => !s.documentTimestamp);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Signature verification"
      description="Integrity of each signature, the certificate chain against the Windows trust store, and revocation (OCSP/CRL)."
      width={680}
      testId="verify-modal"
      footer={
        <>
          <Checkbox checked={checkRevocation} onChange={setCheckRevocation} label="Check revocation online (OCSP / CRL)" disabled={!isDesktop} />
          <div className="flex-1" />
          {status.length ? (
            <Button onClick={() => void import('@/actions/reports').then((m) => m.saveValidationReport())} data-testid="verify-report" title="Save what was checked as a PDF report">
              Save report
            </Button>
          ) : null}
          {signatures.length ? (
            <Button
              onClick={() => void addArchiveTimestamp('http://timestamp.digicert.com').then(() => setRan(true))}
              disabled={!isDesktop}
              data-testid="verify-add-archive"
              title="Adds validation data and a document timestamp over the whole file (PAdES B-LTA); repeat it every few years to keep the signatures verifiable"
            >
              Add archive timestamp
            </Button>
          ) : null}
          {signatures.length && signatures.some((s) => !s.ltv) ? (
            <Button onClick={() => void addLongTermValidation().then(() => setRan(true))} disabled={!isDesktop} data-testid="verify-add-ltv" title="Store the certificate chains and OCSP / CRL answers in the file (the signatures stay valid)">
              Add long-term validation
            </Button>
          ) : null}
          <Button onClick={() => void verifyCurrentSignatures(checkRevocation).then(() => setRan(true))} data-testid="verify-run">
            <RefreshCw size={14} /> Verify again
          </Button>
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2 rounded-lg bg-[var(--hover)] px-3 py-2 text-xs" data-testid="eu-tl-status">
        <ShieldCheck size={14} className="shrink-0 text-brand-600" />
        <span className="min-w-0 flex-1">
          {tl
            ? `EU Trusted Lists: ${tl.services.length} qualified services, downloaded ${new Date(tl.fetched).toLocaleDateString()}.`
            : 'EU Trusted Lists not downloaded: qualified EU signatures are recognised only through the Windows roots.'}
        </span>
        <Button
          size="sm"
          disabled={!isDesktop}
          data-testid="eu-tl-update"
          onClick={() =>
            void updateEuTrustedLists().then(async (res) => {
              if (res) setTl(res);
              await verifyCurrentSignatures(false);
              setRan(true);
            })
          }
        >
          {tl ? 'Update' : 'Download'}
        </Button>
      </div>
      {ran && status.length === 0 ? <Callout kind="info">This document has no digital signatures.</Callout> : null}
      {status.map((s) => (
        <SignatureCard key={s.fieldName} sig={s} />
      ))}
    </Dialog>
  );
}

function SignatureCard({ sig }: { sig: SignatureValidation }) {
  const ok = sig.integrity === 'valid' && !sig.modifiedAfterSigning;
  const trusted = sig.chainStatus === 'trusted';
  const revoked = sig.revocationStatus === 'revoked';
  const tone = !ok || revoked ? 'bad' : trusted ? 'good' : 'warn';
  return (
    <div
      data-testid="signature-card"
      className={cn(
        'mb-3 rounded-lg border p-3',
        tone === 'good' && 'border-emerald-300 dark:border-emerald-800',
        tone === 'warn' && 'border-amber-300 dark:border-amber-800',
        tone === 'bad' && 'border-rose-300 dark:border-rose-800',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        {tone === 'good' ? <BadgeCheck className="text-accent-600" size={20} /> : tone === 'warn' ? <ShieldAlert className="text-amber-600" size={20} /> : <BadgeX className="text-rose-600" size={20} />}
        <div>
          <div className="text-[13px] font-semibold">
            {sig.documentTimestamp ? <span className="mr-1 font-normal text-muted">Document timestamp ·</span> : null}
            {sig.signerName || sig.fieldName}
            {sig.padesLevel ? (
              <span className="ml-2 rounded bg-brand-50 px-1 text-[10px] font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200" data-testid="pades-badge">
                PAdES {sig.padesLevel}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-muted">
            {sig.signedAt ? new Date(sig.signedAt).toLocaleString() : 'time unknown'} {sig.hasTimestamp ? '· trusted timestamp' : '· time from signer’s clock'}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-xs">
        <Row label="Document integrity">
          {sig.integrity === 'valid' ? 'Unchanged since signing' : sig.integrity === 'invalid' ? 'MODIFIED — signature broken' : 'Could not be checked'}
        </Row>
        <Row label="Covers whole file">
          {sig.coversWholeFile
            ? 'Yes'
            : !sig.modifiedAfterSigning && sig.laterChanges
              ? `Allowed changes after signing: ${[sig.laterChanges.ltv ? 'validation data' : '', sig.laterChanges.signatures ? 'more signatures' : '', sig.laterChanges.form ? 'form filling' : ''].filter(Boolean).join(', ')}`
              : 'No — content was changed after this signature'}
        </Row>
        {sig.certified ? <Row label="Certified">{['', 'Yes — no changes allowed', 'Yes — form filling and signing allowed', 'Yes — forms, signing and comments allowed'][sig.certified]}</Row> : null}
        {!sig.documentTimestamp ? <Row label="Long-term validation">{sig.ltv ? 'Yes — validation data saved in the file' : 'No'}</Row> : null}
        {sig.euTrusted || sig.qualified ? (
          <Row label="EU qualified">
            {sig.euTrusted
              ? sig.documentTimestamp
                ? 'Qualified timestamp authority'
                : sig.qualified === 'qscd'
                  ? 'Qualified electronic signature'
                  : sig.qualified === 'qc'
                    ? 'Advanced signature, qualified certificate'
                    : 'Issuer is a qualified trust service'
              : 'Declared by the certificate, not confirmed (download the EU Trusted Lists)'}
            {sig.euTrusted ? <span className="block text-[11px] text-muted">{sig.euTrusted}</span> : null}
          </Row>
        ) : null}
        <Row label={sig.documentTimestamp ? 'Timestamp authority' : 'Signer identity'}>
          {sig.chainStatus === 'trusted'
            ? sig.euTrusted
              ? 'Trusted (EU Trusted List)'
              : 'Trusted (chain to a Windows root)'
            : sig.chainStatus === 'expired'
              ? 'Certificate expired at signing time'
              : sig.chainStatus === 'incomplete'
                ? 'Chain incomplete'
                : sig.selfSigned
                  ? 'Self-signed — not verified'
                  : 'Not trusted on this computer'}
        </Row>
        <Row label="Revocation">
          {sig.revocationStatus === 'good' ? 'Not revoked' : sig.revocationStatus === 'revoked' ? 'REVOKED' : sig.revocationStatus === 'unknown' ? 'Unknown' : 'Not checked'}
          {sig.revocationDetails ? <span className="block text-[11px] text-muted">{sig.revocationDetails}</span> : null}
        </Row>
        {sig.algorithm ? <Row label="Algorithm">{sig.algorithm}</Row> : null}
        {sig.reason ? <Row label="Reason">{sig.reason}</Row> : null}
        <Row label="Certificate">
          <span className="break-all">{sig.certSubject}</span>
          <span className="block text-[11px] text-muted">
            {sig.certValidFrom ? new Date(sig.certValidFrom).toLocaleDateString() : ''} – {sig.certValidTo ? new Date(sig.certValidTo).toLocaleDateString() : ''}
          </span>
        </Row>
        {sig.chainDetails?.length ? (
          <Row label="Chain">
            {sig.chainDetails.map((c, i) => (
              <span key={i} className="block break-all">
                {'↳ '.repeat(i ? 1 : 0)}
                {c}
              </span>
            ))}
          </Row>
        ) : null}
      </dl>
      {sig.message ? <p className="mt-2 text-[11px] text-muted">{sig.message}</p> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
