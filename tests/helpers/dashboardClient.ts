import { createClient } from '@supabase/supabase-js';
import type { StaffProfile } from '../../src/shared/models';
import type {
  LobbyWithRelations,
  TopupWithMember,
} from '../../src/dashboard/lib/data';

export const ownerFixture: StaffProfile = {
  id: '10000000-0000-4000-8000-000000000001',
  auth_user_id: '20000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  role: 'OWNER',
  active: true,
  discord_user_id: '111111111111111111',
  created_at: '2026-09-14T01:00:00Z',
  updated_at: '2026-09-14T01:00:00Z',
};
export const adminFixture: StaffProfile = {
  ...ownerFixture,
  id: '10000000-0000-4000-8000-000000000002',
  auth_user_id: '20000000-0000-4000-8000-000000000002',
  email: 'admin@example.com',
  role: 'ADMIN',
  discord_user_id: '222222222222222222',
};
export const auditFixture = {
  id: '30000000-0000-4000-8000-000000000001',
  actor_type: 'SYSTEM',
  actor_staff_id: ownerFixture.id,
  actor_auth_user_id: ownerFixture.auth_user_id,
  actor_discord_id: null,
  source: 'SYSTEM',
  action: 'OWNER_BOOTSTRAPPED',
  entity_type: 'staff_profiles',
  entity_id: ownerFixture.id,
  reason: null,
  created_at: '2026-09-14T01:00:00Z',
};
export const memberFixture = {
  id: '40000000-0000-4000-8000-000000000001',
  discord_user_id: '333333333333333333',
  auth_user_id: null,
  discord_username: 'member_one',
  display_name: 'Member One',
  status: 'ACTIVE',
  created_at: '2026-09-14T01:00:00Z',
  updated_at: '2026-09-14T01:00:00Z',
  wallets: { available_centavos: 100000, reserved_centavos: 25000 },
};
export const topupFixture: TopupWithMember = {
  id: '50000000-0000-4000-8000-000000000001',
  user_id: memberFixture.id,
  amount_centavos: 10000,
  currency: 'PHP',
  provider: 'QRPH_MOCK',
  provider_payment_id: 'qrph_mock_payment_1',
  provider_reference: 'RMP-TEST',
  provider_event_id: null,
  status: 'PENDING',
  qr_created_at: '2026-09-14T01:00:00Z',
  expires_at: '2026-09-14T01:30:00Z',
  provider_paid_amount_centavos: null,
  provider_paid_at: null,
  credited_at: null,
  reviewed_by: null,
  review_note: null,
  review_resolution: null,
  resolved_at: null,
  notification_claimed_at: null,
  notification_failure_at: null,
  created_at: '2026-09-14T01:00:00Z',
  updated_at: '2026-09-14T01:00:00Z',
  members: {
    discord_user_id: memberFixture.discord_user_id,
    discord_username: memberFixture.discord_username,
    display_name: memberFixture.display_name,
  },
};
export const discordChannelFixture = {
  channel_id: '777777777777777778',
  guild_id: '777777777777777777',
  channel_name: 'scrim-betting',
  channel_type: 'GUILD_TEXT' as const,
  can_post: true,
  active: true,
  last_synced_at: '2026-09-15T00:00:00Z',
};
export const lobbyFixture: LobbyWithRelations = {
  id: '60000000-0000-4000-8000-000000000001',
  display_name: 'Lobby 1',
  status: 'OPEN' as const,
  discord_guild_id: discordChannelFixture.guild_id,
  discord_channel_id: discordChannelFixture.channel_id,
  discord_message_id: null,
  roster_entry_centavos: 10_000,
  side_betting_enabled: true,
  side_bet_min_centavos: 10_000,
  side_bet_max_centavos: 500_000,
  platform_fee_bps: 500,
  winner: null,
  created_by: ownerFixture.id,
  created_at: '2026-09-15T00:00:00Z',
  updated_at: '2026-09-15T00:00:00Z',
  discord_revision: 1,
  discord_synced_revision: 0,
  discord_sync_claimed_at: null,
  discord_sync_error: null,
  financial_commitment_at: null,
  archived_at: null,
  discord_previous_channel_id: null,
  discord_previous_message_id: null,
  discord_channels: { channel_name: discordChannelFixture.channel_name },
  lobby_players: [],
  side_bets: [],
};
type MockOptions = {
  signedIn?: boolean;
  role?: 'OWNER' | 'ADMIN';
  active?: boolean;
  nonstaff?: boolean;
  members?: (typeof memberFixture)[];
  wallets?: {
    user_id: string;
    available_centavos: number;
    reserved_centavos: number;
  }[];
  staff?: StaffProfile[];
  audit?: (typeof auditFixture)[];
  topups?: (typeof topupFixture)[];
  channels?: (typeof discordChannelFixture)[];
  lobbies?: LobbyWithRelations[];
  transactions?: { id: string; amount_centavos: number; created_at: string }[];
  failTable?: string;
  logoutFails?: boolean;
};
let instance = 0;

export async function dashboardClient(options: MockOptions = {}) {
  const state = {
    role: options.role ?? 'OWNER',
    active: options.active ?? true,
    nonstaff: options.nonstaff ?? false,
    failTable: options.failTable ?? '',
    logoutFails: options.logoutFails ?? false,
  };
  let profiles = options.staff ?? [ownerFixture, adminFixture];
  const members = options.members ?? [];
  const wallets =
    options.wallets ??
    members.map((member) => ({ user_id: member.id, ...member.wallets }));
  const audits = options.audit ?? [];
  let topups = options.topups ?? [];
  const channels = options.channels ?? [discordChannelFixture];
  let lobbies = structuredClone(options.lobbies ?? []);
  const transactions = options.transactions ?? [];
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
    query: URLSearchParams;
  }[] = [];
  const currentStaff = () => ({
    ...(state.role === 'OWNER' ? ownerFixture : adminFixture),
    active: state.active,
  });
  const user = () => ({
    id: currentStaff().auth_user_id,
    email: currentStaff().email,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: ownerFixture.created_at,
  });
  function accessToken() {
    return `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user().id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
  }
  const session = () => ({
    access_token: accessToken(),
    refresh_token: 'test-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: user(),
  });
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'dashboard-test.example.invalid')
      throw new Error('Tests cannot call a live project.');
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    calls.push({
      path: url.pathname,
      method: request.method,
      body,
      query: url.searchParams,
    });
    const reply = (data: unknown, status = 200, count?: number) =>
      new Response(request.method === 'HEAD' ? null : JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(count === undefined ? {} : { 'Content-Range': `0-0/${count}` }),
        },
      });
    const name = url.pathname.split('/').at(-1);
    if (name === 'token') return reply(session());
    if (name === 'user') return reply(user());
    if (name === 'logout')
      return state.logoutFails
        ? reply({ message: 'Unavailable' }, 500)
        : reply({});
    if (name === 'get_staff_session')
      return state.active && !state.nonstaff
        ? reply(currentStaff())
        : reply({ code: '42501', message: 'Active staff required' }, 403);
    if (name === 'record_staff_login') return reply(null);
    if (
      name === 'owner_set_admin' ||
      name === 'owner_set_staff_discord' ||
      name === 'owner_resolve_topup_review'
    ) {
      if (state.role !== 'OWNER' || !state.active)
        return reply({ code: '42501', message: 'Active OWNER required' }, 403);
      if (body.p_email === ownerFixture.email)
        return reply({ code: '42501', message: 'Cannot change OWNER' }, 403);
      if (body.p_email === 'missing@example.com')
        return reply(
          {
            code: '22023',
            message: 'Existing confirmed Supabase Auth account required',
          },
          400,
        );
      if (name === 'owner_resolve_topup_review') {
        const current = topups.find((topup) => topup.id === body.p_topup_id);
        if (!current)
          return reply({ code: 'P0002', message: 'Not found' }, 404);
        const updated: TopupWithMember = {
          ...current,
          status: 'RESOLVED',
          review_resolution:
            body.p_decision === 'APPROVE'
              ? 'APPROVED_CREDIT'
              : 'REJECTED_CREDIT',
          review_note: String(body.p_reason),
          reviewed_by: ownerFixture.id,
          resolved_at: new Date().toISOString(),
          credited_at:
            body.p_decision === 'APPROVE'
              ? new Date().toISOString()
              : current.credited_at,
        };
        topups = topups.map((topup) =>
          topup.id === updated.id ? updated : topup,
        );
        return reply(updated);
      }
      const previous = profiles.find((staff) =>
        name === 'owner_set_admin'
          ? staff.email === body.p_email
          : staff.id === body.p_staff_id,
      );
      const updated = {
        ...(previous ?? adminFixture),
        email:
          typeof body.p_email === 'string'
            ? body.p_email
            : (previous ?? adminFixture).email,
        discord_user_id:
          name === 'owner_set_staff_discord'
            ? (body.p_discord_user_id as string | null)
            : ((body.p_discord_user_id as string | null) ??
              previous?.discord_user_id ??
              null),
        active:
          name === 'owner_set_admin'
            ? Boolean(body.p_active)
            : (previous?.active ?? true),
      };
      profiles = [
        ...profiles.filter((staff) => staff.id !== updated.id),
        updated,
      ];
      return reply(updated);
    }
    if (name === 'create_lobby') {
      if (!state.active || state.nonstaff)
        return reply({ code: '42501', message: 'Active staff required' }, 403);
      const channel = channels.find(
        (entry) => entry.channel_id === body.p_discord_channel_id,
      );
      if (!channel)
        return reply(
          { code: '22023', message: 'Invalid Discord channel' },
          400,
        );
      const created = {
        ...lobbyFixture,
        id: '60000000-0000-4000-8000-000000000099',
        display_name: String(body.p_display_name),
        discord_guild_id: String(body.p_discord_guild_id),
        discord_channel_id: String(body.p_discord_channel_id),
        roster_entry_centavos: Number(body.p_roster_entry_centavos),
        side_betting_enabled: Boolean(body.p_side_betting_enabled),
        side_bet_min_centavos:
          body.p_side_bet_min_centavos === null
            ? null
            : Number(body.p_side_bet_min_centavos),
        side_bet_max_centavos:
          body.p_side_bet_max_centavos === null
            ? null
            : Number(body.p_side_bet_max_centavos),
        platform_fee_bps: Number(body.p_platform_fee_bps),
        discord_channels: { channel_name: channel.channel_name },
        lobby_players: [],
      };
      lobbies = [created, ...lobbies];
      const row = Object.fromEntries(
        Object.entries(created).filter(
          ([key]) =>
            key !== 'discord_channels' &&
            key !== 'lobby_players' &&
            key !== 'side_bets',
        ),
      );
      return reply(row);
    }
    if (name === 'add_lobby_player') {
      if (!state.active || state.nonstaff)
        return reply({ code: '42501', message: 'Active staff required' }, 403);
      const lobby = lobbies.find((entry) => entry.id === body.p_lobby_id);
      const member = members.find((entry) => entry.id === body.p_member_id);
      if (!lobby || !member)
        return reply({ code: 'P0002', message: 'Not found' }, 404);
      if (
        (member.wallets?.available_centavos ?? 0) < lobby.roster_entry_centavos
      )
        return reply({ code: '22003', message: 'Insufficient balance' }, 400);
      const player = {
        id: '61000000-0000-4000-8000-000000000001',
        lobby_id: lobby.id,
        user_id: member.id,
        discord_user_id: member.discord_user_id,
        display_name:
          member.display_name ??
          member.discord_username ??
          member.discord_user_id,
        team: body.p_team as 'RADIANT' | 'DIRE',
        stake_centavos: lobby.roster_entry_centavos,
        status: 'ACTIVE' as const,
        added_by: currentStaff().id,
        added_source: 'DASHBOARD' as const,
        added_at: new Date().toISOString(),
        removed_by: null,
        removed_at: null,
        removed_source: null,
        members: {
          discord_user_id: member.discord_user_id,
          discord_username: member.discord_username,
          display_name: member.display_name,
        },
      };
      lobby.lobby_players.push(player);
      lobby.discord_revision += 1;
      lobby.financial_commitment_at ??= new Date().toISOString();
      return reply(player);
    }
    if (name === 'remove_lobby_player') {
      const lobby = lobbies.find((entry) =>
        entry.lobby_players.some(
          (player) => player.id === body.p_lobby_player_id,
        ),
      );
      const player = lobby?.lobby_players.find(
        (entry) => entry.id === body.p_lobby_player_id,
      );
      if (!lobby || !player)
        return reply({ code: 'P0002', message: 'Not found' }, 404);
      player.status = 'REMOVED';
      player.removed_by = currentStaff().id;
      player.removed_at = new Date().toISOString();
      player.removed_source = 'DASHBOARD';
      lobby.discord_revision += 1;
      return reply(player);
    }
    if (name === 'update_lobby') {
      const lobby = lobbies.find((entry) => entry.id === body.p_lobby_id);
      if (!lobby) return reply({ code: 'P0002', message: 'Not found' }, 404);
      const committed =
        lobby.financial_commitment_at !== null ||
        lobby.lobby_players.length > 0;
      if (
        committed &&
        (Number(body.p_roster_entry_centavos) !== lobby.roster_entry_centavos ||
          Number(body.p_platform_fee_bps) !== lobby.platform_fee_bps ||
          body.p_discord_channel_id !== lobby.discord_channel_id ||
          Boolean(body.p_side_betting_enabled) !== lobby.side_betting_enabled ||
          body.p_side_bet_min_centavos !== lobby.side_bet_min_centavos ||
          body.p_side_bet_max_centavos !== lobby.side_bet_max_centavos)
      )
        return reply(
          { code: '42501', message: 'Financial lobby terms are immutable' },
          403,
        );
      const channel = channels.find(
        (entry) => entry.channel_id === body.p_discord_channel_id,
      );
      if (!channel)
        return reply({ code: '22023', message: 'Invalid channel' }, 400);
      lobby.display_name = String(body.p_display_name);
      lobby.discord_channel_id = String(body.p_discord_channel_id);
      lobby.roster_entry_centavos = Number(body.p_roster_entry_centavos);
      lobby.side_betting_enabled = Boolean(body.p_side_betting_enabled);
      lobby.side_bet_min_centavos =
        body.p_side_bet_min_centavos === null
          ? null
          : Number(body.p_side_bet_min_centavos);
      lobby.side_bet_max_centavos =
        body.p_side_bet_max_centavos === null
          ? null
          : Number(body.p_side_bet_max_centavos);
      lobby.platform_fee_bps = Number(body.p_platform_fee_bps);
      lobby.discord_channels = { channel_name: channel.channel_name };
      lobby.discord_revision += 1;
      return reply(lobby);
    }
    if (
      name === 'postpone_lobby' ||
      name === 'resume_lobby' ||
      name === 'cancel_lobby' ||
      name === 'archive_lobby'
    ) {
      const lobby = lobbies.find((entry) => entry.id === body.p_lobby_id);
      if (!lobby) return reply({ code: 'P0002', message: 'Not found' }, 404);
      if (name === 'archive_lobby' && state.role !== 'OWNER')
        return reply({ code: '42501', message: 'OWNER role required' }, 403);
      lobby.status =
        name === 'postpone_lobby'
          ? 'POSTPONED'
          : name === 'resume_lobby'
            ? 'OPEN'
            : name === 'cancel_lobby'
              ? 'CANCELLED'
              : 'ARCHIVED';
      if (name === 'archive_lobby')
        lobby.archived_at = new Date().toISOString();
      if (name === 'cancel_lobby') {
        for (const player of lobby.lobby_players) {
          if (player.status !== 'ACTIVE') continue;
          player.status = 'REMOVED';
          player.removed_by = currentStaff().id;
          player.removed_at = new Date().toISOString();
          player.removed_source = 'LOBBY_CANCELLED';
        }
      }
      lobby.discord_revision += 1;
      return reply(lobby);
    }
    if (name === state.failTable)
      return reply(
        {
          code: 'TEST_UNAVAILABLE',
          message: 'Do not expose this internal error',
        },
        503,
      );
    const page = <T>(rows: T[]) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return reply(rows.slice(offset, offset + limit), 200, rows.length);
    };
    if (name === 'wallets') return page(wallets);
    if (name === 'wallet_transactions') return page(transactions);
    if (name === 'topups') return page(topups);
    if (name === 'discord_channels') {
      let result = channels;
      if (url.searchParams.get('active') === 'eq.true')
        result = result.filter((channel) => channel.active);
      if (url.searchParams.get('can_post') === 'eq.true')
        result = result.filter((channel) => channel.can_post);
      return page(result);
    }
    if (name === 'lobbies') {
      const requestedId = url.searchParams.get('id')?.replace(/^eq\./, '');
      const rows = requestedId
        ? lobbies.filter((lobby) => lobby.id === requestedId)
        : lobbies;
      if (
        request.headers
          .get('accept')
          ?.includes('application/vnd.pgrst.object+json')
      )
        return rows[0]
          ? reply(rows[0])
          : reply({ code: 'PGRST116', message: 'Not found' }, 406);
      return page(rows);
    }
    if (name === 'members') return page(members);
    if (name === 'staff_profiles') {
      let result =
        state.role === 'OWNER'
          ? profiles
          : profiles.filter((staff) => staff.auth_user_id === user().id);
      if (url.searchParams.has('role'))
        result = result.filter(
          (staff) => `eq.${staff.role}` === url.searchParams.get('role'),
        );
      if (url.searchParams.has('active'))
        result = result.filter(
          (staff) => `eq.${staff.active}` === url.searchParams.get('active'),
        );
      return page(result);
    }
    if (name === 'audit_logs') {
      let result = state.role === 'OWNER' ? audits : [];
      const source = url.searchParams.get('source');
      if (source)
        result = result.filter((row) => `eq.${row.source}` === source);
      const action = url.searchParams.get('action');
      if (action)
        result = result.filter((row) =>
          row.action.toLowerCase().includes(action.slice(7, -1).toLowerCase()),
        );
      for (const boundary of url.searchParams.getAll('created_at')) {
        if (boundary.startsWith('gte.'))
          result = result.filter(
            (row) => new Date(row.created_at) >= new Date(boundary.slice(4)),
          );
        if (boundary.startsWith('lt.'))
          result = result.filter(
            (row) => new Date(row.created_at) < new Date(boundary.slice(3)),
          );
      }
      return page(result);
    }
    throw new Error(`Unexpected test request: ${url.pathname}`);
  };
  const client = createClient(
    'https://dashboard-test.example.invalid',
    'test-public-key',
    {
      global: { fetch: fetcher },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `dashboard-test-${++instance}`,
      },
    },
  );
  if (options.signedIn)
    await client.auth.setSession({
      access_token: accessToken(),
      refresh_token: 'test-refresh',
    });
  return { client, state, calls };
}
