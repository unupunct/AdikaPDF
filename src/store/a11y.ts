/**
 * Accessibility panel and Reading order mode: the last PDF/UA report, the
 * area highlighted on a page (an issue clicked in the report), and the
 * reading-order editor (on / off, selected items, type for new regions).
 */
import { create } from 'zustand';
import type { UaReport } from '@/lib/pdf/pdfua';
import type { OrderType } from '@/lib/pdf/readingOrder';
import type { Box } from '@/lib/pdf/textRemoval';

export interface A11yState {
  report: UaReport | null;
  checking: boolean;
  highlight: { pageId: string; box: Box } | null;
  orderMode: boolean;
  /** Item ids (structure elements) selected in Reading order. */
  selected: string[];
  /** Page (PageRef id) of the selection. */
  selectedPage: string | null;
  /** Type a drawn rectangle tags its untagged content as. */
  regionType: OrderType;
  /** Bumped after every reading-order edit so the boxes reload. */
  epoch: number;
}

export const useA11y = create<A11yState>()(() => ({ report: null, checking: false, highlight: null, orderMode: false, selected: [], selectedPage: null, regionType: 'P', epoch: 0 }));
