import type { SupabaseClient } from '@supabase/supabase-js';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { handleLobbyButton } from '../src/bot/lobbies/lobbyInteractions';

const lobbyId = '90000000-0000-4000-8000-000000000001';
const memberDiscordId = '888888888888888888';
const messageId = '999999999999999999';
const interactionId = '777777777777777777';

function logger() {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function interaction(action: 'join-radiant' | 'join-dire' | 'leave') {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    value: {
      id: interactionId,
      customId: `lobby:${action}:${lobbyId}`,
      user: { id: memberDiscordId },
      message: { id: messageId },
      deferReply,
      editReply,
    } as unknown as ButtonInteraction,
    deferReply,
    editReply,
  };
}

function serviceClient(
  result: unknown,
  error: { code: string; message: string } | null = null,
) {
  const rpc = vi.fn().mockResolvedValue({ data: result, error });
  const single = vi.fn().mockResolvedValue({
    data: { roster_entry_centavos: 10_000 },
    error: null,
  });
  const client = {
    rpc,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single })),
      })),
    })),
  } as unknown as SupabaseClient;
  return { client, rpc };
}

describe('Discord lobby self-service privacy and identity', () => {
  it.each([
    ['join-radiant', 'RADIANT'],
    ['join-dire', 'DIRE'],
  ] as const)(
    'handles private %s using interaction.user.id',
    async (action, team) => {
      const button = interaction(action);
      const service = serviceClient({
        lobby_name: 'Lobby 1',
        entry_centavos: 10_000,
        team,
      });
      expect(
        await handleLobbyButton(button.value, service.client, logger()),
      ).toBe(true);
      expect(button.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(service.rpc).toHaveBeenCalledWith('join_lobby_self_with_amount', {
        p_lobby_id: lobbyId,
        p_discord_user_id: memberDiscordId,
        p_team: team,
        p_entry_centavos: null,
        p_discord_interaction_id: interactionId,
        p_discord_message_id: messageId,
      });
      expect(button.editReply).toHaveBeenCalledWith(
        expect.stringContaining(`YOU JOINED ${team}`),
      );
      expect(button.editReply).toHaveBeenCalledWith(
        expect.stringContaining('Entry Reserved: ₱100.00'),
      );
    },
  );

  it('leaves privately and requests one idempotent database release', async () => {
    const button = interaction('leave');
    const service = serviceClient({
      lobby_name: 'Lobby 1',
      entry_centavos: 10_000,
      team: 'RADIANT',
    });
    await handleLobbyButton(button.value, service.client, logger());
    expect(button.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(service.rpc).toHaveBeenCalledWith(
      'leave_lobby_self_with_interaction',
      {
        p_lobby_id: lobbyId,
        p_discord_user_id: memberDiscordId,
        p_discord_interaction_id: interactionId,
        p_discord_message_id: messageId,
      },
    );
    expect(button.editReply).toHaveBeenCalledWith(
      expect.stringContaining('YOU LEFT THE LOBBY'),
    );
  });

  it('shows the entry threshold without exposing wallet balance when funds are insufficient', async () => {
    const button = interaction('join-radiant');
    const service = serviceClient(null, {
      code: '22003',
      message: 'Insufficient available balance',
    });
    await handleLobbyButton(button.value, service.client, logger());
    const response = String(button.editReply.mock.calls[0]?.[0]);
    expect(response).toContain('INSUFFICIENT BALANCE');
    expect(response).toContain('Lobby Entry: ₱100.00');
    expect(response).toContain('/topup');
    expect(response).not.toMatch(/available.*₱|reserved.*₱/i);
  });
});
