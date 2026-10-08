import { describe, expect, it } from 'vitest';
import { findPattern, type PatternId } from '@/lib/patterns';

const found = (id: PatternId, text: string) => findPattern(id, text).map(([s, e]) => text.slice(s, e));

describe('redaction patterns: candidates are cut back to a valid length', () => {
  it('IBAN followed by the currency', () => {
    expect(found('iban', 'Cont: RO49 AAAA 1B31 0075 9384 0000 RON, banca X')).toEqual(['RO49 AAAA 1B31 0075 9384 0000']);
    expect(found('iban', 'IBAN RO49AAAA1B31007593840000 EUR')).toEqual(['RO49AAAA1B31007593840000']);
  });

  it('lower-case IBAN and an IBAN of another country', () => {
    expect(found('iban', 'cont ro49 aaaa 1b31 0075 9384 0000.')).toEqual(['ro49 aaaa 1b31 0075 9384 0000']);
    expect(found('iban', 'DE89 3704 0044 0532 0130 00 ref 12')).toEqual(['DE89 3704 0044 0532 0130 00']);
  });

  it('card number followed by the expiry date or the CVV', () => {
    expect(found('card', 'card 4111 1111 1111 1111 05 27')).toEqual(['4111 1111 1111 1111']);
    expect(found('card', 'card 4111 1111 1111 1111 123')).toEqual(['4111 1111 1111 1111']);
    expect(found('card', 'card 4111-1111-1111-1111 05/27')).toEqual(['4111-1111-1111-1111']);
    expect(found('card', 'amex 3782 822463 10005 exp 01/30')).toEqual(['3782 822463 10005']);
  });

  it('CNP written in groups', () => {
    expect(found('cnp', 'CNP 1 800101 221144, seria')).toEqual(['1 800101 221144']);
    expect(found('cnp', 'CNP 180 0101 221 144')).toEqual(['180 0101 221 144']);
    expect(found('cnp', 'CNP 1 800101 221145')).toEqual([]);
    // A grouped CNP is not also reported as a phone number.
    expect(found('phone', 'CNP 1 800101 221144')).toEqual([]);
  });
});
