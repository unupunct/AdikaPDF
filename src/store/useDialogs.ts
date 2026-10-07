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

/** Asks which certificate (Windows store or digital ID file) opens a document encrypted for certificates. */
export function askCertificateKey(fileName: string, recipients: string[], error: string | null = null): Promise<import('@/lib/crypto/pubsec').RecipientKey | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      certKey: {
        fileName,
        recipients,
        error,
        resolve: (v) => {
          useDialogs.setState({ certKey: null });
          resolve(v);
        },
      },
    });
  });
}

export function askPassword(fileName: string, incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      password: {
        fileName,
        incorrect,
        resolve: (v) => {
          useDialogs.setState({ password: null });
          resolve(v);
        },
      },
    });
  });
}

/** Shows a message with an OK button (e.g. a form script's app.alert). */
export function showMessage(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    useDialogs.setState({
      confirm: {
        title,
        message,
        confirmLabel: 'OK',
        danger: false,
        messageOnly: true,
        resolve: () => {
          useDialogs.setState({ confirm: null });
          resolve();
        },
      },
    });
  });
}

export function askConfirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.setState({
      confirm: {
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? 'Continue',
        danger: opts.danger ?? false,
        resolve: (ok) => {
          useDialogs.setState({ confirm: null });
          resolve(ok === true);
        },
      },
    });
  });
}

/** Asks with three buttons: Cancel (null), `altLabel` ('alt') and `confirmLabel` ('confirm'). */
export function askChoice(opts: { title: string; message: string; confirmLabel: string; altLabel: string; danger?: boolean }): Promise<'confirm' | 'alt' | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      confirm: {
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel,
        altLabel: opts.altLabel,
        danger: opts.danger ?? false,
        resolve: (v) => {
          useDialogs.setState({ confirm: null });
          resolve(v === 'alt' ? 'alt' : v ? 'confirm' : null);
        },
      },
    });
  });
}
