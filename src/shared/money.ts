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
  return formatPhpBigint(value);
}

export function formatPhpBigint(value: bigint): string {
  if (value < 0n) throw new Error('Amount must not be negative.');
  return `₱${(value / 100n).toLocaleString('en-PH')}.${String(value % 100n).padStart(2, '0')}`;
}

export function formatBasisPoints(basisPoints: number): string {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 1000)
    throw new Error('Basis points must be an integer from 0 to 1000.');
  const value = BigInt(basisPoints);
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n
    ? `${whole}%`
    : `${whole}.${String(fraction).padStart(2, '0')}%`;
}

export function parsePercentToBasisPoints(input: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match?.[1])
    throw new Error('Use a percentage with at most two decimal places.');
  const value =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (value > 1000n)
    throw new Error('Platform fee must be between 0% and 10%.');
  return Number(value);
}

function assertProjectionInput(centavos: bigint, basisPoints?: number) {
  if (centavos < 0n) throw new Error('Amount must not be negative.');
  if (
    basisPoints !== undefined &&
    (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 1000)
  )
    throw new Error('Basis points must be an integer from 0 to 1000.');
}

export function calculateWinningProfit(acceptedStakeCentavos: bigint) {
  assertProjectionInput(acceptedStakeCentavos);
  return acceptedStakeCentavos;
}

export function calculateGrossReturn(acceptedStakeCentavos: bigint) {
  assertProjectionInput(acceptedStakeCentavos);
  return acceptedStakeCentavos * 2n;
}

export function calculatePlatformFee(
  winningProfitCentavos: bigint,
  platformFeeBps: number,
) {
  assertProjectionInput(winningProfitCentavos, platformFeeBps);
  return (winningProfitCentavos * BigInt(platformFeeBps)) / 10_000n;
}

export function calculateNetWinningReturn(
  acceptedStakeCentavos: bigint,
  platformFeeBps: number,
) {
  const gross = calculateGrossReturn(acceptedStakeCentavos);
  const fee = calculatePlatformFee(
    calculateWinningProfit(acceptedStakeCentavos),
    platformFeeBps,
  );
  return gross - fee;
}
