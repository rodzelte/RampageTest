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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/dashboard/App';
import {
  dashboardClient,
  ownerFixture,
  adminFixture,
  auditFixture,
  memberFixture,
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
