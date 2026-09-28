/** Arguments passed from ribbon buttons to the modal they open. */
import { create } from 'zustand';
import type { ExportFormat } from '@/actions/convert';

export type ImportKind = 'office' | 'images' | 'html' | 'markdown' | 'documents' | 'cad' | 'scan';

/** A box drawn on a page (display points) that a modal completes: a link area or a crop box. */
export interface PageBox {
  pageId: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface ModalArgs {
  exportFormat: ExportFormat;
  importKind: ImportKind;
  /** Link being created (link tool) or edited (existing link object id). */
  linkDraft: (PageBox & { objectId?: string }) | null;
  /** Crop box drawn with the crop tool. */
  cropDraft: PageBox | null;
  /** Tab the page-marks dialog opens on. */
  pageMarksTab: 'watermark' | 'header' | 'background';
}

export const useModalArgs = create<ModalArgs>()(() => ({ exportFormat: 'docx', importKind: 'office', linkDraft: null, cropDraft: null, pageMarksTab: 'watermark' }));
