import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { getStaffSession, signInStaff } from '../src/shared/staff-auth';
import {
  ensureDiscordMember,
  requireDiscordRole,
} from '../src/server/discord-auth';
import { bootstrapOwner } from '../src/server/bootstrap-owner';

const userId = '00000000-0000-4000-8000-000000000001';
const staffId = '00000000-0000-4000-8000-000000000002';
const now = new Date().toISOString();
const profile = {
  id: staffId,
  auth_user_id: userId,
  email: 'owner@example.com',
  role: 'OWNER',
  discord_user_id: '111111111111111111',
  active: true,
  created_at: now,
  updated_at: now,
};
const identity = {
  id: userId,
  email: profile.email,
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: now,
};
const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
type StubOptions = {
  denied?: boolean;
  auditDenied?: boolean;
  inactive?: boolean;
  wrongIdentity?: boolean;
  admin?: boolean;
  tokenInvalid?: boolean;
  bootstrapConflict?: boolean;
};

function stubClient(options: StubOptions = {}) {
  const calls: {
    path: string;
    body: Record<string, unknown>;
    accept: string | null;
  }[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const text = await request.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      calls.push({ path, body, accept: request.headers.get('Accept') });
      const response = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (path.endsWith('/token'))
        return response({
          access_token: token,
          refresh_token: 'fake-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          user: identity,
        });
      if (path.endsWith('/user'))
        return options.tokenInvalid
          ? response({ message: 'Invalid token' }, 401)
          : response(identity);
      if (path.endsWith('/logout')) return response({});
      if (path.endsWith('/get_staff_session')) {
        if (options.denied)
          return response({ code: '42501', message: 'Denied' }, 403);
        return response({
          ...profile,
          role: options.admin ? 'ADMIN' : 'OWNER',
          active: !options.inactive,
          auth_user_id: options.wrongIdentity ? staffId : userId,
        });
      }
      if (path.endsWith('/record_staff_login'))
        return options.auditDenied
          ? response({ code: '42501', message: 'Denied' }, 403)
          : response(null);
      if (path.endsWith('/ensure_member'))
        return response({
          id: userId,
          discord_user_id: body.p_discord_user_id,
          discord_username: body.p_username,
          display_name: body.p_display_name,
          auth_user_id: null,
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        });
      if (path.endsWith('/authorize_discord'))
        return options.denied
          ? response({ code: '42501', message: 'Denied' }, 403)
          : response({
              id: staffId,
              role: body.p_required_role,
              discord_user_id: body.p_discord_user_id,
            });
      if (path.endsWith('/bootstrap_owner'))
        return options.bootstrapConflict
          ? response({ code: '23505', message: 'OWNER conflict' }, 409)
          : response(profile);
      throw new Error(`Unexpected request: ${path}`);
    },
  );
  const client = createClient(
    'https://example.supabase.co',
    'test-public-key',
    {
      global: { fetch: fetcher },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return { client, calls, fetcher };
}

describe('Supabase Auth integration', () => {
  it.each([false, true])(
    'signs in OWNER/ADMIN through email/password and verifies server staff data (admin=%s)',
    async (admin) => {
      const { client, calls } = stubClient({ admin });
      const staff = await signInStaff(
        client,
        'owner@example.com',
        'test-password',
      );
      expect(staff.role).toBe(admin ? 'ADMIN' : 'OWNER');
      expect(
        calls.find((call) => call.path.endsWith('/token'))?.body,
      ).toMatchObject({
        email: 'owner@example.com',
        password: 'test-password',
      });
      expect(calls.some((call) => call.path.endsWith('/user'))).toBe(true);
      expect(
        calls.find((call) => call.path.endsWith('/get_staff_session'))?.accept,
      ).toContain('application/vnd.pgrst.object+json');
      expect(
        calls.some((call) => call.path.endsWith('/record_staff_login')),
      ).toBe(true);
    },
  );
  it.each([
    { denied: true },
    { inactive: true },
    { wrongIdentity: true },
    { auditDenied: true },
    { tokenInvalid: true },
  ])(
    'clears the session when authorization or login auditing fails: %j',
    async (options) => {
      const { client } = stubClient(options);
      await expect(
        signInStaff(client, profile.email, 'test-password'),
      ).rejects.toThrow();
      expect((await client.auth.getSession()).data.session).toBeNull();
    },
  );
  it('does not accept an absent Supabase Auth session', async () => {
    const { client } = stubClient();
    await expect(getStaffSession(client)).rejects.toThrow('sign in again');
  });
});

describe('trusted Discord adapter', () => {
  const interaction = {
    user: {
      id: '123456789012345678',
      username: 'member',
      globalName: 'Member',
    },
  };
  it('ensures the invoking member and requests a single returned row', async () => {
    const { client, calls } = stubClient();
    const member = await ensureDiscordMember(client, interaction);
    expect(member.discord_user_id).toBe(interaction.user.id);
    expect(calls[0]?.body).toEqual({
      p_discord_user_id: interaction.user.id,
      p_username: 'member',
      p_display_name: 'Member',
    });
    expect(calls[0]?.accept).toContain('application/vnd.pgrst.object+json');
  });
  it('passes interaction.user.id to the staff RPC, ignoring server roles or target options', async () => {
    const { client, calls } = stubClient();
    const forged = {
      ...interaction,
      options: { user: profile.discord_user_id },
      member: { roles: ['OWNER'] },
    };
    await requireDiscordRole(client, forged, 'OWNER');
    expect(calls[0]?.body).toEqual({
      p_discord_user_id: interaction.user.id,
      p_required_role: 'OWNER',
    });
  });
  it('fails closed if staff authorization is rejected', async () => {
    const { client } = stubClient({ denied: true });
    await expect(
      requireDiscordRole(client, interaction, 'ADMIN'),
    ).rejects.toThrow('permission');
  });
  it('rejects invalid Discord identity before issuing a request', async () => {
    const { client, fetcher } = stubClient();
    await expect(
      ensureDiscordMember(client, {
        user: { ...interaction.user, id: 'display-name' },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('OWNER environment bootstrap', () => {
  it('uses OWNER_EMAIL and optional Discord ID from configuration', async () => {
    const { client, calls } = stubClient();
    await bootstrapOwner(client, {
      OWNER_EMAIL: profile.email,
      OWNER_DISCORD_USER_ID: profile.discord_user_id,
    });
    expect(calls[0]?.body).toEqual({
      p_owner_email: profile.email,
      p_discord_user_id: profile.discord_user_id,
    });
  });
  it('reports conflicts without retrying a second OWNER creation', async () => {
    const { client, calls } = stubClient({ bootstrapConflict: true });
    await expect(
      bootstrapOwner(client, { OWNER_EMAIL: profile.email }),
    ).rejects.toThrow('conflict');
    expect(calls).toHaveLength(1);
  });
  it('requires OWNER_EMAIL before issuing an RPC', async () => {
    const { client, fetcher } = stubClient();
    await expect(bootstrapOwner(client, {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
