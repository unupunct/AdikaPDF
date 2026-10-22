import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { FirstRunWelcome } from '@/components/shell/FirstRunWelcome';
import { usePDFStore } from '@/store/usePDFStore';
import { useUiMode, WELCOME_KEY, MODE_KEY } from '@/store/uiMode';
import { useHelp } from '@/store/help';
import { useLang } from '@/lib/i18n';

const page = { id: 'p1', sourceId: 's1', sourcePageIndex: 0, rotation: 0, width: 595, height: 842 } as unknown as ReturnType<typeof usePDFStore.getState>['pages'][number];

// Opening a file: the picker "chooses" a PDF and it opens.
const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/actions/document', async (orig) => ({
  ...(await orig<typeof import('@/actions/document')>()),
  openDialog: vi.fn(async () => {
    opened.count++;
    const { usePDFStore } = await import('@/store/usePDFStore');
    usePDFStore.setState({ pages: [{ ...page, id: `p${opened.count}` }], fileName: 'a.pdf' });
  }),
}));
const quick = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/components/modals/ToolsModal', async (orig) => ({
  ...(await orig<typeof import('@/components/modals/ToolsModal')>()),
  startQuickTool: vi.fn(async (id: string) => void quick.ids.push(id)),
}));

function renderWelcome() {
  return render(
    <TooltipProvider>
      <FirstRunWelcome />
    </TooltipProvider>,
  );
}

beforeEach(async () => {
  quick.ids = [];
  act(() => {
    usePDFStore.setState({ pages: [], modal: null, tool: 'selectText', inspectorOpen: false, ribbonTab: 'home' });
    useUiMode.setState({ mode: 'simple', peek: null, welcome: true });
    useHelp.setState({ open: false });
  });
  await act(() => useLang.getState().setLang('en'));
});

describe('first-run welcome', () => {
  it('is a dialog with the privacy line, the task cards, language and ribbon choices; focus on Start', async () => {
    renderWelcome();
    const dlg = await screen.findByRole('dialog', { name: 'Welcome to Adika PDF Editor' });
    expect(dlg.textContent).toContain('works offline');
    for (const name of ['Sign a PDF', 'Create an e-Factura', 'Edit text in a PDF', 'Combine PDFs', 'Fill in a form', 'Convert to Word or Excel']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) }), name).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: 'How it works' })).toHaveLength(6);
    expect(screen.getByRole('group', { name: 'Interface language' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Ribbon' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('first-run-close')));
  });

  it('Start with "Don’t show this again" ticked hides it for good; unticked shows it next time', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWelcome();
    await user.click(await screen.findByTestId('first-run-close'));
    expect(useUiMode.getState().welcome).toBe(false);
    expect(localStorage.getItem(WELCOME_KEY)).toBe('hide');
    unmount();

    act(() => useUiMode.getState().openWelcome());
    renderWelcome();
    await user.click(screen.getByRole('checkbox', { name: 'Don’t show this again' }));
    await user.keyboard('{Escape}');
    expect(useUiMode.getState().welcome).toBe(false);
    expect(localStorage.getItem(WELCOME_KEY)).toBe('show');
  });

  it('chooses the ribbon and the language', async () => {
    const user = userEvent.setup();
    renderWelcome();
    await user.click(screen.getByTestId('first-run-mode-full'));
    expect(useUiMode.getState().mode).toBe('full');
    expect(localStorage.getItem(MODE_KEY)).toBe('full');
    expect(screen.getByTestId('first-run-mode-full').getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByTestId('first-run-mode-simple'));
    expect(useUiMode.getState().mode).toBe('simple');
    await user.click(screen.getByTestId('first-run-lang-ro'));
    await waitFor(() => expect(useLang.getState().lang).toBe('ro'));
    expect(screen.getByTestId('first-run-lang-ro').getAttribute('aria-pressed')).toBe('true');
  });

  it('"How it works" opens the guide page of the task over the welcome', async () => {
    const user = userEvent.setup();
    renderWelcome();
    await user.click(screen.getByTestId('first-run-help-sign'));
    expect(useHelp.getState()).toMatchObject({ open: true, page: 'signing-sign' });
    act(() => useHelp.getState().close());
    await user.click(screen.getByTestId('first-run-help-einvoice'));
    expect(useHelp.getState()).toMatchObject({ open: true, page: 'efactura-create' });
    act(() => useHelp.getState().close());
    await user.click(screen.getByTestId('first-run-help-combine'));
    expect(useHelp.getState()).toMatchObject({ page: 'getting-started', anchor: 'the-welcome-screen' });
    expect(useUiMode.getState().welcome).toBe(true);
  });

  const cases: Array<{ id: string; expectState: () => void }> = [
    { id: 'sign', expectState: () => expect(usePDFStore.getState()).toMatchObject({ modal: 'signature', ribbonTab: 'sign' }) },
    { id: 'einvoice', expectState: () => expect(usePDFStore.getState().modal).toBe('einvoiceNew') },
    { id: 'editText', expectState: () => expect(usePDFStore.getState().tool).toBe('editText') },
    { id: 'combine', expectState: () => expect(quick.ids).toEqual(['merge']) },
    { id: 'form', expectState: () => expect(usePDFStore.getState().inspectorOpen).toBe(true) },
    { id: 'convert', expectState: () => expect(usePDFStore.getState().modal).toBe('tools') },
  ];
  for (const c of cases) {
    it(`card "${c.id}" closes the welcome and starts the task`, async () => {
      const user = userEvent.setup();
      renderWelcome();
      await user.click(screen.getByTestId(`first-run-${c.id}`));
      expect(useUiMode.getState().welcome).toBe(false);
      await waitFor(c.expectState, { timeout: 8000 });
    });
  }
});
