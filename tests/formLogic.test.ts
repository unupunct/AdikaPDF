import { describe, expect, it } from 'vitest';
import { acrobatScripts, calcOrder, calculate, checkInput, displayValue, evaluateFormula, parseDate, parseNumber, parseScripts, type FieldLogic } from '@/lib/formLogic';

describe('smart form fields', () => {
  it('reads numbers typed in any style', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('1 250 lei')).toBe(1250);
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('')).toBe(0);
  });

  it('shows numbers, currency, percent and dates in the chosen style', () => {
    expect(displayValue({ kind: 'number', decimals: 2, sep: 2, currency: ' lei', currencyBefore: false }, '1234.5')).toBe('1.234,50 lei');
    expect(displayValue({ kind: 'number', decimals: 2, sep: 0, currency: '€', currencyBefore: true }, '1234.5')).toBe('€1,234.50');
    expect(displayValue({ kind: 'percent', decimals: 1, sep: 2 }, '0.195')).toBe('19,5%');
    expect(displayValue({ kind: 'date', pattern: 'dd.mm.yyyy' }, '5.3.2026')).toBe('05.03.2026');
  });

  it('checks input and explains mistakes', () => {
    const money: FieldLogic = { format: { kind: 'number', decimals: 2, sep: 2, currency: ' lei', currencyBefore: false }, range: { min: 0, max: 10000 } };
    expect(checkInput(money, '1.250,456')).toEqual({ value: '1250.46', error: null });
    expect(checkInput(money, 'o mie').error).toBe('Enter a number.');
    expect(checkInput(money, '-5').error).toBe('Enter a value from 0 to 10000.');
    const date: FieldLogic = { format: { kind: 'date', pattern: 'dd.mm.yyyy' } };
    expect(checkInput(date, '31.02.2026').error).toBe('Enter a date as dd.mm.yyyy.');
    expect(checkInput(date, '1/3/2026')).toEqual({ value: '01.03.2026', error: null });
    expect(parseDate('29.02.2028', 'dd.mm.yyyy')?.getDate()).toBe(29);
    expect(checkInput({ format: { kind: 'percent', decimals: 0, sep: 1 } }, '19%').value).toBe('0.19');
  });

  it('calculates sums, products and formulas with field names containing spaces', () => {
    const vals: Record<string, number> = { Qty: 3, 'Unit price': 12.5, Tax: 0.19 };
    const names = Object.keys(vals);
    const get = (n: string) => vals[n] ?? NaN;
    expect(calculate({ op: 'sum', fields: ['Qty', 'Unit price'] }, names, get)).toBe(15.5);
    expect(calculate({ op: 'product', fields: ['Qty', 'Unit price'] }, names, get)).toBe(37.5);
    expect(evaluateFormula('Qty * Unit price * (1 + Tax)', names, get)).toBeCloseTo(44.625);
    expect(evaluateFormula('Qty / 0', names, get)).toBe(0);
    expect(evaluateFormula('Qty * (', names, get)).toBeNaN();
    expect(evaluateFormula('alert(1)', names, get)).toBeNaN(); // no code is run
  });

  it('orders calculations so totals come after their parts, and skips cycles', () => {
    const order = calcOrder({
      Total: { calc: { op: 'formula', formula: 'Subtotal + VAT' } },
      VAT: { calc: { op: 'formula', formula: 'Subtotal * 0.19' } },
      Subtotal: { calc: { op: 'product', fields: ['Qty', 'Price'] } },
      Qty: {},
      Price: {},
      A: { calc: { op: 'sum', fields: ['B'] } },
      B: { calc: { op: 'sum', fields: ['A'] } },
    });
    expect(order).toEqual(['Subtotal', 'VAT', 'Total']);
  });

  it('writes Acrobat form scripts and reads them back', () => {
    const names = ['Qty', 'Unit price', 'Total'];
    const logic: FieldLogic = {
      format: { kind: 'number', decimals: 2, sep: 2, currency: ' lei', currencyBefore: false },
      range: { min: 0, max: null },
      calc: { op: 'formula', formula: 'Qty * Unit price' },
    };
    const js = acrobatScripts(logic, names);
    expect(js.F).toBe('AFNumber_Format(2, 2, 0, 0, " lei", false);');
    expect(js.V).toBe('AFRange_Validate(true, 0, false, 0);');
    expect(js.C).toContain('BVCALC Qty * Unit price EVCALC');
    expect(js.C).toContain('AFMakeNumber(getField("Unit price").value)');
    expect(parseScripts(js)).toEqual(logic);
    expect(parseScripts(acrobatScripts({ calc: { op: 'sum', fields: ['A', 'B'] }, format: { kind: 'date', pattern: 'dd.mm.yyyy' } }, []))).toEqual({ calc: { op: 'sum', fields: ['A', 'B'] }, format: { kind: 'date', pattern: 'dd.mm.yyyy' } });
    // Acrobat's own form of the list.
    expect(parseScripts({ C: 'AFSimple_Calculate("SUM", ["Line 1", "Line 2"]);' }).calc).toEqual({ op: 'sum', fields: ['Line 1', 'Line 2'] });
  });
});
