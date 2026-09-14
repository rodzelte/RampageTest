import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  ensureDiscordMember,
  requireDiscordRole,
  type InvokingInteraction,
} from '../../server/discord-auth';
import { parsePhpToCentavos } from '../../shared/money';
import { topupSchema } from '../../shared/models';
import type { BotConfig } from '../config';
import type { CreatedQrPhTopup, QrPhProvider } from '../providers/qrph';

export function parseTopupAmount(
  input: string,
  config: Pick<BotConfig, 'TOPUP_MIN_CENTAVOS' | 'TOPUP_MAX_CENTAVOS'>,
) {
  const amountCentavos = parsePhpToCentavos(input);
  if (amountCentavos < config.TOPUP_MIN_CENTAVOS)
    throw new Error(`Minimum top-up is ${config.TOPUP_MIN_CENTAVOS} centavos.`);
  if (amountCentavos > config.TOPUP_MAX_CENTAVOS)
    throw new Error(`Maximum top-up is ${config.TOPUP_MAX_CENTAVOS} centavos.`);
  return amountCentavos;
}

async function qrFromUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:')
    throw new Error('QR image URL must use HTTPS.');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(10_000) });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.startsWith('image/'))
    throw new Error('Provider QR image is invalid.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 2_000_000)
    throw new Error('Provider QR image has an invalid size.');
  return bytes;
}

export async function renderTopupQr(created: CreatedQrPhTopup) {
  if (created.qrImageBuffer?.length) return created.qrImageBuffer;
  if (created.qrPayload)
    return QRCode.toBuffer(created.qrPayload, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 420,
      margin: 2,
    });
  if (created.qrImageUrl) return qrFromUrl(created.qrImageUrl);
  throw new Error('Payment provider did not return a QR image or payload.');
}

export async function createTopupRequest(input: {
  client: SupabaseClient;
  interaction: InvokingInteraction;
  amountText: string;
  provider: QrPhProvider;
  config: Pick<
    BotConfig,
    'TOPUP_MIN_CENTAVOS' | 'TOPUP_MAX_CENTAVOS' | 'TOPUP_EXPIRY_MINUTES'
  >;
  now?: Date;
  topupId?: string;
}) {
  const amountCentavos = parseTopupAmount(input.amountText, input.config);
  const member = await ensureDiscordMember(input.client, input.interaction);
  await requireDiscordRole(input.client, input.interaction, 'MEMBER');
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + input.config.TOPUP_EXPIRY_MINUTES * 60_000,
  );
  const topupId = input.topupId ?? randomUUID();
  const { data, error } = await input.client
    .rpc('create_topup', {
      p_topup_id: topupId,
      p_user_id: member.id,
      p_amount_centavos: amountCentavos,
      p_provider: input.provider.name,
      p_expires_at: expiresAt.toISOString(),
    })
    .single();
  if (error) throw new Error('Unable to create a top-up request.');
  topupSchema.parse(data);
  try {
    const created = await input.provider.createTopup({
      topupId,
      amountCentavos,
      expiresAt,
    });
    if (created.expiresAt.getTime() !== expiresAt.getTime())
      throw new Error('Provider expiry did not match the requested expiry.');
    const { data: saved, error: saveError } = await input.client
      .rpc('set_topup_provider', {
        p_topup_id: topupId,
        p_provider_payment_id: created.providerPaymentId,
        p_provider_reference: created.providerReference ?? null,
      })
      .single();
    if (saveError) throw new Error('Unable to save payment provider details.');
    const topup = topupSchema.parse(saved);
    const qrImage = await renderTopupQr(created);
    return { topup, qrImage, amountCentavos, expiresAt };
  } catch (error) {
    await input.client.rpc('fail_topup_creation', {
      p_topup_id: topupId,
      p_reason: 'Provider QR creation failed',
    });
    throw error;
  }
}

export const topupNotificationSchema = z.object({
  topup_id: z.uuid(),
  discord_user_id: z.string().regex(/^\d{17,20}$/),
  credited_amount_centavos: z.number().int().positive(),
  available_centavos: z.number().int().min(0),
});
