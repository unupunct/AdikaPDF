/**
 * Floating toolbar over selected text (like Foxit): copy, read aloud, highlight,
 * underline, strikeout, squiggly. With a markup tool active, the markup is
 * applied as soon as the mouse is released instead.
 */
import { useEffect, useState } from 'react';
import { Copy, Highlighter, Strikethrough, Underline, Volume2, Waves } from 'lucide-react';
import { readSelection } from '@/actions/readingAids';
import { usePDFStore } from '@/store/usePDFStore';
import { applyMarkupToSelection, selectionByPage } from '@/lib/selectionMarkup';
import { markupKindOf } from '@/lib/tools';
import type { MarkupKind } from '@/types';

export function SelectionToolbar() {
  const tool = usePDFStore((s) => s.tool);
  const readOnly = usePDFStore((s) => s.readOnlyReason !== null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onUp = () =>
      // Let the browser finish updating the selection first.
      setTimeout(() => {
        const s = usePDFStore.getState();
        const kind = markupKindOf(s.tool);
        if (kind) {
          if (applyMarkupToSelection(kind)) setPos(null);
          return;
        }
        if (s.tool !== 'selectText' || selectionByPage().length === 0) {
          setPos(null);
          return;
        }
        const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
        if (r) setPos({ x: r.left + r.width / 2, y: r.top });
      }, 0);
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest('[data-testid="selection-toolbar"]')) setPos(null);
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerdown', onDown);
    };
  }, []);

  useEffect(() => {
    if (tool !== 'selectText') setPos(null);
  }, [tool]);

  if (!pos) return null;
  const mark = (k: MarkupKind) => {
    applyMarkupToSelection(k);
    setPos(null);
  };
  const Btn = ({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId: string }) => (
    <button type="button" title={label} aria-label={label} data-testid={testId} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded hover-app">
      {children}
    </button>
  );
  return (
    <div
      data-testid="selection-toolbar"
      className="fixed z-[70] flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-app bg-panel p-0.5 shadow-lg"
      style={{ left: pos.x, top: pos.y - 6 }}
    >
      <Btn label="Copy" testId="sel-copy" onClick={() => void navigator.clipboard?.writeText(window.getSelection()?.toString() ?? '').then(() => usePDFStore.getState().toast('Copied.', 'success'))}>
        <Copy size={14} />
      </Btn>
      <Btn label="Read aloud" testId="sel-read" onClick={readSelection}>
        <Volume2 size={14} />
      </Btn>
      {readOnly ? null : (
        <>
          <span className="mx-0.5 h-4 w-px bg-[var(--border)]" />
          <Btn label="Highlight" testId="sel-highlight" onClick={() => mark('highlight')}>
            <Highlighter size={14} className="text-amber-500" />
          </Btn>
          <Btn label="Underline" testId="sel-underline" onClick={() => mark('underline')}>
            <Underline size={14} className="text-green-600" />
          </Btn>
          <Btn label="Strikeout" testId="sel-strikeout" onClick={() => mark('strikeout')}>
            <Strikethrough size={14} className="text-red-600" />
          </Btn>
          <Btn label="Squiggly underline" testId="sel-squiggly" onClick={() => mark('squiggly')}>
            <Waves size={14} className="text-blue-600" />
          </Btn>
        </>
      )}
    </div>
  );
}
