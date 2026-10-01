/**
 * Security → Certificate: encrypt the document for chosen people (their
 * certificates), and the dialog that asks for your certificate when opening
 * such a document.
 */
import { useEffect, useState } from 'react';
import { FileKey2, KeyRound, Lock, Trash2 } from 'lucide-react';
import forge from 'node-forge';
import { usePDFStore } from '@/store/usePDFStore';
import { useDialogs } from '@/store/useDialogs';
import { Button, Callout, Checkbox, Dialog, Field, Input, Tabs } from '@/components/ui/primitives';
import { errorMessage, exportCurrentPdf, saveDerived, withBusy } from '@/actions/document';
import { base64ToBytes, isDesktop, pickFiles, winstoreDecrypt, winstoreList, type StoreCertificate } from '@/lib/platform';
import { identityFromCertificateDer, loadP12 } from '@/lib/crypto/digitalSignature';
import type { PdfPermissions } from '@/lib/crypto/encrypt';
import { cn } from '@/lib/cn';

interface Recipient {
  id: string;
  name: string;
  detail: string;
  cert: forge.pki.Certificate;
}

function certFromFile(bytes: Uint8Array): forge.pki.Certificate {
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.includes('-----BEGIN CERTIFICATE-----')) return forge.pki.certificateFromPem(text);
  return identityFromCertificateDer(bytes).certificate;
}

const describe = (c: forge.pki.Certificate) => {
  const cn = (c.subject.getField('CN') as { value?: string } | null)?.value ?? '';
  const email = (c.subject.getField('E') as { value?: string } | null)?.value ?? '';
  const issuer = (c.issuer.getField('CN') as { value?: string } | null)?.value ?? '';
  return { name: cn || email || 'Certificate', detail: [email, issuer ? `issued by ${issuer}` : '', `until ${c.validity.notAfter.toLocaleDateString()}`].filter(Boolean).join(' · ') };
};

export function CertEncryptModal() {
  const open = usePDFStore((s) => s.modal === 'certencrypt');
  const close = () => usePDFStore.getState().openModal(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [store, setStore] = useState<StoreCertificate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [perms, setPerms] = useState<PdfPermissions>({ print: true, printHighQuality: true, modify: false, copy: false, annotate: true, fillForms: true, extractForAccessibility: true, assemble: false });

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (isDesktop) void winstoreList().then(setStore).catch(() => setStore([]));
  }, [open]);

  const add = (cert: forge.pki.Certificate) => {
    const id = forge.md.sha1.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()).digest().toHex();
    setRecipients((cur) => (cur.some((r) => r.id === id) ? cur : [...cur, { id, cert, ...describe(cert) }]));
  };

  const addFiles = async () => {
    setError(null);
    try {
      const files = await pickFiles([{ name: 'Certificates', extensions: ['cer', 'crt', 'pem', 'der'] }], true);
      for (const f of files) add(certFromFile(f.bytes));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const run = async () => {
    setError(null);
    const out = await withBusy('Encrypting for the recipients…', async (progress) => {
      const { encryptForCertificates } = await import('@/lib/crypto/pubsec');
      return encryptForCertificates(await exportCurrentPdf({}, progress), recipients.map((r) => r.cert), perms);
    });
    if (!out) return;
    await saveDerived(out, '-encrypted', false);
    close();
  };

  const mine = store.filter((c) => c.hasPrivateKey);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Encrypt for certificates"
      description="Only the people you choose can open the copy, each with the private key of their own certificate (smart card, token or digital ID). There is no password to share. Add your own certificate too if you want to open it yourself."
      width={620}
      testId="certencrypt-modal"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!recipients.length} onClick={() => void run()} data-testid="certencrypt-run">
            <Lock size={14} /> Encrypt and save
          </Button>
        </>
      }
    >
      {error ? <Callout kind="error">{error}</Callout> : null}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Recipients</span>
        <Button size="sm" onClick={() => void addFiles()} data-testid="certencrypt-add-file">
          <FileKey2 size={13} /> Add certificate files…
        </Button>
      </div>
      {recipients.length ? (
        <ul className="mb-3 rounded-md border border-app text-xs" data-testid="certencrypt-recipients">
          {recipients.map((r) => (
            <li key={r.id} className="flex items-center gap-2 border-b border-app px-2 py-1.5 last:border-0">
              <span className="font-medium" data-no-translate>
                {r.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted" data-no-translate>
                {r.detail}
              </span>
              <button type="button" aria-label="Remove recipient" className="rounded p-0.5 hover-app" onClick={() => setRecipients((cur) => cur.filter((x) => x.id !== r.id))}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 rounded-md border border-dashed border-app px-3 py-3 text-center text-xs text-muted">Add the certificates (.cer files) of the people who may open the document.</p>
      )}
      {mine.length ? (
        <div className="mb-3">
          <div className="mb-1 text-xs font-semibold">My certificates in Windows</div>
          <div className="flex flex-wrap gap-1">
            {mine.map((c) => {
              let d: { name: string } = { name: c.thumbprint.slice(0, 8) };
              try {
                d = describe(identityFromCertificateDer(base64ToBytes(c.derBase64)).certificate);
              } catch {
                /* unreadable */
              }
              return (
                <Button key={c.thumbprint} size="sm" onClick={() => add(identityFromCertificateDer(base64ToBytes(c.derBase64)).certificate)} data-testid="certencrypt-add-mine">
                  + {d.name}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-x-3 text-xs">
        <Checkbox checked={perms.print} onChange={(v) => setPerms({ ...perms, print: v, printHighQuality: v })} label="Allow printing" />
        <Checkbox checked={perms.copy} onChange={(v) => setPerms({ ...perms, copy: v })} label="Allow copying text" />
        <Checkbox checked={perms.modify} onChange={(v) => setPerms({ ...perms, modify: v, assemble: v })} label="Allow changes" />
        <Checkbox checked={perms.annotate} onChange={(v) => setPerms({ ...perms, annotate: v, fillForms: v })} label="Allow comments and form filling" />
      </div>
    </Dialog>
  );
}

/** Asked when opening a document encrypted for certificates. */
export function CertKeyDialog() {
  const prompt = useDialogs((s) => s.certKey);
  const [tab, setTab] = useState<'store' | 'file'>('store');
  const [store, setStore] = useState<StoreCertificate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setError(prompt.error);
    setPw('');
    if (isDesktop)
      void winstoreList()
        .then((l) => {
          const mine = l.filter((c) => c.hasPrivateKey);
          setStore(mine);
          setSelected(mine[0]?.thumbprint ?? null);
          setTab(mine.length ? 'store' : 'file');
        })
        .catch(() => setTab('file'));
    else setTab('file');
  }, [prompt]);

  if (!prompt) return null;
  const confirm = async () => {
    setError(null);
    try {
      if (tab === 'store') {
        const c = store.find((x) => x.thumbprint === selected);
        if (!c) return;
        const certificate = identityFromCertificateDer(base64ToBytes(c.derBase64)).certificate;
        prompt.resolve({ certificate, decryptKey: (e) => winstoreDecrypt(c.thumbprint, e) });
      } else {
        if (!file) return;
        const id = loadP12(file.bytes, pw);
        const { recipientFromPrivateKey } = await import('@/lib/crypto/pubsec');
        prompt.resolve(recipientFromPrivateKey(id.certificate, id.privateKey as forge.pki.rsa.PrivateKey));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && prompt.resolve(null)}
      title="Open with your certificate"
      description={`${prompt.fileName} is encrypted for certificates. Choose yours: its private key opens the document.`}
      width={560}
      testId="certkey-dialog"
      footer={
        <>
          <Button onClick={() => prompt.resolve(null)}>Cancel</Button>
          <Button variant="primary" disabled={tab === 'store' ? !selected : !file} onClick={() => void confirm()} data-testid="certkey-open">
            <KeyRound size={14} /> Open
          </Button>
        </>
      }
    >
      {error ? <Callout kind="error">{error}</Callout> : null}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'store', label: 'Windows certificate' },
          { value: 'file', label: 'Digital ID file (.pfx)' },
        ]}
      />
      {tab === 'store' ? (
        store.length ? (
          <div className="max-h-48 overflow-auto rounded-md border border-app text-xs">
            {store.map((c) => {
              let d = { name: c.thumbprint.slice(0, 8), detail: '' };
              try {
                d = describe(identityFromCertificateDer(base64ToBytes(c.derBase64)).certificate);
              } catch {
                /* unreadable */
              }
              return (
                <label key={c.thumbprint} className={cn('flex items-center gap-2 border-b border-app px-2 py-1.5 last:border-0', selected === c.thumbprint && 'bg-brand-50 dark:bg-brand-900/30')}>
                  <input type="radio" name="certkey" checked={selected === c.thumbprint} onChange={() => setSelected(c.thumbprint)} />
                  <span className="font-medium" data-no-translate>
                    {d.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted" data-no-translate>
                    {d.detail}
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <Callout kind="info">No certificate with a private key is installed in Windows. Use a digital ID file instead.</Callout>
        )
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <Button
              onClick={async () => {
                const f = (await pickFiles([{ name: 'Digital IDs', extensions: ['pfx', 'p12'] }]))[0];
                if (f) setFile({ name: f.name, bytes: f.bytes });
              }}
              data-testid="certkey-pick"
            >
              <FileKey2 size={14} /> Choose file…
            </Button>
            <span className="truncate text-xs text-muted" data-no-translate>
              {file?.name ?? ''}
            </span>
          </div>
          <Field label="Password of the digital ID">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void confirm()} data-testid="certkey-password" />
          </Field>
        </>
      )}
    </Dialog>
  );
}
