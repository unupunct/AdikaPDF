import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { Modals } from '@/components/modals/Modals';
import { HelpHost } from '@/components/help/HelpHost';
import { TopBar } from '@/components/shell/TopBar';
import { usePDFStore } from '@/store/usePDFStore';
import { useHelp } from '@/store/help';
import { useLang } from '@/lib/i18n';
import { axeProblems, describeProblems } from './axe';

function App() {
  return (
    <TooltipProvider>
      <TopBar />
      <Modals />
      <HelpHost />
    </TooltipProvider>
  );
}

// The viewer is loaded on first use: allow for a slow first import under load.
const article = () => screen.findByTestId('help-article', {}, { timeout: 10000 });
const shownPage = async () => (await article()).getAttribute('data-page');

beforeEach(async () => {
  act(() => {
    usePDFStore.setState({ modal: null, pages: [] });
    useHelp.setState({ open: false, query: '' });
  });
  await act(() => useLang.getState().setLang('en'));
});
afterEach(async () => {
  act(() => useHelp.getState().close());
  await act(() => useLang.getState().setLang('en'));
});

describe('help viewer', () => {
  it('F1 opens the start page; Escape closes it', async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'F1' });
    const dlg = await screen.findByRole('dialog', { name: 'Help' }, { timeout: 10000 });
    expect(await shownPage()).toBe('index');
    expect(dlg.querySelector('h1')?.textContent).toBe('Adika PDF Editor user guide');
    // The table of contents lists the pages by group; the current one is marked.
    const toc = screen.getByRole('navigation', { name: 'Help pages' });
    expect(toc.querySelector('[aria-current="page"]')?.textContent).toBe('Adika PDF Editor user guide');
    expect(screen.getByTestId('help-page-efactura-anaf-send')).toBeTruthy();
    // Guide text is already translated: the DOM translator must leave it alone.
    expect((await article()).hasAttribute('data-no-translate')).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull());
  });

  it('F1 inside a dialog opens the page about that dialog', async () => {
    render(<App />);
    act(() => usePDFStore.setState({ modal: 'anaf' }));
    await screen.findByRole('dialog', { name: 'ANAF e-Factura' });
    fireEvent.keyDown(window, { key: 'F1' });
    expect(await shownPage()).toBe('efactura-anaf-send');
  });

  it("a dialog's ? button opens its heading", async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => usePDFStore.setState({ modal: 'token' }));
    const dlg = await screen.findByRole('dialog', { name: 'Sign with a token or smart card' });
    await user.click(dlg.querySelector<HTMLElement>('[data-testid="dialog-help"]')!);
    expect(await shownPage()).toBe('signing-sign');
    expect(useHelp.getState().anchor).toBe('sign-with-a-usb-token-or-smart-card');
  });

  it('searches every page and opens a result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('help-open'));
    await article();
    await user.type(screen.getByRole('searchbox', { name: 'Search the help' }), 'SPV');
    const results = await screen.findAllByTestId('help-result');
    expect(results.length).toBeGreaterThan(2);
    const anaf = results.find((r) => r.textContent?.includes('Send invoices to ANAF'));
    expect(anaf).toBeTruthy();
    await user.click(anaf!);
    expect(await shownPage()).toBe('efactura-anaf-send');
    await user.clear(screen.getByRole('searchbox', { name: 'Search the help' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search the help' }), 'zzqqxx');
    expect(await screen.findByText('No results.')).toBeTruthy();
  });

  it('follows links between pages, back and forward; web links open outside', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<App />);
    act(() => useHelp.getState().openHelp('index'));
    const a = await article();
    await user.click(a.querySelector<HTMLAnchorElement>('a[href="getting-started.md"]')!);
    expect(await shownPage()).toBe('getting-started');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await shownPage()).toBe('index');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await shownPage()).toBe('getting-started');
    act(() => useHelp.getState().go('index'));
    await waitFor(async () => expect(await shownPage()).toBe('index'));
    await user.click((await article()).querySelector<HTMLAnchorElement>('a[href^="https://github.com"]')!);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/github\.com\//), '_blank', 'noopener');
    expect(await shownPage()).toBe('index');
    open.mockRestore();
  });

  it('shows the guide in Romanian, and in English for languages without a guide', async () => {
    render(<App />);
    await act(() => useLang.getState().setLang('ro'));
    act(() => useHelp.getState().openHelp('signing-sign'));
    expect((await article()).querySelector('h1')?.textContent).toBe('Semnarea unui document');
    expect((await article()).getAttribute('lang')).toBe('ro');
    expect(screen.queryByText('The guide is available in English and Romanian.')).toBeNull();
    await act(() => useLang.getState().setLang('de'));
    await waitFor(async () => expect((await article()).querySelector('h1')?.textContent).toBe('Sign a document'));
    expect(screen.getByText('The guide is available in English and Romanian.')).toBeTruthy();
  });

  it('pictures come from the bundled guide', async () => {
    render(<App />);
    act(() => useHelp.getState().openHelp('efactura-read'));
    const img = (await article()).querySelector('img');
    expect(img?.getAttribute('alt')).toBeTruthy();
    expect(img?.getAttribute('src')).toMatch(/einvoice-readable/);
  });

  it('passes axe (serious and critical)', async () => {
    render(<App />);
    act(() => useHelp.getState().openHelp('efactura-create'));
    const dlg = await screen.findByRole('dialog', { name: 'Help' }, { timeout: 10000 });
    await article();
    const problems = await axeProblems(dlg);
    expect(problems, describeProblems(problems)).toEqual([]);
  });
});
