import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { Modals } from '@/components/modals/Modals';
import { Toasts } from '@/components/shell/Overlays';
import { usePDFStore } from '@/store/usePDFStore';
import { applyDeployment } from '@/lib/policy';
import { openReport, useReport } from '@/actions/report';
import { axeProblems, describeProblems } from './axe';

const App = () => (
  <TooltipProvider>
    <Modals />
    <Toasts />
  </TooltipProvider>
);

const opened: string[] = [];
let clip = '';

beforeEach(() => {
  opened.length = 0;
  clip = '';
  vi.spyOn(window, 'open').mockImplementation((url) => (opened.push(String(url)), null));
  act(() => {
    usePDFStore.setState({ modal: null, toasts: [] });
    useReport.setState({ open: false });
    applyDeployment({ policies: {} });
  });
});
// After userEvent.setup(), which puts its own clipboard in place.
const mockClipboard = () => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void (clip = t) } });

afterEach(() => {
  vi.restoreAllMocks();
  act(() => applyDeployment({ policies: {} }));
});

describe('report a problem', () => {
  it('shows what GitHub gets before opening it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await act(() => openReport('bug'));
    const dlg = await screen.findByRole('dialog', { name: 'Report a problem' });
    expect(await axeProblems(dlg), describeProblems(await axeProblems(dlg))).toEqual([]);
    await user.type(screen.getByTestId('report-title'), 'Save fails');
    const preview = screen.getByTestId('report-preview').textContent!;
    expect(preview).toContain('[Bug]: Save fails');
    expect(preview).toContain('### Adika version');
    expect(preview).toContain('### Windows version');
    expect(preview).toContain('### Installed or portable\n\nInstalled');
    expect(preview).toContain('### Steps');
    await user.click(screen.getByTestId('report-open'));
    await waitFor(() => expect(opened).toHaveLength(1));
    const u = new URL(opened[0]);
    expect(u.pathname).toBe('/unupunct/AdikaPDF/issues/new');
    expect(u.searchParams.get('title')).toBe('[Bug]: Save fails');
    expect(u.searchParams.get('template')).toBe('bug_report.yml');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Report a problem' })).toBeNull());
  });

  it('switches to a feature request', async () => {
    const user = userEvent.setup();
    render(<App />);
    await act(() => openReport('bug'));
    await user.click(await screen.findByRole('tab', { name: 'Suggest a feature' }));
    expect(screen.getByTestId('report-preview').textContent).toContain('### What would you like to do');
  });

  it('with online features turned off by policy only Copy text is offered', async () => {
    const user = userEvent.setup();
    mockClipboard();
    act(() => applyDeployment({ policies: { machine: { DisableOnlineFeatures: 1 } } }));
    render(<App />);
    await act(() => openReport('feature'));
    await screen.findByTestId('report-blocked');
    expect((screen.getByTestId('report-open') as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId('report-copy'));
    await waitFor(() => expect(clip).toContain('### What would you like to do'));
    expect(opened).toEqual([]);
  });

  it('a crash report is shown cleaned, can be edited, and is copied when it does not fit the address', async () => {
    const user = userEvent.setup();
    mockClipboard();
    render(<App />);
    await act(() => openReport('bug', { name: 'crash-20261022-101500-123-1.log', text: 'Panic: boom at %USERPROFILE%\\<path>\n' + 'frame\n'.repeat(2000) }));
    await screen.findByRole('dialog', { name: 'Report this crash' });
    const box = screen.getByTestId('report-crash') as HTMLTextAreaElement;
    await user.clear(box);
    await user.type(box, 'Panic: boom (edited)');
    expect(screen.getByTestId('report-preview').textContent).toContain('Panic: boom (edited)');
    act(() => useReport.setState((s) => ({ crash: { ...s.crash!, text: 'x'.repeat(9000) } })));
    await user.click(screen.getByTestId('report-open'));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(new URL(opened[0]).searchParams.get('crash-log')).toBeNull();
    expect(clip).toBe('x'.repeat(9000));
    expect(await screen.findByText(/too long for the address, so it was copied/)).toBeTruthy();
  });

  it('"Don\'t offer crash reports again" is remembered', async () => {
    const user = userEvent.setup();
    render(<App />);
    await act(() => openReport('bug', { name: 'crash-1.log', text: 'Panic' }));
    await user.click(await screen.findByRole('checkbox', { name: "Don't offer crash reports again" }));
    const { crashPromptsOff } = await import('@/actions/report');
    expect(crashPromptsOff()).toBe(true);
  });
});
