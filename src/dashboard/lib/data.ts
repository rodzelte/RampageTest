import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  centavosSchema,
  memberSchema,
  staffSchema,
  discordIdSchema,
  topupSchema,
} from '../../shared/models';
import {
  getStaffSession,
  StaffAuthorizationError,
} from '../../shared/staff-auth';
import { dateBounds } from './dates';
import { dashboardConfig } from './config';

export const PAGE_SIZE = 25;
const walletBalance = z.object({
  available_centavos: centavosSchema,
  reserved_centavos: centavosSchema,
});
const memberWithWallet = memberSchema.extend({
  wallets: walletBalance.nullable(),
});
export type MemberWithWallet = z.infer<typeof memberWithWallet>;
export const auditSchema = z.object({
  id: z.uuid(),
  actor_type: z.string(),
  actor_staff_id: z.uuid().nullable(),
  actor_auth_user_id: z.uuid().nullable(),
  actor_discord_id: z.string().nullable(),
  source: z.string(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.uuid().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type AuditEvent = z.infer<typeof auditSchema>;
export type AuditFilters = {
  date: string;
  source: string;
  action: string;
  actor: string;
};
export const emptyAuditFilters: AuditFilters = {
  date: '',
  source: '',
  action: '',
  actor: '',
};
const topupWithMember = topupSchema.extend({
  members: z.object({
    discord_user_id: discordIdSchema,
    discord_username: z.string().nullable(),
    display_name: z.string().nullable(),
  }),
});
export type TopupWithMember = z.infer<typeof topupWithMember>;
export type PaymentFilters = {
  date: string;
  status: string;
  discord: string;
  reference: string;
};
export const emptyPaymentFilters: PaymentFilters = {
  date: '',
  status: '',
  discord: '',
  reference: '',
};

function queryError(error: { code?: string } | null, context: string) {
  if (!error) return;
  // Code/context only: never log tokens, query payloads, or financial records.
  if (import.meta.env.DEV)
    console.warn(`[dashboard:${context}]`, error.code ?? 'request_failed');
  throw new Error(
    `Unable to load ${context}. Check your connection and access, then try again.`,
  );
}
export function sumWalletLiability(wallets: z.infer<typeof walletBalance>[]) {
  const total = wallets.reduce((sum, row) => {
    const valid = walletBalance.parse(row);
    return (
      sum + BigInt(valid.available_centavos) + BigInt(valid.reserved_centavos)
    );
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Wallet liability exceeds the supported display range.');
  return Number(total);
}

async function loadLiability(client: SupabaseClient, signal: AbortSignal) {
  let total = 0n;
  // Do not silently truncate totals at Supabase's default 1,000-row limit.
  const batchSize = 500;
  for (let offset = 0; ; offset += batchSize) {
    const { data, error } = await client
      .from('wallets')
      .select('user_id,available_centavos,reserved_centavos')
      .order('user_id')
      .range(offset, offset + batchSize - 1)
      .abortSignal(signal);
    queryError(error, 'wallet liability');
    const rows = z.array(walletBalance).parse(data);
    total += BigInt(sumWalletLiability(rows));
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Wallet liability exceeds the supported display range.');
    if (rows.length < batchSize) return Number(total);
  }
}

async function loadCashIn(client: SupabaseClient, signal: AbortSignal) {
  let total = 0n;
  let today = 0n;
  const localToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: dashboardConfig.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const bounds = dateBounds(localToday);
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client
      .from('wallet_transactions')
      .select('id,amount_centavos,created_at')
      .eq('type', 'TOPUP')
      .eq('source_type', 'TOPUP')
      .order('id')
      .range(offset, offset + 499)
      .abortSignal(signal);
    queryError(error, 'cash in');
    const rows = z
      .array(
        z.object({
          amount_centavos: z.number().int().positive(),
          created_at: z.string(),
        }),
      )
      .parse(data);
    for (const row of rows) {
      total += BigInt(row.amount_centavos);
      if (row.created_at >= bounds.start && row.created_at < bounds.end)
        today += BigInt(row.amount_centavos);
    }
    if (
      total > BigInt(Number.MAX_SAFE_INTEGER) ||
      today > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Cash in exceeds the supported display range.');
    if (rows.length < 500)
      return { totalCashIn: Number(total), todayCashIn: Number(today) };
  }
}

export async function loadOverview(
  client: SupabaseClient,
  role: 'OWNER' | 'ADMIN',
  signal: AbortSignal,
) {
  const [members, liability, admins, cashIn] = await Promise.all([
    client
      .from('members')
      .select('id', { count: 'exact', head: true })
      .abortSignal(signal),
    loadLiability(client, signal),
    role === 'OWNER'
      ? client
          .from('staff_profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'ADMIN')
          .eq('active', true)
          .abortSignal(signal)
      : null,
    loadCashIn(client, signal),
  ]);
  queryError(members.error, 'member count');
  if (admins) queryError(admins.error, 'admin count');
  if (members.count === null || (admins && admins.count === null))
    throw new Error('Overview counts are unavailable. Please try again.');
  return {
    totalMembers: members.count,
    liability,
    activeAdmins: admins?.count ?? null,
    ...cashIn,
  };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
export function memberSearchFilter(search: string) {
  const value = JSON.stringify(`%${escapeLike(search.trim())}%`);
  return ['discord_user_id', 'discord_username', 'display_name']
    .map((field) => `${field}.ilike.${value}`)
    .join(',');
}
export async function loadMembers(
  client: SupabaseClient,
  search: string,
  page: number,
  signal: AbortSignal,
) {
  let query = client
    .from('members')
    .select('*,wallets(available_centavos,reserved_centavos)', {
      count: 'exact',
    });
  if (search.trim()) query = query.or(memberSearchFilter(search));
  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .order('id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    .abortSignal(signal);
  queryError(error, 'members');
  if (count === null)
    throw new Error('Member count is unavailable. Please try again.');
  return { rows: z.array(memberWithWallet).parse(data), count };
}

export async function loadStaff(client: SupabaseClient, signal: AbortSignal) {
  const rows: z.infer<typeof staffSchema>[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client
      .from('staff_profiles')
      .select('*')
      .order('created_at')
      .order('id')
      .range(offset, offset + 499)
      .abortSignal(signal);
    queryError(error, 'staff accounts');
    const batch = z.array(staffSchema).parse(data);
    rows.push(...batch);
    if (batch.length < 500) return rows;
  }
}

export async function loadAudit(
  client: SupabaseClient,
  filters: AuditFilters,
  page: number,
  signal: AbortSignal,
) {
  let query = client
    .from('audit_logs')
    .select(
      'id,actor_type,actor_staff_id,actor_auth_user_id,actor_discord_id,source,action,entity_type,entity_id,reason,created_at',
      { count: 'exact' },
    );
  if (filters.date) {
    const { start, end } = dateBounds(filters.date);
    query = query.gte('created_at', start).lt('created_at', end);
  }
  if (filters.source) query = query.eq('source', filters.source);
  if (filters.action.trim())
    query = query.ilike('action', `%${escapeLike(filters.action.trim())}%`);
  if (filters.actor === 'SYSTEM') query = query.eq('actor_type', 'SYSTEM');
  else if (filters.actor) query = query.eq('actor_staff_id', filters.actor);
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    .abortSignal(signal);
  queryError(error, 'audit events');
  if (count === null)
    throw new Error('Audit count is unavailable. Please try again.');
  return { rows: z.array(auditSchema).parse(data), count };
}

export async function loadPayments(
  client: SupabaseClient,
  filters: PaymentFilters,
  page: number,
  signal: AbortSignal,
) {
  let query = client
    .from('topups')
    .select('*,members!inner(discord_user_id,discord_username,display_name)', {
      count: 'exact',
    });
  if (filters.date) {
    const { start, end } = dateBounds(filters.date);
    query = query.gte('created_at', start).lt('created_at', end);
  }
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.discord.trim())
    query = query.eq('members.discord_user_id', filters.discord.trim());
  if (filters.reference.trim())
    query = query.ilike(
      'provider_reference',
      `%${escapeLike(filters.reference.trim())}%`,
    );
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    .abortSignal(signal);
  queryError(error, 'payments');
  if (count === null)
    throw new Error('Payment count is unavailable. Please try again.');
  return { rows: z.array(topupWithMember).parse(data), count };
}

async function requireCurrentOwner(client: SupabaseClient) {
  const staff = await getStaffSession(client);
  if (staff.role !== 'OWNER')
    throw new StaffAuthorizationError(
      'Only the active OWNER can manage staff.',
    );
}
function mutationError(error: { code?: string; message: string }) {
  if (error.code === '42501')
    return new StaffAuthorizationError(
      'You are not authorized to manage staff.',
    );
  if (error.code === '23505')
    return new Error(
      'That email or Discord ID is already linked to a staff account.',
    );
  if (error.code === '22023' && /confirmed|Auth account/i.test(error.message))
    return new Error(
      "Create or invite this user's Supabase Auth account first, and confirm their email.",
    );
  if (error.code === '22023')
    return new Error('Check the account, Discord ID, and required reason.');
  return new Error(
    'Unable to save this change. Check your connection and try again.',
  );
}

export async function setAdmin(
  client: SupabaseClient,
  input: { email: string; discordId: string; active: boolean; reason: string },
) {
  const email = z.email().parse(input.email.trim());
  const discordId = input.discordId.trim()
    ? discordIdSchema.parse(input.discordId.trim())
    : null;
  if (!input.active && !input.reason.trim())
    throw new Error('A reason is required to disable an admin.');
  await requireCurrentOwner(client);
  const { data, error } = await client
    .rpc('owner_set_admin', {
      p_email: email,
      p_discord_user_id: discordId,
      p_active: input.active,
      p_reason: input.reason.trim() || null,
    })
    .single();
  if (error) throw mutationError(error);
  return staffSchema.parse(data);
}

export async function setStaffDiscord(
  client: SupabaseClient,
  input: { staffId: string; discordId: string; reason: string },
) {
  z.uuid().parse(input.staffId);
  const discordId = input.discordId.trim()
    ? discordIdSchema.parse(input.discordId.trim())
    : null;
  if (!input.reason.trim())
    throw new Error('A reason is required to change a Discord mapping.');
  await requireCurrentOwner(client);
  const { data, error } = await client
    .rpc('owner_set_staff_discord', {
      p_staff_id: input.staffId,
      p_discord_user_id: discordId,
      p_reason: input.reason.trim(),
    })
    .single();
  if (error) throw mutationError(error);
  return staffSchema.parse(data);
}

export async function resolveTopupReview(
  client: SupabaseClient,
  input: {
    topupId: string;
    decision: 'APPROVE' | 'REJECT';
    reason: string;
    creditAmountCentavos: number | null;
  },
) {
  z.uuid().parse(input.topupId);
  if (!input.reason.trim()) throw new Error('A review reason is required.');
  if (
    input.decision === 'APPROVE' &&
    (!input.creditAmountCentavos || input.creditAmountCentavos <= 0)
  )
    throw new Error('Confirm the positive amount to credit.');
  await requireCurrentOwner(client);
  const { data, error } = await client
    .rpc('owner_resolve_topup_review', {
      p_topup_id: input.topupId,
      p_decision: input.decision,
      p_reason: input.reason.trim(),
      p_credit_amount_centavos:
        input.decision === 'APPROVE' ? input.creditAmountCentavos : null,
    })
    .single();
  if (error) throw mutationError(error);
  return topupSchema.parse(data);
}
