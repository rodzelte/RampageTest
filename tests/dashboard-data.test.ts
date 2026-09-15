import { describe, expect, it } from 'vitest';
import {
  loadOverview,
  loadAudit,
  loadMembers,
  memberSearchFilter,
  setAdmin,
  setStaffDiscord,
  sumWalletLiability,
  loadPayments,
  resolveTopupReview,
  createLobby,
  loadDiscordChannels,
  loadLobby,
  loadLobbies,
  parseCreateLobbyInput,
} from '../src/dashboard/lib/data';
import { dateBounds } from '../src/dashboard/lib/dates';
import {
  dashboardClient,
  memberFixture,
  adminFixture,
  topupFixture,
  discordChannelFixture,
  lobbyFixture,
} from './helpers/dashboardClient';

const signal = () => new AbortController().signal;
describe('dashboard queries and mutation authorization', () => {
  it('sums available and reserved centavos exactly, including empty wallets', () => {
    expect(sumWalletLiability([])).toBe(0);
    expect(
      sumWalletLiability([
        { available_centavos: 100001, reserved_centavos: 24999 },
        { available_centavos: 25, reserved_centavos: 75 },
      ]),
    ).toBe(125100);
    expect(() =>
      sumWalletLiability([
        { available_centavos: Number.MAX_SAFE_INTEGER, reserved_centavos: 1 },
      ]),
    ).toThrow('range');
  });
  it('paginates wallet totals beyond the default Supabase row cap', async () => {
    const wallets = Array.from({ length: 1201 }, (_, index) => ({
      user_id: String(index),
      available_centavos: 100,
      reserved_centavos: 1,
    }));
    const { client, calls } = await dashboardClient({ wallets });
    const result = await loadOverview(client, 'OWNER', signal());
    expect(result.liability).toBe(121301);
    expect(calls.filter((call) => call.path.endsWith('/wallets'))).toHaveLength(
      3,
    );
  });
  it('does not request owner admin totals for the ADMIN overview', async () => {
    const { client, calls } = await dashboardClient({
      role: 'ADMIN',
      members: [memberFixture],
    });
    const result = await loadOverview(client, 'ADMIN', signal());
    expect(result.liability).toBe(125000);
    expect(result.activeAdmins).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/staff_profiles'))).toBe(
      false,
    );
  });
  it('counts only TOPUP ledger entries as cash in', async () => {
    const today = new Date().toISOString();
    const { client } = await dashboardClient({
      transactions: [
        { id: '1', amount_centavos: 10000, created_at: today },
        { id: '2', amount_centavos: 25050, created_at: today },
      ],
    });
    const result = await loadOverview(client, 'OWNER', signal());
    expect(result.totalCashIn).toBe(35050);
    expect(result.todayCashIn).toBe(35050);
  });
  it('loads filtered payments and keeps ADMIN review read-only', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      role: 'ADMIN',
      topups: [topupFixture],
    });
    const result = await loadPayments(
      client,
      {
        date: '2026-09-14',
        status: 'PENDING',
        discord: topupFixture.members.discord_user_id,
        reference: 'RMP',
      },
      0,
      signal(),
    );
    expect(result.rows[0]?.id).toBe(topupFixture.id);
    expect(
      calls.find((call) => call.path.endsWith('/topups'))?.query.get('status'),
    ).toBe('eq.PENDING');
    await expect(
      resolveTopupReview(client, {
        topupId: topupFixture.id,
        decision: 'REJECT',
        reason: 'Reviewed',
        creditAmountCentavos: null,
      }),
    ).rejects.toThrow('Only the active OWNER');
    expect(
      calls.some((call) => call.path.endsWith('/owner_resolve_topup_review')),
    ).toBe(false);
  });
  it('requires OWNER reason and explicit provider-paid credit amount', async () => {
    const reviewTopup = {
      ...topupFixture,
      status: 'AMOUNT_MISMATCH_REVIEW' as const,
      provider_paid_amount_centavos: 9000,
      provider_paid_at: topupFixture.created_at,
    };
    const { client, calls } = await dashboardClient({
      signedIn: true,
      topups: [reviewTopup],
    });
    await expect(
      resolveTopupReview(client, {
        topupId: reviewTopup.id,
        decision: 'APPROVE',
        reason: '',
        creditAmountCentavos: 9000,
      }),
    ).rejects.toThrow('reason');
    const resolved = await resolveTopupReview(client, {
      topupId: reviewTopup.id,
      decision: 'APPROVE',
      reason: 'Confirmed actual cash received',
      creditAmountCentavos: 9000,
    });
    expect(resolved.review_resolution).toBe('APPROVED_CREDIT');
    expect(
      calls.find((call) => call.path.endsWith('/owner_resolve_topup_review'))
        ?.body,
    ).toMatchObject({
      p_credit_amount_centavos: 9000,
      p_reason: 'Confirmed actual cash received',
    });
  });
  it('escapes member searches and uses server pagination', async () => {
    const search = 'name_%,"test)';
    const filter = memberSearchFilter(search);
    expect(filter).toContain('discord_username.ilike."');
    expect(filter).toContain('\\\\_');
    const { client, calls } = await dashboardClient();
    await loadMembers(client, search, 2, signal());
    expect(calls[0]?.query.get('or')).toBe(`(${filter})`);
    expect(calls[0]?.query.get('offset')).toBe('50');
  });
  it('maps a Manila calendar date to an inclusive/exclusive UTC interval', async () => {
    expect(dateBounds('2026-09-14', 'Asia/Manila')).toEqual({
      start: '2026-09-13T16:00:00.000Z',
      end: '2026-09-14T16:00:00.000Z',
    });
    expect(() => dateBounds('2026-02-30')).toThrow('valid date');
    const { client, calls } = await dashboardClient();
    await loadAudit(
      client,
      {
        date: '2026-09-14',
        source: 'SYSTEM',
        action: 'OWNER_',
        actor: adminFixture.id,
      },
      0,
      signal(),
    );
    expect(calls[0]?.query.getAll('created_at')).toEqual([
      'gte.2026-09-13T16:00:00.000Z',
      'lt.2026-09-14T16:00:00.000Z',
    ]);
    expect(calls[0]?.query.get('actor_staff_id')).toBe(`eq.${adminFixture.id}`);
  });
  it.each([{ role: 'ADMIN' as const }, { active: false }])(
    'denies protected writes using current server staff data: %j',
    async (options) => {
      const { client, calls } = await dashboardClient({
        ...options,
        signedIn: true,
      });
      await expect(
        setAdmin(client, {
          email: 'new@example.com',
          discordId: '',
          active: true,
          reason: '',
        }),
      ).rejects.toThrow();
      await expect(
        setStaffDiscord(client, {
          staffId: adminFixture.id,
          discordId: '111111111111111111',
          reason: 'Change',
        }),
      ).rejects.toThrow();
      expect(
        calls.some(
          (call) =>
            call.path.endsWith('/owner_set_admin') ||
            call.path.endsWith('/owner_set_staff_discord'),
        ),
      ).toBe(false);
    },
  );
  it('validates disable reasons before any mutation', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    await expect(
      setAdmin(client, {
        email: adminFixture.email,
        discordId: '',
        active: false,
        reason: ' ',
      }),
    ).rejects.toThrow('reason');
    expect(calls.some((call) => call.path.endsWith('/owner_set_admin'))).toBe(
      false,
    );
  });
  it('parses lobby money and platform fee exactly', () => {
    expect(
      parseCreateLobbyInput({
        displayName: ' Lobby 1 ',
        channel: discordChannelFixture,
        rosterEntry: '100.00',
        sideBettingEnabled: true,
        sideBetMinimum: '100',
        sideBetMaximum: '5000',
        platformFee: '5.00',
      }),
    ).toEqual({
      displayName: 'Lobby 1',
      rosterEntryCentavos: 10_000,
      sideBetMinCentavos: 10_000,
      sideBetMaxCentavos: 500_000,
      platformFeeBps: 500,
    });
    expect(() =>
      parseCreateLobbyInput({
        displayName: 'Lobby',
        channel: discordChannelFixture,
        rosterEntry: '1e2',
        sideBettingEnabled: false,
        sideBetMinimum: '',
        sideBetMaximum: '',
        platformFee: '5',
      }),
    ).toThrow();
    expect(() =>
      parseCreateLobbyInput({
        displayName: 'Below participation floor',
        channel: discordChannelFixture,
        rosterEntry: '100.00',
        sideBettingEnabled: true,
        sideBetMinimum: '99.99',
        sideBetMaximum: '5000.00',
        platformFee: '5.00',
      }),
    ).toThrow('at least the roster entry');
    expect(
      parseCreateLobbyInput({
        displayName: 'Above participation floor',
        channel: discordChannelFixture,
        rosterEntry: '100.00',
        sideBettingEnabled: true,
        sideBetMinimum: '200.00',
        sideBetMaximum: '5000.00',
        platformFee: '5.00',
      }).sideBetMinCentavos,
    ).toBe(20_000);
  });
  it('loads safe lobby/channel data and calls the authorized creation RPC', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [lobbyFixture],
    });
    expect(await loadDiscordChannels(client, signal())).toEqual([
      discordChannelFixture,
    ]);
    expect((await loadLobbies(client, signal()))[0]?.id).toBe(lobbyFixture.id);
    expect((await loadLobby(client, lobbyFixture.id, signal())).status).toBe(
      'OPEN',
    );
    const created = await createLobby(client, {
      displayName: 'Lobby 2',
      channel: discordChannelFixture,
      rosterEntry: '100',
      sideBettingEnabled: false,
      sideBetMinimum: '',
      sideBetMaximum: '',
      platformFee: '5',
    });
    expect(created.status).toBe('OPEN');
    expect(
      calls.find((call) => call.path.endsWith('/create_lobby'))?.body,
    ).toMatchObject({
      p_roster_entry_centavos: 10_000,
      p_side_bet_min_centavos: null,
      p_side_bet_max_centavos: null,
      p_platform_fee_bps: 500,
    });
  });
});
