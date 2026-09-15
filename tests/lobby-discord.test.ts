import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  type Client,
} from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  parseLobbyDiscordSync,
  reconcileLobbyDiscord,
  renderLobbyComponents,
  renderLobbyEmbed,
  syncGuildChannels,
} from '../src/bot/lobbies/lobbyDiscord';

const lobbyId = '90000000-0000-4000-8000-000000000001';
const channelId = '999999999999999991';
const guildId = '999999999999999992';
const messageId = '999999999999999993';
const botId = '999999999999999994';

function lobby(
  players: unknown[] = [],
  message: string | null = null,
  status:
    | 'OPEN'
    | 'POSTPONED'
    | 'LOCKED'
    | 'SETTLED'
    | 'CANCELLED'
    | 'ARCHIVED' = 'OPEN',
) {
  return parseLobbyDiscordSync({
    id: lobbyId,
    display_name: 'Lobby 1',
    status,
    discord_guild_id: guildId,
    discord_channel_id: channelId,
    discord_message_id: message,
    roster_entry_centavos: 10_000,
    side_betting_enabled: true,
    side_bet_min_centavos: 10_000,
    side_bet_max_centavos: 500_000,
    platform_fee_bps: 500,
    winner: null,
    created_by: '90000000-0000-4000-8000-000000000002',
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
    discord_revision: 1 + players.length,
    discord_synced_revision: 0,
    discord_sync_claimed_at: '2026-09-15T00:00:01Z',
    discord_sync_error: null,
    financial_commitment_at: players.length > 0 ? '2026-09-15T00:00:00Z' : null,
    archived_at: null,
    discord_previous_channel_id: null,
    discord_previous_message_id: null,
    discord_channel_name: 'scrim-betting',
    players,
    side_bets: [],
  });
}

function player(index: number, team: 'RADIANT' | 'DIRE') {
  return {
    id: `9${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    discord_user_id: `8${String(index).padStart(17, '0')}`,
    display_name: `Player ${index}`,
    team,
    stake_centavos: 10_000,
    status: 'ACTIVE',
    added_by: '90000000-0000-4000-8000-000000000002',
    added_source: 'DASHBOARD',
    added_at: `2026-09-15T00:00:${String(index).padStart(2, '0')}Z`,
    removed_by: null,
    removed_at: null,
    removed_source: null,
  };
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function reconciliation(
  options: {
    lobbyMessage?: string | null;
    recent?: Collection<string, unknown>;
    sendFails?: boolean;
  } = {},
) {
  const edit = vi.fn().mockResolvedValue({ id: messageId });
  const existing = {
    id: messageId,
    author: { id: botId },
    embeds: [{ footer: { text: `Rampage lobby ${lobbyId}` } }],
    edit,
  };
  const recent = options.recent ?? new Collection<string, unknown>();
  const fetch = vi.fn().mockImplementation((value: unknown) => {
    if (typeof value === 'string') return Promise.resolve(existing);
    return Promise.resolve(recent);
  });
  const send = options.sendFails
    ? vi.fn().mockRejectedValue(new Error('Missing Access'))
    : vi.fn().mockResolvedValue({ id: messageId });
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const discord = {
    user: { id: botId },
    channels: {
      fetch: vi.fn().mockResolvedValue({
        id: channelId,
        type: ChannelType.GuildText,
        messages: { fetch },
        send,
      }),
    },
  } as unknown as Client;
  return {
    discord,
    client: { rpc } as unknown as SupabaseClient,
    log: logger(),
    fetch,
    send,
    edit,
    rpc,
    existing,
  };
}

describe('Phase 4 Discord channel and lobby synchronization', () => {
  it('syncs only safe text/announcement metadata without exposing the bot token', async () => {
    const allowed = {
      id: channelId,
      name: 'scrim-betting',
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
    };
    const denied = {
      id: '999999999999999995',
      name: 'read-only',
      type: ChannelType.GuildAnnouncement,
      permissionsFor: () => ({
        has: (permission: bigint) =>
          permission !== PermissionFlagsBits.SendMessages,
      }),
    };
    const ignored = {
      id: '999999999999999996',
      name: 'voice',
      type: ChannelType.GuildVoice,
      permissionsFor: () => ({ has: () => true }),
    };
    const channels = new Collection<string, unknown>([
      [allowed.id, allowed],
      [denied.id, denied],
      [ignored.id, ignored],
    ]);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const discord = {
      user: { id: botId },
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          channels: { fetch: vi.fn().mockResolvedValue(channels) },
        }),
      },
    } as unknown as Client;
    const result = await syncGuildChannels(
      discord,
      { rpc } as unknown as SupabaseClient,
      guildId,
      logger(),
    );
    expect(result).toEqual([
      {
        channel_id: channelId,
        channel_name: 'scrim-betting',
        channel_type: 'GUILD_TEXT',
        can_post: true,
      },
      {
        channel_id: denied.id,
        channel_name: 'read-only',
        channel_type: 'GUILD_ANNOUNCEMENT',
        can_post: false,
      },
    ]);
    expect(rpc).toHaveBeenCalledWith('sync_discord_channels', {
      p_guild_id: guildId,
      p_channels: result,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/token/i);
  });

  it('renders public configuration and pools without private wallet data', () => {
    const embed = renderLobbyEmbed(
      lobby([player(1, 'RADIANT'), player(2, 'DIRE')]),
    ).toJSON();
    expect(embed.title).toBe('🎮 Lobby 1 — Match & Betting Overview');
    expect(embed.description).toContain(
      '⚔️ 🟢 <@800000000000000001> vs 🔴 <@800000000000000002>',
    );
    expect(embed.description).toContain('STATUS: OPEN');
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Platform Fee',
          value: '5% of winning profit',
        }),
        expect.objectContaining({ name: '🟢 RADIANT — 1/5' }),
        expect.objectContaining({ name: '🔴 DIRE — 1/5' }),
        expect.objectContaining({
          name: '📊 POOL SUMMARY',
          value: expect.stringContaining('💰 Total: ₱200.00'),
        }),
      ]),
    );
    const publicText = JSON.stringify(embed);
    expect(publicText).not.toMatch(
      /available balance|reserved balance|top-?up|payment reference|QR/i,
    );
  });

  it('shows READY TO LOCK for full 5v5 while status stays OPEN', () => {
    const players = [
      ...Array.from({ length: 5 }, (_, index) => player(index + 1, 'RADIANT')),
      ...Array.from({ length: 5 }, (_, index) => player(index + 6, 'DIRE')),
    ];
    const embed = renderLobbyEmbed(lobby(players)).toJSON();
    expect(embed.description).toContain('STATUS: OPEN');
    expect(embed.description).toContain('ROSTERS FULL');
    expect(embed.description).toContain('READY TO LOCK');
  });

  it('enables self-service buttons only while OPEN and removes them when archived', () => {
    const open = renderLobbyComponents(lobby()).map((row) => row.toJSON());
    expect(
      open[0]?.components.map((button) =>
        'label' in button ? button.label : undefined,
      ),
    ).toEqual(['Join Radiant', 'Join Dire', 'Leave Lobby']);
    expect(open[0]?.components.every((button) => !button.disabled)).toBe(true);
    expect(
      open[1]?.components.map((button) =>
        'label' in button ? button.label : undefined,
      ),
    ).toEqual(['Bet Radiant', 'Bet Dire']);
    for (const status of ['POSTPONED', 'CANCELLED'] as const) {
      const components = renderLobbyComponents(
        lobby([], messageId, status),
      ).map((row) => row.toJSON());
      expect(components[0]?.components.every((button) => button.disabled)).toBe(
        true,
      );
      expect(
        renderLobbyEmbed(lobby([], messageId, status)).toJSON().description,
      ).toContain(status);
    }
    expect(renderLobbyComponents(lobby([], messageId, 'ARCHIVED'))).toEqual([]);
  });

  it('keeps roster buttons but omits bet buttons for an OPEN non-betting lobby', () => {
    const rows = renderLobbyComponents({
      ...lobby(),
      side_betting_enabled: false,
      side_bet_min_centavos: null,
      side_bet_max_centavos: null,
    }).map((row) => row.toJSON());
    expect(rows).toHaveLength(1);
    expect(
      rows[0]?.components.map((button) =>
        'label' in button ? button.label : undefined,
      ),
    ).toEqual(['Join Radiant', 'Join Dire', 'Leave Lobby']);
    expect(rows[0]?.components.every((button) => !button.disabled)).toBe(true);
  });

  it('includes active side bets in the combined pool, difference, and safely bounded public list', () => {
    const sideBets = Array.from({ length: 20 }, (_, index) => ({
      id: `7${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
      bet_number: 3500 + index,
      discord_user_id: `6${String(index).padStart(17, '0')}`,
      display_name: `Bettor ${index}`,
      side: index === 0 ? ('DIRE' as const) : ('RADIANT' as const),
      accepted_amount_centavos: 10_000,
      placed_at: `2026-09-15T00:01:${String(index).padStart(2, '0')}Z`,
    }));
    const embed = renderLobbyEmbed({
      ...lobby([player(1, 'RADIANT'), player(2, 'DIRE')]),
      side_bets: sideBets,
    }).toJSON();
    const pool = embed.fields?.find(
      (field) => field.name === '📊 POOL SUMMARY',
    );
    const difference = embed.fields?.find(
      (field) => field.name === '⚖️ CURRENT POOL DIFFERENCE',
    );
    const radiantList = embed.fields?.find(
      (field) => field.name === '🟢 RADIANT SIDE BETS',
    );
    expect(pool?.value).toContain('Radiant side bets: ₱1,900.00');
    expect(pool?.value).toContain('Dire side bets: ₱100.00');
    expect(pool?.value).toContain('Total: ₱2,200.00');
    expect(difference?.value).toContain('RADIANT Lead +₱1,800.00');
    expect(radiantList?.value).toContain('more active bets');
    expect(radiantList!.value.length).toBeLessThanOrEqual(1024);
    expect(JSON.stringify(embed)).not.toMatch(
      /available_centavos|reserved_centavos|wallet balance/i,
    );
  });

  it('posts one message for a new lobby and saves its ID', async () => {
    const deps = reconciliation();
    expect(
      await reconcileLobbyDiscord(
        lobby([], null),
        deps.discord,
        deps.client,
        deps.log,
      ),
    ).toBe(true);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([expect.anything()]),
      }),
    );
    expect(deps.edit).not.toHaveBeenCalled();
    expect(deps.rpc).toHaveBeenCalledWith('complete_lobby_discord_sync', {
      p_lobby_id: lobbyId,
      p_revision: 1,
      p_discord_message_id: messageId,
    });
  });

  it('edits the saved message for roster changes instead of posting again', async () => {
    const deps = reconciliation();
    const changed = lobby([player(1, 'RADIANT')], messageId);
    await reconcileLobbyDiscord(changed, deps.discord, deps.client, deps.log);
    expect(deps.fetch).toHaveBeenCalledWith(messageId);
    expect(deps.edit).toHaveBeenCalledOnce();
    expect(deps.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([expect.anything()]),
      }),
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('recovers an already-posted lobby message after a database completion failure', async () => {
    const recent = new Collection<string, unknown>();
    const deps = reconciliation({ recent });
    recent.set(messageId, deps.existing);
    await reconcileLobbyDiscord(
      lobby([], null),
      deps.discord,
      deps.client,
      deps.log,
    );
    expect(deps.edit).toHaveBeenCalledOnce();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('retires the old interactive message before posting once in a changed channel', async () => {
    const previousChannelId = '999999999999999995';
    const previousMessageId = '999999999999999996';
    const retire = vi.fn().mockResolvedValue({ id: previousMessageId });
    const send = vi.fn().mockResolvedValue({ id: messageId });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const discord = {
      user: { id: botId },
      channels: {
        fetch: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(
            id === previousChannelId
              ? {
                  type: ChannelType.GuildText,
                  messages: {
                    fetch: vi.fn().mockResolvedValue({ edit: retire }),
                  },
                }
              : {
                  type: ChannelType.GuildText,
                  messages: {
                    fetch: vi.fn().mockResolvedValue(new Collection()),
                  },
                  send,
                },
          ),
        ),
      },
    } as unknown as Client;
    const moved = {
      ...lobby([], null),
      discord_previous_channel_id: previousChannelId,
      discord_previous_message_id: previousMessageId,
    };
    expect(
      await reconcileLobbyDiscord(
        moved,
        discord,
        { rpc } as unknown as SupabaseClient,
        logger(),
      ),
    ).toBe(true);
    expect(retire).toHaveBeenCalledWith({
      content: '↪️ This lobby moved to another channel.',
      embeds: [],
      components: [],
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('records Discord failure for retry without invoking any financial operation', async () => {
    const deps = reconciliation({ sendFails: true });
    expect(
      await reconcileLobbyDiscord(
        lobby([], null),
        deps.discord,
        deps.client,
        deps.log,
      ),
    ).toBe(false);
    expect(deps.rpc.mock.calls.map((call) => call[0])).toEqual([
      'fail_lobby_discord_sync',
    ]);
    expect(JSON.stringify(deps.rpc.mock.calls)).not.toMatch(/wallet|ledger/i);
  });

  it('succeeds on a later retry after a transient Discord failure', async () => {
    const failed = reconciliation({ sendFails: true });
    await reconcileLobbyDiscord(
      lobby([], null),
      failed.discord,
      failed.client,
      failed.log,
    );
    const retry = reconciliation();
    expect(
      await reconcileLobbyDiscord(
        lobby([], null),
        retry.discord,
        retry.client,
        retry.log,
      ),
    ).toBe(true);
    expect(retry.send).toHaveBeenCalledOnce();
  });
});
