import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BusyOverlay, Toasts } from '@/components/shell/Overlays';
import { usePDFStore } from '@/store/usePDFStore';

const saveBytes = vi.fn();
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  saveBytes: (...args: unknown[]) => saveBytes(...args),
}));

const { saveFile } = await import('@/actions/saveGuard');
const { withBusy } = await import('@/actions/document');

beforeEach(() => {
  saveBytes.mockReset();
  act(() => usePDFStore.setState({ toasts: [], busy: null }));
});

describe('toasts', () => {
  it('a failed save shows the reason and a Save as… button that saves elsewhere', async () => {
    const user = userEvent.setup();
    saveBytes.mockRejectedValueOnce(new Error('The process cannot access the file (os error 32)')).mockResolvedValueOnce('D:\\Other\\report.pdf');
    render(<Toasts />);
    let result: string | null = 'x';
    await act(async () => {
      result = await saveFile(new Uint8Array([1]), 'report.pdf', [{ name: 'PDF', extensions: ['pdf'] }], { existingPath: 'C:\\Locked\\report.pdf' });
    });
    expect(result).toBeNull();
    expect(saveBytes.mock.calls[0][3]).toBe('C:\\Locked\\report.pdf');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not save report.pdf: The file is open in another program.');
    await user.click(screen.getByRole('button', { name: 'Save as…' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledTimes(2));
    // The retry asks for a new place (no existing path) with the same bytes and name.
    expect(saveBytes.mock.calls[1][1]).toBe('report.pdf');
    expect(saveBytes.mock.calls[1][3]).toBeUndefined();
    await screen.findByText('Saved to D:\\Other\\report.pdf');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a custom retry replaces the plain one, and Dismiss removes the toast', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    saveBytes.mockRejectedValueOnce(new Error('os error 5'));
    render(<Toasts />);
    await act(async () => {
      await saveFile(new Uint8Array([1]), 'a.pdf', [], { retry });
    });
    expect(screen.getByRole('alert').textContent).toContain('Access was denied');
    await user.click(screen.getByRole('button', { name: 'Save as…' }));
    expect(retry).toHaveBeenCalledOnce();
    act(() => usePDFStore.getState().toast('Done.', 'success'));
    expect(screen.getByRole('status').textContent).toContain('Done.');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('BusyOverlay', () => {
  it('a cancellable operation shows a focused Cancel that aborts it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <BusyOverlay />
        <Toasts />
      </>,
    );
    let seen: AbortSignal | null = null;
    let run!: Promise<unknown>;
    act(() => {
      run = withBusy('Compressing', (progress, signal) => {
        seen = signal;
        progress('Compressing page 1 of 9', 0.1);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))));
      });
    });
    const dlg = await screen.findByRole('dialog', { name: 'Compressing page 1 of 9' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    await user.click(cancel);
    expect(seen!.aborted).toBe(true);
    await act(async () => {
      expect(await run).toBeUndefined();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // A cancelled run is not an error.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Cancelled.');
  });

  it('Esc cancels too; an operation that cannot be cancelled has no button', async () => {
    const user = userEvent.setup();
    render(<BusyOverlay />);
    const abort = new AbortController();
    act(() => usePDFStore.getState().setBusy({ message: 'Signing', progress: null, abort }));
    await user.keyboard('{Escape}');
    expect(abort.signal.aborted).toBe(true);
    expect(screen.getByText('Cancelling…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => usePDFStore.getState().setBusy({ message: 'Opening', progress: null }));
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  });
});
