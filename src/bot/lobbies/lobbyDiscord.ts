import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
  type Message,
  type NonThreadGuildBasedChannel,
} from 'discord.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  lobbyPlayerSchema,
  lobbySchema,
  sideBetSchema,
  type Lobby,
  type LobbyPlayer,
} from '../../shared/models';
import {
  formatBasisPoints,
  formatPhp,
  formatPhpBigint,
} from '../../shared/money';
import { getLobbyMatchup } from '../../shared/lobby-matchup';

const lobbyDiscordSyncSchema = lobbySchema.extend({
  discord_channel_name: z.string().nullable(),
  players: z.array(
    lobbyPlayerSchema.pick({
      id: true,
      discord_user_id: true,
      display_name: true,
      team: true,
      stake_centavos: true,
      added_at: true,
    }),
  ),
  side_bets: z.array(
    sideBetSchema.pick({
      id: true,
      bet_number: true,
      discord_user_id: true,
      display_name: true,
      side: true,
      accepted_amount_centavos: true,
      placed_at: true,
    }),
  ),
});
export type LobbyDiscordSync = z.infer<typeof lobbyDiscordSyncSchema>;

export function lobbyButtonId(
  lobbyId: string,
  action: 'join-radiant' | 'join-dire' | 'leave' | 'bet-radiant' | 'bet-dire',
) {
  return `lobby:${action}:${lobbyId}`;
}

export function renderLobbyComponents(input: LobbyDiscordSync) {
  if (input.status === 'ARCHIVED') return [];
  const disabled = input.status !== 'OPEN';
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(lobbyButtonId(input.id, 'join-radiant'))
        .setLabel('Join Radiant')
        .setEmoji('🟢')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(lobbyButtonId(input.id, 'join-dire'))
        .setLabel('Join Dire')
        .setEmoji('🔴')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(lobbyButtonId(input.id, 'leave'))
        .setLabel('Leave Lobby')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
  if (input.side_betting_enabled)
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(lobbyButtonId(input.id, 'bet-radiant'))
          .setLabel('Bet Radiant')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId(lobbyButtonId(input.id, 'bet-dire'))
          .setLabel('Bet Dire')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(disabled),
      ),
    );
  return rows;
}

function rosterLines(players: LobbyDiscordSync['players']) {
  if (players.length === 0) return 'Waiting for players…';
  return players
    .map(
      (player) =>
        `${player.display_name} — ${formatPhp(player.stake_centavos)}`,
    )
    .join('\n');
}

export function sideBetLines(bets: LobbyDiscordSync['side_bets']) {
  if (bets.length === 0) return 'No active side bets.';
  const newest = [...bets].sort(
    (a, b) =>
      b.placed_at.localeCompare(a.placed_at) || b.bet_number - a.bet_number,
  );
  const shown: string[] = [];
  for (const bet of newest) {
    const line = `• <@${bet.discord_user_id}> — ${formatPhp(bet.accepted_amount_centavos)} #${bet.bet_number}`;
    if (shown.length >= 12 || [...shown, line].join('\n').length > 900) break;
    shown.push(line);
  }
  const omitted = bets.length - shown.length;
  return `${shown.join('\n')}${omitted > 0 ? `\n+ ${omitted} more active bets` : ''}`;
}

export function renderLobbyEmbed(input: LobbyDiscordSync) {
  const radiant = input.players.filter((player) => player.team === 'RADIANT');
  const dire = input.players.filter((player) => player.team === 'DIRE');
  const radiantPool = radiant.reduce(
    (sum, player) => sum + BigInt(player.stake_centavos),
    0n,
  );
  const direPool = dire.reduce(
    (sum, player) => sum + BigInt(player.stake_centavos),
    0n,
  );
  const radiantBets = input.side_bets.filter((bet) => bet.side === 'RADIANT');
  const direBets = input.side_bets.filter((bet) => bet.side === 'DIRE');
  const radiantSideBetPool = radiantBets.reduce(
    (sum, bet) => sum + BigInt(bet.accepted_amount_centavos),
    0n,
  );
  const direSideBetPool = direBets.reduce(
    (sum, bet) => sum + BigInt(bet.accepted_amount_centavos),
    0n,
  );
  const radiantTotal = radiantPool + radiantSideBetPool;
  const direTotal = direPool + direSideBetPool;
  const difference =
    radiantTotal >= direTotal
      ? radiantTotal - direTotal
      : direTotal - radiantTotal;
  const differenceText =
    difference === 0n
      ? `DIFF: ${formatPhpBigint(0n)}\n\n✅ Pool is currently balanced.`
      : `DIFF: ${formatPhpBigint(difference)}\n${radiantTotal > direTotal ? '🟢 RADIANT' : '🔴 DIRE'} Lead +${formatPhpBigint(difference)}\n\n⚠️ Excess leading-side side bets are subject to LIFO refund on lock.`;
  const full = radiant.length === 5 && dire.length === 5;
  const matchup = getLobbyMatchup(input.players);
  const representative = (
    player: ReturnType<typeof getLobbyMatchup>['radiant'],
  ) => (player ? `<@${player.discord_user_id}>` : 'TBD');
  const sideBetting = input.side_betting_enabled
    ? `Enabled\n${formatPhp(input.side_bet_min_centavos!)} – ${formatPhp(input.side_bet_max_centavos!)}`
    : 'Disabled';
  const statusDescription =
    input.status === 'OPEN'
      ? `🟢 STATUS: OPEN${full ? '\n\n✅ ROSTERS FULL\n**READY TO LOCK**' : ''}`
      : input.status === 'POSTPONED'
        ? '⏸ STATUS: POSTPONED\n\nRoster and wallet reservations are preserved.'
        : input.status === 'CANCELLED'
          ? '❌ STATUS: CANCELLED\n\nAll active roster and side-bet reservations have been returned.'
          : input.status === 'ARCHIVED'
            ? '📦 STATUS: ARCHIVED\n\nThis lobby is retained as read-only history.'
            : `STATUS: ${input.status}`;
  return new EmbedBuilder()
    .setTitle(`🎮 ${input.display_name} — Match & Betting Overview`)
    .setDescription(
      `⚔️ 🟢 ${representative(matchup.radiant)} vs 🔴 ${representative(matchup.dire)}\n\nStatus:\n${statusDescription}`,
    )
    .addFields(
      {
        name: 'Roster Entry',
        value: `${formatPhp(input.roster_entry_centavos)} per player`,
        inline: true,
      },
      {
        name: 'Platform Fee',
        value: `${formatBasisPoints(input.platform_fee_bps)} of winning profit`,
        inline: true,
      },
      { name: 'Side Betting', value: sideBetting, inline: true },
      {
        name: `🟢 RADIANT — ${radiant.length}/5`,
        value: rosterLines(radiant),
      },
      {
        name: `🔴 DIRE — ${dire.length}/5`,
        value: rosterLines(dire),
      },
      {
        name: '📊 POOL SUMMARY',
        value: `🟢 Radiant roster: ${formatPhpBigint(radiantPool)}\n🟢 Radiant side bets: ${formatPhpBigint(radiantSideBetPool)}\n🟢 Radiant total: ${formatPhpBigint(radiantTotal)}\n\n🔴 Dire roster: ${formatPhpBigint(direPool)}\n🔴 Dire side bets: ${formatPhpBigint(direSideBetPool)}\n🔴 Dire total: ${formatPhpBigint(direTotal)}\n\n💰 Total: ${formatPhpBigint(radiantTotal + direTotal)}`,
      },
      { name: '⚖️ CURRENT POOL DIFFERENCE', value: differenceText },
      { name: '🟢 RADIANT SIDE BETS', value: sideBetLines(radiantBets) },
      { name: '🔴 DIRE SIDE BETS', value: sideBetLines(direBets) },
    )
    .setFooter({ text: `Rampage lobby ${input.id}` });
}

function channelMetadata(
  channel: NonThreadGuildBasedChannel,
  botUserId: string,
) {
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  )
    return null;
  const permissions = channel.permissionsFor(botUserId);
  const canPost = Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.SendMessages) &&
    permissions.has(PermissionFlagsBits.EmbedLinks),
  );
  return {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type:
      channel.type === ChannelType.GuildAnnouncement
        ? ('GUILD_ANNOUNCEMENT' as const)
        : ('GUILD_TEXT' as const),
    can_post: canPost,
  };
}

export async function syncGuildChannels(
  discord: Client,
  client: SupabaseClient,
  guildId: string,
  logger: Logger,
) {
  if (!discord.user) throw new Error('Discord bot is not ready.');
  const guild = await discord.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const safeChannels = [...channels.values()].flatMap((channel) => {
    if (!channel) return [];
    const metadata = channelMetadata(channel, discord.user!.id);
    return metadata ? [metadata] : [];
  });
  const { error } = await client.rpc('sync_discord_channels', {
    p_guild_id: guildId,
    p_channels: safeChannels,
  });
  if (error) {
    logger.error(
      { code: error.code },
      'Unable to synchronize Discord channels',
    );
    throw new Error('Discord channel synchronization failed.');
  }
  return safeChannels;
}

async function findExistingLobbyMessage(
  channel: Extract<
    GuildBasedChannel,
    { type: ChannelType.GuildText | ChannelType.GuildAnnouncement }
  >,
  discord: Client,
  lobby: LobbyDiscordSync,
) {
  if (lobby.discord_message_id)
    return channel.messages.fetch(lobby.discord_message_id);
  const recent = await channel.messages.fetch({ limit: 50 });
  const footer = `Rampage lobby ${lobby.id}`;
  return (
    recent.find(
      (message) =>
        message.author.id === discord.user?.id &&
        message.embeds.some((embed) => embed.footer?.text === footer),
    ) ?? null
  );
}

export async function reconcileLobbyDiscord(
  lobby: LobbyDiscordSync,
  discord: Client,
  client: SupabaseClient,
  logger: Logger,
) {
  try {
    if (
      lobby.discord_previous_channel_id &&
      lobby.discord_previous_message_id
    ) {
      try {
        const previousChannel = await discord.channels.fetch(
          lobby.discord_previous_channel_id,
        );
        if (
          previousChannel &&
          (previousChannel.type === ChannelType.GuildText ||
            previousChannel.type === ChannelType.GuildAnnouncement)
        ) {
          const previousMessage = await previousChannel.messages.fetch(
            lobby.discord_previous_message_id,
          );
          await previousMessage.edit({
            content: '↪️ This lobby moved to another channel.',
            embeds: [],
            components: [],
          });
        }
      } catch {
        logger.warn(
          { lobbyId: lobby.id },
          'Unable to retire the previous lobby message',
        );
      }
    }
    const channel = await discord.channels.fetch(lobby.discord_channel_id);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    )
      throw new Error('Configured lobby channel is unavailable.');
    const embed = renderLobbyEmbed(lobby);
    const components = renderLobbyComponents(lobby);
    let message: Message;
    const existing = await findExistingLobbyMessage(channel, discord, lobby);
    if (existing) {
      message = await existing.edit({
        content: '',
        embeds: [embed],
        components,
      });
    } else {
      message = await channel.send({ embeds: [embed], components });
    }
    const { error } = await client.rpc('complete_lobby_discord_sync', {
      p_lobby_id: lobby.id,
      p_revision: lobby.discord_revision,
      p_discord_message_id: message.id,
    });
    if (error) throw new Error(`Database completion failed: ${error.code}`);
    return true;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Discord synchronization failed';
    logger.warn(
      { lobbyId: lobby.id, revision: lobby.discord_revision },
      'Lobby Discord synchronization failed',
    );
    const { error: recordError } = await client.rpc('fail_lobby_discord_sync', {
      p_lobby_id: lobby.id,
      p_revision: lobby.discord_revision,
      p_error: reason,
    });
    if (recordError)
      logger.error(
        { lobbyId: lobby.id, code: recordError.code },
        'Unable to record Lobby Discord synchronization failure',
      );
    return false;
  }
}

export function startLobbyDiscordWorker(
  discord: Client,
  client: SupabaseClient,
  guildId: string,
  logger: Logger,
) {
  let running = false;
  let rerun = false;
  const drain = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        for (let count = 0; count < 25; count += 1) {
          const { data, error } = await client.rpc('claim_lobby_discord_sync');
          if (error) {
            logger.error(
              { code: error.code },
              'Unable to claim Lobby Discord synchronization',
            );
            break;
          }
          if (!data) break;
          const lobby = lobbyDiscordSyncSchema.parse(data);
          if (!(await reconcileLobbyDiscord(lobby, discord, client, logger)))
            break;
        }
      } while (rerun);
    } finally {
      running = false;
    }
  };
  const wake = () => void drain();
  const realtime = client
    .channel('lobby-discord-revisions')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lobbies' },
      wake,
    )
    .subscribe();
  void syncGuildChannels(discord, client, guildId, logger)
    .then(wake)
    .catch(() => undefined);
  const retryTimer = setInterval(wake, 15_000);
  retryTimer.unref();
  const channelTimer = setInterval(
    () =>
      void syncGuildChannels(discord, client, guildId, logger).catch(
        () => undefined,
      ),
    10 * 60_000,
  );
  channelTimer.unref();
  return () => {
    clearInterval(retryTimer);
    clearInterval(channelTimer);
    void client.removeChannel(realtime);
  };
}

export function parseLobbyDiscordSync(value: unknown): LobbyDiscordSync {
  return lobbyDiscordSyncSchema.parse(value);
}

export type LobbyDiscordPlayer = Pick<
  LobbyPlayer,
  | 'id'
  | 'discord_user_id'
  | 'display_name'
  | 'team'
  | 'stake_centavos'
  | 'added_at'
>;
export type LobbyRecord = Lobby;
