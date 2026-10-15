/** Convert → ANAF e-Factura: connect to SPV with the user's registered application, upload invoices and follow them, list and download messages. */
import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Link2, Link2Off, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Tabs } from '@/components/ui/primitives';
import { translate } from '@/lib/i18n';
import { isDesktop, pickFiles } from '@/lib/platform';
import { checkAnafApp, type AnafValidation, type MessageKind, type SpvMessage, type UploadRecord } from '@/lib/einvoice/anaf';
import { detectEInvoice } from '@/lib/einvoice/parse';
import * as anaf from '@/actions/anaf';

type Tab = 'send' | 'messages' | 'uploads' | 'settings';

const KIND_LABEL: Record<MessageKind, string> = { sent: 'Sent', received: 'Received', errors: 'Errors', 'buyer-message': 'Buyer message', other: 'Other' };
const STATE_LABEL: Record<UploadRecord['state'], string> = { sent: 'Sent', processing: 'Being processed', ok: 'Accepted', nok: 'Rejected (errors)', rejected: 'Rejected at upload', unknown: 'Unknown' };
const stateClass = (s: UploadRecord['state']) => (s === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : s === 'nok' || s === 'rejected' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400');

export function AnafModal() {
  const open = usePDFStore((s) => s.modal === 'anaf');
  const close = () => usePDFStore.getState().openModal(null);
  const settings = anaf.useAnafSettings();
  const session = anaf.useAnafSession();
  const paste = anaf.useAnafPaste();
  const outbox = anaf.useAnafOutbox();
  const [tab, setTab] = useState<Tab>('send');
  const [secret, setSecret] = useState('');
  const [secretSaved, setSecretSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [cif, setCif] = useState('');
  const [current, setCurrent] = useState<UploadRecord | null>(null);
  const [validation, setValidation] = useState<AnafValidation | null>(null);
  const [messages, setMessages] = useState<SpvMessage[] | null>(null);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [pasted, setPasted] = useState('');
  const watch = useRef<AbortController | null>(null);

  const appProblem = checkAnafApp({ clientId: settings.clientId, clientSecret: secret, redirectUri: settings.redirectUri, test: settings.test });

  useEffect(() => {
    if (!open) {
      watch.current?.abort();
      anaf.cancelAnafSignIn();
      return;
    }
    setError('');
    setValidation(null);
    setCurrent(null);
    void anaf.readClientSecret().then((s) => {
      setSecret(s);
      setSecretSaved(!!s);
      if (!settings.clientId || !s || !settings.redirectUri) setTab('settings');
    });
    void anaf.readUploads().then(setUploads);
    void anaf.anafClient().catch(() => undefined);
    const x = anaf.useAnafOutbox.getState().xml;
    setCif((x && anaf.cifOfInvoice(x)) || settings.cif);
    if (x) setTab('send');
  }, [open]);

  useEffect(() => () => watch.current?.abort(), []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(anaf.anafErrorText(e));
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = () =>
    run('save', async () => {
      await anaf.saveClientSecret(secret.trim());
      setSecretSaved(!!secret.trim());
      usePDFStore.getState().toast('ANAF settings saved.', 'success');
    });

  const connect = () =>
    run('connect', async () => {
      await anaf.saveClientSecret(secret.trim());
      await anaf.connectAnaf();
      usePDFStore.getState().toast('Connected to ANAF e-Factura.', 'success');
      if (tab === 'settings') setTab('send');
    });

  const pickXml = async () => {
    const f = (await pickFiles([{ name: 'e-Factura XML', extensions: ['xml'] }], false))[0];
    if (!f) return;
    const xml = new TextDecoder('utf-8').decode(f.bytes).replace(/^﻿/, '');
    if (!detectEInvoice(xml)) {
      setError(translate('This file is not an electronic invoice (UBL, e-Factura or CII).'));
      return;
    }
    const number = /<cbc:ID>([^<]*)<\/cbc:ID>/.exec(xml)?.[1] ?? /<ram:ID>([^<]*)<\/ram:ID>/.exec(xml)?.[1] ?? f.name;
    anaf.useAnafOutbox.setState({ xml, number, name: f.name });
    setCif(anaf.cifOfInvoice(xml) || cif);
    setValidation(null);
    setCurrent(null);
  };

  const validate = () =>
    run('validate', async () => {
      if (outbox.xml) setValidation(await anaf.checkXmlWithAnaf(outbox.xml));
    });

  const startWatch = (rec: UploadRecord) => {
    watch.current?.abort();
    const ctrl = new AbortController();
    watch.current = ctrl;
    void anaf
      .watchUpload(rec, ctrl.signal, (r) => {
        setCurrent(r);
        setUploads((all) => [r, ...all.filter((u) => !(u.index === r.index && u.test === r.test))]);
      })
      .catch((e) => !ctrl.signal.aborted && setError(anaf.anafErrorText(e)));
  };

  const upload = () =>
    run('upload', async () => {
      if (!outbox.xml) return;
      settings.update({ cif });
      const rec = await anaf.uploadToAnaf(outbox.xml, outbox.number, cif);
      setCurrent(rec);
      setUploads(await anaf.readUploads());
      usePDFStore.getState().toast(`Sent to ANAF: upload index ${rec.index}.`, 'success');
      startWatch(rec);
    });

  const checkNow = (rec: UploadRecord) =>
    run(`status-${rec.index}`, async () => {
      const r = await anaf.checkUpload(rec);
      if (current?.index === r.index) setCurrent(r);
      setUploads(await anaf.readUploads());
    });

  const loadMessages = () =>
    run('messages', async () => {
      settings.update({ cif });
      setMessages(await anaf.listAnafMessages(cif, settings.days));
    });

  const download = (id: string, action: 'open' | 'save') => run(`dl-${id}-${action}`, () => anaf.downloadAnafMessage(id, action));

  const env = settings.test ? 'test' : 'production';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="ANAF e-Factura"
      description="Uploads and downloads through ANAF's SPV, only when you press a button. Your certificate is used by the browser during sign-in; Adika never sees it."
      width={860}
      testId="anaf-modal"
      footer={
        <>
          <span className="mr-auto text-xs text-muted" data-testid="anaf-connection">
            {session.connected ? (settings.test ? 'Connected to ANAF (test environment).' : 'Connected to ANAF.') : 'Not connected to ANAF.'}
          </span>
          {session.connected ? (
            <Button onClick={() => void run('disconnect', anaf.disconnectAnaf)} data-testid="anaf-disconnect">
              <Link2Off size={14} /> Disconnect
            </Button>
          ) : (
            <Button variant="primary" disabled={!!appProblem || !!busy} onClick={() => void connect()} data-testid="anaf-connect">
              <Link2 size={14} /> Connect…
            </Button>
          )}
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'send', label: 'Send' },
          { value: 'messages', label: 'Messages' },
          { value: 'uploads', label: 'Sent log' },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      {settings.test ? <Callout kind="warn">ANAF test environment: invoices sent here have no legal effect.</Callout> : null}
      {paste.waiting ? (
        <Callout kind="info">
          <p className="mb-1">Sign in to ANAF in the browser. When it ends on your callback page, copy the whole address from the browser&apos;s address bar and paste it here.</p>
          <div className="flex gap-2">
            <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…?code=…&state=…" data-testid="anaf-callback" />
            <Button variant="primary" disabled={!pasted.trim()} onClick={() => { anaf.submitCallback(pasted); setPasted(''); }}>
              Continue
            </Button>
            <Button onClick={() => anaf.submitCallback(null)}>Cancel</Button>
          </div>
        </Callout>
      ) : null}
      {busy === 'connect' && !paste.waiting ? (
        <Callout kind="info">
          Waiting for the sign-in in the browser…{' '}
          <button type="button" className="underline" onClick={anaf.cancelAnafSignIn}>
            Cancel
          </button>
        </Callout>
      ) : null}
      {error ? (
        <Callout kind="error">
          <span className="whitespace-pre-wrap" data-no-translate data-testid="anaf-error">
            {error}
          </span>
        </Callout>
      ) : null}

      {tab === 'send' ? (
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Invoice">
                <div className="flex h-8 items-center rounded-md border border-app bg-panel-2 px-2.5 text-[13px]" data-no-translate data-testid="anaf-outbox">
                  {outbox.xml ? outbox.name : '—'}
                </div>
              </Field>
            </div>
            <div className="mb-3">
              <Button onClick={() => void pickXml()}>
                <FolderOpen size={14} /> Choose XML…
              </Button>
            </div>
            <div className="w-40">
              <Field label="CUI (SPV)">
                <Input value={cif} onChange={(e) => setCif(e.target.value)} data-testid="anaf-cif" />
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!outbox.xml || !!busy} onClick={() => void validate()} data-testid="anaf-validate">
              <ShieldCheck size={14} /> Check with ANAF
            </Button>
            <Button variant="primary" disabled={!outbox.xml || !cif.trim() || !session.connected || !!busy} onClick={() => void upload()} data-testid="anaf-upload">
              <Upload size={14} /> {settings.test ? 'Send to ANAF (test)' : 'Send to ANAF'}
            </Button>
          </div>
          {validation ? <ValidationResult v={validation} /> : null}
          {current ? (
            <div className="rounded-lg border border-app p-3 text-xs" data-testid="anaf-current">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {translate('Upload index')}{' '}
                  <b data-no-translate>{current.index}</b> · <span className={stateClass(current.state)}>{translate(STATE_LABEL[current.state])}</span>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" disabled={!!busy} onClick={() => void checkNow(current)}>
                    <RefreshCw size={13} /> Check status
                  </Button>
                  {current.downloadId ? (
                    <Button size="sm" disabled={!!busy} onClick={() => void download(current.downloadId, current.state === 'ok' ? 'open' : 'save')}>
                      <Download size={13} /> {current.state === 'ok' ? 'Open' : 'Save'}
                    </Button>
                  ) : null}
                </span>
              </div>
              {current.state === 'sent' || current.state === 'processing' ? <p className="mt-1 text-muted">ANAF is processing the invoice. The status is checked every 30 seconds while this window is open (at most 10 minutes).</p> : null}
              {current.errors.length ? (
                <ul className="mt-1 list-disc pl-4 text-rose-600 dark:text-rose-400" data-no-translate>
                  {current.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {!session.connected ? <p className="text-xs text-muted">Connect to ANAF to send invoices. Checking with ANAF needs no connection.</p> : null}
        </div>
      ) : null}

      {tab === 'messages' ? (
        <div className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-end gap-2">
            <div className="w-40">
              <Field label="CUI">
                <Input value={cif} onChange={(e) => setCif(e.target.value)} />
              </Field>
            </div>
            <div className="w-32">
              <Field label="Last days (1–60)">
                <Input type="number" min={1} max={60} value={settings.days} onChange={(e) => settings.update({ days: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })} />
              </Field>
            </div>
            <div className="mb-3">
              <Button variant="primary" disabled={!session.connected || !cif.trim() || !!busy} onClick={() => void loadMessages()} data-testid="anaf-list">
                <RefreshCw size={14} /> Show messages
              </Button>
            </div>
          </div>
          {messages ? (
            messages.length ? (
              <table className="w-full text-xs" data-testid="anaf-messages">
                <thead className="text-left text-[11px] text-muted">
                  <tr>
                    <th className="pb-1 font-normal">Date</th>
                    <th className="pb-1 font-normal">Type</th>
                    <th className="pb-1 font-normal">Details</th>
                    <th className="w-44" />
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id} className="border-t border-app align-top">
                      <td className="py-1 pr-2 whitespace-nowrap" data-no-translate>
                        {m.created}
                      </td>
                      <td className="py-1 pr-2">{translate(KIND_LABEL[m.kind])}</td>
                      <td className="py-1 pr-2" data-no-translate>
                        {m.details}
                      </td>
                      <td className="py-1 text-right">
                        <span className="flex justify-end gap-1">
                          {m.kind !== 'errors' ? (
                            <Button size="sm" disabled={!!busy} onClick={() => void download(m.id, 'open')}>
                              <FileUp size={13} /> Open
                            </Button>
                          ) : null}
                          <Button size="sm" disabled={!!busy} onClick={() => void download(m.id, 'save')}>
                            <Download size={13} /> Save
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-muted">No messages in this period.</p>
            )
          ) : (
            <p className="text-xs text-muted">Invoices you sent, invoices you received and error reports from ANAF, kept by ANAF for 60 days.</p>
          )}
        </div>
      ) : null}

      {tab === 'uploads' ? (
        uploads.length ? (
          <table className="w-full text-xs" data-testid="anaf-uploads">
            <thead className="text-left text-[11px] text-muted">
              <tr>
                <th className="pb-1 font-normal">Sent</th>
                <th className="pb-1 font-normal">Invoice</th>
                <th className="pb-1 font-normal">CUI</th>
                <th className="pb-1 font-normal">Upload index</th>
                <th className="pb-1 font-normal">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={`${u.test}-${u.index}`} className="border-t border-app">
                  <td className="py-1 pr-2" data-no-translate>
                    {u.at.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="py-1 pr-2" data-no-translate>
                    {u.number}
                    {u.test ? ' (test)' : ''}
                  </td>
                  <td className="py-1 pr-2" data-no-translate>
                    {u.cif}
                  </td>
                  <td className="py-1 pr-2" data-no-translate>
                    {u.index}
                  </td>
                  <td className={`py-1 pr-2 ${stateClass(u.state)}`}>{translate(STATE_LABEL[u.state])}</td>
                  <td className="py-1 text-right">
                    <span className="flex justify-end gap-1">
                      {u.test === settings.test && u.state !== 'ok' && u.state !== 'nok' && u.state !== 'rejected' ? (
                        <Button size="sm" disabled={!session.connected || !!busy} onClick={() => void checkNow(u)}>
                          <RefreshCw size={13} /> Check status
                        </Button>
                      ) : null}
                      {u.test === settings.test && u.downloadId ? (
                        <Button size="sm" disabled={!session.connected || !!busy} onClick={() => void download(u.downloadId, 'save')}>
                          <Download size={13} /> Save
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted">Nothing sent to ANAF from this computer yet.</p>
        )
      ) : null}

      {tab === 'settings' ? (
        <div className="text-[13px]">
          <Callout kind="info">
            Sending to SPV needs an application registered by you in ANAF&apos;s portal (anaf.ro → Servicii online → Înregistrare utilizatori → Dezvoltatori aplicații) for the e-Factura service. Enter its client ID, client secret and callback URL exactly as registered. A callback of the form http://localhost:&lt;port&gt;/callback lets Adika receive the sign-in directly; with any other callback you paste the final address back.
          </Callout>
          <Field label="Client ID">
            <Input value={settings.clientId} onChange={(e) => settings.update({ clientId: e.target.value.trim() })} data-testid="anaf-client-id" />
          </Field>
          <Field label="Client secret" hint={isDesktop ? 'Kept in Windows Credential Manager.' : 'Kept in this browser\'s storage (the desktop app uses Windows Credential Manager).'}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={secretSaved ? '••••••••' : ''} data-testid="anaf-client-secret" />
          </Field>
          <Field label="Callback URL">
            <Input value={settings.redirectUri} onChange={(e) => settings.update({ redirectUri: e.target.value.trim() })} placeholder="http://localhost:8765/callback" data-testid="anaf-redirect" />
          </Field>
          <Checkbox checked={settings.test} onChange={(v) => settings.update({ test: v })} label="Use ANAF's test environment" />
          <Checkbox
            checked={settings.rememberSignIn}
            onChange={(v) => void anaf.setRememberSignIn(v)}
            disabled={!isDesktop}
            label="Stay connected: keep ANAF's refresh token in Windows Credential Manager (valid up to a year; anyone using this Windows account could send invoices)"
          />
          {appProblem ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{translate(appProblem)}</p> : null}
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void saveSettings()} disabled={!!busy}>
              Save settings
            </Button>
            <span className="text-xs text-muted" data-no-translate>
              {`${translate('Environment')}: ${translate(env)}`}
            </span>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export function ValidationResult({ v }: { v: AnafValidation }) {
  return (
    <div className="rounded-lg border border-app p-3 text-xs" data-testid="anaf-validation">
      {v.ok ? (
        <p className="font-medium text-emerald-700 dark:text-emerald-400">ANAF found no errors in the XML.</p>
      ) : (
        <p className="font-medium text-rose-600 dark:text-rose-400">ANAF found errors in the XML:</p>
      )}
      {v.messages.length ? (
        <ul className="mt-1 flex flex-col gap-1" data-no-translate>
          {v.messages.map((m, i) => (
            <li key={i}>
              {m.rule ? <span className="mr-1 font-mono text-[10px] opacity-70">{m.rule}</span> : null}
              {m.message}
            </li>
          ))}
        </ul>
      ) : null}
      {v.traceId ? (
        <p className="mt-1 text-[10px] text-muted" data-no-translate>
          trace_id {v.traceId}
        </p>
      ) : null}
    </div>
  );
}
