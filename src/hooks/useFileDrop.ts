/**
 * Window-wide file drop. PDFs open (or are appended when a document is
 * open), images become pages (or are placed as images), Office files are
 * converted through the desktop app.
 */
import { useEffect, useRef, useState } from 'react';
import { usePDFStore } from '@/store/usePDFStore';
import { openPdfBytes, withBusy } from '@/actions/document';
import { CAD_EXTENSIONS, DOCUMENT_EXTENSIONS, deliverPdf, documentToPdf, imagesToPdf, OFFICE_EXTENSIONS, IMAGE_EXTENSIONS } from '@/actions/convert';
import { loadFontBytes } from '@/lib/fonts';
import { imageFileToDataUrl } from '@/lib/objectFactory';
import { decodeTiff } from '@/lib/images';

export function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void handleFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return dragging;
}

async function handleFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const ext = (f: File) => f.name.split('.').pop()?.toLowerCase() ?? '';
  const pdfs = files.filter((f) => ext(f) === 'pdf');
  const images = files.filter((f) => IMAGE_EXTENSIONS.includes(ext(f)));
  const office = files.filter((f) => OFFICE_EXTENSIONS.includes(ext(f)));
  const docs = files.filter((f) => DOCUMENT_EXTENSIONS.includes(ext(f)) || CAD_EXTENSIONS.includes(ext(f)));
  const store = usePDFStore.getState();
  const hasDoc = store.pages.length > 0;

  if (office.length) {
    store.toast('Office files dropped from Explorer: use Convert → Office to pick them (the converter needs their location on disk).', 'info');
    store.openModal('import');
  }
  if (pdfs.length) {
    if (!hasDoc) {
      const [first, ...rest] = pdfs;
      const ok = await openPdfBytes(new Uint8Array(await first.arrayBuffer()), first.name);
      for (const f of ok ? rest : []) await usePDFStore.getState().mergeDocument(new Uint8Array(await f.arrayBuffer()), f.name);
    } else {
      await withBusy('Adding pages…', async () => {
        for (const f of pdfs) await usePDFStore.getState().mergeDocument(new Uint8Array(await f.arrayBuffer()), f.name);
      });
      usePDFStore.getState().toast(`Added ${pdfs.length} PDF${pdfs.length > 1 ? 's' : ''} at the end.`, 'success');
    }
  }
  for (const f of docs) {
    await withBusy(`Converting ${f.name}…`, async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let pdf: Uint8Array;
      if (ext(f) === 'dxf') {
        const { DXF_DEFAULT_OPTIONS, decodeDxf, dxfToPdf } = await import('@/lib/pdf/dxf');
        pdf = (await dxfToPdf(decodeDxf(bytes), { ...DXF_DEFAULT_OPTIONS, loadFont: () => loadFontBytes({ family: 'sans', bold: false, italic: false }) })).bytes;
      } else {
        pdf = (await documentToPdf(bytes, f.name, { pageSize: 'A4', landscape: false, marginMm: 15 })).bytes;
      }
      const st = usePDFStore.getState();
      await deliverPdf(pdf, f.name, st.pages.length > 0 && !st.readOnlyReason);
    });
  }
  if (images.length) {
    const decoded: Array<{ src: string; width: number; height: number }> = [];
    for (const f of images) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/tiff?$/.test(ext(f))) decoded.push(...decodeTiff(bytes));
      else decoded.push(await imageFileToDataUrl(bytes, f.name));
    }
    const s = usePDFStore.getState();
    if (s.pages.length > 0 && decoded.length === 1 && !s.readOnlyReason) {
      s.setPendingImage(decoded[0]);
      s.toast('Click on the page to place the image.', 'info');
    } else {
      await withBusy('Creating PDF from images…', async () => {
        await deliverPdf(await imagesToPdf(decoded, { pageSize: 'a4', orientation: 'auto', marginMm: 10 }), `${images[0].name}.pdf`, usePDFStore.getState().pages.length > 0);
      });
    }
  }
}
