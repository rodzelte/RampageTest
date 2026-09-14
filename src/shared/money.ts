import { centavosSchema } from './models';

// Parse decimal text without floating point arithmetic or rounding.
export function parsePhpToCentavos(input: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match?.[1])
    throw new Error('Use a PHP amount with at most two decimal places.');
  const value =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Amount exceeds supported range.');
  return centavosSchema.parse(Number(value));
}

export function formatPhp(centavos: number): string {
  const value = BigInt(centavosSchema.parse(centavos));
  return `₱${(value / 100n).toLocaleString('en-PH')}.${String(value % 100n).padStart(2, '0')}`;
}
