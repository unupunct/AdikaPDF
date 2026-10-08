/**
 * Sign → Sign many files: pick PDFs or a folder, one identity (.pfx, Windows
 * certificate, token / smart card, cloud signature) entered once, the usual
 * signature options and a fixed appearance; results per file, as CSV too.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Cloud, FilePlus2, FileSignature, FolderOpen, KeyRound, Loader2, LogIn, MinusCircle, RefreshCw, Save, Send, Usb, X, XCircle } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { useCscProviders } from '@/store/cscProviders';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tabs } from '@/components/ui/primitives';
import { identityFromCertificateDer, loadP12, type SigningIdentity } from '@/lib/crypto/digitalSignature';
import { targetLevel, type BatchSignOptions, type BatchSignResult, type SignCorner } from '@/lib/batchSign';
import type { CscClient, CscCredential } from '@/lib/crypto/csc';
import { errorMessage } from '@/actions/document';
import { askConfirm } from '@/store/useDialogs';
import { base64ToBytes, isDesktop, pickFiles, pickFolder, pickPaths, pkcs11DetectModules, pkcs11ListTokens, winstoreList, type Pkcs11Module, type StoreCertificate, type TokenCertificate, type TokenInfo } from '@/lib/platform';
import { cn } from '@/lib/cn';

type Source = 'pfx' | 'store' | 'token' | 'cloud';
type PageChoice = 'first' | 'last' | 'number';
type OutputMode = 'suffix' | 'folder' | 'replace';

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function certName(derBase64: string): { name: string; issuer: string; validTo: Date } | null {
  try {
    const i = identityFromCertificateDer(base64ToBytes(derBase64));
    return { name: i.name, issuer: /CN=([^,]+)/.exec(i.issuer)?.[1] ?? i.issuer, validTo: i.validTo };
  } catch {
    return null;
  }
}

export function BatchSignModal() {
  const open = usePDFStore((s) => s.modal === 'batchsign');
  const savedSigs = usePDFStore((s) => s.savedSignatures);
  const [files, setFiles] = useState<string[]>([]);
  const [subfolders, setSubfolders] = useState(true);
  const [source, setSource] = useState<Source>('pfx');
  // .pfx
  const [pfx, setPfx] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [pfxPass, setPfxPass] = useState('');
  const [identity, setIdentity] = useState<SigningIdentity | null>(null);
  // Windows store
  const [storeCerts, setStoreCerts] = useState<StoreCertificate[] | null>(null);
  const [storeSel, setStoreSel] = useState<string | null>(null);
  // token
  const [modules, setModules] = useState<Pkcs11Module[]>([]);
  const [module, setModule] = useState('');
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokenSel, setTokenSel] = useState<{ slotId: number; cert: TokenCertificate } | null>(null);
  const [pin, setPin] = useState('');
  // cloud
  const { providers, lastProvider, lastCredential, remember } = useCscProviders();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [client, setClient] = useState<CscClient | null>(null);
  const [creds, setCreds] = useState<CscCredential[] | null>(null);
  const [credSel, setCredSel] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [otpAsk, setOtpAsk] = useState<{ round: number; resolve: (otp: string | null) => void } | null>(null);
  const [otpAgain, setOtpAgain] = useState('');
  // options
  const [reason, setReason] = useState('I approve this document');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [useTsa, setUseTsa] = useState(false);
  const [tsaUrl, setTsaUrl] = useState('http://timestamp.digicert.com');
  const [ltv, setLtv] = useState(false);
  const [archive, setArchive] = useState(false);
  const [pades, setPades] = useState(true);
  const [certify, setCertify] = useState<0 | 1 | 2 | 3>(0);
  // appearance
  const [visible, setVisible] = useState(true);
  const [pageChoice, setPageChoice] = useState<PageChoice>('last');
  const [pageNumber, setPageNumber] = useState(1);
  const [corner, setCorner] = useState<SignCorner>('bottom-right');
  const [offset, setOffset] = useState({ x: 28, y: 28 });
  const [size, setSize] = useState({ width: 210, height: 62 });
  const [ink, setInk] = useState('');
  const [useField, setUseField] = useState(false);
  const [fieldName, setFieldName] = useState('Signature1');
  // output
  const [outMode, setOutMode] = useState<OutputMode>('suffix');
  const [suffix, setSuffix] = useState('-signed');
  const [outFolder, setOutFolder] = useState<string | null>(null);
  // run
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [results, setResults] = useState<Array<BatchSignResult | undefined> | null>(null);
  const cancel = useRef(false);

  const clearSecrets = () => {
    setPfxPass('');
    setPin('');
    setOtp('');
    setOtpAgain('');
  };
  const close = () => {
    if (running) return;
    clearSecrets();
    setIdentity(null);
    usePDFStore.getState().openModal(null);
  };

  useEffect(() => {
    if (!open) return;
    if (results) setFiles([]);
    setResults(null);
    setProgress(null);
    setError(null);
    setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fail = (e: unknown) => setError(errorMessage(e));

  // ---------------------------------------------------------------- sources
  const loadStore = async () => {
    setStoreCerts(null);
    try {
      const all = (await winstoreList()).filter((c) => c.hasPrivateKey);
      setStoreCerts(all);
      const valid = all.find((c) => (certName(c.derBase64)?.validTo.getTime() ?? 0) > Date.now());
      setStoreSel((valid ?? all[0])?.thumbprint ?? null);
    } catch (e) {
      setStoreCerts([]);
      fail(e);
    }
  };
  const scanTokens = async (path: string) => {
    setModule(path);
    setTokens(null);
    setTokenSel(null);
    setBusy('tokens');
    try {
      const list = await pkcs11ListTokens(path);
      setTokens(list);
      const first = list.flatMap((t) => t.certificates.map((c) => ({ slotId: t.slotId, cert: c })))[0];
      if (first) setTokenSel(first);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const loadCreds = async (c: CscClient) => {
    setBusy('cloud');
    try {
      const list = await c.listCredentials();
      setCreds(list);
      setCredSel((list.find((x) => x.id === lastCredential) ?? list[0])?.id ?? null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const pickProvider = async (id: string | null) => {
    setProviderId(id);
    setCreds(null);
    setCredSel(null);
    const p = providers.find((x) => x.id === id);
    if (!p) return setClient(null);
    const { cscClient } = await import('@/actions/cloudSign');
    const c = cscClient(p);
    setClient(c);
    if (c.signedIn) void loadCreds(c);
  };

  useEffect(() => {
    if (!open || !isDesktop) return;
    setError(null);
    if (source === 'store' && storeCerts === null) void loadStore();
    if (source === 'token' && !modules.length)
      void pkcs11DetectModules().then((m) => {
        setModules(m);
        if (m[0] && !module) void scanTokens(m[0].path);
      });
    if (source === 'cloud' && providerId === null) void pickProvider((providers.find((p) => p.id === lastProvider) ?? providers[0])?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const token = tokens?.find((t) => t.slotId === tokenSel?.slotId);
  const pinPad = token?.protectedAuthPath ?? false;
  const cred = creds?.find((c) => c.id === credSel) ?? null;
  const storeCert = storeCerts?.find((c) => c.thumbprint === storeSel) ?? null;
  const identityReady =
    source === 'pfx' ? !!identity : source === 'store' ? !!storeCert : source === 'token' ? !!tokenSel && (pinPad || pin.length >= 4) : !!cred && (!cred.pin || cred.pin.optional || !!pin) && (!cred.otp || cred.otp.optional || !!otp);
  const outputReady = outMode === 'replace' || (outMode === 'suffix' ? !!suffix.trim() : !!outFolder);
  const ready = files.length > 0 && identityReady && outputReady && !running && (!useTsa || !!tsaUrl.trim());

  // ---------------------------------------------------------------- files
  const addFiles = async () => {
    const picked = isDesktop ? await pickPaths([{ name: 'PDF documents', extensions: ['pdf'] }], true) : [];
    setResults(null);
    setFiles((cur) => [...cur, ...picked.filter((p) => !cur.includes(p))]);
  };
  const addFolder = async () => {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const { collectPdfs } = await import('@/actions/batchSign');
      const found = await collectPdfs(folder, subfolders);
      if (!found.length) usePDFStore.getState().toast('No PDF files in that folder.', 'info');
      setResults(null);
      setFiles((cur) => [...cur, ...found.filter((p) => !cur.includes(p))]);
    } catch (e) {
      fail(e);
    }
  };

  // ---------------------------------------------------------------- run
  const run = async () => {
    if (!ready) return;
    if (outMode === 'replace') {
      const ok = await askConfirm({
        title: 'Replace the original files?',
        message: `The ${files.length} original file(s) will be overwritten with the signed versions. A file is replaced only after it was signed successfully. This cannot be undone.`,
        confirmLabel: 'Replace originals',
        danger: true,
      });
      if (!ok) return;
    }
    setError(null);
    setNote(null);
    const opts: BatchSignOptions = {
      reason,
      location,
      contactInfo: contact,
      tsaUrl: useTsa ? tsaUrl.trim() : null,
      pades,
      certify,
      ltv,
      archive: ltv && useTsa && archive,
      appearance: {
        visible,
        page: pageChoice === 'number' ? Math.max(1, pageNumber) : pageChoice,
        corner,
        offsetX: offset.x,
        offsetY: offset.y,
        width: Math.max(20, size.width),
        height: Math.max(10, size.height),
        fieldName: useField && fieldName.trim() ? fieldName.trim() : undefined,
      },
      output: outMode === 'replace' ? { mode: 'replace' } : outMode === 'folder' ? { mode: 'folder', folder: outFolder!, suffix } : { mode: 'suffix', suffix: suffix.trim() },
    };
    const list = [...files];
    setRunning(true);
    cancel.current = false;
    setResults(list.map(() => undefined));
    setProgress({ done: 0, total: list.length, current: '' });
    const { openBatchSigner, signFiles } = await import('@/actions/batchSign');
    let opened: Awaited<ReturnType<typeof openBatchSigner>> | null = null;
    try {
      if (source === 'pfx') opened = await openBatchSigner({ kind: 'pfx', identity: identity! });
      else if (source === 'store') opened = await openBatchSigner({ kind: 'store', cert: storeCert! });
      else if (source === 'token') {
        const thePin = pinPad ? null : pin;
        setPin('');
        opened = await openBatchSigner({ kind: 'token', module, slotId: tokenSel!.slotId, certificate: tokenSel!.cert, pin: thePin });
      } else {
        remember(providerId, cred!.id);
        const secrets = { pin: cred!.pin ? pin || undefined : undefined, otp: cred!.otp ? otp || undefined : undefined };
        setPin('');
        setOtp('');
        opened = await openBatchSigner(
          {
            kind: 'cloud',
            client: client!,
            credential: cred!,
            secrets,
            moreSecrets: (round) => new Promise((resolve) => setOtpAsk({ round, resolve: (code) => resolve(code ? { otp: code } : null) })),
          },
          (msg) => usePDFStore.getState().toast(msg, 'info'),
        );
      }
      if (opened.note) setNote(opened.note);
      const out = await signFiles(list, opened.signer, { name: opened.name, issuer: opened.issuer }, opts, ink || null, {
        onProgress: (done, total, current) => setProgress({ done, total, current }),
        onResult: (r, i) => setResults((cur) => (cur ? cur.map((x, k) => (k === i ? r : x)) : cur)),
        cancelled: () => cancel.current,
      });
      const ok = out.filter((r) => r.status === 'done').length;
      usePDFStore.getState().toast(`Signed ${ok} of ${out.length} file(s).`, ok === out.length ? 'success' : 'info');
    } catch (e) {
      // The identity could not be opened (wrong PIN, no session): nothing was signed.
      await opened?.signer.close?.().catch(() => undefined);
      setResults(null);
      fail(e);
    } finally {
      setRunning(false);
      setOtpAsk(null);
      clearSecrets();
    }
  };

  const done = results?.filter((r) => r?.status === 'done').length ?? 0;
  const finished = !!results && !running && results.every(Boolean);
  const level = targetLevel({ pades, tsaUrl: useTsa ? tsaUrl : null, ltv, archive: ltv && useTsa && archive });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Sign many files"
      description="One digital signature on many PDFs: the PIN or authorization is asked once for the whole batch."
      width={720}
      testId="batchsign-modal"
      footer={
        <>
          {finished && results ? (
            <Button onClick={() => void import('@/actions/batchSign').then((m) => m.saveResultsCsv(results.filter((r): r is BatchSignResult => !!r)))} data-testid="batchsign-csv">
              <Save size={13} /> Save results as CSV
            </Button>
          ) : null}
          {running ? <Button onClick={() => (cancel.current = true)} data-testid="batchsign-stop">Stop after this file</Button> : <Button onClick={close}>Close</Button>}
          <Button variant="accent" disabled={!ready} onClick={() => void run()} data-testid="batchsign-run">
            {running ? <Loader2 size={13} className="animate-spin" /> : <FileSignature size={13} />}
            {`Sign ${files.length} file(s)`}
          </Button>
        </>
      }
    >
      {!isDesktop ? <Callout kind="warn">Signing many files needs the Adika desktop app.</Callout> : null}

      {/* ------------------------------------------------ files */}
      <div className="mb-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="flex-1 text-xs font-semibold">Files</span>
          <Checkbox checked={subfolders} label="Include subfolders" onChange={setSubfolders} disabled={running} />
          <Button size="sm" onClick={() => void addFolder()} disabled={running || !isDesktop} data-testid="batchsign-add-folder">
            <FolderOpen size={13} /> Add folder…
          </Button>
          <Button size="sm" onClick={() => void addFiles()} disabled={running || !isDesktop} data-testid="batchsign-add">
            <FilePlus2 size={13} /> Add PDFs…
          </Button>
        </div>
        {files.length ? (
          <ul className="max-h-40 overflow-auto rounded-md border border-app text-[12px]" data-testid="batchsign-files">
            {files.map((f, i) => {
              const r = results?.[i];
              return (
                <li key={f} className="flex items-center gap-2 border-b border-app px-2 py-1 last:border-0" title={f}>
                  {r ? (
                    r.status === 'done' ? <CheckCircle2 size={13} className="text-accent-600" /> : r.status === 'skipped' ? <MinusCircle size={13} className="text-amber-600" /> : <XCircle size={13} className="text-rose-600" />
                  ) : running && progress?.done === i ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate" data-no-translate>
                    {baseName(f)}
                  </span>
                  {r ? (
                    <span className="max-w-[60%] truncate text-muted" data-testid="batchsign-result" title={r.message}>
                      {r.status === 'done' ? (
                        <>
                          <span data-no-translate>{`→ ${baseName(r.output!)}`}</span>
                          {r.message ? <span data-no-translate>{` (${r.message})`}</span> : null}
                        </>
                      ) : (
                        <span>{r.message}</span>
                      )}
                    </span>
                  ) : null}
                  {!running && !results ? (
                    <button type="button" aria-label="Remove" className="rounded p-0.5 hover-app" onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>
                      <X size={12} />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-app px-3 py-4 text-center text-[12px] text-muted">No files yet. Add PDFs or a folder.</p>
        )}
        {progress && running ? (
          <p className="mt-1 text-[11px] text-muted" data-testid="batchsign-progress">
            File {Math.min(progress.done + 1, progress.total)} of {progress.total}: <span data-no-translate>{progress.current}</span>
          </p>
        ) : null}
        {finished ? <p className="mt-1 text-[11px] text-muted" data-testid="batchsign-summary">{`${done} of ${results!.length} file(s) signed.`}</p> : null}
      </div>

      {otpAsk ? (
        <div className="mb-3 rounded-lg border border-amber-300 p-3" data-testid="batchsign-otp-again">
          <p className="mb-2 text-[12px]">Your provider allows only a limited number of signatures per authorization. Enter a new one-time code for the next files.</p>
          <div className="flex gap-2">
            <Input autoComplete="one-time-code" inputMode="numeric" value={otpAgain} onChange={(e) => setOtpAgain(e.target.value)} />
            {cred?.otp?.online && client ? (
              <Button onClick={() => void client.sendOtp(cred).catch(fail)}>
                <Send size={13} /> Send code
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={!otpAgain}
              onClick={() => {
                const code = otpAgain;
                setOtpAgain('');
                otpAsk.resolve(code);
                setOtpAsk(null);
              }}
            >
              Continue
            </Button>
            <Button
              onClick={() => {
                setOtpAgain('');
                otpAsk.resolve(null);
                setOtpAsk(null);
              }}
            >
              Stop
            </Button>
          </div>
        </div>
      ) : null}

      <fieldset disabled={running} className="min-w-0">
        {/* ------------------------------------------------ identity */}
        <div className="mb-1 text-xs font-semibold">Digital ID</div>
        <Tabs
          value={source}
          onChange={(s) => {
            setSource(s);
            setError(null);
          }}
          tabs={[
            { value: 'pfx', label: 'Certificate file' },
            { value: 'store', label: 'Windows certificate' },
            { value: 'token', label: 'Token / smart card' },
            { value: 'cloud', label: 'Cloud signature' },
          ]}
        />
        {source === 'pfx' ? (
          <div className="mb-3">
            <div className="mb-2 flex items-center gap-2">
              <Button
                onClick={async () => {
                  const f = (await pickFiles([{ name: 'Digital IDs', extensions: ['pfx', 'p12'] }]))[0];
                  if (f) {
                    setPfx({ name: f.name, bytes: f.bytes });
                    setIdentity(null);
                  }
                }}
              >
                <FolderOpen size={14} /> Choose certificate…
              </Button>
              <span className="truncate text-xs text-muted" data-no-translate>
                {pfx?.name ?? ''}
              </span>
            </div>
            {pfx && !identity ? (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field label="Certificate password" hint="Asked once for all the files; kept only while this window is open.">
                    <Input type="password" autoComplete="off" value={pfxPass} onChange={(e) => setPfxPass(e.target.value)} data-testid="batchsign-pfx-password" />
                  </Field>
                </div>
                <Button
                  className="mb-3"
                  onClick={() => {
                    try {
                      setIdentity(loadP12(pfx.bytes, pfxPass));
                      setPfxPass('');
                      setError(null);
                    } catch (e) {
                      fail(e);
                    }
                  }}
                  data-testid="batchsign-unlock"
                >
                  <KeyRound size={14} /> Unlock
                </Button>
              </div>
            ) : null}
            {identity ? (
              <p className="text-[12px]" data-testid="batchsign-identity">
                <span data-no-translate>{identity.name}</span>
                <span className="text-muted"> · </span>
                <span className="text-muted" data-no-translate>
                  {identity.selfSigned ? '' : (/CN=([^,]+)/.exec(identity.issuer)?.[1] ?? identity.issuer)}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
        {source === 'store' ? (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted">Certificates with a private key</span>
              <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void loadStore()}>
                <RefreshCw size={14} />
              </Button>
            </div>
            {storeCerts?.length ? (
              <div className="mb-2 max-h-36 overflow-auto rounded-lg border border-app">
                {storeCerts.map((c) => {
                  const info = certName(c.derBase64);
                  return (
                    <label key={c.thumbprint} className={cn('flex items-center gap-2 border-b border-app px-3 py-1.5 text-xs last:border-b-0', c.thumbprint === storeSel && 'bg-brand-50 dark:bg-brand-900/30')}>
                      <input type="radio" name="batchsign-store" checked={c.thumbprint === storeSel} onChange={() => setStoreSel(c.thumbprint)} />
                      <span className="font-medium" data-no-translate>
                        {info?.name ?? c.thumbprint}
                      </span>
                      <span className="truncate text-muted" data-no-translate>
                        {info ? `${info.issuer} · ${info.validTo.toLocaleDateString()}` : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : storeCerts ? (
              <Callout kind="info">No certificate with a private key is installed.</Callout>
            ) : null}
            <p className="text-[11px] text-muted">
              Windows asks for the PIN. Smart card drivers usually remember it until Adika is closed, so it is asked once; some qualified cards ask for every signature — that is the card driver, not Adika.
            </p>
          </div>
        ) : null}
        {source === 'token' ? (
          <div className="mb-3">
            <Field label="Token driver (PKCS#11 module)">
              <div className="flex gap-2">
                <select aria-label="PKCS#11 module" className="h-8 min-w-0 flex-1 rounded-md border border-app bg-panel-2 px-2 text-[13px]" value={module} onChange={(e) => void scanTokens(e.target.value)} data-no-translate>
                  {module && !modules.some((m) => m.path === module) ? <option value={module}>{module}</option> : null}
                  {modules.map((m) => (
                    <option key={m.path} value={m.path}>
                      {m.vendor} — {m.path}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={async () => {
                    const p = (await pickPaths([{ name: 'PKCS#11 module', extensions: ['dll'] }]))[0];
                    if (p) void scanTokens(p);
                  }}
                >
                  Browse…
                </Button>
              </div>
            </Field>
            {busy === 'tokens' ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted">
                <Loader2 size={14} className="animate-spin" /> Reading tokens…
              </div>
            ) : null}
            {tokens?.map((t) =>
              t.certificates.map((c) => {
                const active = tokenSel?.slotId === t.slotId && tokenSel.cert.idHex === c.idHex;
                return (
                  <label key={`${t.slotId}-${c.idHex}`} className={cn('flex items-center gap-2 rounded px-2 py-1 text-xs', active && 'bg-brand-50 dark:bg-brand-900/30')}>
                    <input type="radio" name="batchsign-token" checked={active} onChange={() => setTokenSel({ slotId: t.slotId, cert: c })} />
                    <Usb size={13} className="text-brand-600" />
                    <span className="font-medium" data-no-translate>
                      {c.label || certName(c.derBase64)?.name || c.idHex.slice(0, 8)}
                    </span>
                    <span className="text-muted" data-no-translate>
                      {t.label}
                    </span>
                  </label>
                );
              }),
            )}
            {tokens && !tokens.some((t) => t.certificates.length) ? <Callout kind="warn">No token found. Insert your token or card and press refresh.</Callout> : null}
            {tokenSel ? (
              pinPad ? (
                <Callout kind="info">This reader has a PIN pad: you enter the PIN on the device.</Callout>
              ) : (
                <Field label="Token PIN" hint="Entered once: Adika logs in to the token for the whole batch and logs out at the end. Keys that need the PIN for every signature get it from Adika until the batch ends; it is never stored.">
                  <Input type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} data-testid="batchsign-pin" />
                </Field>
              )
            ) : null}
          </div>
        ) : null}
        {source === 'cloud' ? (
          <div className="mb-3">
            {providers.length === 0 ? (
              <Callout kind="info">Add your signing service first in Sign → Cloud signature.</Callout>
            ) : (
              <>
                <div className="mb-2 flex gap-2">
                  <select aria-label="Signing service" className="h-8 min-w-0 flex-1 rounded-md border border-app bg-panel-2 px-2 text-[13px]" value={providerId ?? ''} onChange={(e) => void pickProvider(e.target.value)} data-no-translate>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.baseUrl}
                      </option>
                    ))}
                  </select>
                  {client && !creds ? (
                    <Button
                      variant="primary"
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy('cloud');
                        try {
                          await client.signIn();
                          await loadCreds(client);
                        } catch (e) {
                          fail(e);
                          setBusy(null);
                        }
                      }}
                    >
                      <LogIn size={14} /> Sign in
                    </Button>
                  ) : null}
                </div>
                {busy === 'cloud' ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-muted">
                    <Loader2 size={14} className="animate-spin" /> Waiting for the signing service…
                  </div>
                ) : null}
                {creds?.map((c) => (
                  <label key={c.id} className={cn('flex items-center gap-2 rounded px-2 py-1 text-xs', c.id === credSel && 'bg-brand-50 dark:bg-brand-900/30')}>
                    <input type="radio" name="batchsign-cred" checked={c.id === credSel} onChange={() => setCredSel(c.id)} />
                    <Cloud size={13} className="text-brand-600" />
                    <span className="font-medium" data-no-translate>
                      {c.name}
                    </span>
                    <span className="text-muted" data-no-translate>
                      {c.description}
                    </span>
                  </label>
                ))}
                {cred ? (
                  <>
                    <p className="my-1 text-[11px] text-muted" data-testid="batchsign-multisign">
                      {cred.authMode === 'oauth2code'
                        ? `Confirm in the browser once for every ${cred.multisign} file(s).`
                        : `One authorization covers up to ${cred.multisign} file(s) (your provider's limit).`}
                    </p>
                    {cred.pin ? (
                      <Field label="PIN">
                        <Input type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
                      </Field>
                    ) : null}
                    {cred.otp ? (
                      <Field label="One-time code">
                        <div className="flex gap-2">
                          <Input autoComplete="one-time-code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} />
                          {cred.otp.online && client ? (
                            <Button onClick={() => void client.sendOtp(cred).catch(fail)}>
                              <Send size={14} /> Send code
                            </Button>
                          ) : null}
                        </div>
                      </Field>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {/* ------------------------------------------------ options */}
        <div className="mb-1 text-xs font-semibold">Signature</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Location">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="Contact">
            <Input value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
        </div>
        <Checkbox checked={useTsa} label="Add a trusted timestamp (RFC 3161, needs internet)" onChange={setUseTsa} />
        {useTsa ? (
          <Field label="Timestamp authority URL">
            <Input value={tsaUrl} onChange={(e) => setTsaUrl(e.target.value)} />
          </Field>
        ) : null}
        <Checkbox checked={ltv} label="Add long-term validation data (LTV: the signature can be verified offline for years; needs internet)" onChange={setLtv} />
        {ltv && useTsa ? <Checkbox checked={archive} label="Add an archive timestamp over the signature and validation data (PAdES B-LTA)" onChange={setArchive} /> : null}
        <Checkbox checked={pades} label="EU format: PAdES baseline (eIDAS)" onChange={setPades} />
        <p className="mb-2 text-[11px] text-muted" data-testid="batchsign-level">
          {level ? `Signature level: PAdES ${level}` : 'Classic PDF signature (adbe.pkcs7.detached)'}
        </p>
        <Field label="Certify" hint="Only files without signatures are certified; files that are already signed get an approval signature.">
          <Select
            value={String(certify)}
            ariaLabel="Certify"
            onChange={(v: string) => setCertify(Number(v) as 0 | 1 | 2 | 3)}
            options={[
              { value: '0', label: 'No: an approval signature' },
              { value: '1', label: 'Certify: no changes allowed' },
              { value: '2', label: 'Certify: filling in forms and signing allowed' },
              { value: '3', label: 'Certify: forms, signing and comments allowed' },
            ]}
          />
        </Field>

        {/* ------------------------------------------------ appearance */}
        <div className="mb-1 text-xs font-semibold">Appearance</div>
        <Checkbox checked={useField} label="Sign into an empty signature field when the file has one named:" onChange={setUseField} />
        {useField ? (
          <div className="mb-2 pl-6">
            <Input value={fieldName} onChange={(e) => setFieldName(e.target.value)} aria-label="Signature field name" data-testid="batchsign-field" />
          </div>
        ) : null}
        <div className="grid grid-cols-3 gap-3">
          <Field label={useField ? 'Otherwise' : 'Visible signature'}>
            <Select
              value={visible ? 'visible' : 'invisible'}
              ariaLabel="Visible signature"
              onChange={(v: string) => setVisible(v === 'visible')}
              options={[
                { value: 'visible', label: 'Visible, at a fixed position' },
                { value: 'invisible', label: 'Invisible (no visible badge)' },
              ]}
            />
          </Field>
          <Field label="Page">
            <div className="flex gap-2">
              <Select
                value={pageChoice}
                ariaLabel="Signature page"
                disabled={!visible}
                onChange={(v: PageChoice) => setPageChoice(v)}
                options={[
                  { value: 'first', label: 'First page' },
                  { value: 'last', label: 'Last page' },
                  { value: 'number', label: 'Page number' },
                ]}
              />
              {pageChoice === 'number' ? <Input type="number" min={1} className="w-16" value={pageNumber} disabled={!visible} onChange={(e) => setPageNumber(Number(e.target.value) || 1)} aria-label="Page number" /> : null}
            </div>
          </Field>
          <Field label="Corner">
            <Select
              value={corner}
              ariaLabel="Corner"
              disabled={!visible}
              onChange={(v: SignCorner) => setCorner(v)}
              options={[
                { value: 'bottom-right', label: 'Bottom-right corner' },
                { value: 'bottom-left', label: 'Bottom-left corner' },
                { value: 'top-right', label: 'Top-right corner' },
                { value: 'top-left', label: 'Top-left corner' },
              ]}
            />
          </Field>
        </div>
        {visible ? (
          <div className="grid grid-cols-5 gap-3">
            <Field label="From the side (pt)">
              <Input type="number" value={offset.x} onChange={(e) => setOffset({ ...offset, x: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="From the edge (pt)">
              <Input type="number" value={offset.y} onChange={(e) => setOffset({ ...offset, y: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Width (pt)">
              <Input type="number" value={size.width} onChange={(e) => setSize({ ...size, width: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Height (pt)">
              <Input type="number" value={size.height} onChange={(e) => setSize({ ...size, height: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Signature image">
              <Select
                value={ink}
                ariaLabel="Signature image"
                onChange={(v: string) => setInk(v)}
                options={[{ value: '', label: 'None' }, ...savedSigs.map((s, i) => ({ value: s.src, label: s.signerName || `Saved signature ${i + 1}` }))]}
              />
            </Field>
          </div>
        ) : null}

        {/* ------------------------------------------------ output */}
        <div className="mb-1 text-xs font-semibold">Save</div>
        <div className="mb-2 grid gap-1 text-[12.5px]">
          <label className="flex items-center gap-2">
            <input type="radio" name="batchsign-out" checked={outMode === 'suffix'} onChange={() => setOutMode('suffix')} />
            Next to the originals, with a suffix
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="batchsign-out" checked={outMode === 'folder'} onChange={() => setOutMode('folder')} data-testid="batchsign-out-folder" />
            Into a folder
            {outMode === 'folder' ? (
              <>
                <Button
                  size="sm"
                  onClick={async () => {
                    const f = await pickFolder();
                    if (f) setOutFolder(f);
                  }}
                >
                  <FolderOpen size={13} /> Choose…
                </Button>
                <span className="truncate text-muted" data-no-translate>
                  {outFolder ?? ''}
                </span>
              </>
            ) : null}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="batchsign-out" checked={outMode === 'replace'} onChange={() => setOutMode('replace')} data-testid="batchsign-out-replace" />
            Replace the originals
          </label>
        </div>
        {outMode !== 'replace' ? (
          <Field label="Suffix" hint={outMode === 'folder' ? 'May be empty in another folder. Existing files are never overwritten: a number is added.' : 'Existing files are never overwritten: a number is added.'}>
            <Input value={suffix} onChange={(e) => setSuffix(e.target.value)} className="w-40" data-testid="batchsign-suffix" />
          </Field>
        ) : (
          <Callout kind="warn">Each original is replaced only after its signed version is complete; files that fail or are skipped stay as they are.</Callout>
        )}
      </fieldset>
      {note ? <Callout kind="info">{note}</Callout> : null}
      {error ? <Callout kind="error">{error}</Callout> : null}
    </Dialog>
  );
}
