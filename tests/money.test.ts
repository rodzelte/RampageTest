import { describe, expect, it } from 'vitest';
import { centavosSchema } from '../src/shared/models';
import { formatPhp, parsePhpToCentavos } from '../src/shared/money';

describe('integer centavo boundaries', () => {
  it.each([
    ['0', 0],
    ['1.01', 101],
    ['0.29', 29],
    ['100000.00', 10000000],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %s exactly', (input, expected) => {
    expect(parsePhpToCentavos(input)).toBe(expected);
  });
  it.each(['1.001', '-1', 'NaN', 'Infinity', '1e2', '90071992547409.92', ''])(
    'rejects %s instead of rounding',
    (input) => {
      expect(() => parsePhpToCentavos(input)).toThrow();
    },
  );
  it.each([1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid authoritative wallet values: %s',
    (value) => {
      expect(centavosSchema.safeParse(value).success).toBe(false);
    },
  );
  it('formats without losing centavos', () => {
    expect(formatPhp(100001)).toBe('₱1,000.01');
    expect(formatPhp(Number.MAX_SAFE_INTEGER)).toBe('₱90,071,992,547,409.91');
  });
});
