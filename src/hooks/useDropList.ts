/** A dialog's file list that takes PDFs and folders dragged from Explorer. */
import { useEffect, useRef } from 'react';
import { useDnd } from '@/store/dnd';

/**
 * Registers the list `name` (put `data-drop-list={name}` on its element);
 * `add` gets the PDF paths. Returns whether a drag is over the list now.
 */
export function useDropList(name: string, add: (paths: string[]) => void, opts: { subfolders: boolean; enabled: boolean }): boolean {
  const latest = useRef({ add, opts });
  latest.current = { add, opts };
  useEffect(() => {
    if (!opts.enabled) return;
    let off: (() => void) | null = null;
    let gone = false;
    void import('@/actions/dnd').then((m) => {
      if (gone) return;
      off = m.registerDropList(name, (files) => m.dropIntoList(files, latest.current.opts.subfolders, latest.current.add));
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [name, opts.enabled]);
  return useDnd((s) => !!s.active && s.target?.kind === 'list' && s.target.list === name);
}
