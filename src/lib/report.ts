/**
 * "Report a problem" / "Suggest a feature" (pure): the GitHub new-issue
 * address with the issue form's fields pre-filled, the same text for the
 * clipboard, and the clean-up of crash reports before anyone sees them.
 *
 * Only what is shown in the review dialog goes into the address: the Adika
 * version, the Windows version, the interface language and whether the copy
 * is installed or portable. No document content, file names or paths. The
 * field ids match `.github/ISSUE_TEMPLATE/*.yml` (GitHub fills form fields
 * from query parameters named after their ids).
 */

export const ISSUES_URL = 'https://github.com/unupunct/AdikaPDF/issues/new';
/** Longer addresses are cut by browsers or refused by GitHub: the crash log then goes through the clipboard. */
export const MAX_URL_LENGTH = 7500;

export type ReportKind = 'bug' | 'feature';

export interface ReportEnv {
  version: string;
  os: string;
  language: string;
  install: 'Installed' | 'Portable';
}

export interface ReportDraft {
  kind: ReportKind;
  title: string;
  env: ReportEnv;
  /** Sanitised crash report, for "Report this crash". */
  crashLog?: string;
}

/** Issue form fields: id → label (the headings GitHub writes into the issue). */
export const BUG_FIELDS = [
  { id: 'version', label: 'Adika version' },
  { id: 'os', label: 'Windows version' },
  { id: 'language', label: 'Interface language' },
  { id: 'install', label: 'Installed or portable' },
  { id: 'what-happened', label: 'What happened' },
  { id: 'expected', label: 'What did you expect' },
  { id: 'steps', label: 'Steps' },
  { id: 'crash-log', label: 'Crash report' },
] as const;

export const FEATURE_FIELDS = [
  { id: 'version', label: 'Adika version' },
  { id: 'language', label: 'Interface language' },
  { id: 'problem', label: 'What would you like to do' },
  { id: 'proposal', label: 'How could it work' },
] as const;

export const TEMPLATES: Record<ReportKind, string> = { bug: 'bug_report.yml', feature: 'feature_request.yml' };
export const TITLE_PREFIX: Record<ReportKind, string> = { bug: '[Bug]: ', feature: '[Feature]: ' };

/** The values the form gets (empty: the user writes it on GitHub). */
export function reportFields(d: ReportDraft): Array<{ id: string; label: string; value: string }> {
  const values: Record<string, string> = {
    version: d.env.version,
    os: d.env.os,
    language: d.env.language,
    install: d.env.install,
    'crash-log': d.crashLog ?? '',
  };
  const fields = d.kind === 'bug' ? BUG_FIELDS : FEATURE_FIELDS;
  return fields.filter((f) => f.id !== 'crash-log' || d.crashLog).map((f) => ({ id: f.id, label: f.label, value: values[f.id] ?? '' }));
}

/** The issue as Markdown, as GitHub shows a filled form (for "Copy text"). */
export function reportText(d: ReportDraft): string {
  const parts = [`${TITLE_PREFIX[d.kind]}${d.title}`.trim(), ''];
  for (const f of reportFields(d)) {
    parts.push(`### ${f.label}`, '');
    if (f.id === 'crash-log' && f.value) parts.push('```', f.value, '```');
    else parts.push(f.value || '_(to fill in)_');
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

/**
 * The new-issue address. When the crash log makes it too long it is left
 * out (`crashLogOmitted`): the caller copies the text and asks the user to paste it.
 */
export function reportUrl(d: ReportDraft): { url: string; crashLogOmitted: boolean } {
  const build = (withLog: boolean) => {
    const q = new URLSearchParams();
    q.set('template', TEMPLATES[d.kind]);
    q.set('title', `${TITLE_PREFIX[d.kind]}${d.title}`);
    for (const f of reportFields(d)) {
      if (!f.value || (f.id === 'crash-log' && !withLog)) continue;
      q.set(f.id, f.value);
    }
    // URLSearchParams writes spaces as "+": GitHub reads them as spaces in the form too, %20 is safer everywhere.
    return `${ISSUES_URL}?${q.toString().replace(/\+/g, '%20')}`;
  };
  const full = build(true);
  if (full.length <= MAX_URL_LENGTH || !d.crashLog) return { url: full, crashLogOmitted: false };
  return { url: build(false), crashLogOmitted: true };
}

/** "Windows 10/11" from the WebView's user agent when the native side cannot say. */
export function osFromUserAgent(ua: string): string {
  const m = /Windows NT (\d+\.\d+)/.exec(ua);
  if (!m) return ua.includes('Win') ? 'Windows' : 'Unknown';
  return m[1] === '10.0' ? 'Windows 10 or 11' : `Windows NT ${m[1]}`;
}

// ---------------------------------------------------------------- crash reports

/** Extensions of files people work on: their names are removed from reports. */
const DOCUMENT_EXT =
  'pdf|fdf|xfdf|docx?|docm|dotx|xlsx?|xlsm|xlsb|pptx?|pptm|ppsx|odt|ods|odp|rtf|csv|txt|md|html?|xml|json|zip|eml|msg|epub|xps|oxps|png|jpe?g|gif|bmp|tiff?|webp|heic|heif|svg|dxf|p12|pfx|cer|crt|der|p7s|ics|vcf';
// A file name without spaces; one in quotes may have spaces.
const DOC_NAME = new RegExp(String.raw`[^\s\\/:*?"<>|()\[\]{}'\x60,;]+\.(${DOCUMENT_EXT})\b`, 'gi');
const QUOTED_DOC = new RegExp(String.raw`(["'“‘])[^"'“”‘’\r\n]*?\.(${DOCUMENT_EXT})(["'”’])`, 'gi');
/** An absolute path: drive, UNC or an environment variable, up to a line end, quote, bracket or ", ". */
const ABS_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|%[A-Z_]+%[\\/])[^\r\n"'<>|()\[\]]*?(?=$|[\r\n"'<>|()\[\]]|,\s|:\d|\s—|\s-\s|\s\(|\.\s)/gm;
const FILE_URL = /file:\/\/\/?/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Where a path starts, as a placeholder: an environment variable, or "<drive>". */
function pathRoot(p: string): string {
  const env = /^%[A-Z_]+%/.exec(p);
  if (env) return env[0];
  if (p.startsWith('\\\\')) return '\\\\<server>';
  return '<drive>';
}

/** The app's own files in a path are kept (they say where in the program something failed). */
const PROGRAM_FILE = /^[\w.-]+\.(rs|js|mjs|ts|tsx|dll|exe|wasm)$/i;

/**
 * A crash report without personal details: the user profile and other
 * folders become %USERPROFILE%, %LOCALAPPDATA%…, other paths are reduced to
 * their root (the program's own files stay), names of documents become
 * <file>.pdf, the Windows user name becomes <user>, e-mail addresses <e-mail>.
 */
export function sanitizeReport(text: string, opts: { userName?: string | null; profile?: string | null } = {}): string {
  let t = text.replace(/\r\n/g, '\n').replace(FILE_URL, '');
  const user = (opts.userName ?? '').trim();
  const profiles = new Set<string>();
  if (opts.profile) profiles.add(opts.profile.replace(/[\\/]+$/, ''));
  if (user) profiles.add(`C:\\Users\\${user}`);
  for (const p of profiles) t = t.replace(new RegExp(p.split(/[\\/]+/).map(esc).join(String.raw`[\\/]+`), 'gi'), '%USERPROFILE%');
  // Any other profile folder (another account, a roaming profile).
  t = t.replace(/\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\r\n"'<>|]+/gi, '%USERPROFILE%');
  t = t.replace(/%USERPROFILE%[\\/]AppData[\\/]Local(?=[\\/]|\b)/gi, '%LOCALAPPDATA%').replace(/%USERPROFILE%[\\/]AppData[\\/]Roaming(?=[\\/]|\b)/gi, '%APPDATA%');
  t = t.replace(ABS_PATH, (p) => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    const root = pathRoot(p);
    if (/^%(LOCALAPPDATA|APPDATA|USERPROFILE|TEMP|PROGRAMFILES)%$/.test(root) && parts.length > 1 && /^Adika PDF Editor$/i.test(parts[1])) {
      // The app's own data folder: keep it, drop what is below.
      return `${root}\\${parts[1]}${parts.length > 2 ? (PROGRAM_FILE.test(last) || /^crash-[\d-]+\.log$/.test(last) ? `\\…\\${last}` : '\\…') : ''}`;
    }
    return PROGRAM_FILE.test(last) && parts.length > 1 ? `${root}\\…\\${last}` : `${root}\\<path>`;
  });
  t = t.replace(EMAIL, '<e-mail>');
  t = t.replace(QUOTED_DOC, (_m, open: string, ext: string, close: string) => `${open}<file>.${ext.toLowerCase()}${close}`);
  t = t.replace(DOC_NAME, (_m, ext: string) => `<file>.${ext.toLowerCase()}`);
  if (user && user.length >= 2) t = t.replace(new RegExp(`(?<![\\p{L}\\d])${esc(user)}(?![\\p{L}\\d])`, 'giu'), '<user>');
  return t;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
