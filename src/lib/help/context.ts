/**
 * Context help: the guide page (and heading) for each dialog. F1 inside a
 * dialog and the dialog's "?" button open it; anything else opens the start
 * page. Anchors are the GitHub-style heading ids of the English page; when
 * the Romanian page has no such heading the page opens at the top.
 */
import type { ModalId } from '@/store/usePDFStore';

export const HELP_CONTEXT: Partial<Record<Exclude<ModalId, null>, string>> = {
  einvoice: 'efactura-read',
  einvoiceNew: 'efactura-create',
  anaf: 'efactura-anaf-send',
  signature: 'signing-concepts',
  certificate: 'signing-sign',
  token: 'signing-sign',
  winstore: 'signing-sign',
  cloudsign: 'signing-sign',
  batchsign: 'signing-batch',
  verify: 'signing-verify',
  recover: 'getting-started',
};

/** Help topics of dialogs that are not store modals (opened inside another dialog). */
export const HELP_TOPICS = {
  sigDesigner: 'signing-appearance',
  welcome: 'the-window#the-welcome-screen',
  welcomeSign: 'signing-sign',
  welcomeInvoice: 'efactura-create',
  ribbonModes: 'the-window#simple-and-full-ribbon',
} as const;

/** The help topic for the dialog that is open (or the start page). */
export function helpTopicFor(modal: ModalId | null | undefined): string {
  return (modal && HELP_CONTEXT[modal]) || 'index';
}
