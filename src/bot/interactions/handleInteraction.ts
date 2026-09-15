import type { Interaction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { BotConfig } from '../config';
import type { QrPhProvider } from '../providers/qrph';
import { handleTopupCommand } from '../commands/topup';
import type { EphemeralTopupRegistry } from '../notifications/topupEphemeral';
import { routeLobbyButton } from '../lobbies/lobbyInteractions';
import {
  handleBetAutocomplete,
  handleBetCommand,
  handleCancelBetCommand,
  routeSideBetInteraction,
} from '../betting/sideBetInteractions';
import {
  handleLobbiesCommand,
  routeLobbyDiscoveryInteraction,
} from '../commands/lobbies';
import {
  handleBalanceCommand,
  handleJoinCommand,
  handleLeaveCommand,
  handleRosterAutocomplete,
  handleTransactionsCommand,
  routeTransactionPagination,
} from '../commands/memberWallet';

export async function handleInteraction(
  interaction: Interaction,
  dependencies: {
    client: SupabaseClient;
    provider: QrPhProvider;
    config: BotConfig;
    logger: Logger;
    ephemeralTopups: EphemeralTopupRegistry;
  },
) {
  if (interaction.isAutocomplete()) {
    if (
      await handleRosterAutocomplete(
        interaction,
        dependencies.client,
        dependencies.logger,
      )
    )
      return;
    await handleBetAutocomplete(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (
    await routeTransactionPagination(
      interaction,
      dependencies.client,
      dependencies.logger,
    )
  )
    return;
  if (
    await routeLobbyDiscoveryInteraction(
      interaction,
      dependencies.client,
      dependencies.logger,
    )
  )
    return;
  if (
    await routeSideBetInteraction(
      interaction,
      dependencies.client,
      dependencies.logger,
    )
  )
    return;
  if (
    await routeLobbyButton(
      interaction,
      dependencies.client,
      dependencies.logger,
    )
  )
    return;
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'topup') {
    try {
      await handleTopupCommand(interaction, dependencies);
    } catch {
      dependencies.logger.error({ command: 'topup' }, 'Top-up command failed');
    }
    return;
  }
  if (interaction.commandName === 'bet') {
    await handleBetCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'join') {
    await handleJoinCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'leave') {
    await handleLeaveCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'lobbies') {
    await handleLobbiesCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'cancelbet') {
    await handleCancelBetCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'balance') {
    await handleBalanceCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
    return;
  }
  if (interaction.commandName === 'transactions') {
    await handleTransactionsCommand(
      interaction,
      dependencies.client,
      dependencies.logger,
    );
  }
}
