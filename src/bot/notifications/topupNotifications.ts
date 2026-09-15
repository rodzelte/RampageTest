import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import { formatPhp } from '../../shared/money';
import { topupSchema, type Topup } from '../../shared/models';
import { topupNotificationSchema } from '../services/topups';
import type { EphemeralTopupRegistry } from './topupEphemeral';

type DiscordUsers = Pick<Client, 'users'>;
type Notification = ReturnType<typeof topupNotificationSchema.parse>;

function formatManilaDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function isCredited(topup: Topup) {
  return (
    topup.status === 'PAID' ||
    (topup.status === 'RESOLVED' &&
      topup.review_resolution === 'APPROVED_CREDIT')
  );
}

function isTerminal(topup: Topup) {
  return (
    isCredited(topup) ||
    topup.status === 'EXPIRED' ||
    topup.status === 'FAILED' ||
    topup.status === 'AMOUNT_MISMATCH_REVIEW' ||
    topup.status === 'LATE_PAID_REVIEW' ||
    topup.status === 'REJECTED' ||
    topup.status === 'RESOLVED'
  );
}

async function claimPaidNotification(
  topupId: string,
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
    return undefined;
  }
  return data ? topupNotificationSchema.parse(data) : null;
}

async function sendPaidTopupDm(
  notification: Notification,
  topup: Topup,
  discord: DiscordUsers,
  client: SupabaseClient,
  logger: Logger,
) {
  try {
    const user = await discord.users.fetch(notification.discord_user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ RAMPAGE TOP-UP SUCCESSFUL')
          .addFields(
            {
              name: 'Amount',
              value: formatPhp(notification.credited_amount_centavos),
            },
            { name: 'Status', value: 'PAID' },
            {
              name: 'Wallet credited',
              value: formatPhp(notification.credited_amount_centavos),
            },
            {
              name: 'Available Balance',
              value: formatPhp(notification.available_centavos),
            },
            {
              name: 'Reference',
              value: topup.provider_reference ?? 'Not provided',
            },
            {
              name: 'Paid',
              value: formatManilaDate(
                topup.provider_paid_at ?? topup.credited_at,
              ),
            },
          )
          .setDescription(
            'Your Rampage wallet has been credited successfully.',
          ),
      ],
    });
  } catch {
    logger.warn(
      { topupId: notification.topup_id },
      'Private top-up DM could not be delivered',
    );
    await client.rpc('record_topup_notification_failure', {
      p_topup_id: notification.topup_id,
      p_reason: 'Discord DM unavailable',
    });
  }
}

export async function notifyPaidTopup(
  topup: Topup,
  discord: DiscordUsers,
  client: SupabaseClient,
  logger: Logger,
) {
  const notification = await claimPaidNotification(topup.id, client, logger);
  if (notification)
    await sendPaidTopupDm(notification, topup, discord, client, logger);
}

export async function handleTopupTerminalState(
  topup: Topup,
  discord: DiscordUsers,
  client: SupabaseClient,
  logger: Logger,
  ephemeralTopups: EphemeralTopupRegistry,
) {
  if (!isTerminal(topup)) return;

  const ephemeralUpdate = ephemeralTopups.update(topup);
  const notification = isCredited(topup)
    ? await claimPaidNotification(topup.id, client, logger)
    : null;
  if (notification)
    await sendPaidTopupDm(notification, topup, discord, client, logger);
  const result = await ephemeralUpdate;

  if (result !== 'updated') {
    logger.warn(
      { topupId: topup.id, result },
      'Private ephemeral top-up response could not be updated',
    );
  }
}

export function startTopupNotificationWorker(
  discord: Client,
  client: SupabaseClient,
  logger: Logger,
  ephemeralTopups: EphemeralTopupRegistry,
) {
  const channel = client
    .channel('topup-private-notifications')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'topups' },
      (payload) => {
        const parsed = topupSchema.safeParse(payload.new);
        if (!parsed.success) {
          logger.warn(
            { issues: parsed.error.issues },
            'Ignored invalid top-up realtime payload',
          );
          return;
        }
        void handleTopupTerminalState(
          parsed.data,
          discord,
          client,
          logger,
          ephemeralTopups,
        );
      },
    )
    .subscribe();

  // A process restart loses ephemeral interaction handles by design. Claim any
  // unsettled private notifications and deliver them through DM instead.
  void client
    .from('topups')
    .select('*')
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
      else
        for (const row of data) {
          const parsed = topupSchema.safeParse(row);
          if (parsed.success)
            void notifyPaidTopup(parsed.data, discord, client, logger);
          else
            logger.warn(
              { issues: parsed.error.issues },
              'Ignored invalid top-up notification catch-up row',
            );
        }
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
