/**
 * Promise-based prompts (password, confirm) so async actions can ask the
 * user something mid-flow: `await askPassword(name)`.
 */
import { create } from 'zustand';

interface PasswordPrompt {
  fileName: string;
  incorrect: boolean;
  resolve: (password: string | null) => void;
}

interface ConfirmPrompt {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  /** Only an OK button (a message, nothing to decide). */
  messageOnly?: boolean;
  /** A third button between Cancel and the main one (`askChoice`). */
  altLabel?: string;
  resolve: (ok: boolean | 'alt') => void;
}

interface CertKeyPrompt {
  fileName: string;
  /** Who the document is encrypted for (issuer and serial number). */
  recipients: string[];
  error: string | null;
  resolve: (key: import('@/lib/crypto/pubsec').RecipientKey | null) => void;
}

interface DialogState {
  password: PasswordPrompt | null;
  confirm: ConfirmPrompt | null;
  certKey: CertKeyPrompt | null;
}

export const useDialogs = create<DialogState>()(() => ({ password: null, confirm: null, certKey: null }));

// A prompt asked while another of the same kind is open waits its turn (never replaces it,
// which would leave the first caller's promise unresolved for ever).
const waiting: { [K in keyof DialogState]: Array<NonNullable<DialogState[K]>> } = { password: [], confirm: [], certKey: [] };

function show<K extends keyof DialogState>(kind: K, prompt: NonNullable<DialogState[K]>): void {
  if (useDialogs.getState()[kind]) waiting[kind].push(prompt);
  else useDialogs.setState({ [kind]: prompt } as unknown as Partial<DialogState>);
}

function next(kind: keyof DialogState): void {
  useDialogs.setState({ [kind]: waiting[kind].shift() ?? null } as unknown as Partial<DialogState>);
}

/** Asks which certificate (Windows store or digital ID file) opens a document encrypted for certificates. */
export function askCertificateKey(fileName: string, recipients: string[], error: string | null = null): Promise<import('@/lib/crypto/pubsec').RecipientKey | null> {
  return new Promise((resolve) => {
    show('certKey', {
      fileName,
      recipients,
      error,
      resolve: (v) => {
        next('certKey');
        resolve(v);
      },
    });
  });
}

export function askPassword(fileName: string, incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    show('password', {
      fileName,
      incorrect,
      resolve: (v) => {
        next('password');
        resolve(v);
      },
    });
  });
}

/** Shows a message with an OK button (e.g. a form script's app.alert). */
export function showMessage(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    show('confirm', {
      title,
      message,
      confirmLabel: 'OK',
      danger: false,
      messageOnly: true,
      resolve: () => {
        next('confirm');
        resolve();
      },
    });
  });
}

export function askConfirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    show('confirm', {
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'Continue',
      danger: opts.danger ?? false,
      resolve: (ok) => {
        next('confirm');
        resolve(ok === true);
      },
    });
  });
}

/** Asks with three buttons: Cancel (null), `altLabel` ('alt') and `confirmLabel` ('confirm'). */
export function askChoice(opts: { title: string; message: string; confirmLabel: string; altLabel: string; danger?: boolean }): Promise<'confirm' | 'alt' | null> {
  return new Promise((resolve) => {
    show('confirm', {
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      altLabel: opts.altLabel,
      danger: opts.danger ?? false,
      resolve: (v) => {
        next('confirm');
        resolve(v === 'alt' ? 'alt' : v ? 'confirm' : null);
      },
    });
  });
}
