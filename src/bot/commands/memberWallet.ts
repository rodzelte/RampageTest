import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { centavosSchema, discordIdSchema } from '../../shared/models';
import { matchupLabel } from '../../shared/lobby-matchup';
import {
  formatPhp,
  formatPhpBigint,
  parsePhpToCentavos,
} from '../../shared/money';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const transactionPagePattern = /^transactions:page:(\d+)$/;
const TRANSACTION_PAGE_SIZE = 10;

const choicePlayerSchema = z.object({
  id: z.uuid(),
  discord_user_id: discordIdSchema,
  display_name: z.string(),
  team: z.enum(['RADIANT', 'DIRE']),
  status: z.enum(['ACTIVE', 'REMOVED']),
  added_at: z.string(),
});
const lobbyChoiceSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  status: z.literal('OPEN'),
  side_betting_enabled: z.boolean(),
  roster_entry_centavos: centavosSchema.positive(),
  lobby_players: z.array(choicePlayerSchema),
});
const rosterResultSchema = z.object({
  duplicate: z.boolean(),
  lobby_name: z.string(),
  entry_centavos: centavosSchema.positive(),
  team: z.enum(['RADIANT', 'DIRE']),
  active_players: z.array(choicePlayerSchema),
});
const walletResultSchema = z.object({
  user_id: z.uuid(),
  available_centavos: centavosSchema,
  reserved_centavos: centavosSchema,
  updated_at: z.string(),
});
const signedCentavosSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const transactionSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  amount_centavos: signedCentavosSchema,
  available_before: centavosSchema,
  available_after: centavosSchema,
  reserved_before: centavosSchema,
  reserved_after: centavosSchema,
  source_type: z.string(),
  source_id: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  lobby_name: z.string().nullable(),
  bet_number: z.number().int().positive().nullable(),
  side: z.enum(['RADIANT', 'DIRE']).nullable(),
});
const transactionResultSchema = z.object({
  user_id: z.uuid(),
  total: z.number().int().nonnegative(),
  transactions: z.array(transactionSchema),
});
type TransactionResult = z.infer<typeof transactionResultSchema>;
type WalletTransaction = z.infer<typeof transactionSchema>;

function normalizeError(error: unknown) {
  return error && typeof error === 'object' && 'message' in error
    ? (error as { code?: string; message: string; details?: string })
    : { message: 'Unknown member command failure' };
}

function safeText(value: string) {
  return value.replace(/@/g, '@\u200b').replace(/([\\`*_~|>])/g, '\\$1');
}

async function loadOpenLobbyChoices(client: SupabaseClient) {
  const { data, error } = await client
    .from('lobbies')
    .select(
      'id,display_name,status,side_betting_enabled,roster_entry_centavos,lobby_players(id,discord_user_id,display_name,team,status,added_at)',
    )
    .eq('status', 'OPEN')
    .order('display_name')
    .order('id');
  if (error) throw error;
  return z.array(lobbyChoiceSchema).parse(data);
}

export async function handleRosterAutocomplete(
  interaction: AutocompleteInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  if (
    !['join', 'leave'].includes(interaction.commandName) ||
    interaction.options.getFocused(true).name !== 'lobby'
  )
    return false;
  try {
    const search = String(interaction.options.getFocused())
      .trim()
      .toLocaleLowerCase('en');
    const open = await loadOpenLobbyChoices(client);
    const available =
      interaction.commandName === 'leave'
        ? open.filter((lobby) =>
            lobby.lobby_players.some(
              (player) =>
                player.status === 'ACTIVE' &&
                player.discord_user_id === interaction.user.id,
            ),
          )
        : open;
    const results = available
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
        event: 'ROSTER_AUTOCOMPLETE',
        command: interaction.commandName,
        open_lobbies: open.length,
        eligible_lobbies: available.length,
        results: results.map((lobby) => ({
          id: lobby.id,
          name: lobby.display_name,
          status: lobby.status,
        })),
      },
      'Roster autocomplete',
    );
    await interaction.respond(
      results.map((lobby) => ({
        name: `${lobby.display_name} • ${matchupLabel(lobby.lobby_players)}`.slice(
          0,
          100,
        ),
        value: lobby.id,
      })),
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      {
        event: 'ROSTER_AUTOCOMPLETE',
        command: interaction.commandName,
        code: normalized.code,
      },
      'Roster autocomplete query failed',
    );
    await interaction.respond([]);
  }
  return true;
}

function entryFromError(error: ReturnType<typeof normalizeError>) {
  if (!error.details) return null;
  const separator = error.details.lastIndexOf('|');
  if (separator < 0) return null;
  const amount = Number(error.details.slice(separator + 1));
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return { name: error.details.slice(0, separator), amount };
}

function joinFailure(
  error: ReturnType<typeof normalizeError>,
  fallbackLobbyName: string,
  suppliedAmount: number,
  team: string,
) {
  const entry = entryFromError(error);
  if (/Incorrect entry amount/i.test(error.message)) {
    const lobbyName = entry?.name || fallbackLobbyName;
    const required = entry?.amount ?? suppliedAmount;
    return `❌ **INCORRECT ENTRY AMOUNT**\n\n${safeText(lobbyName)} requires an entry of ${formatPhp(required)}.\n\nUse:\n/join lobby:"${safeText(lobbyName)}" team:${team} amount:${formatPhp(required).replace(/[₱,]/g, '')}`;
  }
  if (error.code === '22003' && /Insufficient/i.test(error.message))
    return `❌ **INSUFFICIENT BALANCE**\n\nLobby Entry:\n${entry ? formatPhp(entry.amount) : formatPhp(suppliedAmount)}\n\nYour available wallet balance is not enough to join.\n\nUse /topup to add funds.`;
  const existing = /Already in lobby: (RADIANT|DIRE)/i.exec(error.message);
  if (existing)
    return `❌ **ALREADY IN LOBBY**\n\nYou are already playing for ${existing[1]!.toUpperCase()}.\n\nUse /leave first if you want to leave the lobby.`;
  const full = /(RADIANT|DIRE) is full/i.exec(error.message);
  if (full) {
    const team = full[1]!.toUpperCase();
    const other = team === 'RADIANT' ? 'Dire' : 'Radiant';
    return `❌ **${team} IS FULL**\n\n${team[0]}${team.slice(1).toLowerCase()} already has 5/5 players.\n\nChoose ${other} if a slot is available.`;
  }
  if (error.code === '42501')
    return '❌ An active Rampage member account linked to your Discord ID is required.';
  if (/OPEN lobby|Joining requires/i.test(error.message))
    return '❌ **LOBBY NOT AVAILABLE**\n\nThis lobby is no longer open for participation.';
  return '❌ Unable to join this lobby. Please try again.';
}

export async function handleJoinCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lobbyId = interaction.options.getString('lobby', true);
  const team = interaction.options.getString('team', true).toUpperCase();
  const amountText = interaction.options.getString('amount', true);
  let amountCentavos = 0;
  try {
    if (!uuidPattern.test(lobbyId) || !['RADIANT', 'DIRE'].includes(team))
      throw new Error('Invalid lobby or team');
    amountCentavos = parsePhpToCentavos(amountText);
    if (amountCentavos <= 0) throw new Error('Amount must be positive');
    const { data, error } = await client.rpc('join_lobby_self_with_amount', {
      p_lobby_id: lobbyId,
      p_discord_user_id: interaction.user.id,
      p_team: team,
      p_entry_centavos: amountCentavos,
      p_discord_interaction_id: interaction.id,
      p_discord_message_id: null,
    });
    if (error) throw error;
    const result = rosterResultSchema.parse(data);
    await interaction.editReply(
      `✅ **YOU JOINED ${result.team}**\n\nLobby:\n${safeText(result.lobby_name)}\n\nMatch:\n🟢 ${safeText(matchupLabel(result.active_players).replace(' vs ', ' vs 🔴 '))}\n\nEntry:\n${formatPhp(result.entry_centavos)}\n\nYour ${formatPhp(result.entry_centavos)} roster stake has been reserved.\n\nYou are now playing for ${result.team[0]}${result.team.slice(1).toLowerCase()}.`,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      { command: 'join', lobbyId, code: normalized.code },
      'Lobby join rejected',
    );
    const localValidation =
      /at most two decimal|supported range|positive|Invalid lobby or team/i.test(
        normalized.message,
      );
    await interaction.editReply(
      localValidation
        ? `❌ ${normalized.message}`
        : joinFailure(normalized, 'This lobby', amountCentavos, team),
    );
  }
}

function leaveFailure(error: ReturnType<typeof normalizeError>) {
  if (error.code === '42501')
    return '❌ An active Rampage member account linked to your Discord ID is required.';
  if (/not active in this lobby|not found/i.test(error.message))
    return '❌ You are not currently playing in this lobby.';
  if (/OPEN lobby|Leaving requires/i.test(error.message))
    return '❌ **LOBBY NOT AVAILABLE**\n\nYou can leave only while the lobby is OPEN.';
  return '❌ Unable to leave this lobby. Please try again.';
}

export async function handleLeaveCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lobbyId = interaction.options.getString('lobby', true);
  if (!uuidPattern.test(lobbyId)) {
    await interaction.editReply('❌ Select a valid OPEN lobby.');
    return;
  }
  try {
    const { data, error } = await client.rpc(
      'leave_lobby_self_with_interaction',
      {
        p_lobby_id: lobbyId,
        p_discord_user_id: interaction.user.id,
        p_discord_interaction_id: interaction.id,
        p_discord_message_id: null,
      },
    );
    if (error) throw error;
    const result = rosterResultSchema.parse(data);
    await interaction.editReply(
      `✅ **YOU LEFT THE LOBBY**\n\nLobby:\n${safeText(result.lobby_name)}\n\nReleased:\n${formatPhp(result.entry_centavos)}\n\nYour roster stake has been returned to your available wallet.`,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      { command: 'leave', lobbyId, code: normalized.code },
      'Lobby leave rejected',
    );
    await interaction.editReply(leaveFailure(normalized));
  }
}

export async function handleBalanceCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { data, error } = await client.rpc('get_discord_wallet', {
      p_discord_user_id: interaction.user.id,
    });
    if (error) throw error;
    const wallet = walletResultSchema.parse(data);
    await interaction.editReply(
      `💰 **RAMPAGE WALLET**\n\nAvailable:\n${formatPhp(wallet.available_centavos)}\n\nReserved:\n${formatPhp(wallet.reserved_centavos)}\n\nTotal:\n${formatPhpBigint(BigInt(wallet.available_centavos) + BigInt(wallet.reserved_centavos))}\n\nReserved funds may include roster entries and active side bets.`,
    );
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      { command: 'balance', code: normalized.code },
      'Private wallet lookup rejected',
    );
    await interaction.editReply(
      normalized.code === '42501'
        ? '❌ An active Rampage member account linked to your Discord ID is required.'
        : '❌ Unable to load your Rampage wallet. Please try again.',
    );
  }
}

export function formatManilaTimestamp(value: string) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
  return formatted.replace(/, (?=\d{1,2}:)/, ' ');
}

function transactionAmount(transaction: WalletTransaction) {
  if (transaction.type.endsWith('_RESERVE'))
    return transaction.reserved_after - transaction.reserved_before;
  if (transaction.type.endsWith('_RELEASE'))
    return transaction.reserved_before - transaction.reserved_after;
  return Math.abs(transaction.amount_centavos);
}

function transactionPresentation(transaction: WalletTransaction) {
  const amount = formatPhp(transactionAmount(transaction));
  if (transaction.type === 'TOPUP') return [`+ ${amount}`, 'TOPUP'];
  if (transaction.type === 'LOBBY_ROSTER_RESERVE')
    return [`🔒 Reserved ${amount}`, 'LOBBY ROSTER RESERVE'];
  if (transaction.type === 'LOBBY_ROSTER_RELEASE')
    return [`↩ Released ${amount}`, 'LOBBY ROSTER RELEASE'];
  if (transaction.type === 'LOBBY_SIDE_BET_RESERVE')
    return [`🔒 Reserved ${amount}`, 'SIDE BET RESERVE'];
  if (transaction.type === 'LOBBY_SIDE_BET_RELEASE')
    return [`↩ Released ${amount}`, 'SIDE BET RELEASE'];
  const sign = transaction.amount_centavos > 0 ? '+' : '';
  return [
    `${sign}${formatPhp(Math.abs(transaction.amount_centavos))}`,
    transaction.type.replaceAll('_', ' '),
  ];
}

function renderTransaction(transaction: WalletTransaction) {
  const [amount, label] = transactionPresentation(transaction);
  const context = [
    transaction.lobby_name ? safeText(transaction.lobby_name) : null,
    transaction.side,
    transaction.bet_number ? `#${transaction.bet_number}` : null,
  ].filter(Boolean);
  return `**${amount}**\n${label}${context.length ? `\n${context.join(' • ')}` : ''}\n${formatManilaTimestamp(transaction.created_at)}`;
}

export function renderTransactionPage(
  result: TransactionResult,
  requestedPage: number,
) {
  const pages = Math.max(1, Math.ceil(result.total / TRANSACTION_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const entries = result.transactions.slice(0, TRANSACTION_PAGE_SIZE);
  const content = entries.length
    ? `📄 **RECENT TRANSACTIONS**\nPage ${page + 1} of ${pages}\n\n${entries.map(renderTransaction).join('\n\n')}`
    : '📄 **RECENT TRANSACTIONS**\n\nNo wallet transactions yet.';
  const components =
    result.total > TRANSACTION_PAGE_SIZE
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`transactions:page:${Math.max(0, page - 1)}`)
              .setLabel('Previous')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId(`transactions:page:${Math.min(pages - 1, page + 1)}`)
              .setLabel('Next')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === pages - 1),
          ),
        ]
      : [];
  return { content, components };
}

async function loadTransactionPage(
  client: SupabaseClient,
  discordUserId: string,
  page: number,
) {
  const { data, error } = await client.rpc('get_discord_transactions', {
    p_discord_user_id: discordUserId,
    p_limit: TRANSACTION_PAGE_SIZE + 1,
    p_offset: page * TRANSACTION_PAGE_SIZE,
  });
  if (error) throw error;
  return transactionResultSchema.parse(data);
}

async function showTransactions(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  client: SupabaseClient,
  logger: Logger,
  page: number,
) {
  try {
    const result = await loadTransactionPage(client, interaction.user.id, page);
    await interaction.editReply(renderTransactionPage(result, page));
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn(
      { command: 'transactions', code: normalized.code },
      'Private transaction lookup rejected',
    );
    await interaction.editReply({
      content:
        normalized.code === '42501'
          ? '❌ An active Rampage member account linked to your Discord ID is required.'
          : '❌ Unable to load your wallet history. Please try again.',
      components: [],
    });
  }
}

export async function handleTransactionsCommand(
  interaction: ChatInputCommandInteraction,
  client: SupabaseClient,
  logger: Logger,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await showTransactions(interaction, client, logger, 0);
}

export async function routeTransactionPagination(
  interaction: Interaction,
  client: SupabaseClient,
  logger: Logger,
) {
  if (!interaction.isButton()) return false;
  const match = transactionPagePattern.exec(interaction.customId);
  if (!match) return false;
  await interaction.deferUpdate();
  await showTransactions(interaction, client, logger, Number(match[1]));
  return true;
}

export const transactionPageSize = TRANSACTION_PAGE_SIZE;
