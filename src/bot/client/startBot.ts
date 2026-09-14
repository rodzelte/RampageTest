import { Client, Events, GatewayIntentBits } from 'discord.js';
import pino from 'pino';
import { createServiceClient } from '../../server/clients';
import { readBotConfig } from '../config';
import { handleInteraction } from '../interactions/handleInteraction';
import { startTopupNotificationWorker } from '../notifications/topupNotifications';
import { MockQrPhProvider } from '../providers/MockQrPhProvider';

export async function startBot(env: NodeJS.ProcessEnv = process.env) {
  const config = readBotConfig(env);
  const logger = pino({ name: 'rampage-bot' });
  const supabase = createServiceClient(env);
  const provider = new MockQrPhProvider(env.QRPH_WEBHOOK_SECRET);
  const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
  discord.on(
    Events.InteractionCreate,
    (interaction) =>
      void handleInteraction(interaction, {
        client: supabase,
        provider,
        config,
        logger,
      }),
  );
  discord.once(Events.ClientReady, (ready) => {
    logger.info({ userId: ready.user.id }, 'Discord bot ready');
    startTopupNotificationWorker(discord, supabase, logger);
  });
  await discord.login(config.DISCORD_BOT_TOKEN);
  return discord;
}
