/**
 * Code 128: encoding (bars for barcode fields and separator sheets) and
 * reading from a scanned page (horizontal scan lines, either direction).
 */

/** Bar/space widths (modules) of symbols 0..105; 106 is the stop pattern. */
export const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_A = 103;
const START_B = 104;
const START_C = 105;
const STOP = 106;
const CODE_A = 101;
const CODE_B = 100;
const CODE_C = 99;
const BY_PATTERN = new Map(PATTERNS.map((p, i) => [p, i]));

/** Symbol values: code C for runs of 4+ digits, code B otherwise. Printable ASCII only. */
export function encodeSymbols(text: string): number[] {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('Code 128 supports letters, digits and ASCII punctuation only.');
  const out: number[] = [];
  let set: 'B' | 'C' | null = null;
  let i = 0;
  const digitsAhead = (k: number) => {
    let n = 0;
    while (k + n < text.length && text[k + n] >= '0' && text[k + n] <= '9') n++;
    return n;
  };
  while (i < text.length) {
    const d = digitsAhead(i);
    if (d >= 4 || (set === 'C' && d >= 2)) {
      if (set !== 'C') out.push(set === null ? START_C : CODE_C);
      set = 'C';
      const pairs = Math.floor(d / 2);
      for (let p = 0; p < pairs; p++, i += 2) out.push(Number(text.slice(i, i + 2)));
      continue;
    }
    if (set !== 'B') out.push(set === null ? START_B : CODE_B);
    set = 'B';
    out.push(text.charCodeAt(i) - 32);
    i++;
  }
  if (set === null) out.push(START_B);
  const check = out.reduce((s, v, k) => s + v * (k === 0 ? 1 : k), 0) % 103;
  out.push(check, STOP);
  return out;
}

/** Modules of the barcode, true = bar, with 10-module quiet zones. */
export function encodeModules(text: string): boolean[] {
  const out: boolean[] = Array(10).fill(false);
  for (const s of encodeSymbols(text)) {
    const p = PATTERNS[s];
    for (let k = 0; k < p.length; k++) for (let m = 0; m < Number(p[k]); m++) out.push(k % 2 === 0);
  }
  out.push(...Array(10).fill(false));
  return out;
}

/** Symbol values -> text (checksum verified). Null when invalid. */
export function decodeSymbols(sym: number[]): string | null {
  if (sym.length < 3 || ![START_A, START_B, START_C].includes(sym[0])) return null;
  const data = sym.slice(0, -1);
  const check = data.pop()!;
  const sum = data.reduce((s, v, k) => s + v * (k === 0 ? 1 : k), 0) % 103;
  if (sum !== check) return null;
  let set: 'A' | 'B' | 'C' = sym[0] === START_A ? 'A' : sym[0] === START_B ? 'B' : 'C';
  let text = '';
  for (let k = 1; k < data.length; k++) {
    const v = data[k];
    if (set === 'C') {
      if (v < 100) text += String(v).padStart(2, '0');
      else if (v === CODE_B) set = 'B';
      else if (v === CODE_A) set = 'A';
      continue;
    }
    if (v === CODE_C) set = 'C';
    else if (v === CODE_B && set === 'A') set = 'B';
    else if (v === CODE_A && set === 'B') set = 'A';
    else if (v < 96) text += set === 'B' ? String.fromCharCode(v + 32) : v < 64 ? String.fromCharCode(v + 32) : String.fromCharCode(v - 64);
    else return null; // FNC codes are not used here
  }
  return text;
}

/** Decodes run widths (starting with a bar) into text, or null. */
function decodeRuns(runs: number[]): string | null {
  for (let s = 0; s + 6 <= runs.length; s += 2) {
    const first = runs.slice(s, s + 6);
    const module = first.reduce((a, b) => a + b, 0) / 11;
    if (module < 1) continue;
    const norm = (r: number[]) => r.map((x) => Math.max(1, Math.min(4, Math.round(x / module)))).join('');
    const start = BY_PATTERN.get(norm(first));
    if (start === undefined || start < START_A || start > START_C) continue;
    const sym = [start];
    let k = s + 6;
    let ok = false;
    while (k + 6 <= runs.length) {
      // A data symbol first: the stop pattern's first six widths are no symbol,
      // but seven data widths can look like a stop.
      const six = runs.slice(k, k + 6);
      const m6 = six.reduce((a, b) => a + b, 0) / 11;
      const v = BY_PATTERN.get(six.map((x) => Math.max(1, Math.min(4, Math.round(x / m6)))).join(''));
      if (v !== undefined && v !== STOP) {
        sym.push(v);
        k += 6;
        continue;
      }
      const seven = runs.slice(k, k + 7);
      const m7 = seven.reduce((a, b) => a + b, 0) / 13;
      if (seven.length === 7 && seven.map((x) => Math.max(1, Math.min(4, Math.round(x / m7)))).join('') === PATTERNS[STOP]) {
        sym.push(STOP);
        ok = true;
      }
      break;
    }
    if (ok) {
      const text = decodeSymbols(sym);
      if (text !== null) return text;
    }
  }
  return null;
}

/** Runs of a scan line: bar, space, bar… (leading space dropped). */
function lineRuns(bin: Uint8Array, w: number, y: number): number[] {
  const runs: number[] = [];
  let x = 0;
  while (x < w && !bin[y * w + x]) x++;
  while (x < w) {
    const c = bin[y * w + x];
    let n = 0;
    while (x < w && bin[y * w + x] === c) {
      n++;
      x++;
    }
    runs.push(n);
  }
  if (runs.length % 2 === 0) runs.pop(); // trailing space
  return runs;
}

/** Every distinct Code 128 text found on a binarized page (1 = ink). */
export function readCode128(bin: Uint8Array, w: number, h: number): string[] {
  const found = new Set<string>();
  const step = Math.max(1, Math.floor(h / 160));
  for (let y = 0; y < h; y += step) {
    const runs = lineRuns(bin, w, y);
    if (runs.length < 25) continue;
    const t = decodeRuns(runs) ?? decodeRuns([...runs].reverse());
    if (t !== null) found.add(t);
  }
  return [...found];
}
