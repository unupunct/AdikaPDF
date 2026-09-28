/** Comment author name: user setting, else the Windows account name. */
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './platform';

const KEY = 'adika.author';
let osName = '';

export async function initAuthor(): Promise<void> {
  if (isDesktop) osName = await invoke<string>('os_user_name').catch(() => '');
}

export function getAuthor(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v.trim()) return v.trim();
  } catch {
    /* ignore */
  }
  return osName || 'Adika user';
}

export function setAuthor(name: string): void {
  try {
    localStorage.setItem(KEY, name.trim());
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('adika:author'));
}
