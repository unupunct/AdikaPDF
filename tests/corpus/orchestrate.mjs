// Corpus run (not part of `npm test`):
//   node tests/corpus/orchestrate.mjs run [corpusDir] [resultsDir]
//   node tests/corpus/orchestrate.mjs report <resultsDir> [beforeResultsDir]
// `run` hands the PDFs under corpusDir to vitest workers (tests/corpus/run.ts) in batches, kills a
// worker whose stage hangs or that runs out of memory, and goes on with the next file.
// Env: CORPUS_JOBS (parallel workers, default 3), CORPUS_STAGE_MS (per stage, default 60000),
// CORPUS_ONLY (regex on the path), CORPUS_LIMIT, CORPUS_MEM_MB (heap per worker, default 3072).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const repo = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..');
const STAGE_MS = Number(process.env.CORPUS_STAGE_MS ?? 60_000);
const HANG_MS = STAGE_MS + 45_000;
const BATCH = 40;

function listPdfs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'results' && !e.name.startsWith('.')) out.push(...listPdfs(p));
    } else if (/\.pdf$/i.test(e.name) && statSync(p).size > 0) out.push(p);
  }
  return out.sort();
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function run(corpusDir, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  let files = listPdfs(corpusDir);
  if (process.env.CORPUS_ONLY) files = files.filter((f) => new RegExp(process.env.CORPUS_ONLY, 'i').test(f));
  if (process.env.CORPUS_LIMIT) files = files.slice(0, Number(process.env.CORPUS_LIMIT));
  // Resume: files already finished in this results folder are skipped.
  const done = new Set();
  for (const f of readdirSync(resultsDir).filter((n) => n.endsWith('.jsonl'))) {
    for (const l of readLines(join(resultsDir, f))) if (l.at === 'end' || l.at === 'killed') done.add(l.file);
  }
  const queue = files.filter((f) => !done.has(f));
  console.log(`${files.length} PDFs, ${queue.length} to run, results in ${resultsDir}`);
  const jobs = Number(process.env.CORPUS_JOBS ?? 3);
  let started = Date.now();
  let finished = 0;
  const vitest = join(repo, 'node_modules', 'vitest', 'vitest.mjs');

  async function worker(w) {
    const out = join(resultsDir, `worker${w}.jsonl`);
    for (;;) {
      const batch = queue.splice(0, BATCH);
      if (!batch.length) return;
      let rest = batch;
      while (rest.length) {
        const list = join(resultsDir, `worker${w}.list`);
        writeFileSync(list, rest.join('\n'));
        const before = readLines(out).length;
        const child = spawn(process.execPath, [vitest, 'run', '--config', 'tests/corpus/vitest.config.ts'], {
          cwd: repo,
          env: { ...process.env, CORPUS_LIST: list, CORPUS_OUT: out, CORPUS_STAGE_MS: String(STAGE_MS), NODE_OPTIONS: `--max-old-space-size=${process.env.CORPUS_MEM_MB ?? 3072}` },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
        const exited = new Promise((r) => child.on('exit', (code) => r(code)));
        let killed = null;
        let seen = before;
        let lastChange = Date.now();
        for (;;) {
          const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('tick'), 2000))]);
          const lines = readLines(out);
          if (lines.length !== seen) {
            for (const l of lines.slice(seen)) if (l.at === 'end') finished++;
            seen = lines.length;
            lastChange = Date.now();
          }
          const fresh = lines.slice(before);
          if (code !== 'tick') break;
          const endedNow = new Set(fresh.filter((l) => l.at === 'end').map((l) => l.file));
          if (fresh.some((l) => l.status === 'timeout' && !endedNow.has(l.file))) {
            killed = 'timeout';
          } else if (Date.now() - lastChange > HANG_MS) {
            killed = 'hang';
          }
          if (killed) {
            killTree(child);
            await exited;
            break;
          }
        }
        const fresh = readLines(out).slice(before);
        const ended = new Set(fresh.filter((l) => l.at === 'end').map((l) => l.file));
        const current = [...fresh].reverse().find((l) => l.at === 'begin')?.file;
        if (current && !ended.has(current)) {
          const lastStage = [...fresh].reverse().find((l) => l.file === current && l.stage && l.at === 'start')?.stage ?? 'harness';
          const stageDone = fresh.some((l) => l.file === current && l.stage === lastStage && l.status);
          const why = killed ?? (/heap out of memory|allocation failed/i.test(stderr) ? 'oom' : 'crash');
          if (!stageDone) writeFileSync(out, JSON.stringify({ file: current, stage: lastStage, status: why === 'oom' ? 'crash' : why === 'crash' ? 'crash' : 'timeout', sig: `${why}${why === 'crash' ? ': ' + (stderr.split('\n').find((l) => /Error|error/.test(l)) ?? '').trim().slice(0, 120) : ''}` }) + '\n', { flag: 'a' });
          writeFileSync(out, JSON.stringify({ file: current, at: 'killed', why }) + '\n', { flag: 'a' });
          finished++;
          ended.add(current);
        } else if (!killed && fresh.length === 0) {
          console.error(`worker ${w}: vitest failed to start\n${stderr}`);
          process.exit(1);
        }
        rest = rest.filter((f) => !ended.has(f));
        const el = (Date.now() - started) / 1000;
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${finished}/${queue.length + finished + rest.length} files, ${Math.round(el)} s${killed ? `, killed (${killed}) on ${current && basename(current)}` : ''}`);
      }
    }
  }
  await Promise.all(Array.from({ length: jobs }, (_, w) => worker(w)));
  report(resultsDir);
}

const STAGES = ['open', 'decrypt', 'repair', 'save', 'incremental', 'text', 'docx', 'compress', 'pdfa', 'signature', 'pdfua', 'hidden', 'redact', 'search', 'harness'];
const BAD = ['error', 'wrong', 'timeout', 'crash'];

function collect(resultsDir) {
  const byFile = new Map();
  for (const f of readdirSync(resultsDir).filter((n) => n.endsWith('.jsonl'))) {
    for (const l of readLines(join(resultsDir, f))) {
      if (!byFile.has(l.file)) byFile.set(l.file, { stages: {}, ms: 0 });
      const r = byFile.get(l.file);
      if (l.stage && l.status) r.stages[l.stage] = l;
      if (l.at === 'end') r.ms = l.ms;
    }
  }
  return byFile;
}

function counts(byFile) {
  const c = Object.fromEntries(STAGES.map((s) => [s, { pass: 0, skip: 0, error: 0, wrong: 0, timeout: 0, crash: 0 }]));
  for (const r of byFile.values()) for (const [s, l] of Object.entries(r.stages)) if (c[s]) c[s][l.status] = (c[s][l.status] ?? 0) + 1;
  return c;
}

/** File names are shown only for the public pdf.js test corpus. */
function shownName(file, corpusRoot) {
  const rel = relative(corpusRoot, file).replace(/\\/g, '/');
  return rel.startsWith('pdfjs/') || rel.startsWith('pdfjs-links/') || rel.startsWith('qpdf/') || rel.startsWith('pdfium/') ? rel : null;
}

function report(resultsDir, beforeDir) {
  const byFile = collect(resultsDir);
  const files = [...byFile.keys()];
  const corpusRoot = files.length ? files.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); }).replace(/[^\\/]*$/, '') : '';
  const root = corpusRoot.replace(/[\\/]$/, '').replace(/[\\/](pdfjs|qpdf|pdfium|pdflib|pypdf|pypdf-samples|pdfjs-links)$/, '');
  const c = counts(byFile);
  const before = beforeDir ? counts(collect(beforeDir)) : null;
  const bySource = new Map();
  for (const f of files) {
    const top = relative(root, f).replace(/\\/g, '/').split('/')[0];
    bySource.set(top, (bySource.get(top) ?? 0) + 1);
  }
  const L = [];
  L.push('# Corpus run report', '');
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} by \`node tests/corpus/orchestrate.mjs report\`. ${files.length} PDFs: ${[...bySource].map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  L.push('Statuses: **pass**; **skip** (stage not applicable: password needed, incremental save not possible, unsupported encryption); **error** (exception); **wrong** (finished but the result is wrong: output does not reopen, page count changed, text lost, redacted text still there); **timeout** (over the per-stage limit, or hung); **crash** (worker died, e.g. out of memory).', '');
  L.push('| Stage | pass | skip | error | wrong | timeout | crash |' + (before ? ' failures before |' : ''));
  L.push('|---|---|---|---|---|---|---|' + (before ? '---|' : ''));
  for (const s of STAGES) {
    const x = c[s];
    if (!Object.values(x).some(Boolean)) continue;
    const bad = BAD.reduce((n, k) => n + (x[k] ?? 0), 0);
    const b = before ? BAD.reduce((n, k) => n + (before[s][k] ?? 0), 0) : null;
    L.push(`| ${s} | ${x.pass} | ${x.skip} | ${x.error} | ${x.wrong} | ${x.timeout} | ${x.crash} |` + (before ? ` ${b} → ${bad} |` : ''));
  }
  const sigs = new Map();
  for (const [file, r] of byFile) {
    for (const [s, l] of Object.entries(r.stages)) {
      if (!BAD.includes(l.status)) continue;
      const key = `${s} · ${l.status} · ${String(l.sig ?? '').replace(/\(\d+ -> \d+ chars\)/, '(n -> m chars)').replace(/ \d+ -> \d+$/, '').replace(/"[^"]*"/g, '"…"').slice(0, 200)}`;
      if (!sigs.has(key)) sigs.set(key, []);
      sigs.get(key).push(file);
    }
  }
  L.push('', '## Failure signatures', '', '| Count | Stage · status · signature | Examples |', '|---|---|---|');
  for (const [k, list] of [...sigs].sort((a, b) => b[1].length - a[1].length)) {
    const ex = list.map((f) => shownName(f, root)).filter(Boolean).slice(0, 3).map((n) => `\`${n}\``).join(', ');
    L.push(`| ${list.length} | ${k.replace(/\|/g, '\\|')} | ${ex} |`);
  }
  const slow = [...byFile].filter(([, r]) => r.ms).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
  L.push('', '## Slowest files', '', ...slow.map(([f, r]) => `- ${Math.round(r.ms / 1000)} s ${shownName(f, root) ? `\`${shownName(f, root)}\`` : '(not shown)'}`));
  const md = L.join('\n') + '\n';
  writeFileSync(join(resultsDir, 'report.md'), md);
  console.log(md);
  return md;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'run') await run(resolve(a ?? 'D:/MyAIProjects/AdikaPDF/.tools/corpus'), resolve(b ?? join(a ?? 'D:/MyAIProjects/AdikaPDF/.tools/corpus', 'results', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'))));
else if (cmd === 'report') report(resolve(a), b && resolve(b));
else console.log('usage: node tests/corpus/orchestrate.mjs run [corpusDir] [resultsDir] | report <resultsDir> [beforeDir]');
