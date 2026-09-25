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
  resolve: (ok: boolean) => void;
}

interface DialogState {
  password: PasswordPrompt | null;
  confirm: ConfirmPrompt | null;
}

export const useDialogs = create<DialogState>()(() => ({ password: null, confirm: null }));

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
          resolve(ok);
        },
      },
    });
  });
}
