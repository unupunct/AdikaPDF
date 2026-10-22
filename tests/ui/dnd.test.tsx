import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { TooltipProvider } from '@/components/ui/primitives';
import { DropOverlay, Toasts } from '@/components/shell/Overlays';
import { ThumbnailSidebar } from '@/components/sidebar/ThumbnailSidebar';
import { Modals } from '@/components/modals/Modals';
import { usePDFStore } from '@/store/usePDFStore';
import { useDnd } from '@/store/dnd';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useDropList } from '@/hooks/useDropList';
import type { PageRef } from '@/types';

const opened: string[] = [];
vi.mock('@/actions/document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/actions/document')>()),
  openPdfBytes: vi.fn(async (_b: Uint8Array, name: string) => (opened.push(name), true)),
}));

const blank = (id: string): PageRef => ({ id, kind: 'blank', sourceId: null, sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 595, height: 842 });

function Window({ children }: { children?: React.ReactNode }) {
  useFileDrop();
  return (
    <TooltipProvider>
      {children}
      <Modals />
      <Toasts />
      <DropOverlay />
    </TooltipProvider>
  );
}

/** A drag from Explorer as the WebView reports it (types and MIME types while dragging, files on drop). */
function osDrag(files: Array<{ name: string; type: string }>) {
  const list = files.map((f) => new File([new Uint8Array([37, 80, 68, 70])], f.name, { type: f.type }));
  return {
    types: ['Files'],
    files: list,
    items: list.map((f) => ({ kind: 'file', type: f.type, webkitGetAsEntry: () => null })),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

beforeEach(() => {
  opened.length = 0;
  act(() => {
    usePDFStore.setState({ pages: [blank('p1'), blank('p2'), blank('p3')], modal: null, toasts: [], readOnlyReason: null, protection: null });
    useDnd.setState({ active: null, target: null, label: '', rejected: false, insertAt: null, pageDrag: null });
  });
});

describe('drop feedback', () => {
  it('files over the thumbnails: the overlay names the action and a line marks the place', () => {
    render(
      <Window>
        <ThumbnailSidebar />
      </Window>,
    );
    const thumb = screen.getByTestId('thumb-2');
    const dt = osDrag([{ name: 'a.pdf', type: 'application/pdf' }]);
    fireEvent.dragEnter(thumb, { dataTransfer: dt });
    fireEvent.dragOver(thumb, { dataTransfer: dt });
    // jsdom has no layout: every thumbnail is "above" the pointer, so the place is the end.
    expect(screen.getByTestId('drop-label').textContent).toBe('Insert pages at the end or open in a new tab');
    expect(screen.getByTestId('drop-label').getAttribute('aria-live')).toBe('polite');
    expect(screen.getAllByTestId('thumb-drop-line')).toHaveLength(1);
    expect(dt.dropEffect).toBe('copy');
    act(() => window.dispatchEvent(new Event('dragend')));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
  });

  it('a file Adika cannot open is refused with the reason (no-drop cursor)', () => {
    render(
      <Window>
        <ThumbnailSidebar />
      </Window>,
    );
    const dt = osDrag([{ name: 'setup.exe', type: 'application/x-msdownload' }]);
    fireEvent.dragOver(screen.getByTestId('thumb-1'), { dataTransfer: dt });
    expect(screen.getByTestId('drop-overlay').dataset.rejected).toBe('true');
    expect(screen.getByTestId('drop-label').textContent).toBe('Adika cannot open these files.');
    expect(dt.dropEffect).toBe('none');
    expect(screen.queryByTestId('thumb-drop-line')).toBeNull();
  });

  it('a document that does not allow page changes: the drop opens a tab instead', () => {
    act(() => usePDFStore.setState({ readOnlyReason: 'Read-only file' }));
    render(
      <Window>
        <ThumbnailSidebar />
      </Window>,
    );
    fireEvent.dragOver(screen.getByTestId('thumb-1'), { dataTransfer: osDrag([{ name: 'a.pdf', type: 'application/pdf' }]) });
    expect(screen.getByTestId('drop-label').textContent).toBe('Open in a new tab');
    expect(screen.queryByTestId('thumb-drop-line')).toBeNull();
  });
});

describe('dropping files', () => {
  it('a PDF dropped on the thumbnails asks; "Open in new tab" opens it', async () => {
    const user = userEvent.setup();
    render(
      <Window>
        <ThumbnailSidebar />
      </Window>,
    );
    const dt = osDrag([{ name: 'contract.pdf', type: 'application/pdf' }]);
    fireEvent.dragOver(screen.getByTestId('thumb-1'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('thumb-1'), { dataTransfer: dt });
    const dlg = await screen.findByRole('dialog', { name: 'Dropped file' });
    expect(dlg.textContent).toContain('Insert the pages at the end of this document, or open in a new tab?');
    await user.click(screen.getByRole('button', { name: 'Open in new tab' }));
    await waitFor(() => expect(opened).toEqual(['contract.pdf']));
  });

  it('unsupported files get a toast (announced: role status / alert)', async () => {
    render(<Window />);
    const dt = osDrag([{ name: 'tool.exe', type: 'application/x-msdownload' }]);
    fireEvent.drop(document.body, { dataTransfer: dt });
    expect((await screen.findByRole('alert')).textContent).toContain('Not opened (unsupported file type): tool.exe');
  });

  it('a dialog file list takes drops; elsewhere in a dialog they are refused', async () => {
    const added: string[][] = [];
    function List() {
      const [n, setN] = useState(0);
      const over = useDropList('test', (p) => (added.push(p), setN(n + p.length)), { subfolders: true, enabled: true });
      return (
        <div role="dialog" aria-label="Batch">
          <p data-testid="outside">Options</p>
          <div data-drop-list="test" data-testid="list" data-over={over ? 'yes' : 'no'}>
            {n}
          </div>
        </div>
      );
    }
    render(
      <Window>
        <List />
      </Window>,
    );
    const dt = osDrag([{ name: 'a.pdf', type: 'application/pdf' }]);
    fireEvent.dragOver(screen.getByTestId('outside'), { dataTransfer: dt });
    expect(screen.getByTestId('drop-label').textContent).toBe('Close the dialog first, or drop the files onto its file list.');
    await waitFor(() => {
      fireEvent.dragOver(screen.getByTestId('list'), { dataTransfer: dt });
      expect(screen.getByTestId('drop-label').textContent).toBe('Add to the list');
    });
    expect(screen.getByTestId('list').dataset.over).toBe('yes');
    // In the browser build the WebView gives no locations: the list cannot take them and says so.
    fireEvent.drop(screen.getByTestId('list'), { dataTransfer: dt });
    expect((await screen.findByRole('alert')).textContent).toContain('could not find where the dropped files are');
    expect(added).toEqual([]);
  });
});

describe('page drags', () => {
  const pageDrag = () => ({ types: ['text/x-adika-page'], setData: vi.fn(), getData: () => '', dropEffect: 'none', effectAllowed: 'all', files: [], items: [] });

  it('a thumbnail dragged within the list moves the page', async () => {
    render(
      <Window>
        <ThumbnailSidebar />
      </Window>,
    );
    const item = screen.getByTestId('thumb-1').parentElement!;
    const dt = pageDrag();
    fireEvent.dragStart(item, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith('text/x-adika-page', 'p1');
    fireEvent.dragOver(screen.getByTestId('thumb-3'), { dataTransfer: dt });
    expect(screen.getByTestId('drop-label').textContent).toBe('Move the page here');
    expect(dt.dropEffect).toBe('move');
    fireEvent.drop(screen.getByTestId('thumb-3'), { dataTransfer: dt });
    await waitFor(() => expect(usePDFStore.getState().pages.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']));
    expect(useDnd.getState().pageDrag).toBeNull();
  });

  it('hovering another document tab switches to it; its thumbnails then take a copy', async () => {
    const { newTab, useTabs } = await import('@/store/tabs');
    const { TabBar } = await import('@/components/shell/TabBar');
    const first = useTabs.getState().activeId;
    act(() => {
      newTab();
      usePDFStore.setState({ pages: [blank('q1')], fileName: 'second.pdf' });
    });
    act(() => usePDFStore.setState({ fileName: 'second.pdf' }));
    render(
      <Window>
        <TabBar />
        <ThumbnailSidebar />
      </Window>,
    );
    const second = useTabs.getState().activeId;
    const dt = pageDrag();
    fireEvent.dragStart(screen.getByTestId('thumb-1').parentElement!, { dataTransfer: dt });
    const tab = document.querySelector(`[data-tab-id="${first}"]`)!;
    fireEvent.dragOver(tab, { dataTransfer: dt });
    expect(screen.getByTestId('drop-label').textContent).toBe('Hold to switch to this document');
    await waitFor(() => expect(useTabs.getState().activeId).toBe(first), { timeout: 2000 });
    // Now over the first document's thumbnails: a copy from the second tab.
    fireEvent.dragOver(screen.getByTestId('thumb-1'), { dataTransfer: dt });
    expect(screen.getByTestId('drop-label').textContent).toBe('Copy the page into this document');
    expect(dt.dropEffect).toBe('copy');
    expect(screen.getAllByTestId('thumb-drop-line')).toHaveLength(1);
    expect(useDnd.getState().pageDrag?.tabId).toBe(second);
  });
});

describe('dialog lists', () => {
  it('folders give their PDFs, other files are left out', async () => {
    const { listPaths } = await import('@/actions/dnd');
    const f = (name: string, path: string | null, isDir = false) => ({ name, path, isDir, read: async () => new Uint8Array() });
    const collect = vi.fn(async (dir: string, deep: boolean) => (deep ? [`${dir}\\a.pdf`, `${dir}\\sub\\b.pdf`] : [`${dir}\\a.pdf`]));
    const r = await listPaths([f('x.pdf', 'C:\\d\\x.pdf'), f('Scans', 'C:\\Scans', true), f('n.docx', 'C:\\d\\n.docx'), f('y.pdf', null), f('x.pdf', 'C:\\d\\x.pdf')], false, collect);
    expect(r).toEqual({ paths: ['C:\\d\\x.pdf', 'C:\\Scans\\a.pdf'], skipped: ['n.docx'], noPath: ['y.pdf'] });
    expect(collect).toHaveBeenCalledWith('C:\\Scans', false);
    expect((await listPaths([f('Scans', 'C:\\Scans', true)], true, collect)).paths).toHaveLength(2);
  });
});
