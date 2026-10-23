/**
 * Company policies (Group Policy / registry) and the portable mode.
 *
 * The native side reads `HKLM\SOFTWARE\Policies\Adika PDF Editor` and the
 * HKCU equivalent once at start-up (`deployment_info`); a machine value wins
 * over a user value. Values the installer wrote (`/NOUPDATES`, `/LANG=`) are
 * read from `Software\unupunct\Adika PDF Editor` and count only where no
 * policy is set. Templates: deploy/policies (ADMX/ADML).
 *
 * Every network feature asks `onlineAllowed(feature)` (or `assertOnline`);
 * platform.ts gates all native HTTP centrally and net.rs refuses again.
 */
import { create } from 'zustand';
import { LANGS, type Lang } from './i18n';

export type OnlineFeature = 'updates' | 'revocation' | 'timestamp' | 'trustedList' | 'cloudSign' | 'anaf' | 'urlConvert' | 'ocrLanguages' | 'report' | 'network';

type Kind = 'flag' | 'lang' | 'url' | 'list';

/** The supported policies (registry value names, case-insensitive). */
export const POLICY_DEFS: ReadonlyArray<{ name: string; kind: Kind; label: string; installer?: boolean }> = [
  { name: 'DisableUpdateCheck', kind: 'flag', label: 'Update check turned off', installer: true },
  { name: 'DisableOnlineFeatures', kind: 'flag', label: 'Online features turned off' },
  { name: 'DisableCloudSigning', kind: 'flag', label: 'Remote (cloud) signing turned off' },
  { name: 'DefaultLanguage', kind: 'lang', label: 'Default interface language', installer: true },
  { name: 'DefaultTimestampServer', kind: 'url', label: 'Default timestamp server' },
  { name: 'AllowedSigningCertificateIssuers', kind: 'list', label: 'Signing certificates allowed from' },
  { name: 'SaveIncremental', kind: 'flag', label: 'Save as incremental update' },
];

export type RegValue = number | string | string[];
export type RegValues = Record<string, RegValue>;
export interface PolicySources {
  machine: RegValues;
  user: RegValues;
  installer: RegValues;
}

export interface Policies {
  disableUpdateCheck: boolean;
  disableOnlineFeatures: boolean;
  disableCloudSigning: boolean;
  defaultLanguage: Lang | null;
  defaultTimestampServer: string | null;
  /** Parts of an issuer name; empty: every certificate. */
  allowedSigningCertificateIssuers: string[];
  /** Forced "save as incremental update" setting, or null (the user decides). */
  saveIncremental: boolean | null;
}

export interface PolicyEntry {
  name: string;
  label: string;
  value: string;
  source: 'machine' | 'user' | 'installer';
}

export const NO_POLICIES: Policies = {
  disableUpdateCheck: false,
  disableOnlineFeatures: false,
  disableCloudSigning: false,
  defaultLanguage: null,
  defaultTimestampServer: null,
  allowedSigningCertificateIssuers: [],
  saveIncremental: null,
};

export const FALLBACK_TSA = 'http://timestamp.digicert.com';

function lookup(values: RegValues | undefined, name: string): RegValue | undefined {
  if (!values) return undefined;
  const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : values[key];
}

/** A registry value as the policy's type; undefined when it does not fit (then it is ignored). */
export function parseValue(kind: Kind, v: RegValue | undefined): boolean | string | string[] | undefined {
  if (v === undefined) return undefined;
  switch (kind) {
    case 'flag':
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (['1', 'true', 'yes'].includes(t)) return true;
        if (['0', 'false', 'no'].includes(t)) return false;
      }
      return undefined;
    case 'lang': {
      const t = typeof v === 'string' ? v.trim().toLowerCase().slice(0, 2) : '';
      return LANGS.some((l) => l.id === t) ? t : undefined;
    }
    case 'url': {
      const t = typeof v === 'string' ? v.trim() : '';
      return /^https?:\/\/[^\s/]+/i.test(t) ? t : undefined;
    }
    case 'list': {
      const items = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;\r\n]+/) : []).map((s) => s.trim()).filter(Boolean);
      return items.length ? items : undefined;
    }
  }
}

function show(v: boolean | string | string[]): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return Array.isArray(v) ? v.join('; ') : v;
}

/** Machine over user; installer defaults only for the policies the installer can set. */
export function mergePolicies(src: Partial<PolicySources>): { policies: Policies; entries: PolicyEntry[] } {
  const out: Record<string, unknown> = {};
  const entries: PolicyEntry[] = [];
  for (const def of POLICY_DEFS) {
    const order: Array<PolicyEntry['source']> = def.installer ? ['machine', 'user', 'installer'] : ['machine', 'user'];
    for (const source of order) {
      const v = parseValue(def.kind, lookup(src[source], def.name));
      if (v === undefined) continue;
      out[def.name.charAt(0).toLowerCase() + def.name.slice(1)] = v;
      entries.push({ name: def.name, label: def.label, value: show(v), source });
      break;
    }
  }
  return { policies: { ...NO_POLICIES, ...(out as Partial<Policies>) }, entries };
}

interface PolicyState {
  policies: Policies;
  entries: PolicyEntry[];
  portable: boolean;
  /** Portable data folder (next to the exe). */
  dataDir: string | null;
}

export const usePolicy = create<PolicyState>()(() => ({ policies: NO_POLICIES, entries: [], portable: false, dataDir: null }));

export function policies(): Policies {
  return usePolicy.getState().policies;
}

export function isPortable(): boolean {
  return usePolicy.getState().portable;
}

/** Applies what the native side read (also used by tests). */
export function applyDeployment(info: { portable?: boolean; dataDir?: string | null; policies?: Partial<PolicySources> }): void {
  const { policies: p, entries } = mergePolicies(info.policies ?? {});
  usePolicy.setState({ policies: p, entries, portable: !!info.portable, dataDir: info.dataDir ?? null });
}

/** Start-up: reads policies and the portable mode (desktop only). */
export async function loadDeployment(): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    applyDeployment(await invoke('deployment_info'));
  } catch (e) {
    console.error('Reading the policies failed', e);
  }
}

/** Whether a network feature may run under the current policies. */
export function onlineAllowed(feature: OnlineFeature = 'network', p: Policies = policies()): boolean {
  if (p.disableOnlineFeatures) return false;
  if (feature === 'updates') return !p.disableUpdateCheck;
  if (feature === 'cloudSign') return !p.disableCloudSigning;
  return true;
}

const FEATURE_NAMES: Record<OnlineFeature, string> = {
  updates: 'The update check',
  revocation: 'Checking certificates online',
  timestamp: 'Timestamping',
  trustedList: 'Downloading the EU Trusted Lists',
  cloudSign: 'Remote (cloud) signing',
  anaf: 'The ANAF connection',
  urlConvert: 'Converting a web page',
  ocrLanguages: 'Downloading OCR languages',
  report: 'Opening GitHub to report a problem',
  network: 'This online feature',
};

export class PolicyError extends Error {
  constructor(feature: OnlineFeature) {
    super(`${FEATURE_NAMES[feature]} is turned off by your organisation.`);
    this.name = 'PolicyError';
  }
}

export function assertOnline(feature: OnlineFeature = 'network'): void {
  if (!onlineAllowed(feature)) throw new PolicyError(feature);
}

/** The timestamp server offered by default. */
export function defaultTsaUrl(): string {
  return policies().defaultTimestampServer ?? FALLBACK_TSA;
}

/** "CN=…, O=…, C=…" of a forge-style name. */
export function dnString(name: { attributes: Array<{ shortName?: string; name?: string; value?: unknown }> }): string {
  return name.attributes.map((a) => `${a.shortName ?? a.name ?? ''}=${String(a.value ?? '')}`).join(', ');
}

/** AllowedSigningCertificateIssuers: some entry is part of the issuer name (case-insensitive). */
export function signingIssuerAllowed(issuerDn: string, p: Policies = policies()): boolean {
  const list = p.allowedSigningCertificateIssuers;
  if (!list.length) return true;
  const dn = issuerDn.toLowerCase();
  return list.some((e) => dn.includes(e.toLowerCase()));
}

export function assertSigningIssuer(cert: { issuer: { attributes: Array<{ shortName?: string; name?: string; value?: unknown }> } }): void {
  const dn = dnString(cert.issuer);
  if (!signingIssuerAllowed(dn)) throw new Error(`Your organisation does not allow signing with certificates from this issuer: ${dn}`);
}
