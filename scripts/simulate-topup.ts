import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createServiceClient } from '../src/server/clients';
import { parsePhpToCentavos } from '../src/shared/money';

const modeSchema = z.enum([
  'success',
  'mismatch',
  'late',
  'failure',
  'duplicate',
]);
const [modeText, topupId, amountText] = process.argv.slice(2);
const mode = modeSchema.parse(modeText);
z.uuid().parse(topupId);
if (process.env.NODE_ENV === 'production')
  throw new Error('Mock simulation is disabled in production.');
if (process.env.TOPUP_PROVIDER !== 'qrph_mock')
  throw new Error('Mock simulation requires TOPUP_PROVIDER=qrph_mock.');
const secret = z.string().min(16).parse(process.env.QRPH_WEBHOOK_SECRET);
const client = createServiceClient();
const { data, error } = await client
  .from('topups')
  .select('id,amount_centavos,provider_payment_id,expires_at')
  .eq('id', topupId)
  .single();
if (error || !data?.provider_payment_id)
  throw new Error('Top-up or provider payment ID not found.');
const requested = z.number().int().positive().parse(data.amount_centavos);
const amount =
  mode === 'mismatch'
    ? parsePhpToCentavos(z.string().min(1).parse(amountText))
    : requested;
const paidAt =
  mode === 'late'
    ? new Date(new Date(data.expires_at).getTime() + 5 * 60_000)
    : new Date();
const event = {
  event_id: `mock-event-${randomUUID()}`,
  provider_payment_id: data.provider_payment_id,
  paid_amount_centavos: amount,
  currency: 'PHP',
  paid_at: paidAt.toISOString(),
  success: mode !== 'failure',
};
const endpoint = `${z.url().parse(process.env.SUPABASE_URL).replace(/\/$/, '')}/functions/v1/topup-webhook`;
const attempts = mode === 'duplicate' ? 5 : 1;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rampage-topup-webhook-secret': secret,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok)
    throw new Error(`Mock webhook returned HTTP ${response.status}.`);
}
console.log(`Mock ${mode} event accepted for top-up ${topupId}.`);
