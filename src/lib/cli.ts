/**
 * The command line (pure part): parsing `adika-pdf-editor.exe --batch …`
 * into steps, and matching wildcards.
 */
import type { BatchOp, CompressLevel } from './batch';

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

Each result is saved with a suffix (report-processed.pdf); originals are not
changed. Exit code 0 = all done, 1 = some files failed, 2 = wrong arguments.
From cmd.exe use: start /wait adika-pdf-editor.exe --batch …`;

export function parseCli(args: string[]): CliJob {
  const job: CliJob = { files: [], steps: [], sequence: null, out: null, help: false, errors: [] };
  const value = (i: number) => (i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = value(i);
    switch (a) {
      case '--batch':
        break;
      case '--help':
      case '-h':
      case '/?':
        job.help = true;
        break;
      case '--ocr':
        job.steps.push({ kind: 'ocr', lang: v ?? 'ron+eng' });
        if (v) i++;
        break;
      case '--compress': {
        const level = (v ?? 'balanced') as CompressLevel;
        if (!['light', 'balanced', 'strong'].includes(level)) job.errors.push(`Unknown compression level "${level}".`);
        job.steps.push({ kind: 'compress', level });
        if (v) i++;
        break;
      }
      case '--watermark':
        if (!v) job.errors.push('--watermark needs a text.');
        else {
          job.steps.push({ kind: 'watermark', text: v });
          i++;
        }
        break;
      case '--page-numbers':
        job.steps.push({ kind: 'pageNumbers', format: v ?? '{page} / {pages}' });
        if (v) i++;
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
        else {
          job.steps.push({ kind: 'protect', userPassword: v });
          i++;
        }
        break;
      case '--sequence':
        if (!v) job.errors.push('--sequence needs a name.');
        else {
          job.sequence = v;
          i++;
        }
        break;
      case '--out':
        if (!v) job.errors.push('--out needs a folder.');
        else {
          job.out = v;
          i++;
        }
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
