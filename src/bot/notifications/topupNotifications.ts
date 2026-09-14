import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { formatPhp } from '../../shared/money';
import { topupNotificationSchema } from '../services/topups';

export async function notifyPaidTopup(
  topupId: string,
  discord: Pick<Client, 'users'>,
  client: SupabaseClient,
  logger: Logger,
) {
  const { data, error } = await client.rpc('claim_topup_notification', {
    p_topup_id: topupId,
  });
  if (error) {
    logger.error(
      { topupId, code: error.code },
      'Unable to claim top-up notification',
    );
    return;
  }
  if (!data) return;
  const notification = topupNotificationSchema.parse(data);
  try {
    const user = await discord.users.fetch(notification.discord_user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('TOP-UP SUCCESSFUL')
          .addFields(
            {
              name: 'Amount',
              value: formatPhp(notification.credited_amount_centavos),
            },
            {
              name: 'Available Balance',
              value: formatPhp(notification.available_centavos),
            },
          )
          .setDescription('Your payment has been verified and credited.'),
      ],
    });
  } catch {
    logger.warn({ topupId }, 'Private top-up DM could not be delivered');
    await client.rpc('record_topup_notification_failure', {
      p_topup_id: topupId,
      p_reason: 'Discord DM unavailable',
    });
  }
}

export function startTopupNotificationWorker(
  discord: Client,
  client: SupabaseClient,
  logger: Logger,
) {
  const handle = (id: string) =>
    void notifyPaidTopup(id, discord, client, logger);
  const channel = client
    .channel('topup-private-notifications')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'topups' },
      (payload) => {
        const row = payload.new as {
          id?: unknown;
          status?: unknown;
          review_resolution?: unknown;
        };
        if (
          typeof row.id === 'string' &&
          (row.status === 'PAID' ||
            (row.status === 'RESOLVED' &&
              row.review_resolution === 'APPROVED_CREDIT'))
        )
          handle(row.id);
      },
    )
    .subscribe();

  void client
    .from('topups')
    .select('id')
    .is('notification_claimed_at', null)
    .or(
      'status.eq.PAID,and(status.eq.RESOLVED,review_resolution.eq.APPROVED_CREDIT)',
    )
    .then(({ data, error }) => {
      if (error)
        logger.error(
          { code: error.code },
          'Unable to catch up top-up notifications',
        );
      else for (const row of data) handle(String(row.id));
    });

  const expiryTimer = setInterval(() => {
    void client.rpc('expire_pending_topups').then(({ error }) => {
      if (error)
        logger.error({ code: error.code }, 'Unable to expire pending top-ups');
    });
  }, 60_000);
  expiryTimer.unref();

  return () => {
    clearInterval(expiryTimer);
    void client.removeChannel(channel);
  };
}
