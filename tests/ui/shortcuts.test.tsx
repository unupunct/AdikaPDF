import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { usePDFStore } from '@/store/usePDFStore';
import { useCustomize } from '@/store/customize';

const saveDocument = vi.fn(async () => undefined);
vi.mock('@/actions/document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/actions/document')>()),
  saveDocument: (...a: unknown[]) => saveDocument(...(a as [])),
}));

const { useShortcuts } = await import('@/hooks/useShortcuts');
const { CustomizeModal } = await import('@/components/shell/CustomizeModal');

function App() {
  useShortcuts();
  return (
    <div>
      <input aria-label="Page number" />
      {/* jsdom has no isContentEditable: a text area stands in for editable content. */}
      <textarea aria-label="Note" />
    </div>
  );
}

const page = { id: 'p1', sourceId: 's1', sourcePageIndex: 0, rotation: 0, width: 595, height: 842 } as unknown as ReturnType<typeof usePDFStore.getState>['pages'][number];

describe('shortcut gate', () => {
  beforeEach(() => {
    saveDocument.mockClear();
    act(() => {
      usePDFStore.setState({ pages: [page], modal: null, busy: null, presentation: false, tool: 'select', zoom: 1, readOnlyReason: null });
      useCustomize.setState({ shortcuts: [] });
    });
  });

  it('tool letters work on the page but not while typing in a field', () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: 't' });
    expect(usePDFStore.getState().tool).toBe('text');
    act(() => usePDFStore.setState({ tool: 'select' }));
    fireEvent.keyDown(screen.getByLabelText('Page number'), { key: 't' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'r' });
    expect(usePDFStore.getState().tool).toBe('select');
  });

  it('Ctrl+S still saves from inside a field; Ctrl+Z there is left to the field', () => {
    render(<App />);
    const input = screen.getByLabelText('Page number');
    const undo = vi.spyOn(usePDFStore.getState(), 'undo');
    fireEvent.keyDown(input, { key: 's', ctrlKey: true });
    expect(saveDocument).toHaveBeenCalledWith(false);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('AltGr characters (Ctrl+Alt on Windows) are typed, never run as shortcuts', () => {
    render(<App />);
    const input = screen.getByLabelText('Page number');
    const press = (target: Element, key: string, altGraph: boolean) => {
      const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'getModifierState', { value: (k: string) => altGraph && k === 'AltGraph' });
      fireEvent(target, ev);
    };
    const before = usePDFStore.getState().zoom;
    // "+" and "-" typed with AltGr would otherwise be Ctrl+plus / Ctrl+minus (zoom).
    press(input, '+', false);
    press(document.body, '-', false);
    expect(usePDFStore.getState().zoom).toBe(before);
    // AltGr+S (a letter on some layouts, e.g. Polish "ś") is typed...
    press(input, 's', true);
    press(document.body, 's', true);
    expect(saveDocument).not.toHaveBeenCalled();
    // ...while a real Ctrl+Alt+S (no AltGraph state) is still a shortcut.
    press(document.body, 's', false);
    expect(saveDocument).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: '=', ctrlKey: true });
    expect(usePDFStore.getState().zoom).toBeGreaterThan(before);
  });

  it('shortcuts are off while a dialog is open', () => {
    render(<App />);
    act(() => usePDFStore.setState({ modal: 'properties' }));
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 't' });
    expect(saveDocument).not.toHaveBeenCalled();
    expect(usePDFStore.getState().tool).toBe('select');
  });
});

describe('Customize: shortcut conflicts', () => {
  beforeEach(() => {
    act(() => {
      usePDFStore.setState({ pages: [], modal: 'customize' });
      useCustomize.setState({ shortcuts: [], quick: [] });
    });
  });

  async function openKeys() {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <CustomizeModal />
      </TooltipProvider>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Customize' });
    await user.click(within(dlg).getByRole('tab', { name: 'Keyboard shortcuts' }));
    await waitFor(() => expect(within(dlg).getAllByTestId('customize-command').length).toBeGreaterThan(20));
    const pick = async (q: string) => {
      const search = within(dlg).getByLabelText('Find a command');
      await user.clear(search);
      await user.type(search, q);
      const row = within(dlg).getAllByTestId('customize-command')[0];
      await user.click(within(row).getByRole('button', { name: 'Set shortcut' }));
      await within(dlg).findByTestId('customize-capturing');
      return row.textContent;
    };
    return { user, dlg, pick };
  }

  it('warns when the keys were a built-in shortcut, and crosses the built-in out', async () => {
    const { user, dlg, pick } = await openKeys();
    await pick('Merge PDFs');
    await user.keyboard('{Control>}o{/Control}');
    expect(within(dlg).getByText('Ctrl+O was a built-in shortcut: it now runs this command.')).toBeTruthy();
    expect(useCustomize.getState().shortcuts).toEqual([{ tab: 'organize', en: 'Merge PDFs', combo: 'Ctrl+O' }]);
    const builtIn = within(within(dlg).getByTestId('customize-builtin')).getAllByText('Ctrl+O')[0];
    expect(builtIn.className).toContain('line-through');
  });

  it('warns when the keys ran another of your commands, which loses them', async () => {
    const { user, dlg, pick } = await openKeys();
    await pick('Merge PDFs');
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    expect(within(dlg).queryByText(/it now runs this command/)).toBeNull();
    await pick('Compress');
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    expect(within(dlg).getByText(/Ctrl\+Alt\+M ran “Merge PDFs”: it now runs this command\./)).toBeTruthy();
    const mine = useCustomize.getState().shortcuts;
    expect(mine).toHaveLength(1);
    expect(mine[0].combo).toBe('Ctrl+Alt+M');
    expect(mine[0].en).not.toBe('Merge PDFs');
  });

  it('refuses plain letters and lets Esc cancel the capture', async () => {
    const { user, dlg, pick } = await openKeys();
    await pick('Merge PDFs');
    await user.keyboard('q');
    expect(within(dlg).getByText('Use Ctrl or Alt with a key, or a function key (F1–F12).')).toBeTruthy();
    expect(within(dlg).getByTestId('customize-capturing')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(within(dlg).queryByTestId('customize-capturing')).toBeNull();
    // Esc ended the capture, not the dialog.
    expect(screen.getByRole('dialog', { name: 'Customize' })).toBeTruthy();
    expect(useCustomize.getState().shortcuts).toEqual([]);
  });
});
