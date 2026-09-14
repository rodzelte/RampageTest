import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000002',
  admin2: '00000000-0000-4000-8000-000000000003',
  member: '00000000-0000-4000-8000-000000000004',
  member2: '00000000-0000-4000-8000-000000000005',
  outsider: '00000000-0000-4000-8000-000000000006',
  otherOwner: '00000000-0000-4000-8000-000000000007',
  unconfirmed: '00000000-0000-4000-8000-000000000008',
};
const discord = {
  owner: '111111111111111111',
  admin: '222222222222222222',
  admin2: '333333333333333333',
  member: '444444444444444444',
  member2: '555555555555555555',
  fresh: '666666666666666666',
};
let db: PGlite;

// Execute as real PostgreSQL roles. A savepoint keeps a rejected SQL statement
// from aborting the enclosing test transaction.
async function asRole<T>(
  role: 'authenticated' | 'anon' | 'service_role',
  uid: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await db.exec('savepoint request_scope');
  try {
    await db.exec(`set local role ${role}`);
    await db.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)",
      [uid ?? '', role],
    );
    const result = await db.query<T>(sql, params);
    await db.exec('reset role; release savepoint request_scope');
    return result.rows;
  } catch (error) {
    await db.exec(
      'rollback to savepoint request_scope; release savepoint request_scope',
    );
    throw error;
  }
}

async function denied(sql: string, params: unknown[] = []) {
  await db.exec('savepoint rejected_statement');
  try {
    await expect(db.query(sql, params)).rejects.toThrow();
  } finally {
    await db.exec(
      'rollback to savepoint rejected_statement; release savepoint rejected_statement',
    );
  }
}

beforeAll(async () => {
  db = new PGlite();
  // Only Supabase's Auth schema/JWT helpers are shimmed. The application
  // migration, triggers, grants, RPCs, constraints, and RLS run unchanged.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
  `);
  const migration = await readFile(
    new URL(
      '../supabase/migrations/20260914000100_phase1_foundation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(migration);
  const phase3Migration = await readFile(
    new URL(
      '../supabase/migrations/20260914000200_phase3_topups.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase3Migration);
  for (const [name, id] of Object.entries(ids)) {
    await db.query('insert into auth.users values($1, $2, $3)', [
      id,
      `${name}@example.com`,
      name === 'unconfirmed' ? null : new Date().toISOString(),
    ]);
  }
  await db.exec('begin');
  await asRole('service_role', null, 'select public.bootstrap_owner($1, $2)', [
    'owner@example.com',
    discord.owner,
  ]);
  await asRole(
    'authenticated',
    ids.owner,
    'select public.owner_set_admin($1, $2)',
    ['admin@example.com', discord.admin],
  );
  await asRole(
    'authenticated',
    ids.owner,
    'select public.owner_set_admin($1, $2)',
    ['admin2@example.com', discord.admin2],
  );
  for (const name of ['member', 'member2'] as const) {
    await asRole('service_role', null, 'select public.ensure_member($1)', [
      discord[name],
    ]);
    // Trusted fixture only: represents a verified Auth link if member web access
    // is introduced later. No client RPC can assign or change this link.
    await db.query(
      'update public.members set auth_user_id=$1 where discord_user_id=$2',
      [ids[name], discord[name]],
    );
    await db.query(
      `insert into public.wallet_transactions(user_id,type,amount_centavos,available_before,available_after,reserved_before,reserved_after,source_type,source_id,actor_type,actor_id,idempotency_key)
      select id,'TEST_FIXTURE',0,0,0,0,0,'SYSTEM','fixture','SYSTEM','fixture',$1 from public.members where discord_user_id=$2`,
      [name, discord[name]],
    );
  }
  await db.exec('commit');
});
beforeEach(async () => {
  await db.exec('begin');
});
afterEach(async () => {
  await db.exec('rollback');
});
afterAll(async () => {
  await db.close();
});

describe('member identity and wallet foundation', () => {
  it('creates members using an immutable Discord ID and initializes a zero wallet', async () => {
    const rows = await asRole<{
      member: { id: string; discord_user_id: string };
    }>(
      'service_role',
      null,
      'select to_jsonb(public.ensure_member($1,$2,$3)) as member',
      [discord.fresh, 'sample', 'Sample'],
    );
    expect(rows[0]?.member.discord_user_id).toBe(discord.fresh);
    const wallet = await db.query<{
      available_centavos: number;
      reserved_centavos: number;
    }>(
      'select available_centavos,reserved_centavos from public.wallets where user_id=$1',
      [rows[0]?.member.id],
    );
    expect(wallet.rows[0]).toEqual({
      available_centavos: 0,
      reserved_centavos: 0,
    });
  });
  it('prevents duplicate Discord members and duplicate wallets on retries', async () => {
    await asRole('service_role', null, 'select public.ensure_member($1)', [
      discord.fresh,
    ]);
    await asRole('service_role', null, 'select public.ensure_member($1,$2)', [
      discord.fresh,
      'renamed',
    ]);
    const result = await db.query<{ count: number }>(
      'select count(*)::int as count from public.members m join public.wallets w on w.user_id=m.id where discord_user_id=$1',
      [discord.fresh],
    );
    expect(result.rows[0]?.count).toBe(1);
  });
  it('rejects invalid Discord IDs and financial identity changes', async () => {
    await expect(
      asRole('service_role', null, 'select public.ensure_member($1)', [
        'username',
      ]),
    ).rejects.toThrow('Invalid Discord');
    await denied(
      'update public.members set discord_user_id=$1 where discord_user_id=$2',
      [discord.fresh, discord.member],
    );
  });
  it('uses bigint centavos and rejects negative or unsafe balances', async () => {
    const columns = await db.query<{ data_type: string }>(
      "select data_type from information_schema.columns where table_schema='public' and table_name='wallets' and column_name in ('available_centavos','reserved_centavos')",
    );
    expect(columns.rows.map((row) => row.data_type)).toEqual([
      'bigint',
      'bigint',
    ]);
    await denied('update public.wallets set available_centavos=-1');
    await denied(
      'update public.wallets set reserved_centavos=9007199254740992',
    );
  });
  it('does not reactivate suspended members on identity refresh', async () => {
    await db.query(
      "update public.members set status='SUSPENDED' where discord_user_id=$1",
      [discord.member],
    );
    await asRole('service_role', null, 'select public.ensure_member($1)', [
      discord.member,
    ]);
    await expect(
      asRole(
        'service_role',
        null,
        "select public.authorize_discord($1,'MEMBER')",
        [discord.member],
      ),
    ).rejects.toThrow('Active member required');
  });
  it('authorizes active members for MEMBER operations', async () => {
    const rows = await asRole<{ actor: { role: string } }>(
      'service_role',
      null,
      "select public.authorize_discord($1,'MEMBER') actor",
      [discord.member],
    );
    expect(rows[0]?.actor.role).toBe('MEMBER');
  });
});

describe('OWNER bootstrap and staff authorization', () => {
  it('links an existing account case-insensitively and is idempotent', async () => {
    await asRole('service_role', null, 'select public.bootstrap_owner($1)', [
      ' OWNER@EXAMPLE.COM ',
    ]);
    const count = await db.query<{ count: number }>(
      "select count(*)::int count from public.staff_profiles where role='OWNER' and active",
    );
    expect(count.rows[0]?.count).toBe(1);
    const audits = await db.query<{ count: number }>(
      "select count(*)::int count from public.audit_logs where action='OWNER_BOOTSTRAPPED'",
    );
    expect(audits.rows[0]?.count).toBe(1);
  });
  it('fails safely if OWNER_EMAIL conflicts with the existing OWNER', async () => {
    await expect(
      asRole('service_role', null, 'select public.bootstrap_owner($1)', [
        'otherOwner@example.com',
      ]),
    ).rejects.toThrow('OWNER conflict');
    const rows = await db.query<{ auth_user_id: string }>(
      "select auth_user_id from public.staff_profiles where role='OWNER'",
    );
    expect(rows.rows[0]?.auth_user_id).toBe(ids.owner);
  });
  it('rejects absent, blank, and unconfirmed OWNER accounts', async () => {
    for (const email of [
      'missing@example.com',
      'unconfirmed@example.com',
      '',
      null,
    ]) {
      await expect(
        asRole('service_role', null, 'select public.bootstrap_owner($1)', [
          email,
        ]),
      ).rejects.toThrow();
    }
  });
  it('prevents a second OWNER even through direct privileged SQL', async () => {
    await denied(
      "insert into public.staff_profiles(auth_user_id,email,role) values($1,'otherOwner@example.com','OWNER')",
      [ids.otherOwner],
    );
  });
  it('prevents removing, deactivating, demoting, or reassigning the OWNER', async () => {
    await denied("delete from public.staff_profiles where role='OWNER'");
    await denied(
      "update public.staff_profiles set active=false where role='OWNER'",
    );
    await denied(
      "update public.staff_profiles set role='ADMIN' where role='OWNER'",
    );
    await denied(
      "update public.staff_profiles set auth_user_id=$1 where role='OWNER'",
      [ids.otherOwner],
    );
    await denied('truncate public.staff_profiles cascade');
  });
  it('supports multiple ADMIN accounts', async () => {
    const rows = await db.query<{ count: number }>(
      "select count(*)::int count from public.staff_profiles where role='ADMIN' and active",
    );
    expect(rows.rows[0]?.count).toBe(2);
  });
  it('prevents ADMIN and MEMBER from invoking OWNER-only RPCs', async () => {
    for (const actor of [ids.admin, ids.member, ids.outsider]) {
      await expect(
        asRole('authenticated', actor, 'select public.owner_set_admin($1)', [
          'outsider@example.com',
        ]),
      ).rejects.toThrow('Active OWNER required');
      await expect(
        asRole(
          'authenticated',
          actor,
          'select public.owner_set_staff_discord($1,$2,$3)',
          [ids.owner, discord.fresh, 'test'],
        ),
      ).rejects.toThrow('Active OWNER required');
    }
  });
  it('checks active staff and required role using the Discord mapping', async () => {
    await expect(
      asRole(
        'service_role',
        null,
        "select public.authorize_discord($1,'OWNER')",
        [discord.admin],
      ),
    ).rejects.toThrow('Insufficient staff');
    await expect(
      asRole(
        'service_role',
        null,
        "select public.authorize_discord($1,'ADMIN')",
        [discord.member],
      ),
    ).rejects.toThrow('Insufficient staff');
    const owner = await asRole<{ actor: { role: string } }>(
      'service_role',
      null,
      "select public.authorize_discord($1,'ADMIN') actor",
      [discord.owner],
    );
    expect(owner[0]?.actor.role).toBe('OWNER');
    await expect(
      asRole('service_role', null, 'select public.authorize_discord($1,$2)', [
        discord.owner,
        'anything',
      ]),
    ).rejects.toThrow('Invalid required role');
  });
  it('revokes Discord and dashboard privileges immediately when an ADMIN is disabled', async () => {
    await asRole(
      'authenticated',
      ids.owner,
      'select public.owner_set_admin($1,null,false,$2)',
      ['admin@example.com', 'Access revoked'],
    );
    await expect(
      asRole(
        'service_role',
        null,
        "select public.authorize_discord($1,'ADMIN')",
        [discord.admin],
      ),
    ).rejects.toThrow('Insufficient staff');
    await expect(
      asRole('authenticated', ids.admin, 'select public.get_staff_session()'),
    ).rejects.toThrow('Active staff');
    const rows = await asRole(
      'authenticated',
      ids.admin,
      'select * from public.wallets',
    );
    expect(rows).toHaveLength(0);
  });
  it('requires a disable reason and forbids changing OWNER via admin management', async () => {
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.owner_set_admin($1,null,false)',
        ['admin@example.com'],
      ),
    ).rejects.toThrow('requires a reason');
    await expect(
      asRole('authenticated', ids.owner, 'select public.owner_set_admin($1)', [
        'owner@example.com',
      ]),
    ).rejects.toThrow('Cannot change OWNER');
  });
  it('audits mapping changes, prevents duplicate mappings, and invalidates the old ID', async () => {
    const staff = await db.query<{ id: string }>(
      'select id from public.staff_profiles where auth_user_id=$1',
      [ids.admin],
    );
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.owner_set_staff_discord($1,$2,$3)',
        [staff.rows[0]?.id, discord.owner, 'Duplicate'],
      ),
    ).rejects.toThrow('unique');
    await asRole(
      'authenticated',
      ids.owner,
      'select public.owner_set_staff_discord($1,$2,$3)',
      [staff.rows[0]?.id, discord.fresh, 'Updated account'],
    );
    await expect(
      asRole(
        'service_role',
        null,
        "select public.authorize_discord($1,'ADMIN')",
        [discord.admin],
      ),
    ).rejects.toThrow();
    await asRole(
      'service_role',
      null,
      "select public.authorize_discord($1,'ADMIN')",
      [discord.fresh],
    );
    const logs = await db.query<{ reason: string }>(
      "select reason from public.audit_logs where action='ADMIN_DISCORD_ID_CHANGED'",
    );
    expect(logs.rows[0]?.reason).toBe('Updated account');
  });
  it('records staff login and rejects a nonstaff dashboard session', async () => {
    await asRole(
      'authenticated',
      ids.admin,
      'select public.record_staff_login()',
    );
    const rows = await db.query<{ actor_auth_user_id: string }>(
      "select actor_auth_user_id from public.audit_logs where action='STAFF_LOGIN'",
    );
    expect(rows.rows[0]?.actor_auth_user_id).toBe(ids.admin);
    await expect(
      asRole('authenticated', ids.member, 'select public.get_staff_session()'),
    ).rejects.toThrow();
  });
});

describe('RLS and immutable financial history', () => {
  it('enables RLS on all application tables', async () => {
    const rows = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    );
    expect(rows.rows).toHaveLength(6);
    expect(rows.rows.every((row) => row.relrowsecurity)).toBe(true);
  });
  it('restricts members to their own member, wallet, and transaction records', async () => {
    for (const table of ['members', 'wallets', 'wallet_transactions']) {
      const rows = await asRole(
        'authenticated',
        ids.member,
        `select * from public.${table}`,
      );
      expect(rows).toHaveLength(1);
      const outsiders = await asRole(
        'authenticated',
        ids.outsider,
        `select * from public.${table}`,
      );
      expect(outsiders).toHaveLength(0);
    }
    const members = await asRole<{ discord_user_id: string }>(
      'authenticated',
      ids.member,
      'select * from public.members',
    );
    expect(members[0]?.discord_user_id).toBe(discord.member);
    const other = await asRole(
      'authenticated',
      ids.member,
      'select w.* from public.wallets w where user_id=(select id from public.members where discord_user_id=$1)',
      [discord.member2],
    );
    expect(other).toHaveLength(0);
  });
  it('gives ADMIN financial read access but reserves full staff and audit visibility to OWNER', async () => {
    expect(
      await asRole('authenticated', ids.admin, 'select * from public.wallets'),
    ).toHaveLength(2);
    expect(
      await asRole(
        'authenticated',
        ids.admin,
        'select * from public.staff_profiles',
      ),
    ).toHaveLength(1);
    expect(
      await asRole(
        'authenticated',
        ids.admin,
        'select * from public.audit_logs',
      ),
    ).toHaveLength(0);
    expect(
      await asRole(
        'authenticated',
        ids.owner,
        'select * from public.staff_profiles',
      ),
    ).toHaveLength(3);
    expect(
      (
        await asRole(
          'authenticated',
          ids.owner,
          'select * from public.audit_logs',
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('denies anonymous reads and public execution of privileged RPCs', async () => {
    for (const table of [
      'members',
      'wallets',
      'wallet_transactions',
      'staff_profiles',
      'audit_logs',
    ]) {
      await expect(
        asRole('anon', null, `select * from public.${table}`),
      ).rejects.toThrow('permission denied');
    }
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(
        asRole(role, ids.owner, 'select public.ensure_member($1)', [
          discord.fresh,
        ]),
      ).rejects.toThrow('permission denied');
      await expect(
        asRole(role, ids.owner, 'select public.bootstrap_owner($1)', [
          'owner@example.com',
        ]),
      ).rejects.toThrow('permission denied');
      await expect(
        asRole(role, ids.owner, "select public.authorize_discord($1,'OWNER')", [
          discord.owner,
        ]),
      ).rejects.toThrow('permission denied');
    }
  });
  it('denies direct balance changes and self-promotion, including for service_role', async () => {
    for (const [role, uid] of [
      ['authenticated', ids.member],
      ['authenticated', ids.admin],
      ['authenticated', ids.owner],
      ['service_role', null],
    ] as const) {
      await expect(
        asRole(role, uid, 'update public.wallets set available_centavos=100'),
      ).rejects.toThrow('permission denied');
      await expect(
        asRole(role, uid, "update public.staff_profiles set role='OWNER'"),
      ).rejects.toThrow('permission denied');
      await expect(
        asRole(role, uid, 'update public.members set auth_user_id=$1', [
          ids.member,
        ]),
      ).rejects.toThrow('permission denied');
    }
  });
  it('prevents normal application writes, updates, deletes, and truncation of history', async () => {
    for (const [role, uid] of [
      ['authenticated', ids.member],
      ['authenticated', ids.admin],
      ['authenticated', ids.owner],
      ['service_role', null],
    ] as const) {
      for (const table of ['wallet_transactions', 'audit_logs']) {
        for (const sql of [
          `delete from public.${table}`,
          `update public.${table} set created_at=now()`,
          `truncate public.${table}`,
          `insert into public.${table}(id) values(gen_random_uuid())`,
        ]) {
          await expect(asRole(role, uid, sql)).rejects.toThrow(
            'permission denied',
          );
        }
      }
    }
  });
  it('rejects history modification through triggers even with elevated SQL privileges', async () => {
    for (const table of ['wallet_transactions', 'audit_logs']) {
      await denied(`update public.${table} set created_at=now()`);
      await denied(`delete from public.${table}`);
      await denied(`truncate public.${table}`);
    }
  });
  it('enforces unique ledger idempotency keys', async () => {
    await denied(`insert into public.wallet_transactions(user_id,type,amount_centavos,available_before,available_after,reserved_before,reserved_after,source_type,source_id,actor_type,actor_id,idempotency_key)
      select user_id,type,amount_centavos,available_before,available_after,reserved_before,reserved_after,source_type,source_id,actor_type,actor_id,idempotency_key from public.wallet_transactions limit 1`);
  });
});

async function createTopupFixture(options: {
  id?: string;
  memberDiscord?: string;
  amount?: number;
  expiresAt?: Date;
  providerPaymentId?: string;
}) {
  const id = options.id ?? '70000000-0000-4000-8000-000000000001';
  const member = await db.query<{ id: string }>(
    'select id from public.members where discord_user_id=$1',
    [options.memberDiscord ?? discord.member],
  );
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 30 * 60_000);
  await asRole(
    'service_role',
    null,
    'select public.create_topup($1,$2,$3,$4,$5)',
    [id, member.rows[0]?.id, options.amount ?? 50_000, 'QRPH_MOCK', expiresAt],
  );
  await asRole(
    'service_role',
    null,
    'select public.set_topup_provider($1,$2,$3)',
    [id, options.providerPaymentId ?? `qrph_mock_${id}`, `RMP-${id.slice(0, 8)}`],
  );
  return {
    id,
    memberId: member.rows[0]?.id as string,
    paymentId: options.providerPaymentId ?? `qrph_mock_${id}`,
    expiresAt,
  };
}

async function processTopup(
  fixture: Awaited<ReturnType<typeof createTopupFixture>>,
  options: {
    eventId?: string;
    amount?: number;
    paidAt?: Date;
    success?: boolean;
  } = {},
) {
  return asRole<{ topup: { status: string; credited_at: string | null } }>(
    'service_role',
    null,
    'select to_jsonb(public.process_verified_topup($1,$2,$3,$4,$5,$6,$7)) topup',
    [
      'QRPH_MOCK',
      fixture.paymentId,
      options.eventId ?? `event-${fixture.id}`,
      options.amount ?? 50_000,
      'PHP',
      options.paidAt ?? new Date(),
      options.success ?? true,
    ],
  );
}

describe('Phase 3 top-up transaction processing', () => {
  it('creates distinct PENDING topups for the correct member without changing either wallet', async () => {
    const first = await createTopupFixture({});
    const second = await createTopupFixture({
      id: '70000000-0000-4000-8000-000000000002',
      memberDiscord: discord.member2,
      providerPaymentId: 'qrph_mock_second_same_amount',
    });
    expect(first.id).not.toBe(second.id);
    expect(first.paymentId).not.toBe(second.paymentId);
    const rows = await db.query<{
      discord_user_id: string;
      status: string;
      available_centavos: number;
      reserved_centavos: number;
    }>(`select m.discord_user_id,t.status,w.available_centavos,w.reserved_centavos
        from public.topups t join public.members m on m.id=t.user_id
        join public.wallets w on w.user_id=t.user_id order by m.discord_user_id`);
    expect(rows.rows).toEqual([
      {
        discord_user_id: discord.member,
        status: 'PENDING',
        available_centavos: 0,
        reserved_centavos: 0,
      },
      {
        discord_user_id: discord.member2,
        status: 'PENDING',
        available_centavos: 0,
        reserved_centavos: 0,
      },
    ]);
  });

  it('credits an exact timely callback to only the provider-linked member', async () => {
    const first = await createTopupFixture({});
    await createTopupFixture({
      id: '70000000-0000-4000-8000-000000000002',
      memberDiscord: discord.member2,
      providerPaymentId: 'qrph_mock_second_same_amount',
    });
    const processed = await processTopup(first);
    expect(processed[0]?.topup.status).toBe('PAID');
    const wallets = await db.query<{
      discord_user_id: string;
      available_centavos: number;
      reserved_centavos: number;
    }>(
      `select m.discord_user_id,w.available_centavos,w.reserved_centavos
        from public.wallets w join public.members m on m.id=w.user_id
        where m.discord_user_id in ($1,$2) order by m.discord_user_id`,
      [discord.member, discord.member2],
    );
    expect(wallets.rows).toEqual([
      {
        discord_user_id: discord.member,
        available_centavos: 50_000,
        reserved_centavos: 0,
      },
      {
        discord_user_id: discord.member2,
        available_centavos: 0,
        reserved_centavos: 0,
      },
    ]);
  });

  it('handles five duplicate callbacks with one exact ledger credit', async () => {
    const fixture = await createTopupFixture({});
    for (let index = 0; index < 5; index += 1)
      await processTopup(fixture, { eventId: 'same-provider-event' });
    const ledger = await db.query<{
      count: number;
      total: number;
      available_before: number;
      available_after: number;
      reserved_before: number;
      reserved_after: number;
    }>(
      `select count(*)::int count,sum(amount_centavos)::int total,
        min(available_before)::int available_before,max(available_after)::int available_after,
        min(reserved_before)::int reserved_before,max(reserved_after)::int reserved_after
        from public.wallet_transactions where source_type='TOPUP' and source_id=$1`,
      [fixture.id],
    );
    expect(ledger.rows[0]).toEqual({
      count: 1,
      total: 50_000,
      available_before: 0,
      available_after: 50_000,
      reserved_before: 0,
      reserved_after: 0,
    });
  });

  it('routes amount mismatch to review without credit', async () => {
    const fixture = await createTopupFixture({});
    const result = await processTopup(fixture, { amount: 45_000 });
    expect(result[0]?.topup.status).toBe('AMOUNT_MISMATCH_REVIEW');
    const wallet = await db.query<{ available_centavos: number }>(
      'select available_centavos from public.wallets where user_id=$1',
      [fixture.memberId],
    );
    expect(wallet.rows[0]?.available_centavos).toBe(0);
  });

  it('routes a late exact payment to review without credit', async () => {
    const expiresAt = new Date(Date.now() + 30_000);
    const fixture = await createTopupFixture({ expiresAt });
    const result = await processTopup(fixture, {
      paidAt: new Date(expiresAt.getTime() + 30_000),
    });
    expect(result[0]?.topup.status).toBe('LATE_PAID_REVIEW');
    const ledger = await db.query<{ count: number }>(
      "select count(*)::int count from public.wallet_transactions where source_type='TOPUP'",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });

  it('expires an unpaid stale topup', async () => {
    const fixture = await createTopupFixture({
      expiresAt: new Date(Date.now() + 20),
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    await asRole('service_role', null, 'select public.expire_pending_topups()');
    const row = await db.query<{ status: string }>(
      'select status from public.topups where id=$1',
      [fixture.id],
    );
    expect(row.rows[0]?.status).toBe('EXPIRED');
  });

  it('marks provider/QR creation failure without changing the wallet', async () => {
    const fixture = await createTopupFixture({});
    await asRole(
      'service_role',
      null,
      'select public.fail_topup_creation($1,$2)',
      [fixture.id, 'test failure'],
    );
    const row = await db.query<{ status: string; available_centavos: number }>(
      `select t.status,w.available_centavos from public.topups t
       join public.wallets w on w.user_id=t.user_id where t.id=$1`,
      [fixture.id],
    );
    expect(row.rows[0]).toEqual({ status: 'FAILED', available_centavos: 0 });
  });

  it('allows only OWNER to explicitly approve the verified paid amount and prevents repeat review', async () => {
    const fixture = await createTopupFixture({});
    await processTopup(fixture, { amount: 45_000 });
    await expect(
      asRole(
        'authenticated',
        ids.admin,
        'select public.owner_resolve_topup_review($1,$2,$3,$4)',
        [fixture.id, 'APPROVE', 'Reviewed cash received', 45_000],
      ),
    ).rejects.toThrow('OWNER');
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.owner_resolve_topup_review($1,$2,$3,$4)',
        [fixture.id, 'APPROVE', 'Wrong amount', 50_000],
      ),
    ).rejects.toThrow('provider-paid');
    await asRole(
      'authenticated',
      ids.owner,
      'select public.owner_resolve_topup_review($1,$2,$3,$4)',
      [fixture.id, 'APPROVE', 'Reviewed cash received', 45_000],
    );
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.owner_resolve_topup_review($1,$2,$3,$4)',
        [fixture.id, 'APPROVE', 'Repeat', 45_000],
      ),
    ).rejects.toThrow('not awaiting review');
    const ledger = await db.query<{ count: number; total: number }>(
      `select count(*)::int count,sum(amount_centavos)::int total
       from public.wallet_transactions where source_type='TOPUP'`,
    );
    expect(ledger.rows[0]).toEqual({ count: 1, total: 45_000 });
  });

  it('allows OWNER to reject review without credit and preserves evidence', async () => {
    const fixture = await createTopupFixture({});
    await processTopup(fixture, { amount: 45_000 });
    await asRole(
      'authenticated',
      ids.owner,
      'select public.owner_resolve_topup_review($1,$2,$3,$4)',
      [fixture.id, 'REJECT', 'Payment refunded externally', null],
    );
    const row = await db.query<{
      status: string;
      review_resolution: string;
      provider_paid_amount_centavos: number;
      credited_at: string | null;
    }>(
      'select status,review_resolution,provider_paid_amount_centavos,credited_at from public.topups where id=$1',
      [fixture.id],
    );
    expect(row.rows[0]).toEqual({
      status: 'RESOLVED',
      review_resolution: 'REJECTED_CREDIT',
      provider_paid_amount_centavos: 45_000,
      credited_at: null,
    });
  });

  it('rejects unknown payment IDs and direct application writes', async () => {
    const fixture = await createTopupFixture({});
    await expect(
      asRole(
        'service_role',
        null,
        'select public.process_verified_topup($1,$2,$3,$4,$5,$6,$7)',
        ['QRPH_MOCK', 'unknown', 'event-unknown', 50_000, 'PHP', new Date(), true],
      ),
    ).rejects.toThrow('Unknown provider payment ID');
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        "update public.topups set status='PAID' where id=$1",
        [fixture.id],
      ),
    ).rejects.toThrow();
    await denied('update public.topups set amount_centavos=1 where id=$1', [
      fixture.id,
    ]);
    await denied('delete from public.topups where id=$1', [fixture.id]);
  });
});
