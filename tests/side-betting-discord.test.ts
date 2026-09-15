import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  handleBetAutocomplete,
  handleBetCommand,
  handleCancelBetCommand,
  routeSideBetInteraction,
} from '../src/bot/betting/sideBetInteractions';
import { commandPayloads } from '../src/bot/commands/registry';
import {
  handleLobbiesCommand,
  renderLobbyDiscoveryPage,
  renderSelectedLobby,
  type AvailableLobby,
} from '../src/bot/commands/lobbies';
import {
  dashboardMatchupLabel,
  matchupLabel,
} from '../src/shared/lobby-matchup';

const lobbyId = '90000000-0000-4000-8000-000000000001';
const userId = '888888888888888888';
const interactionId = '777777777777777777';

function logger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger;
}

function betRow() {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    bet_number: 3505,
    lobby_id: lobbyId,
    user_id: '70000000-0000-4000-8000-000000000002',
    discord_user_id: userId,
    display_name: 'Member One',
    side: 'RADIANT',
    requested_amount_centavos: 10_000,
    accepted_amount_centavos: 10_000,
    status: 'ACTIVE',
    placed_at: '2026-09-15T00:00:00Z',
    cancelled_at: null,
    cancelled_source: null,
    discord_interaction_id: interactionId,
    cancel_interaction_id: null,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
  };
}

function placement() {
  return {
    duplicate: false,
    lobby_name: 'Lobby 1',
    platform_fee_bps: 500,
    bet: betRow(),
    winning_profit_centavos: 10_000,
    gross_return_centavos: 20_000,
    platform_fee_centavos: 500,
    net_return_centavos: 19_500,
  };
}

function command(name: 'bet' | 'cancelbet' | 'lobbies') {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const values: Record<string, string | number> = {
    lobby: lobbyId,
    side: 'RADIANT',
    amount: '100.00',
    bet: 3505,
  };
  return {
    value: {
      id: interactionId,
      commandName: name,
      user: { id: userId },
      options: {
        getString: (key: string) => values[key],
        getInteger: (key: string) => values[key],
      },
      deferReply,
      editReply,
      reply,
      followUp,
    } as unknown as ChatInputCommandInteraction,
    deferReply,
    editReply,
    reply,
    followUp,
  };
}

type DiscoveryLobby = {
  id: string;
  display_name: string;
  status: string;
  discord_channel_id: string;
  roster_entry_centavos: number;
  side_betting_enabled: boolean;
  side_bet_min_centavos: number | null;
  side_bet_max_centavos: number | null;
  platform_fee_bps: number;
  lobby_players: {
    id: string;
    discord_user_id: string;
    display_name: string;
    team: 'RADIANT' | 'DIRE';
    status: 'ACTIVE' | 'REMOVED';
    stake_centavos: number;
    added_at: string;
  }[];
  side_bets: {
    side: 'RADIANT' | 'DIRE';
    status: 'ACTIVE' | 'CANCELLED';
    accepted_amount_centavos: number;
  }[];
};

function lobbyRow(
  name: string,
  status: string,
  betting: boolean,
): DiscoveryLobby {
  return {
    id: `${name === 'ADDD' ? '90000000' : '91000000'}-0000-4000-8000-000000000001`,
    display_name: name,
    status,
    discord_channel_id: '999999999999999999',
    roster_entry_centavos: name === 'ADDD' ? 20_000 : 10_000,
    side_betting_enabled: betting,
    side_bet_min_centavos: betting ? 10_000 : null,
    side_bet_max_centavos: betting ? 500_000 : null,
    platform_fee_bps: 500,
    lobby_players: [
      {
        id: '93000000-0000-4000-8000-000000000001',
        discord_user_id: '666666666666666666',
        display_name: 'Yuji',
        team: 'RADIANT',
        status: 'ACTIVE',
        stake_centavos: 10_000,
        added_at: '2026-09-15T00:00:00Z',
      },
      {
        id: '93000000-0000-4000-8000-000000000002',
        discord_user_id: '666666666666666667',
        display_name: 'Removed',
        team: 'RADIANT',
        status: 'REMOVED',
        stake_centavos: 10_000,
        added_at: '2026-09-14T00:00:00Z',
      },
    ],
    side_bets: [],
  };
}

function replyPayload(editReply: ReturnType<typeof vi.fn>) {
  return editReply.mock.calls[0]?.[0] as
    string | { content?: string; components?: unknown[] };
}

function replyText(editReply: ReturnType<typeof vi.fn>) {
  const payload = replyPayload(editReply);
  return typeof payload === 'string' ? payload : (payload.content ?? '');
}

function discoveryClient(rows: DiscoveryLobby[]) {
  let result = [...rows];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      result = result.filter(
        (row) => row[column as keyof DiscoveryLobby] === value,
      );
      return query;
    }),
    order: vi.fn(() => query),
    then: (resolve: (value: { data: DiscoveryLobby[]; error: null }) => void) =>
      Promise.resolve(resolve({ data: result, error: null })),
  };
  const rpc = vi
    .fn()
    .mockResolvedValue({ data: { role: 'MEMBER' }, error: null });
  return {
    client: { rpc, from: vi.fn(() => query) } as unknown as SupabaseClient,
    query,
    rpc,
  };
}

describe('Phase 5 Discord side betting', () => {
  it('registers only the eight canonical Phase 5 member commands', () => {
    expect(commandPayloads.map((entry) => entry.name)).toEqual([
      'lobbies',
      'join',
      'leave',
      'bet',
      'cancelbet',
      'topup',
      'balance',
      'transactions',
    ]);
    expect(JSON.stringify(commandPayloads)).not.toMatch(
      /addplayer|editbet|closebet/,
    );
  });

  it('lists an OPEN roster lobby when side betting is disabled and remains ephemeral', async () => {
    const slash = command('lobbies');
    const service = discoveryClient([lobbyRow('ADDD', 'OPEN', false)]);
    await handleLobbiesCommand(slash.value, service.client, logger());
    expect(slash.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(service.rpc).toHaveBeenCalledWith('authorize_discord', {
      p_discord_user_id: userId,
      p_required_role: 'MEMBER',
    });
    const response = JSON.stringify(replyPayload(slash.editReply));
    expect(response).toContain('OPEN LOBBIES');
    expect(response).toContain('ADDD');
    expect(response).toContain('R 1/5');
    expect(response).toContain('₱200.00');
    expect(response).toContain('Betting OFF');
  });

  it('lists an OPEN betting lobby with its range and fee', async () => {
    const slash = command('lobbies');
    const service = discoveryClient([lobbyRow('Lobby 2', 'OPEN', true)]);
    await handleLobbiesCommand(slash.value, service.client, logger());
    const response = JSON.stringify(replyPayload(slash.editReply));
    expect(response).toContain('Lobby 2');
    expect(response).toContain('Betting ON');
    expect(response).toContain('Lobby 2 • Yuji vs TBD');
  });

  it.each(['POSTPONED', 'CANCELLED', 'ARCHIVED'])(
    'excludes %s lobbies from discovery',
    async (status) => {
      const slash = command('lobbies');
      const service = discoveryClient([
        lobbyRow('Visible', 'OPEN', false),
        lobbyRow(`Hidden ${status}`, status, true),
      ]);
      await handleLobbiesCommand(slash.value, service.client, logger());
      const response = JSON.stringify(replyPayload(slash.editReply));
      expect(response).toContain('Visible');
      expect(response).not.toContain(`Hidden ${status}`);
      expect(service.query.eq).toHaveBeenCalledWith('status', 'OPEN');
    },
  );

  it('returns the private empty state when no OPEN lobbies exist', async () => {
    const slash = command('lobbies');
    await handleLobbiesCommand(
      slash.value,
      discoveryClient([]).client,
      logger(),
    );
    expect(replyText(slash.editReply)).toContain(
      'No OPEN lobbies are currently available.',
    );
  });

  it('uses a compact select menu and paginates every lobby after option 25 without omissions', () => {
    const lobbies = Array.from({ length: 61 }, (_, index) => ({
      ...lobbyRow(`Lobby ${index + 1}`, 'OPEN', index % 2 === 0),
      id: `9${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })) as AvailableLobby[];
    const first = renderLobbyDiscoveryPage(lobbies, 0);
    const second = renderLobbyDiscoveryPage(lobbies, 1);
    const third = renderLobbyDiscoveryPage(lobbies, 2);
    expect(first.content).toContain('Page 1 of 3\n1–25 of 61');
    expect(second.content).toContain('Page 2 of 3\n26–50 of 61');
    expect(third.content).toContain('Page 3 of 3\n51–61 of 61');
    const options = [first, second, third].map((page) => {
      const menu = page.components[0]!.toJSON().components[0];
      return menu && 'options' in menu ? (menu.options ?? []) : [];
    });
    expect(options.map((pageOptions) => pageOptions.length)).toEqual([
      25, 25, 11,
    ]);
    expect(new Set(options.flat().map((option) => option.value)).size).toBe(61);
    expect(first.components[1]?.toJSON()).toEqual(
      expect.objectContaining({ components: expect.any(Array) }),
    );
  });

  it('renders a compact selected-lobby matchup and combined pool summary', () => {
    const lobby = {
      ...lobbyRow('Lobby 2', 'OPEN', true),
      lobby_players: [
        ...lobbyRow('Lobby 2', 'OPEN', true).lobby_players,
        {
          id: '93000000-0000-4000-8000-000000000003',
          discord_user_id: '666666666666666668',
          display_name: 'kurimaw',
          team: 'DIRE' as const,
          status: 'ACTIVE' as const,
          stake_centavos: 10_000,
          added_at: '2026-09-15T00:01:00Z',
        },
      ],
    } as AvailableLobby;
    const selected = renderSelectedLobby(lobby, [lobby], 0);
    expect(selected.content).toContain(
      '⚔️ 🟢 <@666666666666666666> vs 🔴 <@666666666666666668>',
    );
    expect(selected.content).toContain(
      'Pool:** Radiant ₱100.00 • Dire ₱100.00 • Total ₱200.00',
    );
    expect(selected.components).toHaveLength(1);
  });

  it('chooses the earliest active Radiant representative by added_at', () => {
    const later = lobbyRow('Lobby 2', 'OPEN', true).lobby_players[0]!;
    const earliest = {
      ...later,
      id: '93000000-0000-4000-8000-000000000004',
      display_name: '@First Radiant',
      added_at: '2026-09-14T23:59:00Z',
    };
    const removed = {
      ...later,
      id: '93000000-0000-4000-8000-000000000005',
      display_name: 'Removed Earlier',
      status: 'REMOVED' as const,
      added_at: '2026-09-14T00:00:00Z',
    };
    expect(matchupLabel([later, earliest, removed])).toBe(
      'First Radiant vs TBD',
    );
  });

  it('chooses the earliest active Dire representative by added_at and then id', () => {
    const base = lobbyRow('Lobby 2', 'OPEN', true).lobby_players[0]!;
    const direLater = {
      ...base,
      id: '93000000-0000-4000-8000-000000000009',
      display_name: 'Dire Later',
      team: 'DIRE' as const,
      added_at: '2026-09-15T00:00:00Z',
    };
    const direFirstById = {
      ...direLater,
      id: '93000000-0000-4000-8000-000000000007',
      display_name: 'Dire First',
    };
    expect(matchupLabel([base, direLater, direFirstById])).toBe(
      'Yuji vs Dire First',
    );
  });

  it('shows TBD for a missing team and excludes removed members', () => {
    const active = lobbyRow('Lobby 2', 'OPEN', true).lobby_players[0]!;
    const removed = {
      ...active,
      id: '93000000-0000-4000-8000-000000000005',
      display_name: 'Removed Earlier',
      status: 'REMOVED' as const,
      added_at: '2026-09-14T00:00:00Z',
    };
    expect(matchupLabel([active, removed])).toBe('Yuji vs TBD');
    expect(dashboardMatchupLabel([active, removed])).toBe('@Yuji vs TBD');
  });

  it('places /bet privately using interaction identity and exact centavos', async () => {
    const slash = command('bet');
    const rpc = vi.fn().mockResolvedValue({ data: placement(), error: null });
    await handleBetCommand(
      slash.value,
      { rpc } as unknown as SupabaseClient,
      logger(),
    );
    expect(slash.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(rpc).toHaveBeenCalledWith('place_side_bet_self', {
      p_lobby_id: lobbyId,
      p_discord_user_id: userId,
      p_side: 'RADIANT',
      p_amount_centavos: 10_000,
      p_discord_interaction_id: interactionId,
    });
    const response = String(slash.editReply.mock.calls[0]?.[0]);
    expect(response).toContain('BET PLACED');
    expect(response).toContain('#3505');
    expect(response).toContain('Potential Gross Return:\n₱200.00');
    expect(response).toContain('Estimated Platform Fee:\n₱5.00');
    expect(response).toContain('Estimated Net Return:\n₱195.00');
    expect(response).not.toMatch(/available|reserved balance/i);
    expect(slash.reply).not.toHaveBeenCalled();
  });

  it('keeps /bet autocomplete restricted to OPEN lobbies with betting enabled', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const filters: [string, unknown][] = [];
    const rows = [
      {
        id: lobbyId,
        display_name: 'Enabled Lobby',
        status: 'OPEN',
        side_betting_enabled: true,
        lobby_players: lobbyRow('Lobby 2', 'OPEN', true).lobby_players,
      },
      {
        id: '91000000-0000-4000-8000-000000000001',
        display_name: 'Disabled Lobby',
        status: 'OPEN',
        side_betting_enabled: false,
        lobby_players: [],
      },
      {
        id: '92000000-0000-4000-8000-000000000001',
        display_name: 'Paused Lobby',
        status: 'POSTPONED',
        side_betting_enabled: true,
        lobby_players: [],
      },
      {
        id: '94000000-0000-4000-8000-000000000001',
        display_name: 'Empty Lobby',
        status: 'OPEN',
        side_betting_enabled: true,
        lobby_players: [],
      },
      {
        id: '95000000-0000-4000-8000-000000000001',
        display_name: 'Cancelled Lobby',
        status: 'CANCELLED',
        side_betting_enabled: true,
        lobby_players: [],
      },
      {
        id: '96000000-0000-4000-8000-000000000001',
        display_name: 'Archived Lobby',
        status: 'ARCHIVED',
        side_betting_enabled: true,
        lobby_players: [],
      },
    ];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      order: vi.fn(() => query),
      then: (resolve: (value: { data: typeof rows }) => void) =>
        Promise.resolve(
          resolve({
            data: rows.filter((row) =>
              filters.every(([column, value]) =>
                column === 'status' ? row.status === value : true,
              ),
            ),
          }),
        ),
    };
    const interaction = {
      commandName: 'bet',
      options: {
        getFocused: (withName?: boolean) =>
          withName ? { name: 'lobby', value: '' } : '',
      },
      respond,
    };
    await handleBetAutocomplete(
      interaction as never,
      { from: vi.fn(() => query) } as unknown as SupabaseClient,
      logger(),
    );
    expect(filters).toEqual([['status', 'OPEN']]);
    expect(respond).toHaveBeenCalledWith([
      { name: 'Enabled Lobby • Yuji vs TBD', value: lobbyId },
      {
        name: 'Empty Lobby • TBD vs TBD',
        value: '94000000-0000-4000-8000-000000000001',
      },
    ]);
  });

  it('matches /bet autocomplete by lobby or matchup text case-insensitively and caps blank searches at 25', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `8${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
      display_name: `Lobby ${index + 1}`,
      status: 'OPEN' as const,
      side_betting_enabled: true,
      lobby_players:
        index === 29 ? lobbyRow('Lobby 2', 'OPEN', true).lobby_players : [],
    }));
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      then: (resolve: (value: { data: typeof rows; error: null }) => void) =>
        Promise.resolve(resolve({ data: rows, error: null })),
    };
    const interaction = {
      commandName: 'bet',
      options: {
        getFocused: (
          withName?: boolean,
        ): string | { name: string; value: string } =>
          withName ? { name: 'lobby', value: 'yUjI' } : 'yUjI',
      },
      respond,
    };
    const log = logger();
    await handleBetAutocomplete(
      interaction as never,
      { from: vi.fn(() => query) } as unknown as SupabaseClient,
      log,
    );
    expect(respond).toHaveBeenCalledWith([
      { name: 'Lobby 30 • Yuji vs TBD', value: rows[29]!.id },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BET_AUTOCOMPLETE',
        open_lobbies: 30,
        eligible_lobbies: 30,
      }),
      'Bet autocomplete',
    );
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toMatch(
      /service.role|secret|token/i,
    );

    interaction.options.getFocused = (withName?: boolean) =>
      withName ? { name: 'lobby', value: '' } : '';
    await handleBetAutocomplete(
      interaction as never,
      { from: vi.fn(() => query) } as unknown as SupabaseClient,
      log,
    );
    expect(respond.mock.calls[1]?.[0]).toHaveLength(25);
  });

  it('rejects a stale disabled-betting target with the canonical unavailable response', async () => {
    const slash = command('bet');
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'SIDE BETTING DISABLED' },
    });
    await handleBetCommand(
      slash.value,
      { rpc } as unknown as SupabaseClient,
      logger(),
    );
    const response = String(slash.editReply.mock.calls[0]?.[0]);
    expect(response).toBe(
      '❌ **LOBBY NOT AVAILABLE**\n\nThis lobby is no longer open for betting.',
    );
    expect(slash.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });

  it('cancels /cancelbet privately and never accepts a member ID option', async () => {
    const slash = command('cancelbet');
    const rpc = vi.fn().mockResolvedValue({
      data: {
        duplicate: false,
        lobby_name: 'Lobby 1',
        bet: {
          ...betRow(),
          status: 'CANCELLED',
          cancelled_at: '2026-09-15T01:00:00Z',
          cancelled_source: 'DISCORD_SELF_SERVICE',
          cancel_interaction_id: interactionId,
        },
      },
      error: null,
    });
    await handleCancelBetCommand(
      slash.value,
      { rpc } as unknown as SupabaseClient,
      logger(),
    );
    expect(slash.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(rpc).toHaveBeenCalledWith('cancel_side_bet_self', {
      p_bet_number: 3505,
      p_discord_user_id: userId,
      p_discord_interaction_id: interactionId,
    });
    expect(slash.editReply).toHaveBeenCalledWith(
      expect.stringContaining('BET CANCELLED'),
    );
  });

  it.each(['radiant', 'dire'] as const)(
    'opens the Bet %s amount modal without creating a public message',
    async (side) => {
      const showModal = vi.fn().mockResolvedValue(undefined);
      const reply = vi.fn().mockResolvedValue(undefined);
      const single = vi.fn().mockResolvedValue({
        data: {
          display_name: 'Lobby 1',
          status: 'OPEN',
          side_betting_enabled: true,
          side_bet_min_centavos: 10_000,
          side_bet_max_centavos: 500_000,
        },
        error: null,
      });
      const interaction = {
        customId: `lobby:bet-${side}:${lobbyId}`,
        showModal,
        reply,
        isButton: () => true,
        isModalSubmit: () => false,
      } as unknown as Interaction;
      const client = {
        from: vi.fn(() => ({
          select: vi.fn(() => ({ eq: vi.fn(() => ({ single })) })),
        })),
      } as unknown as SupabaseClient;
      expect(await routeSideBetInteraction(interaction, client, logger())).toBe(
        true,
      );
      expect(showModal).toHaveBeenCalledOnce();
      const modal = showModal.mock.calls[0]?.[0].toJSON();
      expect(modal.custom_id).toBe(`lobby:bet-submit:${side}:${lobbyId}`);
      expect(JSON.stringify(modal)).toContain('₱100.00 – ₱5,000.00');
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it('keeps insufficient-balance errors private and omits the wallet amount', async () => {
    const slash = command('bet');
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '22003', message: 'Insufficient available balance' },
    });
    await handleBetCommand(
      slash.value,
      { rpc } as unknown as SupabaseClient,
      logger(),
    );
    expect(slash.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    const response = String(slash.editReply.mock.calls[0]?.[0]);
    expect(response).toContain('INSUFFICIENT BALANCE');
    expect(response).not.toMatch(/available.*₱|reserved.*₱/i);
  });
});
