/** What is being dragged over the window and what dropping it here would do (actions/dnd.ts keeps it up to date). */
import { create } from 'zustand';
import type { DropTarget } from '@/lib/dnd';

export interface PageDrag {
  tabId: string;
  pageIds: string[];
  /** blockedReason(…, 'copy') of the source document. */
  copyBlocked: string | null;
}

export interface DndState {
  /** Files from Explorer or pages are being dragged over the window. */
  active: 'files' | 'pages' | null;
  target: DropTarget | null;
  label: string;
  rejected: boolean;
  pageDrag: PageDrag | null;
}

export const useDnd = create<DndState>()(() => ({ active: null, target: null, label: '', rejected: false, pageDrag: null }));
