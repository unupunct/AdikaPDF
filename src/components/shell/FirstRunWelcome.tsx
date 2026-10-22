/**
 * The welcome shown at the first start (and from Help → Welcome screen):
 * what Adika is for, a few common tasks with their guide pages, the
 * interface language and the simple or full ribbon.
 */
import { useId, useState, type ReactNode } from 'react';
import { Combine, FileOutput, FormInput, PanelTop, PanelsTopLeft, ReceiptText, ShieldCheck, Signature, TextCursorInput } from 'lucide-react';
import { Button, Checkbox, Dialog } from '@/components/ui/primitives';
import { usePDFStore } from '@/store/usePDFStore';
import { useUiMode, type RibbonMode } from '@/store/uiMode';
import { openHelp } from '@/store/help';
import { HELP_TOPICS } from '@/lib/help/context';
import { LANGS, useLang } from '@/lib/i18n';
import { cn } from '@/lib/cn';

export type WelcomeTask = 'sign' | 'einvoice' | 'editText' | 'combine' | 'form' | 'convert';

/** Opens a PDF; true when one is open afterwards. */
async function openPdf(): Promise<boolean> {
  const { openDialog } = await import('@/actions/document');
  const before = usePDFStore.getState().pages[0]?.id;
  await openDialog();
  const s = usePDFStore.getState();
  return s.pages.length > 0 && s.pages[0]?.id !== before;
}

/** What each card does. */
export async function startTask(task: WelcomeTask): Promise<void> {
  const s = () => usePDFStore.getState();
  switch (task) {
    case 'sign':
      if (await openPdf()) {
        s().setRibbonTab('sign');
        s().openModal('signature');
      }
      return;
    case 'einvoice':
      return (await import('@/actions/einvoiceCreate')).openNewEInvoice();
    case 'editText':
      if (await openPdf()) {
        s().setTool('editText');
        s().toast('Click any existing text to replace it', 'info');
      }
      return;
    case 'combine':
      return (await import('@/components/modals/ToolsModal')).startQuickTool('merge');
    case 'form':
      if (await openPdf()) usePDFStore.setState({ inspectorOpen: true, selectedIds: [] });
      return;
    case 'convert':
      s().openModal('tools');
      return;
  }
}

const TASKS: Array<{ id: WelcomeTask; title: string; text: string; icon: ReactNode; help: string }> = [
  { id: 'sign', title: 'Sign a PDF', text: 'Your handwritten signature, or a digital one with a certificate or token', icon: <Signature size={20} />, help: HELP_TOPICS.welcomeSign },
  { id: 'einvoice', title: 'Create an e-Factura', text: 'Issue an invoice, check it and send it to ANAF', icon: <ReceiptText size={20} />, help: HELP_TOPICS.welcomeInvoice },
  { id: 'editText', title: 'Edit text in a PDF', text: 'Click a line and type, in the document’s own font', icon: <TextCursorInput size={20} />, help: HELP_TOPICS.welcome },
  { id: 'combine', title: 'Combine PDFs', text: 'Several files into one, in the order you choose', icon: <Combine size={20} />, help: HELP_TOPICS.welcome },
  { id: 'form', title: 'Fill in a form', text: 'Type into the fields of a PDF form, then save or print it', icon: <FormInput size={20} />, help: HELP_TOPICS.welcome },
  { id: 'convert', title: 'Convert to Word or Excel', text: 'And pictures, PowerPoint, or Office files to PDF', icon: <FileOutput size={20} />, help: HELP_TOPICS.welcome },
];

export function FirstRunWelcome() {
  const open = useUiMode((u) => u.welcome);
  return open ? <WelcomeDialog /> : null;
}

function WelcomeDialog() {
  const mode = useUiMode((u) => u.mode);
  const lang = useLang((l) => l.lang);
  const [hide, setHide] = useState(true);
  const close = () => useUiMode.getState().closeWelcome(!hide);
  const run = (task: WelcomeTask) => {
    close();
    void startTask(task).catch((e: unknown) => usePDFStore.getState().toast(String(e), 'error'));
  };
  const langId = useId();
  const modeId = useId();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Welcome to Adika PDF Editor"
      description="What would you like to do?"
      width={760}
      testId="first-run"
      help={HELP_TOPICS.welcome}
      footer={
        <>
          <div className="mr-auto">
            <Checkbox checked={hide} onChange={setHide} label="Don’t show this again" />
          </div>
          <Button variant="primary" onClick={close} data-testid="first-run-close" data-autofocus>
            Start
          </Button>
        </>
      }
    >
      <p className="mb-3 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-[12.5px] text-brand-800 dark:bg-brand-900/40 dark:text-brand-100">
        <ShieldCheck size={16} className="shrink-0" aria-hidden />
        Adika works offline: your documents stay on this computer and are never uploaded.
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Common tasks">
        {TASKS.map((t) => (
          <li key={t.id} className="flex flex-col rounded-lg border border-app bg-panel-2">
            <button type="button" className="flex flex-1 items-start gap-2.5 rounded-t-lg p-3 text-left hover-app" onClick={() => run(t.id)} data-testid={`first-run-${t.id}`}>
              <span className="mt-0.5 text-brand-600 dark:text-brand-400" aria-hidden>
                {t.icon}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-semibold">{t.title}</span>
                <span className="text-[11.5px] leading-snug text-muted">{t.text}</span>
              </span>
            </button>
            <button
              type="button"
              className="h-7 rounded-b-lg border-t border-app px-3 text-left text-[11.5px] text-brand-700 hover:underline dark:text-brand-300"
              onClick={() => openHelp(t.help)}
              data-testid={`first-run-help-${t.id}`}
            >
              How it works
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div role="group" aria-labelledby={langId}>
          <div id={langId} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Interface language
          </div>
          <div className="flex flex-wrap gap-1">
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={lang === l.id}
                onClick={() => void useLang.getState().setLang(l.id)}
                className={cn('h-7 rounded-md border px-2 text-[12px]', lang === l.id ? 'border-brand-600 bg-brand-50 font-semibold text-brand-800 dark:bg-brand-900/40 dark:text-brand-100' : 'border-app hover-app')}
                data-testid={`first-run-lang-${l.id}`}
              >
                <span data-no-translate lang={l.id}>
                  {l.label}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div role="group" aria-labelledby={modeId}>
          <div id={modeId} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Ribbon
          </div>
          <div className="grid grid-cols-2 gap-1">
            <ModeChoice mode="simple" current={mode} icon={<PanelTop size={16} />} title="Simple" text="The most common commands" />
            <ModeChoice mode="full" current={mode} icon={<PanelsTopLeft size={16} />} title="Full" text="Every command, in tabs" />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function ModeChoice({ mode, current, icon, title, text }: { mode: RibbonMode; current: RibbonMode; icon: ReactNode; title: string; text: string }) {
  const on = mode === current;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => useUiMode.getState().setMode(mode)}
      className={cn('flex items-start gap-2 rounded-md border p-2 text-left', on ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-100' : 'border-app hover-app')}
      data-testid={`first-run-mode-${mode}`}
    >
      <span className="mt-0.5" aria-hidden>
        {icon}
      </span>
      <span className="flex flex-col">
        <span className="text-[12.5px] font-semibold">{title}</span>
        <span className="text-[11px] leading-snug opacity-80">{text}</span>
      </span>
    </button>
  );
}
