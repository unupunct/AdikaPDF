import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { Ribbon, RIBBON_TABS } from '@/components/ribbon/Ribbon';
import { TopBar } from '@/components/shell/TopBar';
import { CommandPalette, usePalette } from '@/components/shell/CommandPalette';
import { usePDFStore } from '@/store/usePDFStore';
import { runCommand } from '@/store/customize';
import { initialMode, MODE_KEY, usedBefore, useUiMode, welcomeDue, WELCOME_KEY } from '@/store/uiMode';

function fakeStorage(items: Record<string, string>): Storage {
  const m = new Map(Object.entries(items));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

function renderShell() {
  return render(
    <TooltipProvider>
      <TopBar />
      <Ribbon />
      <CommandPalette />
    </TooltipProvider>,
  );
}

const page = { id: 'p1', sourceId: 's1', sourcePageIndex: 0, rotation: 0, width: 595, height: 842 } as unknown as ReturnType<typeof usePDFStore.getState>['pages'][number];

beforeEach(() => {
  act(() => {
    usePDFStore.setState({ ribbonTab: 'home', modal: null, busy: null, presentation: false, pages: [] });
    useUiMode.setState({ mode: 'simple', peek: null, welcome: false });
  });
});

describe('ribbon mode: the default', () => {
  it('a new installation starts simple, with the welcome', () => {
    const st = fakeStorage({});
    expect(usedBefore(st)).toBe(false);
    expect(initialMode(st)).toBe('simple');
    expect(welcomeDue(st)).toBe(true);
  });

  it('someone who used Adika before keeps the full ribbon and gets no welcome', () => {
    for (const key of ['adika.recent.v1', 'adika.customize', 'adika.theme', 'adika.lang', 'adika.savedSignatures.v1']) {
      const st = fakeStorage({ [key]: 'x' });
      expect(initialMode(st), key).toBe('full');
      expect(welcomeDue(st), key).toBe(false);
    }
    // Other programs' keys are not a sign of use.
    expect(initialMode(fakeStorage({ 'other.app': '1' }))).toBe('simple');
  });

  it('a stored choice wins; the welcome follows "Don’t show this again"', () => {
    expect(initialMode(fakeStorage({ [MODE_KEY]: 'full' }))).toBe('full');
    expect(initialMode(fakeStorage({ [MODE_KEY]: 'simple', 'adika.recent.v1': '[]' }))).toBe('simple');
    expect(welcomeDue(fakeStorage({ [WELCOME_KEY]: 'hide' }))).toBe(false);
    expect(welcomeDue(fakeStorage({ [WELCOME_KEY]: 'show', 'adika.recent.v1': '[]' }))).toBe(true);
    // The mode key itself does not make a user "existing".
    expect(welcomeDue(fakeStorage({ [MODE_KEY]: 'simple' }))).toBe(true);
  });
});

describe('simple ribbon', () => {
  it('shows the common commands by task, no tabs', () => {
    renderShell();
    expect(screen.queryByRole('tablist', { name: 'Ribbon' })).toBeNull();
    const region = screen.getByRole('region', { name: 'Simple ribbon' });
    expect(region.getAttribute('data-testid')).toBe('ribbon');
    for (const name of ['Open', 'Save', 'Print', 'E-mail', 'Edit text', 'Add text', 'Highlight', 'Note', 'Fill & Sign', 'Digital signature', 'Sign many files', 'Verify', 'Combine PDFs', 'Organize', 'Compress', 'OCR', 'Convert', 'Protect', 'e-Factura', 'More tools', 'Help']) {
      expect(within(region).getByRole('button', { name }), name).toBeTruthy();
    }
    const groups = [...region.querySelectorAll('[data-ribbon-group]')].map((g) => g.getAttribute('data-ribbon-group'));
    expect(groups).toEqual(['File', 'Edit & comment', 'Sign', 'Pages', 'Convert', 'Protect', 'E-invoice', 'More']);
    expect(screen.getAllByRole('button').filter((b) => region.contains(b)).length).toBeLessThanOrEqual(22);
  });

  it('commands that need a document wait for one', () => {
    renderShell();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Protect' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Sign many files' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => usePDFStore.setState({ pages: [page] }));
    expect((screen.getByRole('button', { name: 'Protect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('More tools, the top bar switch and View → Simple ribbon switch modes and are remembered', async () => {
    const user = userEvent.setup();
    renderShell();
    const toggle = screen.getByTestId('ribbon-mode');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'More tools' }));
    expect(useUiMode.getState().mode).toBe('full');
    expect(localStorage.getItem(MODE_KEY)).toBe('full');
    expect(screen.getByRole('tablist', { name: 'Ribbon' })).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await user.click(screen.getByRole('tab', { name: 'View' }));
    await user.click(screen.getByTestId('btn-simple-ribbon'));
    expect(useUiMode.getState().mode).toBe('simple');
    expect(localStorage.getItem(MODE_KEY)).toBe('simple');

    await user.click(toggle);
    expect(localStorage.getItem(MODE_KEY)).toBe('full');
    await user.click(toggle);
    expect(localStorage.getItem(MODE_KEY)).toBe('simple');
    expect(screen.getByRole('region', { name: 'Simple ribbon' })).toBeTruthy();
  });

  it('keyboard: Tab moves through the commands, a menu opens with Enter, Alt focuses the first command', async () => {
    const user = userEvent.setup();
    renderShell();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
    act(() => usePDFStore.setState({ pages: [page] }));
    screen.getByRole('button', { name: 'Digital signature' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menuitem', { name: 'Certificate ID' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(usePDFStore.getState().modal).toBe('certificate');
  });

  it('tool search runs a command of the full ribbon: its tab is shown, with a way back', async () => {
    renderShell();
    act(() => usePalette.setState({ open: true }));
    const input = await screen.findByRole('textbox', { name: 'Search tools and commands…' });
    await new Promise((r) => setTimeout(r, 80));
    fireEvent.change(input, { target: { value: 'batch' } });
    const item = (await screen.findAllByTestId('palette-item')).find((b) => b.textContent?.startsWith('Batch'));
    expect(item).toBeTruthy();
    fireEvent.click(item!);
    await waitFor(() => expect(usePDFStore.getState().modal).toBe('batch'));
    expect(useUiMode.getState()).toMatchObject({ mode: 'simple', peek: 'convert' });
    expect(usePDFStore.getState().ribbonTab).toBe('convert');
    fireEvent.click(screen.getByTestId('ribbon-back-simple'));
    expect(useUiMode.getState().peek).toBeNull();
    expect(screen.getByRole('region', { name: 'Simple ribbon' })).toBeTruthy();
    expect(useUiMode.getState().mode).toBe('simple');
  });

  it('tool search and Quick Access use the simple button when there is one', async () => {
    renderShell();
    await runCommand({ tab: 'sign', en: 'Sign many files' });
    expect(usePDFStore.getState().modal).toBe('batchsign');
    expect(useUiMode.getState().peek).toBeNull();
    act(() => usePDFStore.setState({ modal: null }));
    await runCommand({ tab: 'organize', en: 'Portfolio' });
    await waitFor(() => expect(usePDFStore.getState().modal).toBe('portfolio'));
    expect(useUiMode.getState().peek).toBe('organize');
  });
});

/** Height / width in CSS px of Tailwind size classes (h-6, h-[72px], min-w-6, w-8…). */
function sizeOf(cls: string, prop: 'h' | 'w'): number {
  let best = 0;
  for (const c of cls.split(/\s+/)) {
    const m = new RegExp(`^(?:min-)?${prop}-(\\d+(?:\\.\\d+)?|\\[(\\d+)px\\])$`).exec(c);
    if (m) best = Math.max(best, m[2] ? Number(m[2]) : Number(m[1]) * 4);
  }
  return best;
}

describe('ribbon target size (WCAG 2.2: at least 24 × 24 px)', () => {
  const check = (where: string) => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="ribbon"] button, [data-testid="ribbon"] input, [data-testid="ribbon"] select')) {
      const h = sizeOf(el.className, 'h');
      const name = el.getAttribute('aria-label') ?? el.textContent ?? el.outerHTML.slice(0, 60);
      if (h < 24) bad.push(`${where}: ${name} (height ${h || 'none'})`);
      // Narrow controls carry a width class; buttons with a text label are wider than 24 px.
      const w = sizeOf(el.className, 'w');
      const iconOnly = el.tagName === 'BUTTON' && !el.textContent?.trim();
      if ((iconOnly || el.tagName === 'INPUT') && w < 24) bad.push(`${where}: ${name} (width ${w || 'none'})`);
    }
    return bad;
  };

  it('every tab of the full ribbon, with a document', () => {
    act(() => useUiMode.setState({ mode: 'full' }));
    act(() => usePDFStore.setState({ pages: [page] }));
    render(
      <TooltipProvider>
        <Ribbon />
      </TooltipProvider>,
    );
    const bad: string[] = [];
    for (const t of RIBBON_TABS) {
      act(() => usePDFStore.setState({ ribbonTab: t.id }));
      bad.push(...check(t.id));
    }
    expect(bad).toEqual([]);
  });

  it('the simple ribbon', () => {
    render(
      <TooltipProvider>
        <Ribbon />
      </TooltipProvider>,
    );
    expect(check('simple')).toEqual([]);
  });
});
