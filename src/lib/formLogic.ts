/**
 * Smart form fields: formats (number, currency, percent, date), allowed
 * ranges and calculations (sum, product, average, min, max or a formula such
 * as "Qty * Price"). Written as the standard Acrobat form actions
 * (AFNumber_Format, AFDate_FormatEx, AFRange_Validate, AFSimple_Calculate and
 * simplified field notation), which Acrobat and Foxit run, and read back from
 * existing forms so Adika can calculate while filling. Pure.
 */

export type NumberSep = 0 | 1 | 2 | 3; // 1,234.56 | 1234.56 | 1.234,56 | 1234,56

export type FieldFormat =
  | { kind: 'number'; decimals: number; sep: NumberSep; currency: string; currencyBefore: boolean }
  | { kind: 'percent'; decimals: number; sep: NumberSep }
  | { kind: 'date'; pattern: string };

export type CalcOp = 'sum' | 'product' | 'average' | 'min' | 'max';
export type FieldCalc = { op: CalcOp; fields: string[] } | { op: 'formula'; formula: string };

export interface FieldLogic {
  format?: FieldFormat | null;
  range?: { min: number | null; max: number | null } | null;
  calc?: FieldCalc | null;
}

// ------------------------------------------------------------------ numbers

/** Tolerant number parsing: "1.234,56", "1,234.56", "12,5", "1 234 lei" -> number (NaN when not a number). */
export function parseNumber(raw: string | number | boolean | string[] | null | undefined): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return raw === true ? 1 : NaN;
  let s = raw.replace(/[^\d.,\-−]/g, '').replace('−', '-');
  if (!s || !/\d/.test(s)) return raw.trim() === '' ? 0 : NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // The later one is the decimal mark.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "1,234" (thousands) vs "12,5" (decimal): three digits after a single comma = thousands.
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function group(int: string, sepChar: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sepChar);
}

export function formatNumberField(n: number, decimals: number, sep: NumberSep): string {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(Math.max(0, Math.min(10, decimals))).split('.');
  const thousands = sep === 0 ? ',' : sep === 2 ? '.' : '';
  const dec = sep === 0 || sep === 1 ? '.' : ',';
  return `${neg ? '-' : ''}${thousands ? group(int, thousands) : int}${frac ? dec + frac : ''}`;
}

// ------------------------------------------------------------------ dates

const DATE_PARTS = /(yyyy|yy|mmmm|mmm|mm|m|dd|d|HH|H|MM)/g;

/** Parses a date typed as `pattern` (dd, mm, yyyy, yy, d, m; any separators). */
export function parseDate(raw: string, pattern: string): Date | null {
  const tokens = pattern.match(DATE_PARTS) ?? [];
  const nums = raw.match(/\d+/g) ?? [];
  if (!tokens.length || nums.length < tokens.filter((t) => /^(yyyy|yy|mm|m|dd|d)$/.test(t)).length) return null;
  let d = 1;
  let m = 1;
  let y = new Date().getFullYear();
  let k = 0;
  for (const t of tokens) {
    if (!/^(yyyy|yy|mm|m|dd|d)$/.test(t)) continue;
    const v = Number(nums[k++]);
    if (t === 'dd' || t === 'd') d = v;
    else if (t === 'mm' || t === 'm') m = v;
    else y = t === 'yy' ? 2000 + v - (v > 69 ? 100 : 0) : v;
  }
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

export function formatDate(date: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern.replace(DATE_PARTS, (t) =>
    t === 'yyyy' ? String(date.getFullYear()) : t === 'yy' ? pad(date.getFullYear() % 100) : t === 'mm' ? pad(date.getMonth() + 1) : t === 'm' ? String(date.getMonth() + 1) : t === 'dd' ? pad(date.getDate()) : t === 'd' ? String(date.getDate()) : t,
  );
}

// ------------------------------------------------------------------ values

/** What the field shows for its stored value. */
export function displayValue(fmt: FieldFormat | null | undefined, raw: string): string {
  if (!fmt || raw === '') return raw;
  if (fmt.kind === 'date') {
    const d = parseDate(raw, fmt.pattern);
    return d ? formatDate(d, fmt.pattern) : raw;
  }
  const n = parseNumber(raw);
  if (Number.isNaN(n)) return raw;
  if (fmt.kind === 'percent') return `${formatNumberField(n * 100, fmt.decimals, fmt.sep)}%`;
  const s = formatNumberField(n, fmt.decimals, fmt.sep);
  return fmt.currency ? (fmt.currencyBefore ? `${fmt.currency}${s}` : `${s}${fmt.currency}`) : s;
}

/** Normalises typed input to the stored value, or explains what is wrong. */
export function checkInput(logic: FieldLogic | undefined, typed: string): { value: string; error: string | null } {
  const fmt = logic?.format;
  const t = typed.trim();
  if (t === '') return { value: '', error: null };
  let value = t;
  if (fmt?.kind === 'date') {
    const d = parseDate(t, fmt.pattern);
    if (!d) return { value: t, error: `Enter a date as ${fmt.pattern}.` };
    value = formatDate(d, fmt.pattern);
  } else if (fmt?.kind === 'number' || fmt?.kind === 'percent') {
    let n = parseNumber(t);
    if (Number.isNaN(n)) return { value: t, error: 'Enter a number.' };
    if (fmt.kind === 'percent' && /%/.test(t)) n /= 100;
    value = String(Math.round(n * 10 ** (fmt.decimals + (fmt.kind === 'percent' ? 2 : 0))) / 10 ** (fmt.decimals + (fmt.kind === 'percent' ? 2 : 0)));
  }
  const r = logic?.range;
  if (r && (r.min !== null || r.max !== null)) {
    const n = parseNumber(value);
    if (Number.isNaN(n) || (r.min !== null && n < r.min) || (r.max !== null && n > r.max)) {
      return { value, error: r.min !== null && r.max !== null ? `Enter a value from ${r.min} to ${r.max}.` : r.min !== null ? `Enter a value of at least ${r.min}.` : `Enter a value of at most ${r.max}.` };
    }
  }
  return { value, error: null };
}

// ------------------------------------------------------------------ formulas

type Tok = { t: 'num'; v: number } | { t: 'field'; v: string } | { t: 'op'; v: string };

/** Splits "Qty * Price + Tax 2" into tokens; field names may contain spaces (longest known name wins). */
function tokenize(src: string, names: string[]): Tok[] | null {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    const num = /^\d+(?:[.,]\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0].replace(',', '.')) });
      i += num[0].length;
      continue;
    }
    // Quoted name: "Unit price"
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) return null;
      out.push({ t: 'field', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const name = sorted.find((n) => src.startsWith(n, i) && !/[\p{L}\p{N}_]/u.test(src[i + n.length] ?? ''));
    const bare = name ?? /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i))?.[0];
    if (!bare) return null;
    out.push({ t: 'field', v: bare });
    i += bare.length;
  }
  return out;
}

/** Field names used by a formula (null when it cannot be read). */
export function formulaFields(formula: string, names: string[]): string[] | null {
  const toks = tokenize(formula, names);
  return toks ? [...new Set(toks.filter((t) => t.t === 'field').map((t) => t.v))] : null;
}

/** Evaluates + - * / and parentheses (no code is run). NaN on errors; division by 0 gives 0. */
export function evaluateFormula(formula: string, names: string[], get: (name: string) => number): number {
  const toks = tokenize(formula, names);
  if (!toks) return NaN;
  let p = 0;
  const peek = () => toks[p];
  const expr = (): number => {
    let v = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = toks[p++].v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = toks[p++].v;
      const r = factor();
      v = op === '*' ? v * r : r === 0 ? 0 : v / r;
    }
    return v;
  };
  const factor = (): number => {
    const t = toks[p++];
    if (!t) return NaN;
    if (t.t === 'num') return t.v;
    if (t.t === 'field') return get(t.v);
    if (t.v === '-') return -factor();
    if (t.v === '(') {
      const v = expr();
      if (peek()?.v !== ')') return NaN;
      p++;
      return v;
    }
    return NaN;
  };
  const v = expr();
  return p === toks.length ? v : NaN;
}

export function calculate(calc: FieldCalc, names: string[], get: (name: string) => number): number {
  if (calc.op === 'formula') return evaluateFormula(calc.formula, names, get);
  const vals = calc.fields.map(get).map((v) => (Number.isNaN(v) ? 0 : v));
  if (!vals.length) return 0;
  switch (calc.op) {
    case 'sum':
      return vals.reduce((a, b) => a + b, 0);
    case 'product':
      return vals.reduce((a, b) => a * b, 1);
    case 'average':
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'min':
      return Math.min(...vals);
    case 'max':
      return Math.max(...vals);
  }
}

/** Fields a calculation depends on. */
export function dependsOn(calc: FieldCalc, names: string[]): string[] {
  return calc.op === 'formula' ? (formulaFields(calc.formula, names) ?? []) : calc.fields;
}

/** Calculation order: fields that feed others first (cycles are left out). */
export function calcOrder(logic: Record<string, FieldLogic>): string[] {
  const names = Object.keys(logic);
  const calcs = names.filter((n) => logic[n].calc);
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 2) return true;
    if (state.get(n) === 1) return false; // cycle
    state.set(n, 1);
    for (const d of dependsOn(logic[n].calc!, names)) if (logic[d]?.calc && !visit(d)) return false;
    state.set(n, 2);
    out.push(n);
    return true;
  };
  for (const n of calcs) visit(n);
  return out;
}

// ------------------------------------------------------------------ Acrobat scripts

const q = (s: string) => JSON.stringify(s);

/** Keystroke / Format / Validate / Calculate JavaScript for a field (null = none). */
export function acrobatScripts(logic: FieldLogic, names: string[]): { K?: string; F?: string; V?: string; C?: string } {
  const out: { K?: string; F?: string; V?: string; C?: string } = {};
  const f = logic.format;
  if (f?.kind === 'number') {
    const args = `${f.decimals}, ${f.sep}, 0, 0, ${q(f.currency)}, ${f.currencyBefore}`;
    out.K = `AFNumber_Keystroke(${args});`;
    out.F = `AFNumber_Format(${args});`;
  } else if (f?.kind === 'percent') {
    out.K = `AFPercent_Keystroke(${f.decimals}, ${f.sep});`;
    out.F = `AFPercent_Format(${f.decimals}, ${f.sep});`;
  } else if (f?.kind === 'date') {
    out.K = `AFDate_KeystrokeEx(${q(f.pattern)});`;
    out.F = `AFDate_FormatEx(${q(f.pattern)});`;
  }
  const r = logic.range;
  if (r && (r.min !== null || r.max !== null)) out.V = `AFRange_Validate(${r.min !== null}, ${r.min ?? 0}, ${r.max !== null}, ${r.max ?? 0});`;
  const c = logic.calc;
  if (c && c.op !== 'formula') {
    const op = { sum: 'SUM', product: 'PRD', average: 'AVG', min: 'MIN', max: 'MAX' }[c.op];
    out.C = `AFSimple_Calculate(${q(op)}, new Array(${c.fields.map(q).join(', ')}));`;
  } else if (c) {
    // Acrobat's "simplified field notation": the formula in a comment plus equivalent JavaScript.
    const toks = tokenize(c.formula, names);
    if (toks) {
      const js = toks.map((t) => (t.t === 'num' ? String(t.v) : t.t === 'field' ? `AFMakeNumber(getField(${q(t.v)}).value)` : t.v)).join(' ');
      out.C = `/*** BVCALC ${c.formula} EVCALC ***/ event.value = ${js};`;
    }
  }
  return out;
}

/** Reads the logic back from a field's Format / Validate / Calculate scripts (common Acrobat forms). */
export function parseScripts(scripts: { F?: string; V?: string; C?: string }): FieldLogic {
  const logic: FieldLogic = {};
  const F = scripts.F ?? '';
  let m: RegExpExecArray | null;
  if ((m = /AFNumber_Format\(\s*(\d+)\s*,\s*(\d)\s*,\s*\d+\s*,\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(true|false)/.exec(F)))
    logic.format = { kind: 'number', decimals: Number(m[1]), sep: Math.min(3, Number(m[2])) as NumberSep, currency: JSON.parse(`"${m[3]}"`), currencyBefore: m[4] === 'true' };
  else if ((m = /AFPercent_Format\(\s*(\d+)\s*,\s*(\d)/.exec(F))) logic.format = { kind: 'percent', decimals: Number(m[1]), sep: Math.min(3, Number(m[2])) as NumberSep };
  else if ((m = /AFDate_Format(?:Ex)?\(\s*"([^"]+)"/.exec(F))) logic.format = { kind: 'date', pattern: m[1] };
  if ((m = /AFRange_Validate\(\s*(true|false)\s*,\s*(-?[\d.]+)\s*,\s*(true|false)\s*,\s*(-?[\d.]+)/.exec(scripts.V ?? '')))
    logic.range = { min: m[1] === 'true' ? Number(m[2]) : null, max: m[3] === 'true' ? Number(m[4]) : null };
  const C = scripts.C ?? '';
  if ((m = /AFSimple_Calculate\(\s*"(SUM|PRD|AVG|MIN|MAX)"\s*,\s*(?:new Array\(([^)]*)\)|\[([^\]]*)\])/.exec(C))) {
    const list = (m[2] ?? m[3] ?? '').match(/"((?:[^"\\]|\\.)*)"/g)?.map((s) => JSON.parse(s) as string) ?? [];
    logic.calc = { op: ({ SUM: 'sum', PRD: 'product', AVG: 'average', MIN: 'min', MAX: 'max' } as const)[m[1] as 'SUM'], fields: list };
  } else if ((m = /BVCALC\s+([\s\S]*?)\s+EVCALC/.exec(C))) logic.calc = { op: 'formula', formula: m[1] };
  return logic;
}
