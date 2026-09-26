/** Arguments passed from ribbon buttons to the modal they open. */
import { create } from 'zustand';
import type { ExportFormat } from '@/actions/convert';

export type ImportKind = 'office' | 'images' | 'html' | 'markdown' | 'documents' | 'cad' | 'scan';

interface ModalArgs {
  exportFormat: ExportFormat;
  importKind: ImportKind;
}

export const useModalArgs = create<ModalArgs>()(() => ({ exportFormat: 'docx', importKind: 'office' }));
