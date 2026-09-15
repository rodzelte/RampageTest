import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { commandPayloads } from '../src/bot/commands/registry';
import {
  formatManilaTimestamp,
  handleBalanceCommand,
  handleJoinCommand,
  handleLeaveCommand,
  handleRosterAutocomplete,
  handleTransactionsCommand,
  renderTransactionPage,
  routeTransactionPagination,
} from '../src/bot/commands/memberWallet';

const lobbyId = '90000000-0000-4000-8000-000000000001';
const memberId = '70000000-0000-4000-8000-000000000001';
const userId = '888888888888888888';
const interactionId = '777777777777777777';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function slash(
  name: 'join' | 'leave' | 'balance' | 'transactions',
  values: Record<string, string> = {},
) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    value: {
      id: interactionId,
      commandName: name,
      user: { id: userId },
      options: {
        getString: (key: string) => values[key],
      },
      deferReply,
      editReply,
      reply,
    } as unknown as ChatInputCommandInteraction,
    deferReply,
    editReply,
    reply,
  };
}

function player(
  id: string,
  discordUserId: string,
  name: string,
  team: 'RADIANT' | 'DIRE',
) {
  return {
    id,
    discord_user_id: discordUserId,
    display_name: name,
    team,
    status: 'ACTIVE' as const,
    added_at: '2026-09-15T00:00:00Z',
  };
}

function rosterResult(team: 'RADIANT' | 'DIRE' = 'RADIANT') {
  return {
    duplicate: false,
    lobby_name: 'Lobby 1',
    entry_centavos: 20_000,
    team,
    active_players: [
      player('71000000-0000-4000-8000-000000000001', userId, 'Yuji', 'RADIANT'),
      player(
        '71000000-0000-4000-8000-000000000002',
        '899999999999999999',
        'kurimaw',
        'DIRE',
      ),
    ],
  };
}

function rpcClient(
  data: unknown,
  error: { code?: string; message: string; details?: string } | null = null,
) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

function lobbyRows() {
  return [
    {
      id: lobbyId,
      display_name: 'Lobby 1',
      status: 'OPEN',
      side_betting_enabled: true,
      roster_entry_centavos: 20_000,
      lobby_players: rosterResult().active_players,
    },
    {
      id: '90000000-0000-4000-8000-000000000002',
      display_name: 'Practice',
      status: 'OPEN',
      side_betting_enabled: false,
      roster_entry_centavos: 10_000,
      lobby_players: [],
    },
    {
      id: '90000000-0000-4000-8000-000000000003',
      display_name: 'Paused',
      status: 'POSTPONED',
      side_betting_enabled: true,
      roster_entry_centavos: 10_000,
      lobby_players: [],
    },
    {
      id: '90000000-0000-4000-8000-000000000004',
      display_name: 'Cancelled',
      status: 'CANCELLED',
      side_betting_enabled: true,
      roster_entry_centavos: 10_000,
      lobby_players: [],
    },
    {
      id: '90000000-0000-4000-8000-000000000005',
      display_name: 'Archived',
      status: 'ARCHIVED',
      side_betting_enabled: true,
      roster_entry_centavos: 10_000,
      lobby_players: [],
    },
  ];
}

function autocompleteClient(rows = lobbyRows()) {
  let result = [...rows];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      result = result.filter(
        (row) => row[column as keyof (typeof rows)[number]] === value,
      );
      return query;
    }),
    order: vi.fn(() => query),
    then: (resolve: (value: { data: typeof rows; error: null }) => unknown) =>
      Promise.resolve(resolve({ data: result, error: null })),
  };
  return { client: { from: vi.fn(() => query) } as unknown as SupabaseClient };
}

function autocomplete(commandName: 'join' | 'leave', search = '') {
  const respond = vi.fn().mockResolvedValue(undefined);
  return {
    value: {
      commandName,
      user: { id: userId },
      options: {
        getFocused: (withName?: boolean) =>
          withName ? { name: 'lobby', value: search } : search,
      },
      respond,
    } as unknown as AutocompleteInteraction,
    respond,
  };
}

function transaction(
  id: string,
  type: string,
  createdAt: string,
  balances: {
    amount: number;
    availableBefore: number;
    availableAfter: number;
    reservedBefore: number;
    reservedAfter: number;
  },
) {
  return {
    id,
    type,
    amount_centavos: balances.amount,
    available_before: balances.availableBefore,
    available_after: balances.availableAfter,
    reserved_before: balances.reservedBefore,
    reserved_after: balances.reservedAfter,
    source_type: type.startsWith('LOBBY_ROSTER')
      ? 'LOBBY_ROSTER'
      : type.startsWith('LOBBY_SIDE_BET')
        ? 'LOBBY_SIDE_BET'
        : 'TOPUP',
    source_id: crypto.randomUUID(),
    metadata: {},
    created_at: createdAt,
    lobby_name: type === 'TOPUP' ? null : 'Lobby 1',
    bet_number: type.startsWith('LOBBY_SIDE_BET') ? 3510 : null,
    side: type.startsWith('LOBBY_SIDE_BET') ? ('RADIANT' as const) : null,
  };
}

describe('final Phase 5 Discord member commands', () => {
  it('registers exactly the canonical eight commands without arbitrary wallet-user options', () => {
    expect(commandPayloads.map((command) => command.name)).toEqual([
      'lobbies',
      'join',
      'leave',
      'bet',
      'cancelbet',
      'topup',
      'balance',
      'transactions',
    ]);
    for (const name of ['balance', 'transactions']) {
      const command = commandPayloads.find((entry) => entry.name === name);
      expect(command?.options ?? []).toHaveLength(0);
    }
    expect(commandPayloads.map((command) => command.name)).not.toEqual(
      expect.arrayContaining(['addplayer', 'deposit', 'editbet']),
    );
  });

  it('/join autocomplete includes every OPEN lobby, including betting-disabled and empty-roster lobbies', async () => {
    const interaction = autocomplete('join');
    await handleRosterAutocomplete(
      interaction.value,
      autocompleteClient().client,
      logger(),
    );
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Lobby 1 • Yuji vs kurimaw', value: lobbyId },
      {
        name: 'Practice • TBD vs TBD',
        value: '90000000-0000-4000-8000-000000000002',
      },
    ]);
  });

  it('/join autocomplete filters friendly names case-insensitively and returns at most 25 UUID values', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `9${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
      display_name: index === 29 ? 'Special Lobby' : `Lobby ${index + 1}`,
      status: 'OPEN',
      side_betting_enabled: index % 2 === 0,
      roster_entry_centavos: 10_000,
      lobby_players: [],
    }));
    const typed = autocomplete('join', 'sPeCiAl');
    await handleRosterAutocomplete(
      typed.value,
      autocompleteClient(rows).client,
      logger(),
    );
    expect(typed.respond).toHaveBeenCalledWith([
      { name: 'Special Lobby • TBD vs TBD', value: rows[29]!.id },
    ]);
    const blank = autocomplete('join');
    await handleRosterAutocomplete(
      blank.value,
      autocompleteClient(rows).client,
      logger(),
    );
    expect(blank.respond.mock.calls[0]?.[0]).toHaveLength(25);
    expect(
      blank.respond.mock.calls[0]?.[0].every((option: { value: string }) =>
        /^[0-9a-f-]{36}$/i.test(option.value),
      ),
    ).toBe(true);
  });

  it('/leave autocomplete prefers only OPEN lobbies containing the invoking member', async () => {
    const interaction = autocomplete('leave');
    await handleRosterAutocomplete(
      interaction.value,
      autocompleteClient().client,
      logger(),
    );
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Lobby 1 • Yuji vs kurimaw', value: lobbyId },
    ]);
  });

  it('/join confirms exact centavos privately and keeps roster and side-bet positions distinct', async () => {
    const interaction = slash('join', {
      lobby: lobbyId,
      team: 'RADIANT',
      amount: '200.00',
    });
    const service = rpcClient(rosterResult());
    await handleJoinCommand(interaction.value, service.client, logger());
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(service.rpc).toHaveBeenCalledWith('join_lobby_self_with_amount', {
      p_lobby_id: lobbyId,
      p_discord_user_id: userId,
      p_team: 'RADIANT',
      p_entry_centavos: 20_000,
      p_discord_interaction_id: interactionId,
      p_discord_message_id: null,
    });
    const response = String(interaction.editReply.mock.calls[0]?.[0]);
    expect(response).toContain('YOU JOINED RADIANT');
    expect(response).toContain('🟢 Yuji vs 🔴 kurimaw');
    expect(response).toContain('₱200.00 roster stake has been reserved');
    expect(response).not.toMatch(/available.*₱|reserved balance/i);
  });

  it.each(['100', '300'])(
    '/join rejects a %s PHP mismatch with the fixed entry privately',
    async (amount) => {
      const interaction = slash('join', {
        lobby: lobbyId,
        team: 'RADIANT',
        amount,
      });
      const service = rpcClient(null, {
        code: '22023',
        message: 'Incorrect entry amount',
        details: 'Lobby 1|20000',
      });
      await handleJoinCommand(interaction.value, service.client, logger());
      expect(String(interaction.editReply.mock.calls[0]?.[0])).toContain(
        'INCORRECT ENTRY AMOUNT',
      );
      expect(String(interaction.editReply.mock.calls[0]?.[0])).toContain(
        'Lobby 1 requires an entry of ₱200.00',
      );
    },
  );

  it('shows private insufficient, duplicate, and full-team join errors', async () => {
    const errors = [
      {
        error: { code: '22003', message: 'Insufficient available balance' },
        expected: 'INSUFFICIENT BALANCE',
      },
      {
        error: { code: '23505', message: 'Already in lobby: DIRE' },
        expected: 'already playing for DIRE',
      },
      {
        error: { code: '23514', message: 'RADIANT is full' },
        expected: 'RADIANT IS FULL',
      },
    ];
    for (const example of errors) {
      const interaction = slash('join', {
        lobby: lobbyId,
        team: 'RADIANT',
        amount: '200',
      });
      await handleJoinCommand(
        interaction.value,
        rpcClient(null, example.error).client,
        logger(),
      );
      expect(String(interaction.editReply.mock.calls[0]?.[0])).toContain(
        example.expected,
      );
      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  it('/leave uses only interaction identity and releases only the roster stake privately', async () => {
    const interaction = slash('leave', { lobby: lobbyId });
    const service = rpcClient(rosterResult());
    await handleLeaveCommand(interaction.value, service.client, logger());
    expect(service.rpc).toHaveBeenCalledWith(
      'leave_lobby_self_with_interaction',
      {
        p_lobby_id: lobbyId,
        p_discord_user_id: userId,
        p_discord_interaction_id: interactionId,
        p_discord_message_id: null,
      },
    );
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(String(interaction.editReply.mock.calls[0]?.[0])).toContain(
      'Released:\n₱200.00',
    );
  });

  it('/balance displays only the invoking member available, reserved, and total amounts', async () => {
    const interaction = slash('balance');
    const service = rpcClient({
      user_id: memberId,
      available_centavos: 50_000,
      reserved_centavos: 50_000,
      total_centavos: 100_000,
      updated_at: '2026-09-15T09:30:00Z',
    });
    await handleBalanceCommand(interaction.value, service.client, logger());
    expect(service.rpc).toHaveBeenCalledWith('get_discord_wallet', {
      p_discord_user_id: userId,
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    const response = String(interaction.editReply.mock.calls[0]?.[0]);
    expect(response).toContain('Available:\n₱500.00');
    expect(response).toContain('Reserved:\n₱500.00');
    expect(response).toContain('Total:\n₱1,000.00');
  });

  it('/balance handles inactive or unknown members without exposing wallet data', async () => {
    const interaction = slash('balance');
    await handleBalanceCommand(
      interaction.value,
      rpcClient(null, {
        code: '42501',
        message: 'Active Rampage member required',
      }).client,
      logger(),
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0])).toContain(
      'active Rampage member account',
    );
  });

  it('renders transaction types accurately with newest-first RPC order and Manila timestamps', () => {
    const page = renderTransactionPage(
      {
        user_id: memberId,
        total: 5,
        transactions: [
          transaction(
            '72000000-0000-4000-8000-000000000001',
            'LOBBY_SIDE_BET_RELEASE',
            '2026-09-15T09:34:00Z',
            {
              amount: 0,
              availableBefore: 70_000,
              availableAfter: 100_000,
              reservedBefore: 30_000,
              reservedAfter: 0,
            },
          ),
          transaction(
            '72000000-0000-4000-8000-000000000002',
            'LOBBY_SIDE_BET_RESERVE',
            '2026-09-15T09:33:00Z',
            {
              amount: 0,
              availableBefore: 100_000,
              availableAfter: 70_000,
              reservedBefore: 0,
              reservedAfter: 30_000,
            },
          ),
          transaction(
            '72000000-0000-4000-8000-000000000003',
            'LOBBY_ROSTER_RELEASE',
            '2026-09-15T09:32:00Z',
            {
              amount: 0,
              availableBefore: 80_000,
              availableAfter: 100_000,
              reservedBefore: 20_000,
              reservedAfter: 0,
            },
          ),
          transaction(
            '72000000-0000-4000-8000-000000000004',
            'LOBBY_ROSTER_RESERVE',
            '2026-09-15T09:31:00Z',
            {
              amount: 0,
              availableBefore: 100_000,
              availableAfter: 80_000,
              reservedBefore: 0,
              reservedAfter: 20_000,
            },
          ),
          transaction(
            '72000000-0000-4000-8000-000000000005',
            'TOPUP',
            '2026-09-15T09:30:00Z',
            {
              amount: 100_000,
              availableBefore: 0,
              availableAfter: 100_000,
              reservedBefore: 0,
              reservedAfter: 0,
            },
          ),
        ],
      },
      0,
    );
    expect(page.content.indexOf('SIDE BET RELEASE')).toBeLessThan(
      page.content.indexOf('TOPUP'),
    );
    expect(page.content).toContain('Reserved ₱200.00');
    expect(page.content).toContain('LOBBY ROSTER RELEASE');
    expect(page.content).toContain('Reserved ₱300.00');
    expect(page.content).toContain('SIDE BET RELEASE');
    expect(page.content).toContain('+ ₱1,000.00');
    expect(page.content).toContain('Sep 15, 2026 5:30 PM');
    expect(formatManilaTimestamp('2026-09-15T09:30:00Z')).toBe(
      'Sep 15, 2026 5:30 PM',
    );
  });

  it('/transactions is ephemeral, scoped to interaction.user.id, and paginates privately', async () => {
    const firstPage = {
      user_id: memberId,
      total: 12,
      transactions: [
        transaction(
          '73000000-0000-4000-8000-000000000001',
          'TOPUP',
          '2026-09-15T09:30:00Z',
          {
            amount: 10_000,
            availableBefore: 0,
            availableAfter: 10_000,
            reservedBefore: 0,
            reservedAfter: 0,
          },
        ),
      ],
    };
    const command = slash('transactions');
    const service = rpcClient(firstPage);
    await handleTransactionsCommand(command.value, service.client, logger());
    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(service.rpc).toHaveBeenCalledWith('get_discord_transactions', {
      p_discord_user_id: userId,
      p_limit: 11,
      p_offset: 0,
    });
    const response = command.editReply.mock.calls[0]?.[0];
    expect(JSON.stringify(response)).toContain('transactions:page:1');

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const pageButton = {
      customId: 'transactions:page:1',
      user: { id: userId },
      deferUpdate,
      editReply,
      isButton: () => true,
    } as unknown as ButtonInteraction;
    await routeTransactionPagination(pageButton, service.client, logger());
    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(service.rpc).toHaveBeenLastCalledWith('get_discord_transactions', {
      p_discord_user_id: userId,
      p_limit: 11,
      p_offset: 10,
    });
  });
});
