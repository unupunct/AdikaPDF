/**
 * The command line (pure part): parsing `adika-pdf-editor.exe --batch …`
 * into steps, and matching wildcards.
 */
import { sequenceProblem, type BatchOp, type CompressLevel } from './batch';

export interface CliJob {
  files: string[];
  steps: BatchOp[];
  /** A saved action sequence by name (instead of, or before, the steps). */
  sequence: string | null;
  out: string | null;
  help: boolean;
  errors: string[];
}

export const CLI_HELP = `Adika PDF Editor — command line

  adika-pdf-editor.exe --batch [steps] [--sequence "Name"] [--out folder] files…

Steps (run in the order given):
  --ocr [languages]        make scanned pages searchable (e.g. ron+eng)
  --compress [level]       light | balanced | strong
  --watermark "text"       text watermark
  --page-numbers ["text"]  footer, {page} {pages} {file}
  --grayscale              convert colours to grey
  --flatten                burn forms and comments into the pages
  --sanitize               remove metadata and hidden data
  --pdfa                   convert to PDF/A-2b
  --protect password       AES-256 password (always last)

  --sequence "Name"        a sequence saved in Batch → Action sequence
  --out folder             where the results go (default: next to each file)
  Files may use wildcards: *.pdf, scans\\*.pdf
  Values can also be given as --option=value (--ocr=deu, --compress=strong).

Each result is saved with a suffix (report-processed.pdf); originals are not
changed. Exit code 0 = all done, 1 = some files failed, 2 = wrong arguments.
From cmd.exe use: start /wait adika-pdf-editor.exe --batch …`;

/** Values an option with an optional value accepts without "=" (so a file name is never taken for one). */
const OPTIONAL_VALUE: Record<string, (v: string) => boolean> = {
  '--ocr': (v) => /^[a-z]{3}(_[a-z]+)?(\+[a-z]{3}(_[a-z]+)?)*$/i.test(v),
  '--compress': (v) => /^(light|balanced|strong)$/i.test(v),
  '--page-numbers': (v) => v.includes('{'),
};
/** A path, file name or wildcard rather than a bare word. */
const looksLikeFile = (s: string) => /[.\\/:*?]/.test(s);
const NEEDS_VALUE = new Set(['--watermark', '--protect', '--sequence', '--out']);

export function parseCli(args: string[]): CliJob {
  const job: CliJob = { files: [], steps: [], sequence: null, out: null, help: false, errors: [] };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    // "--opt=value" always; "--opt value" when the option needs a value, or the next word is one of its values or no file.
    let v: string | null = null;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      const next = args[i + 1];
      if (NEEDS_VALUE.has(a) || (a in OPTIONAL_VALUE && (OPTIONAL_VALUE[a](next) || !looksLikeFile(next)))) {
        v = next;
        i++;
      }
    }
    switch (a) {
      case '--batch':
        break;
      case '--help':
      case '-h':
      case '/?':
        job.help = true;
        break;
      case '--ocr':
        job.steps.push({ kind: 'ocr', lang: v || 'ron+eng' });
        break;
      case '--compress': {
        const level = (v || 'balanced').toLowerCase() as CompressLevel;
        if (!['light', 'balanced', 'strong'].includes(level)) job.errors.push(`Unknown compression level "${level}".`);
        job.steps.push({ kind: 'compress', level });
        break;
      }
      case '--watermark':
        if (!v) job.errors.push('--watermark needs a text.');
        else job.steps.push({ kind: 'watermark', text: v });
        break;
      case '--page-numbers':
        job.steps.push({ kind: 'pageNumbers', format: v || '{page} / {pages}' });
        break;
      case '--grayscale':
        job.steps.push({ kind: 'grayscale' });
        break;
      case '--flatten':
        job.steps.push({ kind: 'flatten' });
        break;
      case '--sanitize':
        job.steps.push({ kind: 'sanitize' });
        break;
      case '--pdfa':
        job.steps.push({ kind: 'pdfa' });
        break;
      case '--protect':
        if (!v) job.errors.push('--protect needs a password.');
        else job.steps.push({ kind: 'protect', userPassword: v });
        break;
      case '--sequence':
        if (!v) job.errors.push('--sequence needs a name.');
        else job.sequence = v;
        break;
      case '--out':
        if (!v) job.errors.push('--out needs a folder.');
        else job.out = v;
        break;
      default:
        if (a.startsWith('--')) job.errors.push(`Unknown option ${a}.`);
        else job.files.push(a);
    }
  }
  if (!job.help && !job.errors.length) {
    if (!job.files.length) job.errors.push('No files given.');
    if (!job.steps.length && !job.sequence) job.errors.push('No steps given (for example --ocr or --sequence "Name").');
  }
  return job;
}

/**
 * A saved sequence's steps followed by the command line's (a protect step
 * without a password is dropped), or why they cannot run together.
 */
export function combineSteps(sequence: BatchOp[], extra: BatchOp[]): { steps: BatchOp[]; error: string | null } {
  const steps = [...sequence.filter((s) => s.kind !== 'protect' || s.userPassword), ...extra];
  const problem = sequenceProblem(steps);
  return { steps, error: problem && extra.length && sequence.length ? `${problem} The sequence and the command-line steps cannot be combined in this order.` : problem };
}

/** "*.pdf" style wildcard (case-insensitive, * and ?). */
export function wildcard(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export const hasWildcard = (s: string) => /[*?]/.test(s);

/** Absolute path from the working folder. */
export function absolutePath(p: string, cwd: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p;
  const sep = cwd.endsWith('\\') || cwd.endsWith('/') ? '' : '\\';
  return `${cwd}${sep}${p.replace(/\//g, '\\').replace(/^\.\\/, '')}`;
}
