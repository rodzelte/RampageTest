import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
} from 'discord.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { formatPhp } from '../../shared/money';

const lobbyActionPattern =
  /^lobby:(join-radiant|join-dire|leave):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const selfServiceResult = z.object({
  lobby_name: z.string(),
  entry_centavos: z.number().int().positive(),
  team: z.enum(['RADIANT', 'DIRE']),
});

async function lobbyEntry(client: SupabaseClient, lobbyId: string) {
  const { data } = await client
    .from('lobbies')
    .select('roster_entry_centavos')
    .eq('id', lobbyId)
    .single();
  return typeof data?.roster_entry_centavos === 'number'
    ? data.roster_entry_centavos
    : null;
}

async function failureMessage(
  client: SupabaseClient,
  lobbyId: string,
  error: { code?: string; message: string },
) {
  if (error.code === '22003') {
    const entry = await lobbyEntry(client, lobbyId);
    return `❌ **INSUFFICIENT BALANCE**\n\nLobby Entry: ${entry === null ? 'Unavailable' : formatPhp(entry)}\n\nUse /topup to add funds before joining.`;
  }
  if (error.code === '23505') return 'You are already active in this lobby.';
  if (error.code === '23514')
    return 'That team already has five active players.';
  if (error.code === '42501')
    return 'An active Rampage member account linked to your Discord ID is required.';
  if (/no longer active/i.test(error.message))
    return 'This lobby message is no longer active. Use the current lobby message.';
  if (
    /POSTPONED|OPEN lobby|Joining requires|Leaving requires/i.test(
      error.message,
    )
  )
    return 'Lobby participation is currently unavailable.';
  if (/not active in this lobby/i.test(error.message))
    return 'You are not active in this lobby.';
  return 'Unable to update your lobby roster. Please try again.';
}

export async function handleLobbyButton(
  interaction: ButtonInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  const match = lobbyActionPattern.exec(interaction.customId);
  if (!match) return false;
  const action = match[1]!.toLowerCase();
  const lobbyId = match[2]!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (action === 'leave') {
      const { data, error } = await client.rpc(
        'leave_lobby_self_with_interaction',
        {
          p_lobby_id: lobbyId,
          p_discord_user_id: interaction.user.id,
          p_discord_interaction_id: interaction.id,
          p_discord_message_id: interaction.message.id,
        },
      );
      if (error) throw error;
      const result = selfServiceResult.parse(data);
      await interaction.editReply(
        `✅ **YOU LEFT THE LOBBY**\n\nLobby: ${result.lobby_name}\nEntry Released: ${formatPhp(result.entry_centavos)}\n\nThe roster entry is available in your Rampage wallet again.`,
      );
      return true;
    }
    const team = action === 'join-radiant' ? 'RADIANT' : 'DIRE';
    const { data, error } = await client.rpc('join_lobby_self_with_amount', {
      p_lobby_id: lobbyId,
      p_discord_user_id: interaction.user.id,
      p_team: team,
      p_entry_centavos: null,
      p_discord_interaction_id: interaction.id,
      p_discord_message_id: interaction.message.id,
    });
    if (error) throw error;
    const result = selfServiceResult.parse(data);
    await interaction.editReply(
      `✅ **YOU JOINED ${result.team}**\n\nLobby: ${result.lobby_name}\nEntry Reserved: ${formatPhp(result.entry_centavos)}\n\nThe entry amount is now reserved in your Rampage wallet.`,
    );
    return true;
  } catch (error) {
    const normalized =
      error && typeof error === 'object' && 'message' in error
        ? (error as { code?: string; message: string })
        : { message: 'Unknown lobby interaction failure' };
    logger.warn(
      { lobbyId, action, code: normalized.code },
      'Lobby self-service interaction rejected',
    );
    await interaction.editReply(
      await failureMessage(client, lobbyId, normalized),
    );
    return true;
  }
}

export async function routeLobbyButton(
  interaction: Interaction,
  client: SupabaseClient,
  logger: Logger,
) {
  return interaction.isButton()
    ? handleLobbyButton(interaction, client, logger)
    : false;
}
