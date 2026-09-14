/* global Deno */
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

type MockQrPhEvent = {
  event_id: string;
  provider_payment_id: string;
  paid_amount_centavos: number;
  currency: string;
  paid_at: string;
  success: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function tokenMatches(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function parseEvent(value: unknown): MockQrPhEvent {
  if (!value || typeof value !== 'object') throw new Error('invalid');
  const body = value as Record<string, unknown>;
  if (
    typeof body.event_id !== 'string' ||
    !body.event_id ||
    typeof body.provider_payment_id !== 'string' ||
    !body.provider_payment_id ||
    typeof body.paid_amount_centavos !== 'number' ||
    !Number.isSafeInteger(body.paid_amount_centavos) ||
    body.paid_amount_centavos < 0 ||
    body.currency !== 'PHP' ||
    typeof body.paid_at !== 'string' ||
    Number.isNaN(Date.parse(body.paid_at)) ||
    typeof body.success !== 'boolean'
  )
    throw new Error('invalid');
  return body as MockQrPhEvent;
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405);
  if (Deno.env.get('NODE_ENV') === 'production')
    return json({ error: 'Mock payment simulation is disabled' }, 503);
  if (Deno.env.get('TOPUP_PROVIDER') !== 'qrph_mock')
    return json({ error: 'Top-up provider is not configured' }, 503);
  const secret = Deno.env.get('QRPH_WEBHOOK_SECRET') ?? '';
  if (
    secret.length < 16 ||
    !(await tokenMatches(
      request.headers.get('x-rampage-topup-webhook-secret') ?? '',
      secret,
    ))
  )
    return json({ error: 'Invalid signature' }, 401);

  let event: MockQrPhEvent;
  try {
    event = parseEvent(await request.json());
  } catch {
    return json({ error: 'Invalid webhook payload' }, 400);
  }
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey)
    return json({ error: 'Server configuration unavailable' }, 503);
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc('process_verified_topup', {
    p_provider: 'QRPH_MOCK',
    p_provider_payment_id: event.provider_payment_id,
    p_provider_event_id: event.event_id,
    p_paid_amount_centavos: event.paid_amount_centavos,
    p_currency: event.currency,
    p_paid_at: event.paid_at,
    p_success: event.success,
  });
  if (error) {
    const unknown = error.code === 'P0002';
    return json(
      {
        error: unknown
          ? 'Unknown payment reference'
          : 'Payment could not be processed',
      },
      unknown ? 404 : 400,
    );
  }
  return json({ accepted: true, topup_id: data.id, status: data.status });
});
