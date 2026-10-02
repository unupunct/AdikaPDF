/** Verify → Save report: the signature checks of the open document as a PDF. */
import { usePDFStore } from '@/store/usePDFStore';
import { translate, useLang } from '@/lib/i18n';
import { loadFontBytes } from '@/lib/fonts';
import { withBusy } from './document';
import { saveFile } from './saveGuard';

const LOCALES: Record<string, string> = { en: 'en-GB', ro: 'ro-RO', de: 'de-DE', fr: 'fr-FR', hu: 'hu-HU', it: 'it-IT', es: 'es-ES' };

export async function saveValidationReport(): Promise<void> {
  const s = usePDFStore.getState();
  const fileName = s.fileName ?? 'document.pdf';
  const bytes = await withBusy('Writing the report…', async () => {
    const { validationReportPdf } = await import('@/lib/crypto/validationReport');
    return validationReportPdf(s.signatureStatus, { fileName, loadFont: loadFontBytes, t: translate, locale: LOCALES[useLang.getState().lang] });
  });
  if (!bytes) return;
  await saveFile(bytes, `${fileName.replace(/\.pdf$/i, '')}-validation.pdf`, [{ name: 'PDF documents', extensions: ['pdf'] }]);
}
