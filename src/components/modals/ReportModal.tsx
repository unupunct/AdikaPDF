/** Report a problem / Suggest a feature / Report this crash: shows exactly what GitHub will get, then opens it or copies it. */
import { useMemo, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Tabs, Textarea } from '@/components/ui/primitives';
import { onlineAllowed, usePolicy } from '@/lib/policy';
import { openExternal } from '@/lib/platform';
import { reportText, reportUrl, type ReportDraft, type ReportKind } from '@/lib/report';
import { copyText, crashPromptsOff, setCrashPromptsOff, useReport } from '@/actions/report';

export function ReportModal() {
  const { open, kind, title, crash, env } = useReport();
  const allowed = usePolicy((s) => onlineAllowed('report', s.policies));
  const [dontAsk, setDontAsk] = useState(crashPromptsOff);
  const close = () => useReport.setState({ open: false });
  const draft: ReportDraft | null = useMemo(() => (env ? { kind, title, env, crashLog: crash?.text.trim() || undefined } : null), [kind, title, env, crash]);
  const text = draft ? reportText(draft) : '';
  if (!open || !draft) return null;
  const toast = usePDFStore.getState().toast;

  const copy = async () => {
    if (await copyText(text)) toast('Copied. Paste it into a new issue on GitHub, or send it to your IT department.', 'success');
    else toast('Could not copy to the clipboard.', 'error');
  };
  const openGitHub = async () => {
    const { url, crashLogOmitted } = reportUrl(draft);
    if (crashLogOmitted) {
      const ok = await copyText(draft.crashLog ?? '');
      toast(ok ? 'The crash report is too long for the address, so it was copied: paste it into the Crash report box on GitHub.' : 'The crash report is too long for the address: use Copy text and paste it on GitHub.', 'info');
    }
    try {
      await openExternal(url);
      close();
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={crash ? 'Report this crash' : kind === 'bug' ? 'Report a problem' : 'Suggest a feature'}
      description="Adika sends nothing by itself. This is the text a new GitHub issue will start with; you can still change it there before submitting. No document content, file names or paths are included."
      width={620}
      testId="report-modal"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button onClick={() => void copy()} data-testid="report-copy">
            <Copy size={13} /> Copy text
          </Button>
          <Button variant="primary" disabled={!allowed} onClick={() => void openGitHub()} data-testid="report-open">
            <ExternalLink size={13} /> Open GitHub
          </Button>
        </>
      }
    >
      {!crash ? (
        <Tabs<ReportKind>
          value={kind}
          onChange={(k) => useReport.setState({ kind: k })}
          tabs={[
            { value: 'bug', label: 'Report a problem' },
            { value: 'feature', label: 'Suggest a feature' },
          ]}
        />
      ) : null}
      {!allowed ? (
        <Callout kind="warn">
          <span data-testid="report-blocked">Opening GitHub is turned off by your organisation. Copy the text and send it to your IT department, or paste it into an issue from another computer.</span>
        </Callout>
      ) : null}
      <Field label="Title">
        <Input value={title} onChange={(e) => useReport.setState({ title: e.target.value })} placeholder={kind === 'bug' ? 'In a few words: what goes wrong?' : 'In a few words: what would you like?'} data-testid="report-title" data-autofocus />
      </Field>
      {crash ? (
        <Field label="Crash report" hint="Paths, document names, e-mail addresses and your Windows user name were replaced. Read it and remove anything else you do not want to share.">
          <Textarea
            value={crash.text}
            onChange={(e) => useReport.setState({ crash: { ...crash, text: e.target.value } })}
            rows={8}
            spellCheck={false}
            className="font-mono text-[11px]"
            data-no-translate
            data-testid="report-crash"
          />
        </Field>
      ) : null}
      <div className="mb-1 text-xs font-semibold">Pre-filled text</div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-app bg-panel-2 p-2 font-mono text-[11px]" data-no-translate data-testid="report-preview" tabIndex={0} aria-label="Pre-filled text">
        {text}
      </pre>
      {crash ? (
        <div className="mt-2">
          <Checkbox
            checked={dontAsk}
            onChange={(v) => {
              setDontAsk(v);
              setCrashPromptsOff(v);
            }}
            label="Don't offer crash reports again"
          />
        </div>
      ) : null}
    </Dialog>
  );
}
