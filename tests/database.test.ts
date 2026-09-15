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
  const phase4Migration = await readFile(
    new URL(
      '../supabase/migrations/20260915000100_phase4_lobbies.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase4Migration);
  const phase4ManagementMigration = await readFile(
    new URL(
      '../supabase/migrations/20260915000200_phase4_lobby_management.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase4ManagementMigration);
  const phase4CompatibilityMigration = await readFile(
    new URL(
      '../supabase/migrations/20260915000300_phase4_schema_compatibility.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase4CompatibilityMigration);
  // Reapply in the harness to prove existing additive columns and named checks
  // are reconciled without duplicate-column/constraint failures.
  await db.exec(phase4CompatibilityMigration);
  const phase5Migration = await readFile(
    new URL(
      '../supabase/migrations/20260915000400_phase5_side_betting.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase5Migration);
  const phase5MemberCommandsMigration = await readFile(
    new URL(
      '../supabase/migrations/20260915000500_phase5_member_commands.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await db.exec(phase5MemberCommandsMigration);
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
    expect(rows.rows).toHaveLength(10);
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
    [
      id,
      options.providerPaymentId ?? `qrph_mock_${id}`,
      `RMP-${id.slice(0, 8)}`,
    ],
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
    const firstClaim = await asRole<{ notification: unknown }>(
      'service_role',
      null,
      'select public.claim_topup_notification($1) as notification',
      [fixture.id],
    );
    const duplicateClaim = await asRole<{ notification: unknown }>(
      'service_role',
      null,
      'select public.claim_topup_notification($1) as notification',
      [fixture.id],
    );
    expect(firstClaim[0]?.notification).toMatchObject({
      topup_id: fixture.id,
      credited_amount_centavos: 50_000,
    });
    expect(duplicateClaim[0]?.notification).toBeNull();
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
        [
          'QRPH_MOCK',
          'unknown',
          'event-unknown',
          50_000,
          'PHP',
          new Date(),
          true,
        ],
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

const lobbyChannel = {
  guild: '777777777777777777',
  id: '777777777777777778',
};

async function cacheLobbyChannel(
  channelId = lobbyChannel.id,
  name = 'scrim-betting',
) {
  await asRole(
    'service_role',
    null,
    'select public.sync_discord_channels($1,$2::jsonb)',
    [
      lobbyChannel.guild,
      JSON.stringify([
        {
          channel_id: channelId,
          channel_name: name,
          channel_type: 'GUILD_TEXT',
          can_post: true,
        },
      ]),
    ],
  );
}

async function createLobbyFixture(
  options: {
    actor?: string;
    name?: string;
    fee?: number;
    entry?: number;
    sideBetting?: boolean;
  } = {},
) {
  await cacheLobbyChannel();
  const sideBetting = options.sideBetting ?? true;
  const rows = await asRole<{ lobby: Record<string, unknown> }>(
    'authenticated',
    options.actor ?? ids.owner,
    'select to_jsonb(public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)) lobby',
    [
      options.name ?? 'Lobby 1',
      lobbyChannel.guild,
      lobbyChannel.id,
      options.entry ?? 10_000,
      sideBetting,
      sideBetting ? 10_000 : null,
      sideBetting ? 500_000 : null,
      options.fee ?? 500,
    ],
  );
  return rows[0]!.lobby as {
    id: string;
    status: string;
    platform_fee_bps: number;
    discord_revision: number;
  };
}

async function rosterMember(
  index: number,
  options: { balance?: number; active?: boolean } = {},
) {
  const discordId = `8${String(index).padStart(17, '0')}`;
  const rows = await asRole<{ member: { id: string } }>(
    'service_role',
    null,
    'select to_jsonb(public.ensure_member($1,$2,$3)) member',
    [discordId, `player${index}`, `Player ${index}`],
  );
  const memberId = rows[0]!.member.id;
  await db.query(
    'update public.wallets set available_centavos=$1 where user_id=$2',
    [options.balance ?? 100_000, memberId],
  );
  if (options.active === false)
    await db.query("update public.members set status='SUSPENDED' where id=$1", [
      memberId,
    ]);
  return memberId;
}

function rosterDiscord(index: number) {
  return `8${String(index).padStart(17, '0')}`;
}

async function activateLobbyMessage(
  lobbyId: string,
  revision = 1,
  messageId = '999999999999999999',
) {
  await asRole(
    'service_role',
    null,
    'select public.complete_lobby_discord_sync($1,$2,$3)',
    [lobbyId, revision, messageId],
  );
  return messageId;
}

async function addRosterPlayer(
  lobbyId: string,
  memberId: string,
  team: 'RADIANT' | 'DIRE',
  actor = ids.owner,
) {
  const rows = await asRole<{ player: { id: string; status: string } }>(
    'authenticated',
    actor,
    'select to_jsonb(public.add_lobby_player($1,$2,$3)) player',
    [lobbyId, memberId, team],
  );
  return rows[0]!.player;
}

describe('Phase 4 lobby and roster foundation', () => {
  it.each([
    ['OWNER', ids.owner],
    ['ADMIN', ids.admin],
  ])(
    '%s creates an OPEN lobby with an immutable fee snapshot',
    async (_role, actor) => {
      const lobby = await createLobbyFixture({ actor });
      expect(lobby).toMatchObject({
        status: 'OPEN',
        platform_fee_bps: 500,
        discord_revision: 1,
      });
      const audit = await db.query<{ action: string }>(
        "select action from public.audit_logs where entity_id=$1 and action='LOBBY_CREATED'",
        [lobby.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(lobby.platform_fee_bps).toBe(500);
    },
  );

  it('uses the 500 BPS default and rejects fees outside 0–1000 BPS', async () => {
    await cacheLobbyChannel();
    const defaulted = await asRole<{ fee: number }>(
      'authenticated',
      ids.owner,
      'select (public.create_lobby($1,$2,$3,$4,$5,$6,$7)).platform_fee_bps fee',
      [
        'Default Fee',
        lobbyChannel.guild,
        lobbyChannel.id,
        10_000,
        false,
        null,
        null,
      ],
    );
    expect(defaulted[0]?.fee).toBe(500);
    for (const fee of [-1, 1001])
      await expect(
        asRole(
          'authenticated',
          ids.owner,
          'select public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            'Bad Fee',
            lobbyChannel.guild,
            lobbyChannel.id,
            10_000,
            false,
            null,
            null,
            fee,
          ],
        ),
      ).rejects.toThrow('Platform fee');
  });

  it('rejects member creation access, invalid side-bet configuration, and unsafe channels', async () => {
    await cacheLobbyChannel();
    await expect(
      asRole(
        'authenticated',
        ids.member,
        'select public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          'Denied',
          lobbyChannel.guild,
          lobbyChannel.id,
          10_000,
          false,
          null,
          null,
          500,
        ],
      ),
    ).rejects.toThrow();
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          'Bad Range',
          lobbyChannel.guild,
          lobbyChannel.id,
          10_000,
          true,
          20_000,
          10_000,
          500,
        ],
      ),
    ).rejects.toThrow(/side-bet/i);
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          'Bad Channel',
          lobbyChannel.guild,
          '777777777777777779',
          10_000,
          false,
          null,
          null,
          500,
        ],
      ),
    ).rejects.toThrow('Discord channel');
  });

  it('reserves a Radiant stake atomically with ledger, audit, and Discord revision', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(1);
    const player = await addRosterPlayer(
      lobby.id,
      memberId,
      'RADIANT',
      ids.admin,
    );
    const wallet = await db.query<{
      available_centavos: number;
      reserved_centavos: number;
    }>(
      'select available_centavos,reserved_centavos from public.wallets where user_id=$1',
      [memberId],
    );
    expect(wallet.rows[0]).toEqual({
      available_centavos: 90_000,
      reserved_centavos: 10_000,
    });
    const ledger = await db.query<{
      type: string;
      amount_centavos: number;
      available_before: number;
      available_after: number;
      reserved_before: number;
      reserved_after: number;
      idempotency_key: string;
    }>(
      "select type,amount_centavos,available_before,available_after,reserved_before,reserved_after,idempotency_key from public.wallet_transactions where source_type='LOBBY_ROSTER'",
      [],
    );
    expect(ledger.rows[0]).toMatchObject({
      type: 'LOBBY_ROSTER_RESERVE',
      amount_centavos: 0,
      available_before: 100_000,
      available_after: 90_000,
      reserved_before: 0,
      reserved_after: 10_000,
    });
    expect(ledger.rows[0]?.idempotency_key).toBe(
      `lobby:${lobby.id}:roster:${player.id}:reserve`,
    );
    const evidence = await db.query<{
      action: string;
      discord_revision: number;
    }>(
      `select a.action,l.discord_revision from public.audit_logs a
       join public.lobbies l on l.id=$1 where a.entity_id=$2 and a.action='LOBBY_PLAYER_ADDED'`,
      [lobby.id, player.id],
    );
    expect(evidence.rows[0]).toEqual({
      action: 'LOBBY_PLAYER_ADDED',
      discord_revision: 2,
    });
  });

  it('adds Dire independently and rejects a member on both teams', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(2);
    await addRosterPlayer(lobby.id, memberId, 'DIRE');
    await expect(
      addRosterPlayer(lobby.id, memberId, 'RADIANT'),
    ).rejects.toThrow('already active');
    const players = await db.query<{ team: string }>(
      "select team from public.lobby_players where lobby_id=$1 and status='ACTIVE'",
      [lobby.id],
    );
    expect(players.rows).toEqual([{ team: 'DIRE' }]);
  });

  it.each(['RADIANT', 'DIRE'] as const)(
    'rejects the sixth %s player without a reservation',
    async (team) => {
      const lobby = await createLobbyFixture();
      for (let index = 10; index < 15; index += 1)
        await addRosterPlayer(lobby.id, await rosterMember(index), team);
      const sixth = await rosterMember(15);
      await expect(addRosterPlayer(lobby.id, sixth, team)).rejects.toThrow(
        'five',
      );
      const wallet = await db.query<{
        available_centavos: number;
        reserved_centavos: number;
      }>(
        'select available_centavos,reserved_centavos from public.wallets where user_id=$1',
        [sixth],
      );
      expect(wallet.rows[0]).toEqual({
        available_centavos: 100_000,
        reserved_centavos: 0,
      });
      const count = await db.query<{ count: number }>(
        "select count(*)::int count from public.lobby_players where lobby_id=$1 and team=$2 and status='ACTIVE'",
        [lobby.id, team],
      );
      expect(count.rows[0]?.count).toBe(5);
    },
  );

  it('serializes team-capacity checks and cannot commit two claims for the final slot', async () => {
    const lobby = await createLobbyFixture();
    for (let index = 60; index < 64; index += 1)
      await addRosterPlayer(lobby.id, await rosterMember(index), 'RADIANT');
    const fifthCandidate = await rosterMember(64);
    const sixthCandidate = await rosterMember(65);

    const definition = await db.query<{ definition: string }>(
      "select pg_get_functiondef('rampage_private.enforce_lobby_player_constraints()'::regprocedure) definition",
    );
    expect(definition.rows[0]?.definition).toMatch(
      /select \* into lobby_row[\s\S]*for update/i,
    );

    await db.exec('savepoint simultaneous_slot_claims');
    try {
      await expect(
        db.query(
          `insert into public.lobby_players
          (lobby_id,user_id,discord_user_id,display_name,team,stake_centavos,added_by)
         select $1,m.id,m.discord_user_id,m.display_name,'RADIANT',10000,s.id
         from public.members m cross join public.staff_profiles s
         where m.id in ($2,$3) and s.auth_user_id=$4`,
          [lobby.id, fifthCandidate, sixthCandidate, ids.owner],
        ),
      ).rejects.toThrow('five');
    } finally {
      await db.exec(
        'rollback to savepoint simultaneous_slot_claims; release savepoint simultaneous_slot_claims',
      );
    }

    const count = await db.query<{ count: number }>(
      "select count(*)::int count from public.lobby_players where lobby_id=$1 and team='RADIANT' and status='ACTIVE'",
      [lobby.id],
    );
    expect(count.rows[0]?.count).toBe(4);
  });

  it('rejects insufficient and inactive members without partial state', async () => {
    const lobby = await createLobbyFixture();
    const insufficient = await rosterMember(20, { balance: 9_999 });
    const inactive = await rosterMember(21, { active: false });
    await expect(
      addRosterPlayer(lobby.id, insufficient, 'RADIANT'),
    ).rejects.toThrow('Insufficient');
    await expect(addRosterPlayer(lobby.id, inactive, 'DIRE')).rejects.toThrow(
      'Active member',
    );
    const players = await db.query<{ count: number }>(
      'select count(*)::int count from public.lobby_players where lobby_id=$1',
      [lobby.id],
    );
    expect(players.rows[0]?.count).toBe(0);
  });

  it('removes an OPEN roster player once, restores funds, and preserves history', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(30);
    const player = await addRosterPlayer(lobby.id, memberId, 'RADIANT');
    await asRole(
      'authenticated',
      ids.admin,
      'select public.remove_lobby_player($1)',
      [player.id],
    );
    await asRole(
      'authenticated',
      ids.owner,
      'select public.remove_lobby_player($1)',
      [player.id],
    );
    const wallet = await db.query<{
      available_centavos: number;
      reserved_centavos: number;
    }>(
      'select available_centavos,reserved_centavos from public.wallets where user_id=$1',
      [memberId],
    );
    expect(wallet.rows[0]).toEqual({
      available_centavos: 100_000,
      reserved_centavos: 0,
    });
    const history = await db.query<{ status: string; removed_by: string }>(
      'select status,removed_by from public.lobby_players where id=$1',
      [player.id],
    );
    expect(history.rows[0]).toMatchObject({ status: 'REMOVED' });
    const release = await db.query<{ count: number; key: string }>(
      `select count(*)::int count,min(idempotency_key) key from public.wallet_transactions
       where source_type='LOBBY_ROSTER' and source_id=$1 and type='LOBBY_ROSTER_RELEASE'`,
      [player.id],
    );
    expect(release.rows[0]).toEqual({
      count: 1,
      key: `lobby:${lobby.id}:roster:${player.id}:release`,
    });
    await denied('delete from public.lobby_players where id=$1', [player.id]);
  });

  it('keeps a full 5v5 lobby OPEN and preserves every wallet liability invariant', async () => {
    const lobby = await createLobbyFixture();
    for (let index = 40; index < 50; index += 1)
      await addRosterPlayer(
        lobby.id,
        await rosterMember(index),
        index < 45 ? 'RADIANT' : 'DIRE',
      );
    const state = await db.query<{
      status: string;
      platform_fee_bps: number;
      radiant: number;
      dire: number;
      available: number;
      reserved: number;
    }>(
      `select l.status,l.platform_fee_bps,
        count(*) filter(where p.team='RADIANT' and p.status='ACTIVE')::int radiant,
        count(*) filter(where p.team='DIRE' and p.status='ACTIVE')::int dire,
        sum(w.available_centavos)::int available,sum(w.reserved_centavos)::int reserved
       from public.lobbies l join public.lobby_players p on p.lobby_id=l.id
       join public.wallets w on w.user_id=p.user_id where l.id=$1
       group by l.id`,
      [lobby.id],
    );
    expect(state.rows[0]).toEqual({
      status: 'OPEN',
      platform_fee_bps: 500,
      radiant: 5,
      dire: 5,
      available: 900_000,
      reserved: 100_000,
    });
  });

  it('requires future side-bet minimum to meet the roster participation floor', async () => {
    await cacheLobbyChannel();
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          'Below Floor',
          lobbyChannel.guild,
          lobbyChannel.id,
          10_000,
          true,
          9_999,
          50_000,
          500,
        ],
      ),
    ).rejects.toThrow(/roster entry/i);
    const equal = await createLobbyFixture({ name: 'Equal Floor' });
    const above = await asRole<{ minimum: number }>(
      'authenticated',
      ids.admin,
      'select (public.create_lobby($1,$2,$3,$4,$5,$6,$7,$8)).side_bet_min_centavos minimum',
      [
        'Above Floor',
        lobbyChannel.guild,
        lobbyChannel.id,
        10_000,
        true,
        20_000,
        50_000,
        500,
      ],
    );
    expect(equal.status).toBe('OPEN');
    expect(above[0]?.minimum).toBe(20_000);
  });

  it.each(['RADIANT', 'DIRE'] as const)(
    'lets the invoking Discord member self-join %s with exactly the entry balance',
    async (team) => {
      const lobby = await createLobbyFixture({ sideBetting: false });
      const messageId = await activateLobbyMessage(lobby.id);
      const index = team === 'RADIANT' ? 70 : 71;
      const memberId = await rosterMember(index, { balance: 10_000 });
      const joined = await asRole<{ result: Record<string, unknown> }>(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4) result',
        [lobby.id, rosterDiscord(index), team, messageId],
      );
      expect(joined[0]?.result).toMatchObject({
        lobby_name: 'Lobby 1',
        entry_centavos: 10_000,
        team,
      });
      const wallet = await db.query<{
        available_centavos: number;
        reserved_centavos: number;
      }>(
        'select available_centavos,reserved_centavos from public.wallets where user_id=$1',
        [memberId],
      );
      expect(wallet.rows[0]).toEqual({
        available_centavos: 0,
        reserved_centavos: 10_000,
      });
      const evidence = await db.query<{
        added_source: string;
        added_by: string | null;
        source: string;
        action: string;
      }>(
        `select p.added_source,p.added_by,a.source,a.action
         from public.lobby_players p join public.audit_logs a on a.entity_id=p.id
         where p.lobby_id=$1 and a.action='LOBBY_PLAYER_SELF_JOINED'`,
        [lobby.id],
      );
      expect(evidence.rows[0]).toEqual({
        added_source: 'DISCORD_SELF_SERVICE',
        added_by: null,
        source: 'DISCORD_SELF_SERVICE',
        action: 'LOBBY_PLAYER_SELF_JOINED',
      });
    },
  );

  it('rejects insufficient, duplicate, full-team, and stale-message self joins', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const messageId = await activateLobbyMessage(lobby.id);
    await rosterMember(72, { balance: 9_999 });
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4)',
        [lobby.id, rosterDiscord(72), 'RADIANT', messageId],
      ),
    ).rejects.toThrow('Insufficient');
    const duplicate = await rosterMember(73);
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self($1,$2,$3,$4)',
      [lobby.id, rosterDiscord(73), 'RADIANT', messageId],
    );
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4)',
        [lobby.id, rosterDiscord(73), 'DIRE', messageId],
      ),
    ).rejects.toThrow('already active');
    for (let index = 74; index < 78; index += 1)
      await addRosterPlayer(lobby.id, await rosterMember(index), 'RADIANT');
    await rosterMember(78);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4)',
        [lobby.id, rosterDiscord(78), 'RADIANT', messageId],
      ),
    ).rejects.toThrow('five');
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4)',
        [lobby.id, rosterDiscord(78), 'DIRE', '999999999999999998'],
      ),
    ).rejects.toThrow('no longer active');
    expect(duplicate).toBeTruthy();
  });

  it('self-leave releases once and preserves Discord self-service history', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const messageId = await activateLobbyMessage(lobby.id);
    const memberId = await rosterMember(79);
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self($1,$2,$3,$4)',
      [lobby.id, rosterDiscord(79), 'DIRE', messageId],
    );
    for (let attempt = 0; attempt < 2; attempt += 1)
      await asRole(
        'service_role',
        null,
        'select public.leave_lobby_self($1,$2,$3)',
        [lobby.id, rosterDiscord(79), messageId],
      );
    const state = await db.query<{
      available: number;
      reserved: number;
      releases: number;
      source: string;
      audit_count: number;
    }>(
      `select w.available_centavos::int available,w.reserved_centavos::int reserved,
        count(distinct t.id) filter(where t.type='LOBBY_ROSTER_RELEASE')::int releases,
        max(p.removed_source) source,
        count(distinct a.id) filter(where a.action='LOBBY_PLAYER_SELF_LEFT')::int audit_count
       from public.wallets w join public.lobby_players p on p.user_id=w.user_id
       left join public.wallet_transactions t on t.source_id=p.id::text
       left join public.audit_logs a on a.entity_id=p.id
       where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos`,
      [memberId],
    );
    expect(state.rows[0]).toMatchObject({
      available: 100_000,
      reserved: 0,
      releases: 1,
      source: 'DISCORD_SELF_SERVICE',
      audit_count: 1,
    });
  });

  it('edits all unused terms and locks financial terms/channel after participation', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const messageId = await activateLobbyMessage(lobby.id);
    const nextChannel = '777777777777777779';
    await cacheLobbyChannel(nextChannel, 'moved-lobby');
    const edited = await asRole<{ row: Record<string, unknown> }>(
      'authenticated',
      ids.admin,
      'select to_jsonb(public.update_lobby($1,$2,$3,$4,$5,$6,$7,$8)) row',
      [
        lobby.id,
        'Edited Lobby',
        nextChannel,
        20_000,
        true,
        20_000,
        80_000,
        600,
      ],
    );
    expect(edited[0]?.row).toMatchObject({
      display_name: 'Edited Lobby',
      discord_channel_id: nextChannel,
      discord_message_id: null,
      discord_previous_channel_id: lobbyChannel.id,
      discord_previous_message_id: messageId,
      roster_entry_centavos: 20_000,
      platform_fee_bps: 600,
    });
    const memberId = await rosterMember(80);
    await addRosterPlayer(lobby.id, memberId, 'RADIANT');
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        'select public.update_lobby($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          lobby.id,
          'Still Edited',
          nextChannel,
          30_000,
          true,
          30_000,
          90_000,
          700,
        ],
      ),
    ).rejects.toThrow('immutable');
    const renamed = await asRole<{ name: string }>(
      'authenticated',
      ids.owner,
      'select (public.update_lobby($1,$2,$3,$4,$5,$6,$7,$8)).display_name name',
      [lobby.id, 'Safe Rename', nextChannel, 20_000, true, 20_000, 80_000, 600],
    );
    expect(renamed[0]?.name).toBe('Safe Rename');
  });

  it('postpones without releasing funds, blocks participation, and resumes', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const messageId = await activateLobbyMessage(lobby.id);
    const memberId = await rosterMember(81);
    await addRosterPlayer(lobby.id, memberId, 'RADIANT');
    await asRole(
      'authenticated',
      ids.admin,
      'select public.postpone_lobby($1)',
      [lobby.id],
    );
    await rosterMember(82);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self($1,$2,$3,$4)',
        [lobby.id, rosterDiscord(82), 'DIRE', messageId],
      ),
    ).rejects.toThrow('OPEN');
    const paused = await db.query<{
      status: string;
      available: number;
      reserved: number;
    }>(
      `select l.status,w.available_centavos::int available,w.reserved_centavos::int reserved
       from public.lobbies l join public.wallets w on w.user_id=$2 where l.id=$1`,
      [lobby.id, memberId],
    );
    expect(paused.rows[0]).toEqual({
      status: 'POSTPONED',
      available: 90_000,
      reserved: 10_000,
    });
    const resumed = await asRole<{ status: string }>(
      'authenticated',
      ids.owner,
      'select (public.resume_lobby($1)).status status',
      [lobby.id],
    );
    expect(resumed[0]?.status).toBe('OPEN');
  });

  it.each(['OPEN', 'POSTPONED'] as const)(
    'cancels an %s lobby, refunds every active roster once, and collects no fee',
    async (startingStatus) => {
      const lobby = await createLobbyFixture({ sideBetting: false });
      const members = [await rosterMember(83), await rosterMember(84)];
      await addRosterPlayer(lobby.id, members[0]!, 'RADIANT');
      await addRosterPlayer(lobby.id, members[1]!, 'DIRE');
      if (startingStatus === 'POSTPONED')
        await asRole(
          'authenticated',
          ids.admin,
          'select public.postpone_lobby($1)',
          [lobby.id],
        );
      for (let attempt = 0; attempt < 2; attempt += 1)
        await asRole(
          'authenticated',
          ids.owner,
          'select public.cancel_lobby($1)',
          [lobby.id],
        );
      const wallets = await db.query<{
        available: number;
        reserved: number;
      }>(
        `select available_centavos::int available,reserved_centavos::int reserved
         from public.wallets where user_id=any($1::uuid[]) order by user_id`,
        [members],
      );
      expect(wallets.rows).toEqual([
        { available: 100_000, reserved: 0 },
        { available: 100_000, reserved: 0 },
      ]);
      const evidence = await db.query<{
        status: string;
        active: number;
        releases: number;
        cancel_audits: number;
        refunded: number;
        revenue_table: string | null;
      }>(
        `select l.status,
          count(distinct p.id) filter(where p.status='ACTIVE')::int active,
          count(distinct t.id) filter(where t.idempotency_key like '%:cancel-release')::int releases,
          count(distinct a.id) filter(where a.action='LOBBY_CANCELLED')::int cancel_audits,
          max((a.new_data->>'total_refunded_centavos')::int) refunded,
          to_regclass('public.platform_revenue')::text revenue_table
         from public.lobbies l left join public.lobby_players p on p.lobby_id=l.id
         left join public.wallet_transactions t on t.source_id=p.id::text
         left join public.audit_logs a on a.entity_id=l.id
         where l.id=$1 group by l.id`,
        [lobby.id],
      );
      expect(evidence.rows[0]).toEqual({
        status: 'CANCELLED',
        active: 0,
        releases: 2,
        cancel_audits: 1,
        refunded: 20_000,
        revenue_table: null,
      });
    },
  );

  it('archives unused or cancelled history, rejects active financial archive, and preserves records', async () => {
    const unused = await createLobbyFixture({ name: 'Unused' });
    const unusedArchived = await asRole<{ status: string }>(
      'authenticated',
      ids.owner,
      'select (public.archive_lobby($1)).status status',
      [unused.id],
    );
    expect(unusedArchived[0]?.status).toBe('ARCHIVED');
    const financial = await createLobbyFixture({ name: 'Financial' });
    await addRosterPlayer(financial.id, await rosterMember(85), 'RADIANT');
    await expect(
      asRole('authenticated', ids.admin, 'select public.archive_lobby($1)', [
        financial.id,
      ]),
    ).rejects.toThrow('OWNER');
    await expect(
      asRole('authenticated', ids.owner, 'select public.archive_lobby($1)', [
        financial.id,
      ]),
    ).rejects.toThrow('CANCELLED');
    await asRole('authenticated', ids.owner, 'select public.cancel_lobby($1)', [
      financial.id,
    ]);
    await asRole(
      'authenticated',
      ids.owner,
      'select public.archive_lobby($1)',
      [financial.id],
    );
    const history = await db.query<{
      status: string;
      players: number;
      ledgers: number;
      audits: number;
    }>(
      `select l.status,count(distinct p.id)::int players,count(distinct t.id)::int ledgers,
        count(distinct a.id)::int audits from public.lobbies l
       left join public.lobby_players p on p.lobby_id=l.id
       left join public.wallet_transactions t on t.source_id=p.id::text
       left join public.audit_logs a on a.entity_id=l.id
       where l.id=$1 group by l.id`,
      [financial.id],
    );
    expect(history.rows[0]).toMatchObject({
      status: 'ARCHIVED',
      players: 1,
      ledgers: 2,
    });
    expect(history.rows[0]!.audits).toBeGreaterThanOrEqual(3);
  });

  it('restricts new table reads to active staff and blocks direct writes', async () => {
    const lobby = await createLobbyFixture();
    expect(
      await asRole('authenticated', ids.admin, 'select * from public.lobbies'),
    ).toHaveLength(1);
    for (const table of ['discord_channels', 'lobbies', 'lobby_players']) {
      expect(
        await asRole(
          'authenticated',
          ids.member,
          `select * from public.${table}`,
        ),
      ).toHaveLength(0);
      await expect(
        asRole(
          'authenticated',
          ids.owner,
          `delete from public.${table}${table === 'lobbies' ? ' where id=$1' : ''}`,
          table === 'lobbies' ? [lobby.id] : [],
        ),
      ).rejects.toThrow();
    }
  });

  it('safely refreshes channel metadata and marks stale channels inactive', async () => {
    await cacheLobbyChannel(lobbyChannel.id, 'old-name');
    await cacheLobbyChannel('777777777777777779', 'new-channel');
    const channels = await db.query<{
      channel_id: string;
      active: boolean;
      can_post: boolean;
    }>(
      'select channel_id,active,can_post from public.discord_channels order by channel_id',
    );
    expect(channels.rows).toEqual([
      { channel_id: lobbyChannel.id, active: false, can_post: false },
      { channel_id: '777777777777777779', active: true, can_post: true },
    ]);
  });

  it('claims, completes, and retries Discord synchronization without changing lobby state', async () => {
    const lobby = await createLobbyFixture();
    const claim = await asRole<{ payload: Record<string, unknown> }>(
      'service_role',
      null,
      'select public.claim_lobby_discord_sync() payload',
    );
    expect(claim[0]?.payload).toMatchObject({
      id: lobby.id,
      status: 'OPEN',
      discord_revision: 1,
      players: [],
    });
    await asRole(
      'service_role',
      null,
      'select public.fail_lobby_discord_sync($1,$2,$3)',
      [lobby.id, 1, 'temporary Discord failure'],
    );
    const retry = await asRole<{ payload: Record<string, unknown> }>(
      'service_role',
      null,
      'select public.claim_lobby_discord_sync() payload',
    );
    expect(retry[0]?.payload.id).toBe(lobby.id);
    await asRole(
      'service_role',
      null,
      'select public.complete_lobby_discord_sync($1,$2,$3)',
      [lobby.id, 1, '999999999999999999'],
    );
    const completed = await db.query<{
      status: string;
      discord_message_id: string;
      discord_revision: number;
      discord_synced_revision: number;
    }>(
      'select status,discord_message_id,discord_revision,discord_synced_revision from public.lobbies where id=$1',
      [lobby.id],
    );
    expect(completed.rows[0]).toEqual({
      status: 'OPEN',
      discord_message_id: '999999999999999999',
      discord_revision: 1,
      discord_synced_revision: 1,
    });
    const audits = await db.query<{ action: string }>(
      "select action from public.audit_logs where entity_id=$1 and action in ('LOBBY_DISCORD_SYNC_FAILED','LOBBY_DISCORD_MESSAGE_CREATED') order by created_at",
      [lobby.id],
    );
    expect(audits.rows.map((row) => row.action).sort()).toEqual([
      'LOBBY_DISCORD_MESSAGE_CREATED',
      'LOBBY_DISCORD_SYNC_FAILED',
    ]);
  });
});

function betInteraction(index: number) {
  return `6${String(index).padStart(17, '0')}`;
}

type Phase5BetResult = {
  duplicate: boolean;
  bet: {
    id: string;
    bet_number: number;
    status: string;
    requested_amount_centavos: number;
  };
  [key: string]: unknown;
};

async function placeSideBet(
  lobbyId: string,
  memberIndex: number,
  side: 'RADIANT' | 'DIRE',
  amount: number,
  interactionIndex: number,
) {
  const rows = await asRole<{ result: Phase5BetResult }>(
    'service_role',
    null,
    'select public.place_side_bet_self($1,$2,$3,$4,$5) result',
    [
      lobbyId,
      rosterDiscord(memberIndex),
      side,
      amount,
      betInteraction(interactionIndex),
    ],
  );
  return rows[0]!.result;
}

describe('Phase 5 side betting foundation', () => {
  it.each(['RADIANT', 'DIRE'] as const)(
    'reserves one independent %s position with ledger, audit, and fee preview',
    async (side) => {
      const lobby = await createLobbyFixture();
      const index = side === 'RADIANT' ? 201 : 202;
      const memberId = await rosterMember(index, { balance: 50_000 });
      const result = await placeSideBet(lobby.id, index, side, 10_001, index);
      expect(result).toMatchObject({
        duplicate: false,
        lobby_name: 'Lobby 1',
        winning_profit_centavos: 10_001,
        gross_return_centavos: 20_002,
        platform_fee_centavos: 500,
        net_return_centavos: 19_502,
        bet: {
          side,
          requested_amount_centavos: 10_001,
          accepted_amount_centavos: 10_001,
          status: 'ACTIVE',
        },
      });
      const state = await db.query<{
        available: number;
        reserved: number;
        ledgers: number;
        audits: number;
        committed: boolean;
      }>(
        `select w.available_centavos::int available,w.reserved_centavos::int reserved,
          count(distinct t.id) filter(where t.type='LOBBY_SIDE_BET_RESERVE')::int ledgers,
          count(distinct a.id) filter(where a.action='LOBBY_SIDE_BET_PLACED')::int audits,
          (l.financial_commitment_at is not null) committed
         from public.wallets w join public.side_bets b on b.user_id=w.user_id
         join public.lobbies l on l.id=b.lobby_id
         left join public.wallet_transactions t on t.source_id=b.id::text
         left join public.audit_logs a on a.entity_id=b.id
         where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos,l.financial_commitment_at`,
        [memberId],
      );
      expect(state.rows[0]).toEqual({
        available: 39_999,
        reserved: 10_001,
        ledgers: 1,
        audits: 1,
        committed: true,
      });
    },
  );

  it('allows roster players, spectators, multiple sides, and separate bet numbers', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(203, { balance: 60_000 });
    await addRosterPlayer(lobby.id, memberId, 'RADIANT');
    const one = await placeSideBet(lobby.id, 203, 'RADIANT', 10_000, 2031);
    const two = await placeSideBet(lobby.id, 203, 'RADIANT', 15_000, 2032);
    const three = await placeSideBet(lobby.id, 203, 'DIRE', 10_000, 2033);
    expect(
      new Set([one.bet.bet_number, two.bet.bet_number, three.bet.bet_number])
        .size,
    ).toBe(3);
    const wallet = await db.query<{ available: number; reserved: number }>(
      'select available_centavos::int available,reserved_centavos::int reserved from public.wallets where user_id=$1',
      [memberId],
    );
    expect(wallet.rows[0]).toEqual({ available: 15_000, reserved: 45_000 });
    await rosterMember(204, { balance: 10_000 });
    const spectator = await placeSideBet(lobby.id, 204, 'DIRE', 10_000, 2041);
    expect(spectator.bet.status).toBe('ACTIVE');
  });

  it('deduplicates one Discord interaction but allows a new interaction', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(205, { balance: 30_000 });
    const first = await placeSideBet(lobby.id, 205, 'RADIANT', 10_000, 2051);
    const retry = await placeSideBet(lobby.id, 205, 'RADIANT', 10_000, 2051);
    const second = await placeSideBet(lobby.id, 205, 'RADIANT', 10_000, 2052);
    expect(retry).toMatchObject({ duplicate: true, bet: { id: first.bet.id } });
    expect(second.bet.id).not.toBe(first.bet.id);
    const state = await db.query<{
      bets: number;
      ledgers: number;
      available: number;
    }>(
      `select count(distinct b.id)::int bets,count(distinct t.id)::int ledgers,
        max(w.available_centavos)::int available from public.side_bets b
        join public.wallets w on w.user_id=b.user_id
        join public.wallet_transactions t on t.source_id=b.id::text where b.user_id=$1`,
      [memberId],
    );
    expect(state.rows[0]).toEqual({ bets: 2, ledgers: 2, available: 10_000 });
  });

  it('enforces status, member, configured range, side-betting, and available balance', async () => {
    const lobby = await createLobbyFixture();
    await rosterMember(206, { balance: 9_999 });
    await expect(
      placeSideBet(lobby.id, 206, 'RADIANT', 10_000, 2061),
    ).rejects.toThrow('Insufficient');
    await expect(
      placeSideBet(lobby.id, 206, 'RADIANT', 9_999, 2062),
    ).rejects.toThrow('minimum');
    await expect(
      placeSideBet(lobby.id, 206, 'RADIANT', 500_001, 2063),
    ).rejects.toThrow('maximum');
    await rosterMember(207, { balance: 20_000, active: false });
    await expect(
      placeSideBet(lobby.id, 207, 'DIRE', 10_000, 2071),
    ).rejects.toThrow('Active');
    const disabled = await createLobbyFixture({
      name: 'No Bets',
      sideBetting: false,
    });
    await rosterMember(208, { balance: 20_000 });
    await expect(
      placeSideBet(disabled.id, 208, 'DIRE', 10_000, 2081),
    ).rejects.toThrow('DISABLED');
    for (const status of ['POSTPONED', 'CANCELLED', 'ARCHIVED'] as const) {
      const blocked = await createLobbyFixture({ name: status });
      if (status === 'POSTPONED')
        await asRole(
          'authenticated',
          ids.admin,
          'select public.postpone_lobby($1)',
          [blocked.id],
        );
      else if (status === 'CANCELLED')
        await asRole(
          'authenticated',
          ids.admin,
          'select public.cancel_lobby($1)',
          [blocked.id],
        );
      else
        await asRole(
          'authenticated',
          ids.owner,
          'select public.archive_lobby($1)',
          [blocked.id],
        );
      await expect(
        placeSideBet(blocked.id, 208, 'RADIANT', 10_000, 2082 + status.length),
      ).rejects.toThrow('OPEN');
    }
  });

  it('cancels only the owner bet while OPEN and releases it once', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(209, { balance: 30_000 });
    await rosterMember(210, { balance: 30_000 });
    const placed = await placeSideBet(lobby.id, 209, 'DIRE', 15_000, 2091);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.cancel_side_bet_self($1,$2,$3)',
        [placed.bet.bet_number, rosterDiscord(210), betInteraction(2101)],
      ),
    ).rejects.toThrow('own');
    const cancelled = await asRole<{ result: Phase5BetResult }>(
      'service_role',
      null,
      'select public.cancel_side_bet_self($1,$2,$3) result',
      [placed.bet.bet_number, rosterDiscord(209), betInteraction(2092)],
    );
    const retry = await asRole<{ result: Phase5BetResult }>(
      'service_role',
      null,
      'select public.cancel_side_bet_self($1,$2,$3) result',
      [placed.bet.bet_number, rosterDiscord(209), betInteraction(2093)],
    );
    expect(cancelled[0]?.result).toMatchObject({
      duplicate: false,
      bet: { status: 'CANCELLED', requested_amount_centavos: 15_000 },
    });
    expect(retry[0]?.result).toMatchObject({ duplicate: true });
    const state = await db.query<{
      available: number;
      reserved: number;
      releases: number;
    }>(
      `select w.available_centavos::int available,w.reserved_centavos::int reserved,
        count(t.id) filter(where t.type='LOBBY_SIDE_BET_RELEASE')::int releases
       from public.wallets w left join public.wallet_transactions t on t.user_id=w.user_id
       where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos`,
      [memberId],
    );
    expect(state.rows[0]).toEqual({
      available: 30_000,
      reserved: 0,
      releases: 1,
    });
    await denied('delete from public.side_bets where id=$1', [placed.bet.id]);
    await denied(
      'update public.side_bets set requested_amount_centavos=1 where id=$1',
      [placed.bet.id],
    );
  });

  it('rejects cancellation while POSTPONED and preserves the reservation', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(211, { balance: 20_000 });
    const placed = await placeSideBet(lobby.id, 211, 'RADIANT', 10_000, 2111);
    await asRole(
      'authenticated',
      ids.admin,
      'select public.postpone_lobby($1)',
      [lobby.id],
    );
    await expect(
      asRole(
        'service_role',
        null,
        'select public.cancel_side_bet_self($1,$2,$3)',
        [placed.bet.bet_number, rosterDiscord(211), betInteraction(2112)],
      ),
    ).rejects.toThrow('OPEN');
    const wallet = await db.query<{ available: number; reserved: number }>(
      'select available_centavos::int available,reserved_centavos::int reserved from public.wallets where user_id=$1',
      [memberId],
    );
    expect(wallet.rows[0]).toEqual({ available: 10_000, reserved: 10_000 });
  });

  it('whole-lobby cancellation refunds roster and active bets without refunding an already cancelled bet', async () => {
    const lobby = await createLobbyFixture();
    const memberId = await rosterMember(212, { balance: 50_000 });
    await addRosterPlayer(lobby.id, memberId, 'RADIANT');
    const active = await placeSideBet(lobby.id, 212, 'RADIANT', 15_000, 2121);
    const cancelled = await placeSideBet(lobby.id, 212, 'DIRE', 10_000, 2122);
    await asRole(
      'service_role',
      null,
      'select public.cancel_side_bet_self($1,$2,$3)',
      [cancelled.bet.bet_number, rosterDiscord(212), betInteraction(2123)],
    );
    await asRole('authenticated', ids.owner, 'select public.cancel_lobby($1)', [
      lobby.id,
    ]);
    await asRole('authenticated', ids.owner, 'select public.cancel_lobby($1)', [
      lobby.id,
    ]);
    const state = await db.query<{
      available: number;
      reserved: number;
      active_status: string;
      releases: number;
    }>(
      `select w.available_centavos::int available,w.reserved_centavos::int reserved,
        max(b.status) filter(where b.id=$2) active_status,
        count(distinct t.id) filter(where t.type='LOBBY_SIDE_BET_RELEASE')::int releases
       from public.wallets w join public.side_bets b on b.user_id=w.user_id
       left join public.wallet_transactions t on t.user_id=w.user_id
       where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos`,
      [memberId, active.bet.id],
    );
    expect(state.rows[0]).toEqual({
      available: 50_000,
      reserved: 0,
      active_status: 'CANCELLED',
      releases: 2,
    });
  });

  it('projects combined active pools and excludes cancelled positions', async () => {
    const lobby = await createLobbyFixture();
    await addRosterPlayer(lobby.id, await rosterMember(213), 'RADIANT');
    await addRosterPlayer(lobby.id, await rosterMember(214), 'DIRE');
    await rosterMember(215, { balance: 40_000 });
    await rosterMember(216, { balance: 40_000 });
    await placeSideBet(lobby.id, 215, 'RADIANT', 20_000, 2151);
    const removed = await placeSideBet(lobby.id, 216, 'DIRE', 10_000, 2161);
    await asRole(
      'service_role',
      null,
      'select public.cancel_side_bet_self($1,$2,$3)',
      [removed.bet.bet_number, rosterDiscord(216), betInteraction(2162)],
    );
    const pools = await db.query<{
      radiant_roster: number;
      radiant_bets: number;
      dire_roster: number;
      dire_bets: number;
    }>(
      `select
        (select coalesce(sum(stake_centavos),0)::int from public.lobby_players where lobby_id=$1 and status='ACTIVE' and team='RADIANT') radiant_roster,
        (select coalesce(sum(accepted_amount_centavos),0)::int from public.side_bets where lobby_id=$1 and status='ACTIVE' and side='RADIANT') radiant_bets,
        (select coalesce(sum(stake_centavos),0)::int from public.lobby_players where lobby_id=$1 and status='ACTIVE' and team='DIRE') dire_roster,
        (select coalesce(sum(accepted_amount_centavos),0)::int from public.side_bets where lobby_id=$1 and status='ACTIVE' and side='DIRE') dire_bets`,
      [lobby.id],
    );
    expect(pools.rows[0]).toEqual({
      radiant_roster: 10_000,
      radiant_bets: 20_000,
      dire_roster: 10_000,
      dire_bets: 0,
    });
    const claim = await asRole<{ payload: { side_bets: unknown[] } }>(
      'service_role',
      null,
      'select public.claim_lobby_discord_sync() payload',
    );
    expect(claim[0]?.payload.side_bets).toHaveLength(1);
  });

  it('allows staff RLS reads while members cannot read or mutate side bets', async () => {
    const lobby = await createLobbyFixture();
    await rosterMember(217, { balance: 20_000 });
    await placeSideBet(lobby.id, 217, 'RADIANT', 10_000, 2171);
    expect(
      await asRole(
        'authenticated',
        ids.owner,
        'select * from public.side_bets',
      ),
    ).toHaveLength(1);
    expect(
      await asRole(
        'authenticated',
        ids.admin,
        'select * from public.side_bets',
      ),
    ).toHaveLength(1);
    expect(
      await asRole(
        'authenticated',
        ids.member,
        'select * from public.side_bets',
      ),
    ).toHaveLength(0);
    await expect(
      asRole(
        'authenticated',
        ids.owner,
        "update public.side_bets set status='CANCELLED' where lobby_id=$1",
        [lobby.id],
      ),
    ).rejects.toThrow();
  });
});

describe('Phase 5 final member command RPCs', () => {
  it('accepts the exact slash join amount once and preserves wallet and ledger invariants', async () => {
    const lobby = await createLobbyFixture({
      entry: 20_000,
      sideBetting: false,
    });
    const memberId = await rosterMember(301, { balance: 20_000 });
    const interactionId = betInteraction(3011);
    const first = await asRole<{
      result: { duplicate: boolean; team: string };
    }>(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null) result',
      [lobby.id, rosterDiscord(301), 'RADIANT', 20_000, interactionId],
    );
    const duplicate = await asRole<{
      result: { duplicate: boolean; team: string };
    }>(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null) result',
      [lobby.id, rosterDiscord(301), 'RADIANT', 20_000, interactionId],
    );
    expect(first[0]?.result).toMatchObject({
      duplicate: false,
      team: 'RADIANT',
    });
    expect(duplicate[0]?.result).toMatchObject({
      duplicate: true,
      team: 'RADIANT',
    });
    const state = await db.query<{
      available: number;
      reserved: number;
      players: number;
      reserves: number;
      interaction_id: string;
    }>(
      `select w.available_centavos::int available,w.reserved_centavos::int reserved,
        count(distinct p.id)::int players,
        count(distinct t.id) filter(where t.type='LOBBY_ROSTER_RESERVE')::int reserves,
        max(p.join_interaction_id) interaction_id
       from public.wallets w
       left join public.lobby_players p on p.user_id=w.user_id
       left join public.wallet_transactions t on t.user_id=w.user_id
       where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos`,
      [memberId],
    );
    expect(state.rows[0]).toEqual({
      available: 0,
      reserved: 20_000,
      players: 1,
      reserves: 1,
      interaction_id: interactionId,
    });
  });

  it('rejects below/above entry amounts, insufficient funds, duplicate membership, and a sixth player', async () => {
    const lobby = await createLobbyFixture({
      entry: 20_000,
      sideBetting: false,
    });
    await rosterMember(302, { balance: 50_000 });
    for (const [amount, interaction] of [
      [10_000, 3021],
      [30_000, 3022],
    ] as const)
      await expect(
        asRole(
          'service_role',
          null,
          'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
          [
            lobby.id,
            rosterDiscord(302),
            'RADIANT',
            amount,
            betInteraction(interaction),
          ],
        ),
      ).rejects.toThrow('Incorrect entry amount');
    await rosterMember(303, { balance: 19_999 });
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
        [lobby.id, rosterDiscord(303), 'RADIANT', 20_000, betInteraction(3031)],
      ),
    ).rejects.toThrow('Insufficient');

    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [lobby.id, rosterDiscord(302), 'RADIANT', 20_000, betInteraction(3023)],
    );
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
        [lobby.id, rosterDiscord(302), 'DIRE', 20_000, betInteraction(3024)],
      ),
    ).rejects.toThrow('Already in lobby: RADIANT');
    for (let index = 304; index < 308; index += 1)
      await addRosterPlayer(lobby.id, await rosterMember(index), 'RADIANT');
    await rosterMember(308);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
        [lobby.id, rosterDiscord(308), 'RADIANT', 20_000, betInteraction(3081)],
      ),
    ).rejects.toThrow('RADIANT is full');

    const direLobby = await createLobbyFixture({
      name: 'Dire Full',
      entry: 20_000,
      sideBetting: false,
    });
    for (let index = 314; index < 319; index += 1)
      await addRosterPlayer(direLobby.id, await rosterMember(index), 'DIRE');
    await rosterMember(319);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
        [
          direLobby.id,
          rosterDiscord(319),
          'DIRE',
          20_000,
          betInteraction(3191),
        ],
      ),
    ).rejects.toThrow('DIRE is full');
  });

  it('releases a slash roster position once and an old retry cannot remove a later rejoin', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const memberId = await rosterMember(309, { balance: 20_000 });
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [lobby.id, rosterDiscord(309), 'DIRE', 10_000, betInteraction(3091)],
    );
    const leaveId = betInteraction(3092);
    const first = await asRole<{ result: { duplicate: boolean } }>(
      'service_role',
      null,
      'select public.leave_lobby_self_with_interaction($1,$2,$3,null) result',
      [lobby.id, rosterDiscord(309), leaveId],
    );
    const duplicate = await asRole<{ result: { duplicate: boolean } }>(
      'service_role',
      null,
      'select public.leave_lobby_self_with_interaction($1,$2,$3,null) result',
      [lobby.id, rosterDiscord(309), leaveId],
    );
    expect(first[0]?.result.duplicate).toBe(false);
    expect(duplicate[0]?.result.duplicate).toBe(true);
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [lobby.id, rosterDiscord(309), 'RADIANT', 10_000, betInteraction(3093)],
    );
    await asRole(
      'service_role',
      null,
      'select public.leave_lobby_self_with_interaction($1,$2,$3,null)',
      [lobby.id, rosterDiscord(309), leaveId],
    );
    const state = await db.query<{
      available: number;
      reserved: number;
      active_players: number;
      releases: number;
    }>(
      `select w.available_centavos::int available,w.reserved_centavos::int reserved,
        count(distinct p.id) filter(where p.status='ACTIVE')::int active_players,
        count(distinct t.id) filter(where t.type='LOBBY_ROSTER_RELEASE')::int releases
       from public.wallets w
       left join public.lobby_players p on p.user_id=w.user_id
       left join public.wallet_transactions t on t.user_id=w.user_id
       where w.user_id=$1 group by w.user_id,w.available_centavos,w.reserved_centavos`,
      [memberId],
    );
    expect(state.rows[0]).toEqual({
      available: 10_000,
      reserved: 10_000,
      active_players: 1,
      releases: 1,
    });
  });

  it('rejects non-player and non-OPEN slash leaves without changing wallet state', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    await rosterMember(310);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.leave_lobby_self_with_interaction($1,$2,$3,null)',
        [lobby.id, rosterDiscord(310), betInteraction(3101)],
      ),
    ).rejects.toThrow('not active');
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [lobby.id, rosterDiscord(310), 'DIRE', 10_000, betInteraction(3102)],
    );
    await asRole(
      'authenticated',
      ids.admin,
      'select public.postpone_lobby($1)',
      [lobby.id],
    );
    await expect(
      asRole(
        'service_role',
        null,
        'select public.leave_lobby_self_with_interaction($1,$2,$3,null)',
        [lobby.id, rosterDiscord(310), betInteraction(3103)],
      ),
    ).rejects.toThrow('OPEN');

    const cancelledLobby = await createLobbyFixture({
      name: 'Cancelled Leave',
      sideBetting: false,
    });
    await rosterMember(320);
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [
        cancelledLobby.id,
        rosterDiscord(320),
        'RADIANT',
        10_000,
        betInteraction(3201),
      ],
    );
    await asRole('authenticated', ids.owner, 'select public.cancel_lobby($1)', [
      cancelledLobby.id,
    ]);
    await expect(
      asRole(
        'service_role',
        null,
        'select public.leave_lobby_self_with_interaction($1,$2,$3,null)',
        [cancelledLobby.id, rosterDiscord(320), betInteraction(3202)],
      ),
    ).rejects.toThrow('OPEN');
  });

  it('returns only the invoking active member wallet and newest transaction page', async () => {
    const lobby = await createLobbyFixture({ sideBetting: false });
    const memberId = await rosterMember(311, { balance: 30_000 });
    await rosterMember(312, { balance: 90_000 });
    await asRole(
      'service_role',
      null,
      'select public.join_lobby_self_with_amount($1,$2,$3,$4,$5,null)',
      [lobby.id, rosterDiscord(311), 'RADIANT', 10_000, betInteraction(3111)],
    );
    const wallet = await asRole<{
      result: {
        user_id: string;
        available_centavos: number;
        reserved_centavos: number;
        total_centavos: number;
      };
    }>('service_role', null, 'select public.get_discord_wallet($1) result', [
      rosterDiscord(311),
    ]);
    expect(wallet[0]?.result).toMatchObject({
      user_id: memberId,
      available_centavos: 20_000,
      reserved_centavos: 10_000,
      total_centavos: 30_000,
    });
    await asRole(
      'service_role',
      null,
      'select public.leave_lobby_self_with_interaction($1,$2,$3,null)',
      [lobby.id, rosterDiscord(311), betInteraction(3112)],
    );
    const history = await asRole<{
      result: {
        user_id: string;
        total: number;
        transactions: { id: string; type: string; created_at: string }[];
      };
    }>(
      'service_role',
      null,
      'select public.get_discord_transactions($1,$2,$3) result',
      [rosterDiscord(311), 11, 0],
    );
    expect(history[0]?.result.user_id).toBe(memberId);
    const transactions = history[0]!.result.transactions;
    expect(transactions.map((row) => row.type).sort()).toEqual([
      'LOBBY_ROSTER_RELEASE',
      'LOBBY_ROSTER_RESERVE',
    ]);
    expect(transactions).toEqual(
      [...transactions].sort(
        (left, right) =>
          right.created_at.localeCompare(left.created_at) ||
          right.id.localeCompare(left.id),
      ),
    );
  });

  it('keeps member wallet RPCs service-only and rejects inactive or unknown Discord identities', async () => {
    await expect(
      asRole(
        'authenticated',
        ids.member,
        'select public.get_discord_wallet($1)',
        [discord.member],
      ),
    ).rejects.toThrow();
    await rosterMember(313, { active: false });
    await expect(
      asRole('service_role', null, 'select public.get_discord_wallet($1)', [
        rosterDiscord(313),
      ]),
    ).rejects.toThrow('Active Rampage member required');
    await expect(
      asRole(
        'service_role',
        null,
        'select public.get_discord_transactions($1,$2,$3)',
        ['899999999999999999', 11, 0],
      ),
    ).rejects.toThrow('Active Rampage member required');
  });
});
