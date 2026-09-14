import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CreateQrPhTopupInput,
  QrPhProvider,
  VerifiedQrPhEvent,
} from './qrph';

const eventSchema = z.object({
  event_id: z.string().min(1),
  provider_payment_id: z.string().min(1),
  paid_amount_centavos: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('PHP'),
  paid_at: z.iso.datetime(),
  success: z.boolean(),
});

function secretsMatch(provided: string, expected: string) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class MockQrPhProvider implements QrPhProvider {
  readonly name = 'QRPH_MOCK';

  constructor(private readonly webhookSecret?: string) {}

  async createTopup(input: CreateQrPhTopupInput) {
    return Promise.resolve({
      providerPaymentId: `qrph_mock_${input.topupId}`,
      providerReference: `RMP-${input.topupId.slice(0, 8).toUpperCase()}`,
      qrPayload: `RAMPAGE-MOCK-QRPH:${input.topupId}:${input.amountCentavos}`,
      expiresAt: input.expiresAt,
    });
  }

  async verifyWebhook(request: Request): Promise<VerifiedQrPhEvent> {
    if (
      !this.webhookSecret ||
      !secretsMatch(
        request.headers.get('x-rampage-topup-webhook-secret') ?? '',
        this.webhookSecret,
      )
    )
      throw new Error('Invalid mock QR Ph webhook signature.');
    const body = eventSchema.parse(await request.json());
    return {
      provider: this.name,
      providerPaymentId: body.provider_payment_id,
      providerEventId: body.event_id,
      paidAmountCentavos: body.paid_amount_centavos,
      currency: body.currency,
      paidAt: new Date(body.paid_at),
      success: body.success,
    };
  }
}
