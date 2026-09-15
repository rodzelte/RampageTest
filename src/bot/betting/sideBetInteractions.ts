import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { sideBetSchema } from '../../shared/models';
import { matchupLabel } from '../../shared/lobby-matchup';
import { formatPhp, parsePhpToCentavos } from '../../shared/money';

const uuid =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const betButtonPattern = new RegExp(
  `^lobby:bet-(radiant|dire):(${uuid})$`,
  'i',
);
const betModalPattern = new RegExp(
  `^lobby:bet-submit:(radiant|dire):(${uuid})$`,
  'i',
);

const placementResultSchema = z.object({
  duplicate: z.boolean(),
  lobby_name: z.string(),
  platform_fee_bps: z.number().int(),
  bet: sideBetSchema,
  winning_profit_centavos: z.number().int().nonnegative(),
  gross_return_centavos: z.number().int().nonnegative(),
  platform_fee_centavos: z.number().int().nonnegative(),
  net_return_centavos: z.number().int().nonnegative(),
});
const cancellationResultSchema = z.object({
  duplicate: z.boolean(),
  lobby_name: z.string(),
  bet: sideBetSchema,
});

function normalizeError(error: unknown) {
  return error && typeof error === 'object' && 'message' in error
    ? (error as { code?: string; message: string })
    : { message: 'Unknown side-bet failure' };
}

function bettingFailure(error: { code?: string; message: string }) {
  if (error.code === '22003')
    return '❌ **INSUFFICIENT BALANCE**\n\nYour available Rampage wallet balance is below the requested stake. Use /topup before trying again.';
  if (
    /SIDE BETTING DISABLED|Betting requires an OPEN lobby/i.test(error.message)
  )
    return '❌ **LOBBY NOT AVAILABLE**\n\nThis lobby is no longer open for betting.';
  if (/below.*minimum/i.test(error.message))
    return '❌ The amount is below this lobby’s minimum stake.';
  if (/exceeds.*maximum/i.test(error.message))
    return '❌ The amount exceeds this lobby’s maximum stake.';
  if (/OPEN lobby|Betting requires|cancellation requires/i.test(error.message))
    return '❌ Betting changes are available only while the lobby is OPEN.';
  if (/only your own/i.test(error.message))
    return '❌ You can cancel only your own side bet.';
  if (/not found/i.test(error.message))
    return '❌ Side bet or lobby not found.';
  if (error.code === '42501')
    return '❌ An active Rampage member account linked to your Discord ID is required.';
  return '❌ Unable to process this side bet. Please try again.';
}

function placementConfirmation(result: z.infer<typeof placementResultSchema>) {
  const side = result.bet.side === 'RADIANT' ? '🟢 RADIANT' : '🔴 DIRE';
  const prefix = result.duplicate
    ? '✅ **BET ALREADY PLACED**'
    : '✅ **BET PLACED**';
  return `${prefix}\n\nLobby:\n${result.lobby_name}\n\nBet:\n#${result.bet.bet_number}\n\nSide:\n${side}\n\nStake:\n${formatPhp(result.bet.requested_amount_centavos)}\n\nPotential Gross Return:\n${formatPhp(result.gross_return_centavos)}\n\nEstimated Platform Fee:\n${formatPhp(result.platform_fee_centavos)}\n\nEstimated Net Return:\n${formatPhp(result.net_return_centavos)}\n\nYour ${formatPhp(result.bet.requested_amount_centavos)} stake has been reserved.\n\nFinal accepted stake may be reduced by LIFO when the lobby is locked.`;
}

async function placeBet(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  client: SupabaseClient,
  logger: Logger,
  lobbyId: string,
  side: 'RADIANT' | 'DIRE',
  amount: string,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const amountCentavos = parsePhpToCentavos(amount);
    if (amountCentavos <= 0) throw new Error('Bet amount must be positive.');
    const { data, error } = await client.rpc('place_side_bet_self', {
      p_lobby_id: lobbyId,
      p_discord_user_id: interaction.user.id,
      p_side: side,
      p_amount_centavos: amountCentavos,
      p_discord_interaction_id: interaction.id,
    });
    if (error) throw error;
    await interaction.editReply(
      placementConfirmation(placementResultSchema.parse(data)),
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn({ command: 'bet', code: normalized.code }, 'Side bet rejected');
    const message =
      /at most two decimal|supported range|must be positive/i.test(
        normalized.message,
      )
        ? `❌ ${normalized.message}`
        : bettingFailure(normalized);
    await interaction.editReply(message);
  }
}

export async function handleBetCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  const lobbyId = interaction.options.getString('lobby', true);
  const side = interaction.options.getString('side', true).toUpperCase();
  const amount = interaction.options.getString('amount', true);
  if (
    !z.uuid().safeParse(lobbyId).success ||
    (side !== 'RADIANT' && side !== 'DIRE')
  ) {
    await interaction.reply({
      content: '❌ Select a valid OPEN lobby and side.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await placeBet(interaction, client, logger, lobbyId, side, amount);
}

export async function handleCancelBetCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const betNumber = interaction.options.getInteger('bet', true);
  try {
    const { data, error } = await client.rpc('cancel_side_bet_self', {
      p_bet_number: betNumber,
      p_discord_user_id: interaction.user.id,
      p_discord_interaction_id: interaction.id,
    });
    if (error) throw error;
    const result = cancellationResultSchema.parse(data);
    const heading = result.duplicate
      ? '✅ **BET ALREADY CANCELLED**'
      : '✅ **BET CANCELLED**';
    await interaction.editReply(
      `${heading}\n\nLobby: ${result.lobby_name}\nBet: #${result.bet.bet_number}\nSide: ${result.bet.side}\nReleased: ${formatPhp(result.bet.accepted_amount_centavos)}\n\nThe reserved stake is available in your Rampage wallet again.`,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      { command: 'cancelbet', code: normalized.code },
      'Side-bet cancellation rejected',
    );
    await interaction.editReply(bettingFailure(normalized));
  }
}

async function showBetModal(
  interaction: ButtonInteraction,
  client: SupabaseClient,
  match: RegExpExecArray,
) {
  const side = match[1]!.toUpperCase() as 'RADIANT' | 'DIRE';
  const lobbyId = match[2]!;
  const { data } = await client
    .from('lobbies')
    .select(
      'display_name,status,side_betting_enabled,side_bet_min_centavos,side_bet_max_centavos',
    )
    .eq('id', lobbyId)
    .single();
  if (!data || data.status !== 'OPEN' || !data.side_betting_enabled) {
    await interaction.reply({
      content: '❌ Betting is currently unavailable for this lobby.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const amount = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('PHP amount')
    .setPlaceholder(
      `${formatPhp(data.side_bet_min_centavos)} – ${formatPhp(data.side_bet_max_centavos)}`,
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const modal = new ModalBuilder()
    .setCustomId(`lobby:bet-submit:${side.toLowerCase()}:${lobbyId}`)
    .setTitle(`BET ${side} — ${String(data.display_name).slice(0, 25)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
    );
  await interaction.showModal(modal);
}

export async function handleBetAutocomplete(
  interaction: AutocompleteInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  if (
    interaction.commandName !== 'bet' ||
    interaction.options.getFocused(true).name !== 'lobby'
  )
    return false;
  const focused = String(interaction.options.getFocused()).trim();
  const { data, error } = await client
    .from('lobbies')
    .select(
      'id,display_name,status,side_betting_enabled,lobby_players(id,discord_user_id,display_name,team,status,added_at)',
    )
    .eq('status', 'OPEN')
    .order('display_name')
    .order('id');
  if (error) {
    logger.warn(
      { event: 'BET_AUTOCOMPLETE', code: error.code },
      'Bet autocomplete query failed',
    );
    await interaction.respond([]);
    return true;
  }
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        display_name: z.string(),
        status: z.literal('OPEN'),
        side_betting_enabled: z.boolean(),
        lobby_players: z.array(
          z.object({
            id: z.uuid(),
            discord_user_id: z.string(),
            display_name: z.string(),
            team: z.enum(['RADIANT', 'DIRE']),
            status: z.enum(['ACTIVE', 'REMOVED']),
            added_at: z.string(),
          }),
        ),
      }),
    )
    .parse(data);
  const search = focused.toLocaleLowerCase('en');
  const bettingEnabled = rows.filter((lobby) => lobby.side_betting_enabled);
  const eligible = bettingEnabled
    .filter((lobby) =>
      search
        ? `${lobby.display_name} ${matchupLabel(lobby.lobby_players)}`
            .toLocaleLowerCase('en')
            .includes(search)
        : true,
    )
    .slice(0, 25);
  logger.info(
    {
      event: 'BET_AUTOCOMPLETE',
      open_lobbies: rows.length,
      eligible_lobbies: bettingEnabled.length,
      results: eligible.map((lobby) => ({
        id: lobby.id,
        name: lobby.display_name,
        status: lobby.status,
      })),
    },
    'Bet autocomplete',
  );
  await interaction.respond(
    eligible.map((lobby) => ({
      name: `${lobby.display_name} • ${matchupLabel(lobby.lobby_players)}`.slice(
        0,
        100,
      ),
      value: lobby.id,
    })),
  );
  return true;
}

export async function routeSideBetInteraction(
  interaction: Interaction,
  client: SupabaseClient,
  logger: Logger,
) {
  if (interaction.isButton()) {
    const match = betButtonPattern.exec(interaction.customId);
    if (!match) return false;
    await showBetModal(interaction, client, match);
    return true;
  }
  if (interaction.isModalSubmit()) {
    const match = betModalPattern.exec(interaction.customId);
    if (!match) return false;
    await placeBet(
      interaction,
      client,
      logger,
      match[2]!,
      match[1]!.toUpperCase() as 'RADIANT' | 'DIRE',
      interaction.fields.getTextInputValue('amount'),
    );
    return true;
  }
  return false;
}
