/**
 * Password-protected documents: the owner's restrictions (as Acrobat honours
 * them when the file is opened without the owner password), unlocking them
 * with the owner password, and saving with the same protection.
 */
import { blockedReason, protectionOf, type EditKind, usePDFStore } from '@/store/usePDFStore';
import { askPassword } from '@/store/useDialogs';

/** False (with a message) when the owner's restrictions or a read-only file do not allow this. */
export function allowed(kind: EditKind | 'print' | 'copy'): boolean {
  const s = usePDFStore.getState();
  const why = blockedReason(s, kind);
  if (why) s.toast(why, 'info');
  return !why;
}

/**
 * A new file made from a protected document (a converted, signed or compressed
 * copy…) has no protection: only with every right (the owner password).
 */
export function allowUnprotectedCopy(): boolean {
  const s = usePDFStore.getState();
  if (!s.protection || s.protection.full) return true;
  s.toast("This PDF's owner restricts it: a new copy would drop that protection. Enter the owner password to unlock it.", 'info');
  return false;
}

/** Saved bytes encrypted again like the opened file (same passwords and permissions), unless the protection was removed. */
export async function protectForSave(bytes: Uint8Array): Promise<Uint8Array> {
  const p = usePDFStore.getState().protection;
  if (!p?.keep) return bytes;
  const { encryptWithSecurity } = await import('@/lib/crypto/decrypt');
  return encryptWithSecurity(bytes, p.unlocked);
}

/** Asks for the owner password; with it every restriction is lifted. */
export async function enterOwnerPassword(): Promise<boolean> {
  const s = usePDFStore.getState();
  const p = s.protection;
  if (!p) return false;
  const { isOwnerPassword } = await import('@/lib/crypto/decrypt');
  let incorrect = false;
  for (;;) {
    const pw = await askPassword(s.fileName ?? 'Untitled.pdf', incorrect, true);
    if (pw === null) return false;
    if (await isOwnerPassword(p.unlocked.security, pw)) {
      // The same document (another tab may be active by now): only if it is still this one.
      if (usePDFStore.getState().protection !== p) return false;
      usePDFStore.setState({ protection: { ...protectionOf(p.unlocked, true), keep: p.keep } });
      usePDFStore.getState().toast('Owner password accepted: every restriction is lifted.', 'success');
      return true;
    }
    incorrect = true;
  }
}

/** Saving writes the document without its password protection (`false`), or with it again. */
export function setKeepProtection(keep: boolean): void {
  const s = usePDFStore.getState();
  const p = s.protection;
  if (!p || p.keep === keep) return;
  if (!keep && !p.full) {
    s.toast("Only the owner can remove this PDF's protection. Enter the owner password first.", 'info');
    return;
  }
  usePDFStore.setState({ protection: { ...p, keep }, dirty: true, savedDoc: null });
  s.toast(keep ? 'Saving keeps the password protection.' : 'The password protection is removed when you save.', 'info');
}
