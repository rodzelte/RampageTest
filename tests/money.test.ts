import { describe, expect, it } from 'vitest';
import { centavosSchema } from '../src/shared/models';
import {
  formatBasisPoints,
  formatPhp,
  formatPhpBigint,
  parsePercentToBasisPoints,
  parsePhpToCentavos,
  calculateGrossReturn,
  calculateNetWinningReturn,
  calculatePlatformFee,
  calculateWinningProfit,
} from '../src/shared/money';

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
  it('parses and formats platform fee basis points without floating point', () => {
    expect(parsePercentToBasisPoints('5')).toBe(500);
    expect(parsePercentToBasisPoints('5.50')).toBe(550);
    expect(formatBasisPoints(500)).toBe('5%');
    expect(formatBasisPoints(550)).toBe('5.50%');
    expect(formatPhpBigint(1_000_000n)).toBe('₱10,000.00');
  });
  it.each(['-1', 'NaN', 'Infinity', '1e1', '10.01', '5.001', ''])(
    'rejects invalid platform fee %s',
    (input) => expect(() => parsePercentToBasisPoints(input)).toThrow(),
  );
});

describe('platform fee projections', () => {
  it('projects a ₱100 stake at 5% with integer centavo math', () => {
    expect(calculateWinningProfit(10_000n)).toBe(10_000n);
    expect(calculateGrossReturn(10_000n)).toBe(20_000n);
    expect(calculatePlatformFee(10_000n, 500)).toBe(500n);
    expect(calculateNetWinningReturn(10_000n, 500)).toBe(19_500n);
  });

  it('floors fees to whole centavos and handles zero/1000 BPS', () => {
    expect(calculatePlatformFee(10_001n, 500)).toBe(500n);
    expect(calculatePlatformFee(10_001n, 0)).toBe(0n);
    expect(calculatePlatformFee(10_001n, 1000)).toBe(1_000n);
  });
});
