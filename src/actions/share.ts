/**
 * File → Send by e-mail: the document as it is now (all edits applied) goes
 * into a new message of the default mail program as an attachment. When no
 * mail program takes attachments that way (the new Outlook, web mail), the
 * file is saved next to a ready message and shown in Explorer to drag in.
 */
import { invoke } from '@tauri-apps/api/core';
import { usePDFStore } from '@/store/usePDFStore';
import { translate } from '@/lib/i18n';
import { isDesktop, openExternal, revealInExplorer, sendMail } from '@/lib/platform';
import { errorMessage, exportCurrentPdf, primarySourceBytes, suggestedName, withBusy } from './document';
import { protectForSave } from './protection';

export async function emailDocument(): Promise<void> {
  const s = usePDFStore.getState();
  if (!s.pages.length) return;
  if (!isDesktop) {
    s.toast('Sending by e-mail needs the desktop app.', 'info');
    return;
  }
  const name = suggestedName();
  const path = await withBusy('Preparing the attachment…', async (progress) => {
    // A protected document is sent protected, as it would be saved.
    const bytes = s.readOnlyReason ? primarySourceBytes() : await protectForSave(await exportCurrentPdf({}, progress));
    if (!bytes) throw new Error(s.readOnlyReason ?? 'Nothing to send.');
    return invoke<string>('mail_prepare', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
  });
  if (!path) return;
  const subject = name.replace(/\.pdf$/i, '');
  const body = translate('Please find the document attached.');
  try {
    await sendMail(path, name, subject, body);
  } catch (e) {
    const msg = errorMessage(e);
    if (!msg.startsWith('NO_MAPI')) {
      s.toast(msg, 'error');
      return;
    }
    // No Simple MAPI: an empty message and the file in Explorer to drag into it.
    await openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch(() => undefined);
    await revealInExplorer(path).catch(() => undefined);
    s.toast('Your mail program cannot take attachments directly: the file is shown in Explorer, drag it into the new message.', 'info');
  }
}
