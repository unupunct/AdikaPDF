import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/primitives';
import { Modals } from '@/components/modals/Modals';
import { Ribbon, RIBBON_TABS } from '@/components/ribbon/Ribbon';
import { WelcomeScreen } from '@/components/shell/WelcomeScreen';
import { TopBar } from '@/components/shell/TopBar';
import { StatusBar } from '@/components/shell/StatusBar';
import { CommandPalette, usePalette } from '@/components/shell/CommandPalette';
import { PropertiesPanel } from '@/components/inspector/PropertiesPanel';
import { LeftSidebar } from '@/components/sidebar/LeftSidebar';
import { TabBar } from '@/components/shell/TabBar';
import { usePDFStore, type ModalId } from '@/store/usePDFStore';
import { axeProblems, describeProblems } from './axe';

// The dialogs most people use (and the larger forms), opened without a document.
const DIALOGS: Array<{ id: ModalId; name: RegExp }> = [
  { id: 'properties', name: /properties/i },
  { id: 'ocr', name: /recognize text|ocr/i },
  { id: 'signature', name: /fill & sign/i },
  { id: 'batch', name: /batch/i },
  { id: 'batchsign', name: /sign many/i },
  { id: 'einvoiceNew', name: /e-invoice/i },
  { id: 'customize', name: /customize/i },
  { id: 'about', name: /about/i },
  { id: 'export', name: /export|convert/i },
  { id: 'compress', name: /compress/i },
  { id: 'password', name: /password|protect/i },
  { id: 'foldersearch', name: /search/i },
  { id: 'scan', name: /scan/i },
];

beforeEach(() => {
  act(() => usePDFStore.setState({ modal: null, pages: [], ribbonTab: 'home' }));
});

describe('accessibility (axe, serious and critical)', () => {
  it('the checker itself reports an unnamed button, an unlabelled field and a hidden focusable control', async () => {
    render(
      <div>
        <button type="button">
          <svg />
        </button>
        <div aria-hidden="true">
          <button type="button">Hidden</button>
        </div>
        <input />
      </div>,
    );
    expect((await axeProblems()).map((p) => p.rule).sort()).toEqual(['aria-hidden-focus', 'button-name', 'label']);
  });

  for (const d of DIALOGS) {
    it(`dialog: ${d.id}`, async () => {
      render(
        <TooltipProvider>
          <Modals />
        </TooltipProvider>,
      );
      act(() => usePDFStore.setState({ modal: d.id }));
      const dlg = await screen.findByRole('dialog', { name: d.name });
      // Dialogs that fill themselves in after mounting (Customize reads the ribbon).
      await new Promise((r) => setTimeout(r, 80));
      const problems = await axeProblems(dlg);
      expect(problems, describeProblems(problems)).toEqual([]);
    });
  }

  it('ribbon: every tab, with and without a document', async () => {
    render(
      <TooltipProvider>
        <Ribbon />
      </TooltipProvider>,
    );
    const all: string[] = [];
    for (const t of RIBBON_TABS) {
      act(() => usePDFStore.setState({ ribbonTab: t.id }));
      const problems = await axeProblems(document.body);
      if (problems.length) all.push(`[${t.id}]\n${describeProblems(problems)}`);
    }
    expect(all.join('\n')).toBe('');
  });

  it('start screen, top bar and status bar', async () => {
    render(
      <TooltipProvider>
        <TopBar />
        <WelcomeScreen />
        <StatusBar />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(3));
    const problems = await axeProblems(document.body);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('tool search (with results) and the side panels', async () => {
    render(
      <TooltipProvider>
        <TabBar />
        <LeftSidebar />
        <PropertiesPanel />
        <CommandPalette />
      </TooltipProvider>,
    );
    act(() => usePalette.setState({ open: true }));
    const input = await screen.findByRole('textbox', { name: 'Search tools and commands…' });
    await new Promise((r) => setTimeout(r, 80));
    fireEvent.change(input, { target: { value: 'sign' } });
    await waitFor(() => expect(screen.getAllByTestId('palette-item').length).toBeGreaterThan(0));
    const problems = await axeProblems(document.body);
    expect(problems, describeProblems(problems)).toEqual([]);
    act(() => usePalette.setState({ open: false }));
  });
});