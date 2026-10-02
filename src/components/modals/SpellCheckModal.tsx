/** Comment → Check spelling (F7): walks the misspelt words of comments, text boxes and filled form fields. */
import { useEffect, useMemo, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { useLang } from '@/lib/i18n';
import { Button, Callout, Dialog, Input, Select } from '@/components/ui/primitives';
import { applyChange, defaultSpellLang, issuesOf, type SpellIssue } from '@/lib/spell';
import { errorMessage } from '@/actions/document';

const LANG_KEY = 'adika.spellLang';

export function SpellCheckModal() {
  const open = usePDFStore((s) => s.modal === 'spell');
  const uiLang = useLang((s) => s.lang);
  const close = () => usePDFStore.getState().openModal(null);
  const [langs, setLangs] = useState<string[] | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [issues, setIssues] = useState<SpellIssue[] | null>(null);
  const [checked, setChecked] = useState(0);
  const [changes, setChanges] = useState(0);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [changeTo, setChangeTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (l: string) => {
    setIssues(null);
    setError(null);
    try {
      const { collectSpellTargets, spellCheckTexts } = await import('@/actions/spell');
      const targets = await collectSpellTargets();
      const found = targets.length ? await spellCheckTexts(l, targets.map((t) => t.text)) : [];
      setChecked(targets.length);
      setIssues(issuesOf(targets, found));
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg.startsWith('NO_LANGUAGE') ? 'Windows has no spell checker for this language. Add the language in Windows Settings → Time & language.' : msg);
      setIssues([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    setChanges(0);
    setIgnored(new Set());
    void (async () => {
      const { spellLanguages } = await import('@/actions/spell');
      const list = await spellLanguages().catch(() => []);
      setLangs(list);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(LANG_KEY);
      } catch {
        /* no storage */
      }
      const l = defaultSpellLang(uiLang, list, remembered);
      setLang(l);
      if (l) await run(l);
      else setIssues([]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Words ignored with "Ignore all" stay out.
  const visible = useMemo(() => (issues ?? []).filter((i) => !ignored.has(i.word.toLowerCase())), [issues, ignored]);
  const cur = visible[0] ?? null;

  useEffect(() => {
    if (!cur) return;
    setChangeTo(cur.action === 'delete' ? '' : cur.action === 'replace' ? cur.replacement : (cur.suggestions[0] ?? cur.word));
    if (cur.target.pageId) usePDFStore.getState().navigateTo(cur.target.pageId);
    if (cur.target.key.startsWith('obj:')) usePDFStore.setState({ selectedIds: [cur.target.key.slice(4)] });
  }, [cur]);

  const skip = (all: boolean) => {
    if (!cur || !issues) return;
    if (all) setIgnored(new Set([...ignored, cur.word.toLowerCase()]));
    else setIssues(issues.filter((i) => i !== cur));
  };

  const change = async (all: boolean) => {
    if (!cur || !issues) return;
    setBusy(true);
    try {
      const { applySpellText } = await import('@/actions/spell');
      let list = issues;
      let n = 0;
      const word = cur.word;
      // One target at a time; "Change all" repeats for every place the word occurs.
      for (;;) {
        const idx = list.findIndex((i) => (all ? i.word === word : i === cur || (i.target.key === cur.target.key && i.start === cur.start)));
        if (idx < 0) break;
        const { text, rest } = applyChange(list, idx, changeTo);
        await applySpellText(list[idx].target, text);
        list = rest;
        n++;
        if (!all) break;
      }
      setIssues(list);
      setChanges((c) => c + n);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!cur || !lang) return;
    const { addToDictionary } = await import('@/actions/spell');
    await addToDictionary(lang, cur.word).catch((e: unknown) => usePDFStore.getState().toast(errorMessage(e), 'error'));
    setIgnored(new Set([...ignored, cur.word.toLowerCase()]));
  };

  const what = cur?.action === 'delete' ? 'Repeated word' : cur?.action === 'replace' ? 'Usually corrected' : 'Not in the dictionary';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Check spelling" width={540} testId="spell-modal" footer={<Button onClick={close}>Close</Button>}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Language</span>
          {langs && langs.length ? (
            <Select
              value={lang ?? ''}
              ariaLabel="Spelling language"
              options={langs.map((l) => ({ value: l, label: languageName(l) }))}
              onChange={(l) => {
                setLang(l);
                try {
                  localStorage.setItem(LANG_KEY, l);
                } catch {
                  /* no storage */
                }
                void run(l);
              }}
            />
          ) : null}
        </div>
        {langs && !langs.length ? <Callout kind="warn">The Windows spell checker is not available on this computer.</Callout> : null}
        {error ? <Callout kind="error">{error}</Callout> : null}
        {issues === null && !error ? <p className="text-muted">Checking…</p> : null}
        {issues && !cur && !error ? (
          <Callout kind="success">
            <span data-testid="spell-done">{checked === 0 ? 'There is no text to check: comments, text boxes and filled form fields are checked.' : changes ? `Spelling check complete. ${changes} change${changes === 1 ? '' : 's'} made.` : 'Spelling check complete. No mistakes found.'}</span>
          </Callout>
        ) : null}
        {cur ? (
          <>
            <div>
              <div className="mb-1 text-[11px] text-muted">
                {what} · {cur.target.label}
              </div>
              <div className="max-h-28 overflow-auto rounded-md border border-app bg-app-subtle p-2 leading-relaxed" data-no-translate data-testid="spell-context">
                {context(cur)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-muted">Change to</span>
              <Input value={changeTo} onChange={(e) => setChangeTo(e.target.value)} aria-label="Change to" data-testid="spell-change-to" data-no-translate />
            </div>
            {cur.suggestions.length ? (
              <div className="flex flex-wrap gap-1.5" data-testid="spell-suggestions" data-no-translate>
                {cur.suggestions.map((sg) => (
                  <button
                    key={sg}
                    type="button"
                    onClick={() => setChangeTo(sg)}
                    onDoubleClick={() => {
                      setChangeTo(sg);
                      void change(false);
                    }}
                    className={`rounded border px-2 py-0.5 text-xs ${sg === changeTo ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40' : 'border-app hover-app'}`}
                  >
                    {sg}
                  </button>
                ))}
              </div>
            ) : cur.action === 'suggest' ? (
              <p className="text-xs text-muted">No suggestions.</p>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              <div className="flex gap-2">
                <Button size="sm" onClick={() => skip(false)} data-testid="spell-ignore">
                  Ignore
                </Button>
                <Button size="sm" onClick={() => skip(true)}>
                  Ignore all
                </Button>
                <Button size="sm" onClick={() => void add()} disabled={cur.action !== 'suggest'}>
                  Add to dictionary
                </Button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void change(true)}>
                  Change all
                </Button>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void change(false)} data-testid="spell-change">
                  {cur.action === 'delete' && !changeTo ? 'Delete' : 'Change'}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function context(i: SpellIssue) {
  const t = i.target.text;
  const from = Math.max(0, i.start - 80);
  const to = Math.min(t.length, i.start + i.length + 80);
  return (
    <>
      {from > 0 ? '…' : ''}
      {t.slice(from, i.start)}
      <mark className="rounded bg-rose-200 px-0.5 text-rose-900 underline decoration-rose-600 decoration-wavy">{t.slice(i.start, i.start + i.length)}</mark>
      {t.slice(i.start + i.length, to)}
      {to < t.length ? '…' : ''}
    </>
  );
}

function languageName(tag: string): string {
  try {
    const n = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return n ? `${n.charAt(0).toUpperCase()}${n.slice(1)} (${tag})` : tag;
  } catch {
    return tag;
  }
}
