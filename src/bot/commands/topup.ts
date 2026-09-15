import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatPhp } from '../../shared/money';
import type { BotConfig } from '../config';
import type { QrPhProvider } from '../providers/qrph';
import { createTopupRequest } from '../services/topups';
import type { EphemeralTopupRegistry } from '../notifications/topupEphemeral';

export async function handleTopupCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: {
    client: SupabaseClient;
    provider: QrPhProvider;
    config: BotConfig;
    ephemeralTopups: EphemeralTopupRegistry;
  },
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await createTopupRequest({
      client: dependencies.client,
      interaction,
      amountText: interaction.options.getString('amount', true),
      provider: dependencies.provider,
      config: dependencies.config,
    });
    const filename = `rampage-mock-topup-${result.topup.id}.png`;
    const attachment = new AttachmentBuilder(result.qrImage, {
      name: filename,
    });
    const embed = new EmbedBuilder()
      .setTitle('QR PH TOP-UP')
      .setDescription('Scan the QR below using GCash.')
      .addFields(
        {
          name: 'Amount',
          value: formatPhp(result.amountCentavos),
          inline: true,
        },
        {
          name: 'Expires in',
          value: `${dependencies.config.TOPUP_EXPIRY_MINUTES} minutes`,
          inline: true,
        },
        { name: 'Provider', value: 'QR PH MOCK · Development only' },
      )
      .setImage(`attachment://${filename}`)
      .setFooter({
        text: 'Only you can see this message. Your wallet will be credited automatically after the payment is successfully verified.',
      });
    await interaction.editReply({ embeds: [embed], files: [attachment] });
    dependencies.ephemeralTopups.remember(result.topup.id, interaction);
  } catch (error) {
    const message =
      error instanceof Error &&
      /Minimum|Maximum|PHP amount|supported range/.test(error.message)
        ? error.message
        : 'Unable to create the private payment QR. Please try again later.';
    await interaction.editReply({ content: message, embeds: [], files: [] });
  }
}
