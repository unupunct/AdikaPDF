import { ArrowUpCircle, BadgeCheck, BadgeX, ShieldAlert, X } from 'lucide-react';
import { useUpdates } from '@/lib/updates';
import { openExternal } from '@/lib/platform';
import { usePDFStore } from '@/store/usePDFStore';
import { displaySize } from '@/lib/geometry';
import { AUTO_SPEEDS, useAutoScroll } from '@/components/viewer/AutoScroll';

const TOOL_HINTS: Partial<Record<string, string>> = {
  select: 'Click to select · Shift-click to add · drag empty space to box-select · Alt while dragging disables snapping',
  pan: 'Drag to scroll the page',
  text: 'Click where the new text should start',
  editText: 'Click on existing text to replace it',
  image: 'Click to place the image',
  signature: 'Click to place your signature',
  rect: 'Drag to draw · Shift for a square',
  ellipse: 'Drag to draw · Shift for a circle',
  line: 'Drag to draw · Shift snaps to 45°',
  arrow: 'Drag to draw · Shift snaps to 45°',
  pen: 'Draw freely · the tool stays active',
  highlight: 'Drag over text to highlight · the tool stays active',
  redact: 'Drag over content to mark it for permanent removal',
  'measure-distance': 'Drag between two points · Shift snaps to 45° · the tool stays active',
  'measure-perimeter': 'Click the points · double-click or Enter to finish · Backspace removes a point',
  'measure-area': 'Click the corners · double-click, Enter or the first point finishes',
  snapshot: 'Drag a box to copy that area as a picture',
};

export function StatusBar() {
  const pages = usePDFStore((s) => s.pages);
  const currentPageId = usePDFStore((s) => s.currentPageId);
  const tool = usePDFStore((s) => s.tool);
  const zoom = usePDFStore((s) => s.zoom);
  const selected = usePDFStore((s) => s.selectedIds.length);
  const sigs = usePDFStore((s) => s.signatureStatus);
  const idx = pages.findIndex((p) => p.id === currentPageId);
  const page = pages[idx];
  const size = page ? displaySize(page) : null;
  const hint = tool.startsWith('field-') ? 'Click or drag to place a form field' : TOOL_HINTS[tool];
  const auto = useAutoScroll();
  const upd = useUpdates();
  const showUpdate = upd.status === 'available' && upd.latest && upd.dismissed !== upd.latest.version;
  const invalid = sigs.some((s) => s.integrity !== 'valid' || s.modifiedAfterSigning);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-app bg-panel px-3 text-[11px] text-muted" data-testid="status-bar">
      {page ? (
        <>
          <span data-testid="status-page">
            Page {idx + 1} of {pages.length}
          </span>
          {size ? (
            <span>
              {(size.width / 72 * 25.4).toFixed(0)} × {(size.height / 72 * 25.4).toFixed(0)} mm
            </span>
          ) : null}
          <span>{Math.round(zoom * 100)}%</span>
          {selected ? <span>{selected} selected</span> : null}
        </>
      ) : (
        <span>Ready</span>
      )}
      <span className="min-w-0 flex-1 truncate">{page ? hint : ''}</span>
      {auto.on ? (
        <span data-testid="status-autoscroll" className="font-medium text-brand-700 dark:text-brand-300">
          Auto-scroll {auto.direction === 1 ? '↓' : '↑'} {AUTO_SPEEDS[auto.level]} px/s · ↑↓ speed · − reverse · Esc stop
        </span>
      ) : null}
      {sigs.length ? (
        <button
          type="button"
          onClick={() => usePDFStore.getState().openModal('verify')}
          className={`flex items-center gap-1 ${invalid ? 'text-rose-600' : 'text-accent-600'}`}
          data-testid="status-signatures"
        >
          {invalid ? <BadgeX size={13} /> : <BadgeCheck size={13} />}
          {sigs.length} signature{sigs.length > 1 ? 's' : ''} · {invalid ? 'problem' : 'intact'}
        </button>
      ) : null}
      {showUpdate && upd.latest ? (
        <span className="flex items-center gap-1 font-medium text-brand-700 dark:text-brand-300" data-testid="status-update">
          <button type="button" className="flex items-center gap-1 hover:underline" onClick={() => void openExternal(upd.latest!.url)} title="Open the release page to download the installer">
            <ArrowUpCircle size={12} /> Update {upd.latest.version} available
          </button>
          <button type="button" aria-label="Dismiss" onClick={upd.dismiss} className="rounded p-0.5 hover-app">
            <X size={10} />
          </button>
        </span>
      ) : null}
      <span className="flex items-center gap-1" title="All processing happens on this computer">
        <ShieldAlert size={12} className="text-accent-600" /> Offline &amp; private
      </span>
    </footer>
  );
}
