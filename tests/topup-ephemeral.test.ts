import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  EphemeralTopupRegistry,
  renderTerminalTopupMessage,
} from '../src/bot/notifications/topupEphemeral';
import { handleTopupTerminalState } from '../src/bot/notifications/topupNotifications';
import { topupSchema, type Topup } from '../src/shared/models';

const topupId = '80000000-0000-4000-8000-000000000002';
const memberId = '80000000-0000-4000-8000-000000000001';
const discordId = '888888888888888888';

function topup(
  status: Topup['status'],
  reviewResolution: Topup['review_resolution'] = null,
) {
  return topupSchema.parse({
    id: topupId,
    user_id: memberId,
    amount_centavos: 40_000,
    currency: 'PHP',
    provider: 'QRPH_MOCK',
    provider_payment_id: 'qrph_mock_payment_1',
    provider_reference: 'RMP-PRIVATE',
    provider_event_id: 'event-1',
    status,
    qr_created_at: '2026-09-14T01:00:00Z',
    expires_at: '2026-09-14T01:30:00Z',
    provider_paid_amount_centavos: status === 'PAID' ? 40_000 : null,
    provider_paid_at: status === 'PAID' ? '2026-09-14T01:05:00Z' : null,
    credited_at: status === 'PAID' ? '2026-09-14T01:05:00Z' : null,
    reviewed_by: null,
    review_note: null,
    review_resolution: reviewResolution,
    resolved_at: status === 'RESOLVED' ? '2026-09-14T01:10:00Z' : null,
    notification_claimed_at: null,
    notification_failure_at: null,
    created_at: '2026-09-14T01:00:00Z',
    updated_at: '2026-09-14T01:05:00Z',
  });
}

function dependencies(
  options: { editFails?: boolean; dmFails?: boolean; claims?: unknown[] } = {},
) {
  const editReply = options.editFails
    ? vi.fn().mockRejectedValue(new Error('Unknown interaction'))
    : vi.fn().mockResolvedValue(undefined);
  const send = options.dmFails
    ? vi.fn().mockRejectedValue(new Error('Cannot send messages to this user'))
    : vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn().mockResolvedValue({ send });
  const claims = [...(options.claims ?? [])];
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === 'claim_topup_notification')
      return Promise.resolve({ data: claims.shift() ?? null, error: null });
    if (name === 'record_topup_notification_failure')
      return Promise.resolve({ data: null, error: null });
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const registry = new EphemeralTopupRegistry();
  registry.remember(topupId, {
    editReply,
  } as unknown as Pick<ChatInputCommandInteraction, 'editReply'>);
  return {
    editReply,
    send,
    fetch,
    rpc,
    logger,
    registry,
    discord: { users: { fetch } } as unknown as Pick<Client, 'users'>,
    client: { rpc } as unknown as SupabaseClient,
  };
}

const notification = {
  topup_id: topupId,
  discord_user_id: discordId,
  credited_amount_centavos: 40_000,
  available_centavos: 90_000,
};

describe('private ephemeral QR terminal rendering', () => {
  it.each([
    ['PAID', null, '✅ PAYMENT RECEIVED'],
    ['EXPIRED', null, '⌛ QR EXPIRED'],
    ['FAILED', null, '❌ TOP-UP FAILED'],
    ['AMOUNT_MISMATCH_REVIEW', null, '⚠️ PAYMENT UNDER REVIEW'],
    ['LATE_PAID_REVIEW', null, '⚠️ LATE PAYMENT UNDER REVIEW'],
  ] as const)(
    'removes the QR for %s and renders %s',
    (status, resolution, title) => {
      const message = renderTerminalTopupMessage(topup(status, resolution));
      expect(message.attachments).toEqual([]);
      expect(message.files).toEqual([]);
      expect(message.content).toBe('');
      expect(
        (message.embeds?.[0] as { toJSON(): { title?: string } }).toJSON(),
      ).toMatchObject({ title });
    },
  );

  it('replaces a PAID QR and also sends exactly one private success DM', async () => {
    const deps = dependencies({ claims: [notification] });
    await handleTopupTerminalState(
      topup('PAID'),
      deps.discord,
      deps.client,
      deps.logger,
      deps.registry,
    );
    expect(deps.editReply).toHaveBeenCalledOnce();
    const message = deps.editReply.mock.calls[0]?.[0];
    expect(message).toMatchObject({ content: '', attachments: [], files: [] });
    expect(message.embeds[0].toJSON()).toMatchObject({
      title: '✅ PAYMENT RECEIVED',
      description: 'Your wallet has been credited successfully.',
    });
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledWith(discordId);
    expect(deps.send).toHaveBeenCalledOnce();
    const dm = deps.send.mock.calls[0]?.[0];
    expect(dm.files).toBeUndefined();
    expect(dm.embeds[0].toJSON()).toMatchObject({
      title: '✅ RAMPAGE TOP-UP SUCCESSFUL',
      description: 'Your Rampage wallet has been credited successfully.',
      fields: expect.arrayContaining([
        { name: 'Amount', value: '₱400.00', inline: false },
        { name: 'Status', value: 'PAID', inline: false },
        { name: 'Wallet credited', value: '₱400.00', inline: false },
        { name: 'Available Balance', value: '₱900.00', inline: false },
        { name: 'Reference', value: 'RMP-PRIVATE', inline: false },
        {
          name: 'Paid',
          value: expect.stringContaining('Sep 14, 2026'),
          inline: false,
        },
      ]),
    });
    expect(dm.embeds[0].toJSON().image).toBeUndefined();
    expect(deps.rpc).toHaveBeenCalledWith('claim_topup_notification', {
      p_topup_id: topupId,
    });
  });

  it.each([
    ['EXPIRED', '⌛ QR EXPIRED'],
    ['FAILED', '❌ TOP-UP FAILED'],
    ['AMOUNT_MISMATCH_REVIEW', '⚠️ PAYMENT UNDER REVIEW'],
    ['LATE_PAID_REVIEW', '⚠️ LATE PAYMENT UNDER REVIEW'],
  ] as const)(
    'updates %s privately without any payment or public RPC',
    async (status, title) => {
      const deps = dependencies();
      await handleTopupTerminalState(
        topup(status),
        deps.discord,
        deps.client,
        deps.logger,
        deps.registry,
      );
      expect(deps.editReply.mock.calls[0]?.[0]).toMatchObject({
        content: '',
        attachments: [],
        files: [],
      });
      expect(deps.editReply.mock.calls[0]?.[0].embeds[0].toJSON().title).toBe(
        title,
      );
      expect(deps.rpc).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );

  it('treats an expired interaction token as a UI failure and falls back to a private DM', async () => {
    const paid = topup('PAID');
    const original = structuredClone(paid);
    const deps = dependencies({ editFails: true, claims: [notification] });
    await handleTopupTerminalState(
      paid,
      deps.discord,
      deps.client,
      deps.logger,
      deps.registry,
    );
    expect(paid).toEqual(original);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { topupId, result: 'failed' },
      'Private ephemeral top-up response could not be updated',
    );
    expect(deps.fetch).toHaveBeenCalledWith(discordId);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.rpc.mock.calls.map((call) => call[0])).toEqual([
      'claim_topup_notification',
    ]);
  });

  it('records a private DM failure without changing payment state or blocking the ephemeral update', async () => {
    const paid = topup('PAID');
    const original = structuredClone(paid);
    const deps = dependencies({ dmFails: true, claims: [notification] });
    await handleTopupTerminalState(
      paid,
      deps.discord,
      deps.client,
      deps.logger,
      deps.registry,
    );
    expect(paid).toEqual(original);
    expect(deps.editReply).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { topupId },
      'Private top-up DM could not be delivered',
    );
    expect(deps.rpc.mock.calls.map((call) => call[0])).toEqual([
      'claim_topup_notification',
      'record_topup_notification_failure',
    ]);
    expect(deps.rpc).toHaveBeenCalledWith('record_topup_notification_failure', {
      p_topup_id: topupId,
      p_reason: 'Discord DM unavailable',
    });
  });

  it('coalesces concurrent paid events without a duplicate notification or wallet mutation', async () => {
    const deps = dependencies({ claims: [notification, null] });
    const paid = topup('PAID');
    await Promise.all([
      handleTopupTerminalState(
        paid,
        deps.discord,
        deps.client,
        deps.logger,
        deps.registry,
      ),
      handleTopupTerminalState(
        paid,
        deps.discord,
        deps.client,
        deps.logger,
        deps.registry,
      ),
    ]);
    expect(deps.editReply).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.rpc.mock.calls.map((call) => call[0])).toEqual([
      'claim_topup_notification',
      'claim_topup_notification',
    ]);
  });
});
