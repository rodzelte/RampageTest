import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  centavosSchema,
  discordIdSchema,
  platformFeeBpsSchema,
} from '../../shared/models';
import { getLobbyMatchup, matchupLabel } from '../../shared/lobby-matchup';
import {
  formatBasisPoints,
  formatPhp,
  formatPhpBigint,
} from '../../shared/money';

const playerSchema = z.object({
  id: z.uuid(),
  discord_user_id: discordIdSchema,
  display_name: z.string(),
  team: z.enum(['RADIANT', 'DIRE']),
  status: z.enum(['ACTIVE', 'REMOVED']),
  stake_centavos: centavosSchema.positive(),
  added_at: z.string(),
});
const availableLobbySchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  status: z.literal('OPEN'),
  discord_channel_id: discordIdSchema,
  roster_entry_centavos: centavosSchema.positive(),
  side_betting_enabled: z.boolean(),
  side_bet_min_centavos: centavosSchema.positive().nullable(),
  side_bet_max_centavos: centavosSchema.positive().nullable(),
  platform_fee_bps: platformFeeBpsSchema,
  lobby_players: z.array(playerSchema),
  side_bets: z.array(
    z.object({
      side: z.enum(['RADIANT', 'DIRE']),
      status: z.enum(['ACTIVE', 'CANCELLED']),
      accepted_amount_centavos: centavosSchema,
    }),
  ),
});
export type AvailableLobby = z.infer<typeof availableLobbySchema>;

const pagePattern = /^lobbies:page:(\d+)$/;
const selectPattern = /^lobbies:select:(\d+)$/;
const PAGE_SIZE = 25;

function safeText(value: string) {
  return value.replace(/@/g, '@\u200b').replace(/([\\`*_~|>])/g, '\\$1');
}

async function authorizeMember(client: SupabaseClient, discordUserId: string) {
  const { error } = await client.rpc('authorize_discord', {
    p_discord_user_id: discordUserId,
    p_required_role: 'MEMBER',
  });
  if (error) throw error;
}

async function loadOpenLobbies(client: SupabaseClient) {
  const { data, error } = await client
    .from('lobbies')
    .select(
      'id,display_name,status,discord_channel_id,roster_entry_centavos,side_betting_enabled,side_bet_min_centavos,side_bet_max_centavos,platform_fee_bps,lobby_players(id,discord_user_id,display_name,team,status,stake_centavos,added_at),side_bets(side,status,accepted_amount_centavos)',
    )
    .eq('status', 'OPEN')
    .order('display_name')
    .order('id');
  if (error) throw error;
  return z.array(availableLobbySchema).parse(data);
}

function activeRoster(lobby: AvailableLobby) {
  return lobby.lobby_players.filter((player) => player.status === 'ACTIVE');
}

function menuLabel(lobby: AvailableLobby) {
  return `${lobby.display_name} • ${matchupLabel(lobby.lobby_players)}`.slice(
    0,
    100,
  );
}

function menuDescription(lobby: AvailableLobby) {
  const active = activeRoster(lobby);
  const radiant = active.filter((player) => player.team === 'RADIANT').length;
  const dire = active.filter((player) => player.team === 'DIRE').length;
  return `R ${radiant}/5 • D ${dire}/5 • Entry ${formatPhp(lobby.roster_entry_centavos)} • Betting ${lobby.side_betting_enabled ? 'ON' : 'OFF'}`.slice(
    0,
    100,
  );
}

export function renderLobbyDiscoveryPage(
  lobbies: AvailableLobby[],
  requestedPage = 0,
) {
  if (lobbies.length === 0)
    return {
      content:
        '🎮 **OPEN LOBBIES — 0**\n\nNo OPEN lobbies are currently available.',
      components: [],
    };
  const pages = Math.ceil(lobbies.length / PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const start = page * PAGE_SIZE;
  const current = lobbies.slice(start, start + PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`lobbies:select:${page}`)
    .setPlaceholder('Choose an OPEN lobby')
    .addOptions(
      current.map((lobby) => ({
        label: menuLabel(lobby),
        description: menuDescription(lobby),
        value: lobby.id,
      })),
    );
  const components: ActionRowBuilder<
    StringSelectMenuBuilder | ButtonBuilder
  >[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  if (pages > 1)
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`lobbies:page:${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`lobbies:page:${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pages - 1),
      ),
    );
  return {
    content: `🎮 **OPEN LOBBIES — ${lobbies.length}**\nPage ${page + 1} of ${pages}\n${start + 1}–${start + current.length} of ${lobbies.length}`,
    components,
  };
}

function discordRepresentative(
  player: ReturnType<typeof getLobbyMatchup>['radiant'],
) {
  return player ? `<@${player.discord_user_id}>` : 'TBD';
}

export function renderSelectedLobby(
  lobby: AvailableLobby,
  allLobbies: AvailableLobby[],
  page: number,
) {
  const active = activeRoster(lobby);
  const radiant = active.filter((player) => player.team === 'RADIANT');
  const dire = active.filter((player) => player.team === 'DIRE');
  const bets = lobby.side_bets.filter((bet) => bet.status === 'ACTIVE');
  const radiantPool =
    radiant.reduce((sum, player) => sum + BigInt(player.stake_centavos), 0n) +
    bets
      .filter((bet) => bet.side === 'RADIANT')
      .reduce((sum, bet) => sum + BigInt(bet.accepted_amount_centavos), 0n);
  const direPool =
    dire.reduce((sum, player) => sum + BigInt(player.stake_centavos), 0n) +
    bets
      .filter((bet) => bet.side === 'DIRE')
      .reduce((sum, bet) => sum + BigInt(bet.accepted_amount_centavos), 0n);
  const matchup = getLobbyMatchup(lobby.lobby_players);
  const betting = lobby.side_betting_enabled
    ? `✅ Enabled\n**Bet Range:** ${formatPhp(lobby.side_bet_min_centavos!)} – ${formatPhp(lobby.side_bet_max_centavos!)}`
    : '❌ Disabled';
  return {
    ...renderLobbyDiscoveryPage(allLobbies, page),
    content: `🎮 **${safeText(lobby.display_name)}**\n\n⚔️ 🟢 ${discordRepresentative(matchup.radiant)} vs 🔴 ${discordRepresentative(matchup.dire)}\n\n🟢 OPEN\n\n**Roster:** Radiant ${radiant.length}/5 • Dire ${dire.length}/5\n**Entry:** ${formatPhp(lobby.roster_entry_centavos)}\n**Side Betting:** ${betting}\n**Platform Fee:** ${formatBasisPoints(lobby.platform_fee_bps)} of winning profit\n**Pool:** Radiant ${formatPhpBigint(radiantPool)} • Dire ${formatPhpBigint(direPool)} • Total ${formatPhpBigint(radiantPool + direPool)}`,
  };
}

function normalizedError(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string })
    : {};
}

async function failureReply(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction,
  logger: Logger,
  error: unknown,
) {
  const normalized = normalizedError(error);
  logger.warn(
    { command: 'lobbies', code: normalized.code },
    'Lobby discovery rejected',
  );
  await interaction.editReply(
    normalized.code === '42501'
      ? '❌ An active Rampage member account linked to your Discord ID is required.'
      : '❌ Unable to load available lobbies. Please try again.',
  );
}

export async function handleLobbiesCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await authorizeMember(client, interaction.user.id);
    await interaction.editReply(
      renderLobbyDiscoveryPage(await loadOpenLobbies(client)),
    );
  } catch (error) {
    await failureReply(interaction, logger, error);
  }
}

export async function routeLobbyDiscoveryInteraction(
  interaction: Interaction,
  client: SupabaseClient,
  logger: Logger,
) {
  let component: ButtonInteraction | StringSelectMenuInteraction;
  let page: number;
  let selectedLobbyId: string | undefined;
  if (interaction.isButton()) {
    const match = pagePattern.exec(interaction.customId);
    if (!match) return false;
    component = interaction;
    page = Number(match[1]);
  } else if (interaction.isStringSelectMenu()) {
    const match = selectPattern.exec(interaction.customId);
    if (!match) return false;
    component = interaction;
    page = Number(match[1]);
    selectedLobbyId = interaction.values[0];
  } else return false;
  await component.deferUpdate();
  try {
    await authorizeMember(client, component.user.id);
    const lobbies = await loadOpenLobbies(client);
    if (component.isButton())
      await component.editReply(renderLobbyDiscoveryPage(lobbies, page));
    else {
      const lobby = lobbies.find((entry) => entry.id === selectedLobbyId);
      if (!lobby)
        await component.editReply({
          content: '❌ This lobby is no longer OPEN.',
          components: renderLobbyDiscoveryPage(lobbies, page).components,
        });
      else await component.editReply(renderSelectedLobby(lobby, lobbies, page));
    }
  } catch (error) {
    await failureReply(component, logger, error);
  }
  return true;
}

export const lobbyDiscoveryPageSize = PAGE_SIZE;
