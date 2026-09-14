import type { Interaction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { BotConfig } from '../config';
import type { QrPhProvider } from '../providers/qrph';
import { handleTopupCommand } from '../commands/topup';

export async function handleInteraction(
  interaction: Interaction,
  dependencies: {
    client: SupabaseClient;
    provider: QrPhProvider;
    config: BotConfig;
    logger: Logger;
  },
) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'topup') {
    try {
      await handleTopupCommand(interaction, dependencies);
    } catch {
      dependencies.logger.error({ command: 'topup' }, 'Top-up command failed');
    }
  }
}
