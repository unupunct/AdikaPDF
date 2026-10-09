import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/primitives';
import { Ribbon, RIBBON_TABS } from '@/components/ribbon/Ribbon';
import { usePDFStore } from '@/store/usePDFStore';

function renderRibbon() {
  return render(
    <TooltipProvider>
      <Ribbon />
    </TooltipProvider>,
  );
}

describe('ribbon tabs (keyboard)', () => {
  beforeEach(() => {
    act(() => usePDFStore.setState({ ribbonTab: 'home', modal: null, busy: null, presentation: false }));
  });

  it('is one tab stop: only the selected tab is focusable', () => {
    renderRibbon();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(RIBBON_TABS.map((t) => t.label));
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Home');
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Ribbon');
  });

  it('arrow keys move and wrap, Home and End jump, focus follows the selection', async () => {
    const user = userEvent.setup();
    renderRibbon();
    screen.getByRole('tab', { name: 'Home' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(usePDFStore.getState().ribbonTab).toBe('view');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'View' }));
    expect(screen.getByRole('tab', { name: 'View' }).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Home' }).tabIndex).toBe(-1);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Convert' }));
    await user.keyboard('{ArrowRight}');
    expect(usePDFStore.getState().ribbonTab).toBe('home');
    await user.keyboard('{ArrowLeft}');
    expect(usePDFStore.getState().ribbonTab).toBe('convert');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Home' }));
  });

  it('Tab leaves the tab list for the tab panel', async () => {
    const user = userEvent.setup();
    renderRibbon();
    screen.getByRole('tab', { name: 'Home' }).focus();
    await user.tab();
    expect(document.activeElement?.getAttribute('role')).not.toBe('tab');
    expect(screen.getByRole('tabpanel').contains(document.activeElement)).toBe(true);
  });

  it('pressing and releasing Alt alone focuses the selected tab', () => {
    act(() => usePDFStore.setState({ ribbonTab: 'sign' }));
    renderRibbon();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Sign' }));
  });

  it('Alt as part of a combination, or with a dialog open, leaves focus alone', () => {
    renderRibbon();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(document.body);

    act(() => usePDFStore.setState({ modal: 'properties' }));
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(document.body);

    act(() => usePDFStore.setState({ modal: null }));
    fireEvent.keyDown(window, { key: 'Alt', altKey: true, ctrlKey: true });
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(document.activeElement).toBe(document.body);
  });
});
