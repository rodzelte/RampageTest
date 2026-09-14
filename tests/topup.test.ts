import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { MockQrPhProvider } from '../src/bot/providers/MockQrPhProvider';
import {
  createTopupRequest,
  parseTopupAmount,
  renderTopupQr,
} from '../src/bot/services/topups';
import { handleTopupCommand } from '../src/bot/commands/topup';
import type { BotConfig } from '../src/bot/config';
import type { QrPhProvider } from '../src/bot/providers/qrph';
import { readBotConfig } from '../src/bot/config';

const memberId = '80000000-0000-4000-8000-000000000001';
const topupId = '80000000-0000-4000-8000-000000000002';
const discordId = '888888888888888888';
const now = new Date('2026-09-14T02:00:00.000Z');
const config: BotConfig = {
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_CLIENT_ID: '111111111111111111',
  DISCORD_GUILD_ID: '222222222222222222',
  TOPUP_PROVIDER: 'qrph_mock',
  TOPUP_MIN_CENTAVOS: 10_000,
  TOPUP_MAX_CENTAVOS: 10_000_000,
  TOPUP_EXPIRY_MINUTES: 30,
  NODE_ENV: 'test',
};

function topupRow(providerPaymentId: string | null = null) {
  return {
    id: topupId,
    user_id: memberId,
    amount_centavos: 10_000,
    currency: 'PHP',
    provider: 'QRPH_MOCK',
    provider_payment_id: providerPaymentId,
    provider_reference: providerPaymentId ? 'RMP-80000000' : null,
    provider_event_id: null,
    status: 'PENDING',
    qr_created_at: providerPaymentId ? now.toISOString() : null,
    expires_at: '2026-09-14T02:30:00.000Z',
    provider_paid_amount_centavos: null,
    provider_paid_at: null,
    credited_at: null,
    reviewed_by: null,
    review_note: null,
    review_resolution: null,
    resolved_at: null,
    notification_claimed_at: null,
    notification_failure_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function serviceClient() {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== 'topup-test.example.invalid')
        throw new Error('Tests cannot access a live project.');
      const name = url.pathname.split('/').at(-1) ?? '';
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      calls.push({ name, body });
      const reply = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (name === 'ensure_member')
        return reply({
          id: memberId,
          discord_user_id: body.p_discord_user_id,
          auth_user_id: null,
          discord_username: body.p_username,
          display_name: body.p_display_name,
          status: 'ACTIVE',
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
      if (name === 'authorize_discord')
        return reply({
          id: memberId,
          role: 'MEMBER',
          discord_user_id: discordId,
        });
      if (name === 'create_topup') return reply(topupRow());
      if (name === 'set_topup_provider')
        return reply(topupRow(String(body.p_provider_payment_id)));
      if (name === 'fail_topup_creation')
        return reply({ ...topupRow(), status: 'FAILED' });
      throw new Error(`Unexpected RPC ${name}`);
    },
  );
  const client = createClient(
    'https://topup-test.example.invalid',
    'test-service-key',
    { global: { fetch: fetcher }, auth: { persistSession: false } },
  );
  return { client, calls };
}

const interactionIdentity = {
  user: { id: discordId, username: 'member', globalName: 'Member' },
};

describe('top-up amount limits', () => {
  it('uses TOPUP_PROVIDER=qrph_mock and rejects the mock provider in production', () => {
    expect(
      readBotConfig({
        ...config,
        TOPUP_MIN_CENTAVOS: String(config.TOPUP_MIN_CENTAVOS),
        TOPUP_MAX_CENTAVOS: String(config.TOPUP_MAX_CENTAVOS),
        TOPUP_EXPIRY_MINUTES: String(config.TOPUP_EXPIRY_MINUTES),
      } as unknown as NodeJS.ProcessEnv).TOPUP_PROVIDER,
    ).toBe('qrph_mock');
    expect(() =>
      readBotConfig({
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_CLIENT_ID: config.DISCORD_CLIENT_ID,
        DISCORD_GUILD_ID: config.DISCORD_GUILD_ID,
        TOPUP_PROVIDER: 'qrph_mock',
        NODE_ENV: 'production',
      }),
    ).toThrow('MockQrPhProvider');
  });
  it.each([
    ['100', 10_000],
    ['100.00', 10_000],
    ['500.50', 50_050],
    ['100000', 10_000_000],
  ])('accepts exact PHP amount %s', (text, expected) => {
    expect(parseTopupAmount(text, config)).toBe(expected);
  });
  it.each(['0', '-1', '99.99', '100000.01', '10.001', 'invalid'])(
    'rejects invalid or out-of-range amount %s',
    (text) => expect(() => parseTopupAmount(text, config)).toThrow(),
  );
});

describe('MockQrPhProvider and QR output', () => {
  it('creates a unique mock provider ID and a real PNG QR with clear mock payload', async () => {
    const provider = new MockQrPhProvider();
    const created = await provider.createTopup({
      topupId,
      amountCentavos: 10_000,
      expiresAt: new Date('2026-09-14T02:30:00Z'),
    });
    expect(created.providerPaymentId).toContain(topupId);
    expect(created.qrPayload).toBe(`RAMPAGE-MOCK-QRPH:${topupId}:10000`);
    const png = await renderTopupQr(created);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('rejects an invalid signature and normalizes a valid protected mock event', async () => {
    const provider = new MockQrPhProvider('test-webhook-secret');
    const body = {
      event_id: 'event-1',
      provider_payment_id: `qrph_mock_${topupId}`,
      paid_amount_centavos: 10_000,
      currency: 'PHP',
      paid_at: now.toISOString(),
      success: true,
    };
    await expect(
      provider.verifyWebhook(
        new Request('https://example.invalid', {
          method: 'POST',
          headers: { 'x-rampage-topup-webhook-secret': 'wrong' },
          body: JSON.stringify(body),
        }),
      ),
    ).rejects.toThrow('signature');
    const verified = await provider.verifyWebhook(
      new Request('https://example.invalid', {
        method: 'POST',
        headers: {
          'x-rampage-topup-webhook-secret': 'test-webhook-secret',
        },
        body: JSON.stringify(body),
      }),
    );
    expect(verified).toMatchObject({
      provider: 'QRPH_MOCK',
      providerPaymentId: body.provider_payment_id,
      paidAmountCentavos: 10_000,
      success: true,
    });
  });
});

describe('/topup service and Discord privacy', () => {
  it('ensures and links the invoking Discord member, then stores provider identity', async () => {
    const { client, calls } = serviceClient();
    const result = await createTopupRequest({
      client,
      interaction: interactionIdentity,
      amountText: '100',
      provider: new MockQrPhProvider(),
      config,
      now,
      topupId,
    });
    expect(result.topup.user_id).toBe(memberId);
    expect(result.expiresAt.toISOString()).toBe('2026-09-14T02:30:00.000Z');
    expect(
      calls.find((call) => call.name === 'ensure_member')?.body
        .p_discord_user_id,
    ).toBe(discordId);
    expect(
      calls.find((call) => call.name === 'create_topup')?.body,
    ).toMatchObject({
      p_topup_id: topupId,
      p_user_id: memberId,
      p_amount_centavos: 10_000,
    });
    expect(
      calls.find((call) => call.name === 'set_topup_provider')?.body
        .p_provider_payment_id,
    ).toContain(topupId);
  });

  it('marks the topup FAILED if QR creation fails without a wallet mutation call', async () => {
    const { client, calls } = serviceClient();
    const broken: QrPhProvider = {
      name: 'QRPH_MOCK',
      createTopup: async () => ({
        providerPaymentId: `qrph_mock_${topupId}`,
        expiresAt: new Date('2026-09-14T02:30:00Z'),
      }),
      verifyWebhook: async () => {
        throw new Error('unused');
      },
    };
    await expect(
      createTopupRequest({
        client,
        interaction: interactionIdentity,
        amountText: '100',
        provider: broken,
        config,
        now,
        topupId,
      }),
    ).rejects.toThrow('QR');
    expect(calls.some((call) => call.name === 'fail_topup_creation')).toBe(
      true,
    );
    expect(calls.every((call) => !call.name.includes('wallet'))).toBe(true);
  });

  it('sends the actual QR attachment only through an ephemeral interaction response', async () => {
    const { client } = serviceClient();
    const deferReply = vi.fn(async (payload: unknown) => void payload);
    const editReply = vi.fn(async (payload: unknown) => void payload);
    const interaction = {
      ...interactionIdentity,
      options: { getString: () => '100' },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;
    await handleTopupCommand(interaction, {
      client: client as SupabaseClient,
      provider: new MockQrPhProvider(),
      config,
    });
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledOnce();
    const response = editReply.mock.calls[0]?.[0] as {
      files: { attachment: Buffer }[];
      embeds: {
        toJSON(): { image?: { url: string }; footer?: { text: string } };
      }[];
    };
    expect(Buffer.isBuffer(response.files[0]?.attachment)).toBe(true);
    expect([...response.files[0]!.attachment.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(response.embeds[0]?.toJSON().image?.url).toMatch(/^attachment:\/\//);
    expect(response.embeds[0]?.toJSON().footer?.text).toContain('Only you');
  });
});
