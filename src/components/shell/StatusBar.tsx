import { BadgeCheck, BadgeX, ShieldAlert } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { displaySize } from '@/lib/geometry';

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
      <span className="flex items-center gap-1" title="All processing happens on this computer">
        <ShieldAlert size={12} className="text-accent-600" /> Offline &amp; private
      </span>
    </footer>
  );
}
