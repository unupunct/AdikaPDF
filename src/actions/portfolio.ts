/** PDF Portfolios: make one from files of any kind; opening one shows its files. */
import { usePDFStore } from '@/store/usePDFStore';
import { translate, useLang } from '@/lib/i18n';
import { loadFontBytes } from '@/lib/fonts';
import { pickFiles } from '@/lib/platform';
import type { PortfolioFile, PortfolioLabels } from '@/lib/pdf/portfolio';
import { openPdfBytes, withBusy } from './document';

export async function pickPortfolioFiles(): Promise<PortfolioFile[]> {
  const files = await pickFiles([{ name: 'All files', extensions: ['*'] }], true);
  return files.map((f) => ({ name: f.name, bytes: f.bytes, modified: new Date() }));
}

export async function createPortfolioFrom(files: PortfolioFile[], title: string): Promise<boolean> {
  const bytes = await withBusy('Making the portfolio…', async () => {
    const { createPortfolio, PORTFOLIO_EN } = await import('@/lib/pdf/portfolio');
    const labels = Object.fromEntries(Object.entries(PORTFOLIO_EN).map(([k, v]) => [k, translate(v)])) as unknown as PortfolioLabels;
    const locale = { en: 'en-GB', ro: 'ro-RO', de: 'de-DE', fr: 'fr-FR', hu: 'hu-HU', it: 'it-IT', es: 'es-ES' }[useLang.getState().lang];
    return createPortfolio(files, { title, loadFont: loadFontBytes, labels, locale });
  });
  if (!bytes) return false;
  const ok = await openPdfBytes(bytes, `${title || translate('PDF Portfolio')}.pdf`, null);
  if (ok) {
    usePDFStore.setState({ dirty: true });
    usePDFStore.getState().toast('Portfolio made. Save it to keep the PDF.', 'success');
  }
  return ok;
}

/** After opening: a portfolio shows its files; an embedded e-invoice is announced. */
export async function noteOpenedPdf(bytes: Uint8Array): Promise<void> {
  const { readPortfolio } = await import('@/lib/pdf/portfolio');
  const files = await readPortfolio(bytes).catch(() => null);
  const s = usePDFStore.getState();
  if (files) {
    s.setView({ sidebarTab: 'attachments' });
    usePDFStore.setState({ sidebarOpen: true });
    s.toast(`PDF Portfolio with ${files.length} file${files.length === 1 ? '' : 's'}: they are listed in the Attachments panel.`, 'info');
    return;
  }
  const { findEmbeddedInvoice } = await import('@/lib/einvoice/facturx');
  const inv = await findEmbeddedInvoice(bytes).catch(() => null);
  if (inv) s.toast(`This PDF carries an electronic invoice (${inv.name}). Convert → E-invoice shows its data.`, 'info');
}
