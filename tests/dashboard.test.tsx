// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/dashboard/App';
import {
  dashboardClient,
  ownerFixture,
  adminFixture,
  auditFixture,
  memberFixture,
  discordChannelFixture,
  lobbyFixture,
} from './helpers/dashboardClient';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
function show(
  client: Awaited<ReturnType<typeof dashboardClient>>['client'],
  path = '/overview',
) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App client={client} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe('dashboard sessions and direct routes', () => {
  it('revalidates token refresh without duplicating login audits', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    show(client, '/lobbies');
    await screen.findByRole('heading', { name: 'Lobbies', level: 1 });
    const before = calls.filter((call) =>
      call.path.endsWith('/get_staff_session'),
    ).length;
    await act(async () => {
      await client.auth.refreshSession();
    });
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path.endsWith('/get_staff_session')).length,
      ).toBeGreaterThan(before),
    );
    expect(
      screen.getByRole('heading', { name: 'Lobbies', level: 1 }),
    ).toBeVisible();
    expect(
      calls.filter((call) => call.path.endsWith('/record_staff_login')),
    ).toHaveLength(0);
  });
  it('keeps access closed if logout fails instead of restoring it on focus', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      logoutFails: true,
    });
    const user = show(client, '/lobbies');
    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(
      await screen.findByText('Sign out could not be completed. Please retry.'),
    ).toBeVisible();
    act(() => window.dispatchEvent(new Event('focus')));
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry sign out' }),
    ).toBeVisible();
  });
  it('redirects unauthenticated direct navigation to login', async () => {
    const { client } = await dashboardClient();
    show(client, '/admins');
    expect(
      await screen.findByRole('heading', { name: 'Staff sign in' }),
    ).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it.each(['OWNER', 'ADMIN'] as const)(
    'allows %s email/password login using the existing Auth implementation',
    async (role) => {
      const { client, calls } = await dashboardClient({ role });
      const user = show(client, '/login');
      await user.type(
        await screen.findByLabelText('Email'),
        role === 'OWNER' ? ownerFixture.email : adminFixture.email,
      );
      await user.type(screen.getByLabelText('Password'), 'test-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(
        await screen.findByRole('heading', { name: 'Overview', level: 1 }),
      ).toBeVisible();
      await screen.findByText('Current Wallet Liability');
      expect(
        calls.filter((call) => call.path.endsWith('/record_staff_login')),
      ).toHaveLength(1);
    },
  );
  it.each([{ nonstaff: true }, { role: 'ADMIN' as const, active: false }])(
    'denies unauthorized restored sessions: %j',
    async (options) => {
      const { client } = await dashboardClient({ ...options, signedIn: true });
      show(client);
      expect(
        await screen.findByText(
          'You are not authorized to access this dashboard.',
        ),
      ).toBeVisible();
      await waitFor(async () =>
        expect((await client.auth.getSession()).data.session).toBeNull(),
      );
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    },
  );
  it('denies a non-staff email/password login and clears the session', async () => {
    const { client } = await dashboardClient({ nonstaff: true });
    const user = show(client, '/login');
    await user.type(
      await screen.findByLabelText('Email'),
      'member@example.com',
    );
    await user.type(screen.getByLabelText('Password'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText(
        'You are not authorized to access this dashboard.',
      ),
    ).toBeVisible();
    expect((await client.auth.getSession()).data.session).toBeNull();
  });
  it('restores a valid session and removes dashboard access on logout', async () => {
    const { client } = await dashboardClient({ signedIn: true });
    const user = show(client);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(
      await screen.findByRole('heading', { name: 'Staff sign in' }),
    ).toBeVisible();
    await waitFor(async () =>
      expect((await client.auth.getSession()).data.session).toBeNull(),
    );
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it('rechecks an inactive ADMIN when the window regains focus', async () => {
    const { client, state } = await dashboardClient({
      signedIn: true,
      role: 'ADMIN',
    });
    show(client, '/lobbies');
    await screen.findByRole('heading', { name: 'Lobbies', level: 1 });
    state.active = false;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(
      await screen.findByText(
        'You are not authorized to access this dashboard.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it.each([
    ['/members', 'Members'],
    ['/admins', 'Admins'],
    ['/audit', 'Audit Logs'],
    ['/settings', 'Settings'],
  ])('allows OWNER direct access to %s', async (path, title) => {
    const { client } = await dashboardClient({ signedIn: true });
    show(client, path);
    expect(
      await screen.findByRole('heading', { name: title, level: 1 }),
    ).toBeVisible();
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
  });
  it.each(['/members', '/admins', '/audit', '/settings'])(
    'blocks ADMIN direct navigation to %s without loading owner page data',
    async (path) => {
      const { client, calls } = await dashboardClient({
        signedIn: true,
        role: 'ADMIN',
      });
      show(client, path);
      expect(await screen.findByText('Access denied')).toBeVisible();
      const nav = within(screen.getByRole('navigation'));
      for (const label of ['Members', 'Admins', 'Audit Logs', 'Settings'])
        expect(
          nav.queryByRole('link', { name: label }),
        ).not.toBeInTheDocument();
      expect(
        calls.some((call) =>
          /\/(members|wallets|staff_profiles|audit_logs)$/.test(call.path),
        ),
      ).toBe(false);
    },
  );
  it.each([
    ['/overview', 'Overview'],
    ['/lobbies', 'Lobbies'],
    ['/rampage', 'Rampage'],
    ['/payments', 'Payments'],
    ['/cashouts', 'Cashouts'],
    ['/autopost', 'Autopost'],
  ])('allows ADMIN access to %s', async (path, title) => {
    const { client } = await dashboardClient({ signedIn: true, role: 'ADMIN' });
    show(client, path);
    expect(
      await screen.findByRole('heading', { name: title, level: 1 }),
    ).toBeVisible();
  });
});

describe('dashboard data and empty states', () => {
  it('preserves manual GCash wording for the future Phase 9 cashout', async () => {
    const { client } = await dashboardClient({ signedIn: true });
    show(client, '/cashouts');
    expect(
      await screen.findByText(
        'Manual GCash cashout will be implemented in Phase 9.',
      ),
    ).toBeVisible();
  });
  it('shows real wallet liability and member/admin counts without fabricated future totals', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      members: [memberFixture],
    });
    show(client);
    expect(await screen.findByText('₱1,250.00')).toBeVisible();
    expect(screen.getByText('Coming in Phase 7')).toBeVisible();
    expect(screen.getByText('Active Admins')).toBeVisible();
  });
  it('handles zero members with a read-only empty state', async () => {
    const { client } = await dashboardClient({ signedIn: true });
    show(client, '/members');
    expect(await screen.findByText('No members found.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /balance|deposit|deduct/i }),
    ).not.toBeInTheDocument();
  });
  it('renders member identity and exact available/reserved balances', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      members: [memberFixture],
    });
    show(client, '/members');
    expect(await screen.findByText('Member One')).toBeVisible();
    expect(screen.getByText('₱1,000.00')).toBeVisible();
    expect(screen.getByText('₱250.00')).toBeVisible();
  });
  it('handles empty audit events', async () => {
    const { client } = await dashboardClient({ signedIn: true });
    show(client, '/audit');
    expect(await screen.findByText('No matching audit events.')).toBeVisible();
  });
  it('renders the bootstrap audit, filters it, and offers no mutation controls', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      audit: [auditFixture],
    });
    const user = show(client, '/audit');
    expect(await screen.findByText('OWNER BOOTSTRAPPED')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Source'), 'DISCORD');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('No matching audit events.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /delete|edit|truncate/i }),
    ).not.toBeInTheDocument();
  });
  it('shows recoverable query errors without raw internal detail', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      failTable: 'members',
    });
    show(client, '/members');
    expect(
      await screen.findByRole('alert', {}, { timeout: 10000 }),
    ).toHaveTextContent('Unable to load members');
    expect(
      screen.queryByText('Do not expose this internal error'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('OWNER staff management UI', () => {
  it('protects the OWNER and shows the no-additional-admins state', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      staff: [ownerFixture],
    });
    show(client, '/admins');
    expect(
      await screen.findByText('No additional admins found.'),
    ).toBeVisible();
    expect(screen.getByText('Protected owner')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: `Disable ${ownerFixture.email}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete|demote|create owner/i }),
    ).not.toBeInTheDocument();
  });
  it('links an existing Auth account through the OWNER RPC after confirmation', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    const user = show(client, '/admins');
    await user.type(
      await screen.findByLabelText('Admin email'),
      'new@example.com',
    );
    await user.type(
      screen.getByLabelText(/Discord user ID.*optional/),
      '444444444444444444',
    );
    await user.click(screen.getByRole('button', { name: 'Review admin link' }));
    expect(
      calls.filter((call) => call.path.endsWith('/owner_set_admin')),
    ).toHaveLength(0);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Link admin',
      }),
    );
    await screen.findByText(
      'Staff account updated. The change was recorded in the audit log.',
    );
    expect(
      calls.find((call) => call.path.endsWith('/owner_set_admin'))?.body,
    ).toMatchObject({
      p_email: 'new@example.com',
      p_discord_user_id: '444444444444444444',
      p_active: true,
    });
    expect(
      calls.some(
        (call) => call.path.endsWith('/audit_logs') && call.method !== 'GET',
      ),
    ).toBe(false);
  });
  it('explains a missing confirmed Auth account', async () => {
    const { client } = await dashboardClient({ signedIn: true });
    const user = show(client, '/admins');
    await user.type(
      await screen.findByLabelText('Admin email'),
      'missing@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Review admin link' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Link admin',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Create or invite this user's Supabase Auth account first",
    );
  });
  it('updates a Discord mapping through the existing RPC with a reason', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    const user = show(client, '/admins');
    await user.click(
      await screen.findByRole('button', {
        name: `Edit Discord ID for ${adminFixture.email}`,
      }),
    );
    const dialog = within(screen.getByRole('dialog'));
    await user.clear(dialog.getByLabelText('Discord user ID'));
    await user.type(
      dialog.getByLabelText('Discord user ID'),
      '555555555555555555',
    );
    await user.type(
      dialog.getByLabelText('Reason (required)'),
      'Verified replacement account',
    );
    await user.click(dialog.getByRole('button', { name: 'Save mapping' }));
    await screen.findByText(
      'Staff account updated. The change was recorded in the audit log.',
    );
    expect(
      calls.find((call) => call.path.endsWith('/owner_set_staff_discord'))
        ?.body,
    ).toEqual({
      p_staff_id: adminFixture.id,
      p_discord_user_id: '555555555555555555',
      p_reason: 'Verified replacement account',
    });
  });
  it('requires a reason when disabling an ADMIN and preserves the mapping', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    const user = show(client, '/admins');
    await user.click(
      await screen.findByRole('button', {
        name: `Disable ${adminFixture.email}`,
      }),
    );
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText('Reason (required)')).toBeRequired();
    await user.type(
      dialog.getByLabelText('Reason (required)'),
      'End of staff access',
    );
    await user.click(dialog.getByRole('button', { name: 'Disable admin' }));
    await screen.findByText(
      'Staff account updated. The change was recorded in the audit log.',
    );
    expect(
      calls.find((call) => call.path.endsWith('/owner_set_admin'))?.body,
    ).toMatchObject({
      p_email: adminFixture.email,
      p_active: false,
      p_discord_user_id: null,
      p_reason: 'End of staff access',
    });
  });
});

describe('Phase 4 lobby dashboard', () => {
  it.each(['OWNER', 'ADMIN'] as const)(
    'allows %s to access real lobby management',
    async (role) => {
      const { client } = await dashboardClient({ signedIn: true, role });
      show(client, '/lobbies');
      expect(
        await screen.findByRole('heading', { name: 'Create Lobby' }),
      ).toBeVisible();
      expect(await screen.findByText('No lobbies yet.')).toBeVisible();
    },
  );

  it('shows the same deterministic roster matchup in lobby list and detail views', async () => {
    const player = (
      id: string,
      discordUserId: string,
      displayName: string,
      team: 'RADIANT' | 'DIRE',
      addedAt: string,
    ) => ({
      id,
      lobby_id: lobbyFixture.id,
      user_id: crypto.randomUUID(),
      discord_user_id: discordUserId,
      display_name: displayName,
      team,
      stake_centavos: 10_000,
      status: 'ACTIVE' as const,
      added_by: ownerFixture.id,
      added_source: 'DASHBOARD' as const,
      added_at: addedAt,
      removed_by: null,
      removed_at: null,
      removed_source: null,
    });
    const lobby = {
      ...lobbyFixture,
      lobby_players: [
        player(
          '61000000-0000-4000-8000-000000000001',
          '811111111111111111',
          'Yuji',
          'RADIANT',
          '2026-09-15T00:00:00Z',
        ),
        player(
          '61000000-0000-4000-8000-000000000002',
          '822222222222222222',
          'kurimaw',
          'DIRE',
          '2026-09-15T00:01:00Z',
        ),
      ],
    };
    const { client } = await dashboardClient({
      signedIn: true,
      lobbies: [lobby],
    });
    const user = show(client, '/lobbies');
    expect(await screen.findByText('@Yuji vs @kurimaw')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'View' }));
    expect(await screen.findByText(/@Yuji vs.*@kurimaw/)).toBeVisible();
  });

  it('creates an OPEN lobby with exact money, cached channel, and fee snapshot', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    const user = show(client, '/lobbies');
    await user.type(await screen.findByLabelText('Lobby Name'), 'Lobby 1');
    await user.selectOptions(
      screen.getByLabelText('Discord Channel'),
      discordChannelFixture.channel_id,
    );
    await user.click(
      screen.getByLabelText(
        'Side Betting Enabled (Phase 5 configuration only)',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Create Lobby' }));
    expect(
      await screen.findByRole('heading', { name: 'Lobby 1' }),
    ).toBeVisible();
    expect(screen.getByText('5% of winning profit')).toBeVisible();
    expect(screen.getByText('#scrim-betting')).toBeVisible();
    expect(
      calls.find((call) => call.path.endsWith('/create_lobby'))?.body,
    ).toMatchObject({
      p_roster_entry_centavos: 10_000,
      p_side_bet_min_centavos: 10_000,
      p_side_bet_max_centavos: 500_000,
      p_platform_fee_bps: 500,
      p_discord_channel_id: discordChannelFixture.channel_id,
    });
  });

  it('rejects malformed money and excessive fee before calling the lobby RPC', async () => {
    const { client, calls } = await dashboardClient({ signedIn: true });
    const user = show(client, '/lobbies');
    await user.type(await screen.findByLabelText('Lobby Name'), 'Bad Lobby');
    await user.selectOptions(
      screen.getByLabelText('Discord Channel'),
      discordChannelFixture.channel_id,
    );
    await user.clear(screen.getByLabelText('Roster Entry'));
    await user.type(screen.getByLabelText('Roster Entry'), '1e3');
    await user.clear(screen.getByLabelText(/Platform Fee/));
    await user.type(screen.getByLabelText(/Platform Fee/), '11');
    await user.click(screen.getByRole('button', { name: 'Create Lobby' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /PHP amount|percentage|Platform fee/,
    );
    expect(calls.some((call) => call.path.endsWith('/create_lobby'))).toBe(
      false,
    );
  });

  it('uses only safe cached postable Discord channels in the selector', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      channels: [
        discordChannelFixture,
        {
          ...discordChannelFixture,
          channel_id: '777777777777777779',
          channel_name: 'private-read-only',
          can_post: false,
        },
      ],
    });
    show(client, '/lobbies');
    const selector = await screen.findByLabelText('Discord Channel');
    expect(
      await within(selector).findByRole('option', { name: '#scrim-betting' }),
    ).toBeVisible();
    expect(
      within(selector).queryByText('#private-read-only'),
    ).not.toBeInTheDocument();
  });

  it('searches active members, displays balance, and adds a player', async () => {
    const lobby = { ...lobbyFixture, lobby_players: [] };
    const { client, calls } = await dashboardClient({
      signedIn: true,
      members: [memberFixture],
      lobbies: [lobby],
    });
    const user = show(client, `/lobbies/${lobby.id}`);
    await user.click(
      (await screen.findAllByRole('button', { name: 'Add Player' }))[0]!,
    );
    expect(await screen.findByText('Available: ₱1,000.00')).toBeVisible();
    await user.type(
      screen.getByPlaceholderText('Display name, username, or Discord ID'),
      'Member One',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(
      await screen.findByRole('button', { name: 'Add to Radiant' }),
    );
    expect(
      calls.find((call) => call.path.endsWith('/add_lobby_player'))?.body,
    ).toEqual({
      p_lobby_id: lobby.id,
      p_member_id: memberFixture.id,
      p_team: 'RADIANT',
    });
  });

  it('disables roster addition when available balance is insufficient', async () => {
    const lobby = { ...lobbyFixture, lobby_players: [] };
    const lowBalanceMember = {
      ...memberFixture,
      wallets: { available_centavos: 9_999, reserved_centavos: 0 },
    };
    const { client } = await dashboardClient({
      signedIn: true,
      members: [lowBalanceMember],
      lobbies: [lobby],
    });
    const user = show(client, `/lobbies/${lobby.id}`);
    await user.click(
      (await screen.findAllByRole('button', { name: 'Add Player' }))[0]!,
    );
    expect(
      await screen.findByText('Insufficient available balance.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Add to Radiant' }),
    ).toBeDisabled();
  });

  it('requires confirmation before removing and refunding an active player', async () => {
    const player = {
      id: '61000000-0000-4000-8000-000000000001',
      lobby_id: lobbyFixture.id,
      user_id: memberFixture.id,
      discord_user_id: memberFixture.discord_user_id,
      display_name: 'Member One',
      team: 'RADIANT' as const,
      stake_centavos: 10_000,
      status: 'ACTIVE' as const,
      added_by: ownerFixture.id,
      added_source: 'DASHBOARD' as const,
      added_at: '2026-09-15T00:01:00Z',
      removed_by: null,
      removed_at: null,
      removed_source: null,
      members: {
        discord_user_id: memberFixture.discord_user_id,
        discord_username: memberFixture.discord_username,
        display_name: memberFixture.display_name,
      },
    };
    const lobby = { ...lobbyFixture, lobby_players: [player] };
    const { client, calls } = await dashboardClient({
      signedIn: true,
      members: [memberFixture],
      lobbies: [lobby],
    });
    const user = show(client, `/lobbies/${lobby.id}`);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(
      dialog.getByText(
        '₱100.00 reserved roster entry will be returned to their available balance.',
      ),
    ).toBeVisible();
    expect(
      calls.some((call) => call.path.endsWith('/remove_lobby_player')),
    ).toBe(false);
    await user.click(dialog.getByRole('button', { name: 'Remove & Refund' }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path.endsWith('/remove_lobby_player'))?.body,
      ).toEqual({ p_lobby_player_id: player.id }),
    );
  });

  it('shows READY TO LOCK without changing a full lobby from OPEN', async () => {
    const full = Array.from({ length: 10 }, (_, index) => ({
      id: `6${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
      lobby_id: lobbyFixture.id,
      user_id: `7${String(index).padStart(7, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
      discord_user_id: `8${String(index).padStart(17, '0')}`,
      display_name: `Player ${index + 1}`,
      team: index < 5 ? ('RADIANT' as const) : ('DIRE' as const),
      stake_centavos: 10_000,
      status: 'ACTIVE' as const,
      added_by: ownerFixture.id,
      added_source: 'DASHBOARD' as const,
      added_at: '2026-09-15T00:01:00Z',
      removed_by: null,
      removed_at: null,
      removed_source: null,
    }));
    const { client } = await dashboardClient({
      signedIn: true,
      lobbies: [{ ...lobbyFixture, status: 'OPEN', lobby_players: full }],
    });
    show(client, `/lobbies/${lobbyFixture.id}`);
    expect(await screen.findByText('✅ ROSTERS FULL')).toBeVisible();
    expect(screen.getAllByText('READY TO LOCK').length).toBeGreaterThan(0);
    expect(screen.getByText('STATUS: OPEN')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /lock/i }),
    ).not.toBeInTheDocument();
  });

  it('refetches lobby detail when Realtime roster or side-bet events arrive', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [{ ...lobbyFixture, lobby_players: [] }],
    });
    let rosterCallback: (() => void) | undefined;
    let betCallback: (() => void) | undefined;
    const fakeChannel = {
      on: vi.fn(
        (_: string, filter: { table: string }, callback: () => void) => {
          if (filter.table === 'lobby_players') rosterCallback = callback;
          if (filter.table === 'side_bets') betCallback = callback;
          return fakeChannel;
        },
      ),
      subscribe: vi.fn(() => fakeChannel),
    };
    vi.spyOn(client, 'channel').mockReturnValue(fakeChannel as never);
    vi.spyOn(client, 'removeChannel').mockResolvedValue('ok' as never);
    show(client, `/lobbies/${lobbyFixture.id}`);
    await screen.findByText('Live Pool Summary');
    const before = calls.filter((call) =>
      call.path.endsWith('/lobbies'),
    ).length;
    act(() => rosterCallback?.());
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path.endsWith('/lobbies')).length,
      ).toBeGreaterThan(before),
    );
    const afterRoster = calls.filter((call) =>
      call.path.endsWith('/lobbies'),
    ).length;
    act(() => betCallback?.());
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path.endsWith('/lobbies')).length,
      ).toBeGreaterThan(afterRoster),
    );
  });

  it('shows complete active and cancelled side-bet history with combined pools', async () => {
    const base = {
      id: '71000000-0000-4000-8000-000000000001',
      lobby_id: lobbyFixture.id,
      user_id: memberFixture.id,
      discord_user_id: memberFixture.discord_user_id,
      display_name: 'Member One',
      requested_amount_centavos: 20_000,
      accepted_amount_centavos: 20_000,
      placed_at: '2026-09-15T01:00:00Z',
      discord_interaction_id: '666666666666666666',
      created_at: '2026-09-15T01:00:00Z',
      updated_at: '2026-09-15T01:00:00Z',
    };
    const { client } = await dashboardClient({
      signedIn: true,
      lobbies: [
        {
          ...lobbyFixture,
          side_bets: [
            {
              ...base,
              bet_number: 3505,
              side: 'RADIANT',
              status: 'ACTIVE',
              cancelled_at: null,
              cancelled_source: null,
              cancel_interaction_id: null,
            },
            {
              ...base,
              id: '71000000-0000-4000-8000-000000000002',
              bet_number: 3506,
              side: 'DIRE',
              status: 'CANCELLED',
              discord_interaction_id: '666666666666666667',
              cancel_interaction_id: '666666666666666668',
              cancelled_at: '2026-09-15T01:30:00Z',
              cancelled_source: 'DISCORD_SELF_SERVICE',
            },
          ],
        },
      ],
    });
    show(client, `/lobbies/${lobbyFixture.id}`);
    expect(await screen.findByText('Side Bets')).toBeVisible();
    expect(screen.getByText('Radiant Side Bets: ₱200.00')).toBeVisible();
    expect(screen.getByText('Dire Side Bets: ₱0.00')).toBeVisible();
    expect(screen.getByText('Leading Side: RADIANT')).toBeVisible();
    expect(screen.getByText('#3505')).toBeVisible();
    expect(screen.getByText('#3506')).toBeVisible();
    expect(screen.getByText('CANCELLED')).toBeVisible();
  });

  it('edits every financial setting before participation', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [lobbyFixture],
    });
    const user = show(client, `/lobbies/${lobbyFixture.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit Lobby' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit Lobby' }));
    await user.clear(dialog.getByLabelText('Lobby Name'));
    await user.type(dialog.getByLabelText('Lobby Name'), 'Lobby Renamed');
    await user.clear(dialog.getByLabelText('Roster Entry'));
    await user.type(dialog.getByLabelText('Roster Entry'), '200.00');
    await user.clear(dialog.getByLabelText('Side Bet Minimum'));
    await user.type(dialog.getByLabelText('Side Bet Minimum'), '200.00');
    await user.clear(dialog.getByLabelText(/Platform Fee/));
    await user.type(dialog.getByLabelText(/Platform Fee/), '6.00');
    await user.click(dialog.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path.endsWith('/update_lobby'))?.body,
      ).toMatchObject({
        p_display_name: 'Lobby Renamed',
        p_roster_entry_centavos: 20_000,
        p_side_bet_min_centavos: 20_000,
        p_platform_fee_bps: 600,
      }),
    );
  });

  it('locks committed financial fields while allowing a safe name edit', async () => {
    const committed = {
      ...lobbyFixture,
      financial_commitment_at: '2026-09-15T00:01:00Z',
    };
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [committed],
    });
    const user = show(client, `/lobbies/${committed.id}`);
    await user.click(
      await screen.findByRole('button', { name: 'Edit Safe Fields' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: 'Edit Lobby' }));
    expect(dialog.getByLabelText('Roster Entry')).toBeDisabled();
    expect(dialog.getByLabelText(/Platform Fee/)).toBeDisabled();
    expect(dialog.getByLabelText('Discord Channel')).toBeDisabled();
    await user.clear(dialog.getByLabelText('Lobby Name'));
    await user.type(dialog.getByLabelText('Lobby Name'), 'Safe Rename');
    await user.click(dialog.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path.endsWith('/update_lobby'))?.body,
      ).toMatchObject({ p_display_name: 'Safe Rename' }),
    );
  });

  it('postpones and resumes without showing roster mutation controls', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [lobbyFixture],
    });
    const user = show(client, `/lobbies/${lobbyFixture.id}`);
    await user.click(
      await screen.findByRole('button', { name: 'Postpone Lobby' }),
    );
    expect(await screen.findByText('STATUS: POSTPONED')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Player' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Resume Lobby' }));
    expect(await screen.findByText('STATUS: OPEN')).toBeVisible();
    expect(calls.some((call) => call.path.endsWith('/postpone_lobby'))).toBe(
      true,
    );
    expect(calls.some((call) => call.path.endsWith('/resume_lobby'))).toBe(
      true,
    );
  });

  it('requires cancellation confirmation and offers OWNER archival afterward', async () => {
    const { client, calls } = await dashboardClient({
      signedIn: true,
      lobbies: [
        {
          ...lobbyFixture,
          financial_commitment_at: '2026-09-15T00:01:00Z',
        },
      ],
    });
    const user = show(client, `/lobbies/${lobbyFixture.id}`);
    await user.click(
      await screen.findByRole('button', { name: 'Cancel Lobby' }),
    );
    const confirmation = within(screen.getByRole('dialog'));
    expect(
      confirmation.getByText(/all active roster and side-bet reservations/i),
    ).toBeVisible();
    await user.click(
      confirmation.getByRole('button', { name: 'Cancel & Refund' }),
    );
    expect(await screen.findByText('STATUS: CANCELLED')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive Lobby' })).toBeVisible();
    expect(calls.some((call) => call.path.endsWith('/cancel_lobby'))).toBe(
      true,
    );
  });

  it('hides cancelled and archived lobbies from Active and exposes status filters', async () => {
    const { client } = await dashboardClient({
      signedIn: true,
      lobbies: [
        lobbyFixture,
        {
          ...lobbyFixture,
          id: crypto.randomUUID(),
          display_name: 'Cancelled',
          status: 'CANCELLED',
        },
        {
          ...lobbyFixture,
          id: crypto.randomUUID(),
          display_name: 'Archived',
          status: 'ARCHIVED',
        },
      ],
    });
    const user = show(client, '/lobbies');
    expect(await screen.findByText('Lobby 1')).toBeVisible();
    expect(screen.queryByRole('cell', { name: 'Cancelled' })).toBeNull();
    expect(screen.queryByRole('cell', { name: 'Archived' })).toBeNull();
    await user.selectOptions(
      screen.getByLabelText('Lobby status filter'),
      'ARCHIVED',
    );
    expect(await screen.findByRole('cell', { name: /Archived/ })).toBeVisible();
    expect(screen.queryByRole('cell', { name: 'Lobby 1' })).toBeNull();
  });
});
