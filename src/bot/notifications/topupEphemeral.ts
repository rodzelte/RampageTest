import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from 'discord.js';
import type { Topup } from '../../shared/models';
import { formatPhp } from '../../shared/money';

type EphemeralEditor = Pick<ChatInputCommandInteraction, 'editReply'>;
export type EphemeralUpdateResult = 'updated' | 'unavailable' | 'failed';

function formatManilaDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function renderTerminalTopupMessage(
  topup: Topup,
): InteractionEditReplyOptions {
  const base: InteractionEditReplyOptions = {
    content: '',
    attachments: [],
    files: [],
  };
  if (topup.status === 'PAID')
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ PAYMENT RECEIVED')
          .addFields(
            { name: 'Amount', value: formatPhp(topup.amount_centavos) },
            { name: 'Status', value: 'PAID' },
            { name: 'Credited', value: formatPhp(topup.amount_centavos) },
          )
          .setDescription('Your wallet has been credited successfully.'),
      ],
    };
  if (topup.status === 'EXPIRED')
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('⌛ QR EXPIRED')
          .setDescription(
            'This QR Ph top-up has expired.\nPlease create a new /topup request.',
          ),
      ],
    };
  if (topup.status === 'FAILED')
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('❌ TOP-UP FAILED')
          .setDescription('This QR Ph top-up could not be completed.'),
      ],
    };
  if (topup.status === 'AMOUNT_MISMATCH_REVIEW')
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ PAYMENT UNDER REVIEW')
          .setDescription(
            'The amount received did not match the requested amount.\nNo automatic wallet credit was made.',
          ),
      ],
    };
  if (topup.status === 'LATE_PAID_REVIEW')
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ LATE PAYMENT UNDER REVIEW')
          .setDescription(
            'Payment was received after expiration.\nNo automatic wallet credit was made.',
          ),
      ],
    };
  if (
    topup.status === 'RESOLVED' &&
    topup.review_resolution === 'APPROVED_CREDIT'
  )
    return {
      ...base,
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ PAYMENT RECEIVED')
          .addFields(
            {
              name: 'Credited',
              value:
                topup.provider_paid_amount_centavos === null
                  ? 'Verified amount'
                  : formatPhp(topup.provider_paid_amount_centavos),
            },
            { name: 'Status', value: 'RESOLVED' },
            { name: 'Paid', value: formatManilaDate(topup.provider_paid_at) },
          )
          .setDescription('Your wallet has been credited successfully.'),
      ],
    };
  return {
    ...base,
    embeds: [
      new EmbedBuilder()
        .setTitle('❌ TOP-UP REVIEW CLOSED')
        .setDescription('No wallet credit was made for this top-up.'),
    ],
  };
}

export class EphemeralTopupRegistry {
  private readonly entries = new Map<
    string,
    { editor: EphemeralEditor; timer: NodeJS.Timeout }
  >();
  private readonly updates = new Map<string, Promise<EphemeralUpdateResult>>();

  constructor(private readonly retentionMilliseconds = 35 * 60_000) {}

  remember(topupId: string, editor: EphemeralEditor) {
    this.forget(topupId);
    const timer = setTimeout(
      () => this.entries.delete(topupId),
      this.retentionMilliseconds,
    );
    timer.unref();
    this.entries.set(topupId, { editor, timer });
  }

  forget(topupId: string) {
    const existing = this.entries.get(topupId);
    if (existing) clearTimeout(existing.timer);
    this.entries.delete(topupId);
  }

  has(topupId: string) {
    return this.entries.has(topupId);
  }

  async update(topup: Topup): Promise<EphemeralUpdateResult> {
    const existingUpdate = this.updates.get(topup.id);
    if (existingUpdate) return existingUpdate;
    const entry = this.entries.get(topup.id);
    if (!entry) return 'unavailable';
    this.forget(topup.id);
    const update = (async () => {
      try {
        await entry.editor.editReply(renderTerminalTopupMessage(topup));
        return 'updated' as const;
      } catch {
        return 'failed' as const;
      }
    })();
    this.updates.set(topup.id, update);
    try {
      return await update;
    } finally {
      if (this.updates.get(topup.id) === update) this.updates.delete(topup.id);
    }
  }
}
