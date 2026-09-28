/** Popup editor for a sticky note, anchored next to its icon. */
import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { NoteObject } from '@/types';
import { usePDFStore } from '@/store/usePDFStore';

export function NotePopup({ note, zoom, pageWidth }: { note: NoteObject; zoom: number; pageWidth: number }) {
  const [text, setText] = useState(note.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // Focus now and again after the creating click completes.
    const focus = () => {
      if (document.activeElement !== ref.current) ref.current?.focus();
    };
    focus();
    const id = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(id);
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const store = usePDFStore.getState();
    if (text !== note.text) store.updateObject(note.id, { text, modifiedAt: new Date().toISOString() });
    store.setEditingText(null);
  };

  const width = 220;
  // Open to the right of the icon, or to the left near the page edge.
  const right = (note.x + 24) * zoom + width < pageWidth * zoom;
  const left = right ? (note.x + 24) * zoom : Math.max(0, note.x * zoom - width - 6);

  return (
    <div
      data-testid="note-popup"
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-amber-300 bg-amber-50 shadow-xl dark:border-amber-700 dark:bg-amber-950"
      style={{ left, top: note.y * zoom, width }}
    >
      <div className="flex items-center gap-1 border-b border-amber-200 bg-amber-100 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/60 dark:text-amber-100">
        <span className="min-w-0 flex-1 truncate font-semibold">{note.author}</span>
        <span className="opacity-70">{new Date(note.modifiedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
        <button
          type="button"
          aria-label="Delete note"
          onClick={() => {
            done.current = true;
            usePDFStore.getState().deleteObjects([note.id]);
          }}
          className="rounded p-0.5 hover:bg-amber-200 dark:hover:bg-amber-800"
        >
          <Trash2 size={12} />
        </button>
        <button type="button" aria-label="Close note" onClick={commit} className="rounded p-0.5 hover:bg-amber-200 dark:hover:bg-amber-800">
          <X size={12} />
        </button>
      </div>
      <textarea
        ref={ref}
        data-testid="note-text"
        value={text}
        rows={5}
        placeholder="Write a comment…"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) commit();
        }}
        className="resize-none bg-transparent px-2 py-1.5 text-[12.5px] text-slate-900 outline-none dark:text-amber-50"
      />
    </div>
  );
}
