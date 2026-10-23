// pdf.js scales viewports by /UserUnit; the app's display space is the page's own points.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import { rawPdf, stream } from './helpers/rawPdf';

const bytes = rawPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /UserUnit 3 /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  stream('BT /F1 10 Tf 20 100 Td (Big) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]);
const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
afterAll(() => task.destroy());
const page = async () => (await task.promise).getPage(1) as unknown as Promise<PDFPageProxy>;

vi.mock('@/lib/pdf/pdfService', () => ({
  getPdfPage: () => page(),
  getTextItems: async () => (await (await page()).getTextContent()).items,
  getTextStyles: async () => (await (await page()).getTextContent()).styles,
}));

describe('text runs on a page with /UserUnit', () => {
  it('are in the page points the app works in', async () => {
    const { pageTextRuns } = await import('@/lib/pdf/textGeometry');
    const [run] = await pageTextRuns({ id: 'p', kind: 'source', sourceId: 's', sourceIndex: 0, baseRotation: 0, userRotation: 0, width: 200, height: 200 });
    expect(run.str).toBe('Big');
    expect(run.origin[0]).toBeCloseTo(20);
    expect(run.origin[1]).toBeCloseTo(100);
  });
});
