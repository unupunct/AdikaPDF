/**
 * Measuring (Acrobat "Measure" tool): distance, perimeter and area on the
 * page, converted with a drawing scale ("1 cm on the page = 2 m"). Pure.
 */
import { create } from 'zustand';

export type PageUnit = 'mm' | 'cm' | 'in' | 'pt';
export type RealUnit = 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'yd' | 'mi' | 'pt';

/** `pageValue pageUnit` on paper stand for `realValue realUnit` in reality. */
export interface MeasureScale {
  pageValue: number;
  pageUnit: PageUnit;
  realValue: number;
  realUnit: RealUnit;
}

export const DEFAULT_SCALE: MeasureScale = { pageValue: 1, pageUnit: 'mm', realValue: 1, realUnit: 'mm' };

/** Points per unit (1 pt = 1/72 in). */
const PT_PER: Record<RealUnit, number> = {
  pt: 1,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  m: 72000 / 25.4,
  km: 72_000_000 / 25.4,
  in: 72,
  ft: 72 * 12,
  yd: 72 * 36,
  mi: 72 * 63360,
};

/** Real-world units per page point for a scale. */
export function realPerPoint(s: MeasureScale): number {
  const pagePt = s.pageValue * PT_PER[s.pageUnit];
  return pagePt > 0 ? s.realValue / pagePt : 0;
}

export function polylineLength(points: number[], closed = false): number {
  let len = 0;
  const n = Math.floor(points.length / 2);
  for (let i = 1; i < n; i++) len += Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  if (closed && n > 2) len += Math.hypot(points[0] - points[(n - 1) * 2], points[1] - points[(n - 1) * 2 + 1]);
  return len;
}

/** Shoelace formula; absolute area in square points. */
export function polygonArea(points: number[]): number {
  const n = Math.floor(points.length / 2);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Number with sensible precision for its size, using the user's decimal separator. */
export function formatNumber(v: number, locale?: string): string {
  const digits = Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 10 ? 2 : 3;
  return v.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export type MeasureKind = 'distance' | 'perimeter' | 'area';

/** The value and its label, e.g. "12.5 cm" or "3.2 m²". */
export function measureValue(kind: MeasureKind, points: number[], scale: MeasureScale, locale?: string): { value: number; label: string } {
  const k = realPerPoint(scale);
  if (kind === 'area') {
    const value = polygonArea(points) * k * k;
    return { value, label: `${formatNumber(value, locale)} ${scale.realUnit}²` };
  }
  const value = polylineLength(points, false) * k;
  return { value, label: `${formatNumber(value, locale)} ${scale.realUnit}` };
}

/** "1 cm = 2 m", as written into the PDF's /Measure /R. */
export function scaleText(s: MeasureScale): string {
  return `${formatNumber(s.pageValue, 'en')} ${s.pageUnit} = ${formatNumber(s.realValue, 'en')} ${s.realUnit}`;
}

// ------------------------------------------------------------------ current scale (remembered)

const KEY = 'adika.measureScale';

function loadScale(): MeasureScale {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as MeasureScale | null;
    if (s && s.pageValue > 0 && s.realValue > 0 && s.pageUnit in PT_PER && s.realUnit in PT_PER) return s;
  } catch {
    /* ignore */
  }
  return DEFAULT_SCALE;
}

export const useMeasureScale = create<{ scale: MeasureScale; setScale: (s: MeasureScale) => void }>()((set) => ({
  scale: typeof localStorage === 'undefined' ? DEFAULT_SCALE : loadScale(),
  setScale: (scale) => {
    set({ scale });
    try {
      localStorage.setItem(KEY, JSON.stringify(scale));
    } catch {
      /* ignore */
    }
  },
}));

export const PAGE_UNITS: PageUnit[] = ['mm', 'cm', 'in', 'pt'];
export const REAL_UNITS: RealUnit[] = ['mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi', 'pt'];
