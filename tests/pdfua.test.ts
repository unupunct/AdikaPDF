import { describe, expect, it } from 'vitest';
import { checkPdfUa } from '@/lib/pdf/pdfua';
import { uaDoc } from './helpers/uaDoc';

describe('PDF/UA checker', () => {
  it('passes a conforming document', async () => {
    const r = await checkPdfUa(await uaDoc());
    expect(r.issues).toEqual([]);
  });
});
