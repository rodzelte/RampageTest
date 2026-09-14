-- Phase 1 only. Reviewed repository was empty: no existing migrations or data files.
-- Intentionally fail on name collisions; never replace an unknown existing schema.
begin;

create schema rampage_private;
revoke all on schema rampage_private from public;
grant usage on schema rampage_private to authenticated, service_role;

create table public.members (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null unique check (discord_user_id ~ '^[0-9]{17,20}$'),
  -- Optional future verified Auth link. Never assigned from user-supplied metadata.
  auth_user_id uuid unique references auth.users(id) on delete restrict,
  discord_username text,
  display_name text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  email text not null check (length(trim(email)) > 0),
  role text not null check (role in ('OWNER', 'ADMIN')),
  discord_user_id text unique check (discord_user_id ~ '^[0-9]{17,20}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owner_must_be_active check (role <> 'OWNER' or active)
);
create unique index staff_email_unique on public.staff_profiles (lower(email));
create unique index one_active_owner on public.staff_profiles ((role))
  where role = 'OWNER' and active;

create table public.wallets (
  user_id uuid primary key references public.members(id) on delete restrict,
  available_centavos bigint not null default 0
    check (available_centavos between 0 and 9007199254740991),
  reserved_centavos bigint not null default 0
    check (reserved_centavos between 0 and 9007199254740991),
  updated_at timestamptz not null default now()
);

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.wallets(user_id) on delete restrict,
  type text not null check (length(trim(type)) > 0),
  amount_centavos bigint not null check (amount_centavos between -9007199254740991 and 9007199254740991),
  available_before bigint not null check (available_before between 0 and 9007199254740991),
  available_after bigint not null check (available_after between 0 and 9007199254740991),
  reserved_before bigint not null check (reserved_before between 0 and 9007199254740991),
  reserved_after bigint not null check (reserved_after between 0 and 9007199254740991),
  source_type text not null,
  source_id text not null,
  actor_type text not null check (actor_type in ('MEMBER', 'ADMIN', 'OWNER', 'SYSTEM', 'PAYMENT_WEBHOOK')),
  actor_id text not null,
  idempotency_key text not null unique check (length(trim(idempotency_key)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint transaction_delta_matches check (
    amount_centavos = available_after - available_before + reserved_after - reserved_before
  )
);
create index wallet_transactions_member_time on public.wallet_transactions(user_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('MEMBER', 'ADMIN', 'OWNER', 'SYSTEM', 'PAYMENT_WEBHOOK')),
  actor_staff_id uuid references public.staff_profiles(id) on delete restrict,
  actor_discord_id text,
  actor_auth_user_id uuid references auth.users(id) on delete restrict,
  source text not null check (source in ('DISCORD', 'DASHBOARD', 'PAYMENT_WEBHOOK', 'SYSTEM')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_logs_time on public.audit_logs(created_at desc);

create function rampage_private.reject_history_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Historical records are append-only' using errcode = '42501';
end;
$$;
create trigger wallet_history_immutable before update or delete or truncate on public.wallet_transactions
  for each statement execute function rampage_private.reject_history_mutation();
create trigger audit_history_immutable before update or delete or truncate on public.audit_logs
  for each statement execute function rampage_private.reject_history_mutation();

create function rampage_private.protect_member_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.discord_user_id is distinct from old.discord_user_id then
    raise exception 'Member financial identity is immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger member_identity_immutable before update on public.members
  for each row execute function rampage_private.protect_member_identity();

create function rampage_private.protect_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.role = 'OWNER' and (tg_op = 'DELETE' or new.role <> 'OWNER'
      or not new.active or new.auth_user_id is distinct from old.auth_user_id
      or new.id is distinct from old.id) then
    raise exception 'The active OWNER cannot be removed or reassigned' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger protect_single_owner before update or delete on public.staff_profiles
  for each row execute function rampage_private.protect_owner();
create trigger prevent_staff_truncate before truncate on public.staff_profiles
  for each statement execute function rampage_private.reject_history_mutation();

create function rampage_private.initialize_wallet() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wallets(user_id) values (new.id);
  return new;
end;
$$;
create trigger member_wallet_created after insert on public.members
  for each row execute function rampage_private.initialize_wallet();

create function rampage_private.current_staff_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.staff_profiles where auth_user_id = (select auth.uid()) and active;
$$;
create function rampage_private.current_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.members where auth_user_id = (select auth.uid());
$$;
create function rampage_private.require_owner() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid;
begin
  select id into actor from public.staff_profiles
    where auth_user_id = (select auth.uid()) and active and role = 'OWNER';
  if actor is null then raise exception 'Active OWNER required' using errcode = '42501'; end if;
  return actor;
end;
$$;

alter table public.members enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.audit_logs enable row level security;

create policy members_read_self_or_staff on public.members for select to authenticated
  using (id = (select rampage_private.current_member_id()) or (select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));
create policy staff_read_self_or_owner on public.staff_profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select rampage_private.current_staff_role()) = 'OWNER');
create policy wallets_read_self_or_staff on public.wallets for select to authenticated
  using (user_id = (select rampage_private.current_member_id()) or (select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));
create policy transactions_read_self_or_staff on public.wallet_transactions for select to authenticated
  using (user_id = (select rampage_private.current_member_id()) or (select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));
create policy audit_read_owner on public.audit_logs for select to authenticated
  using ((select rampage_private.current_staff_role()) = 'OWNER');

-- No application role has direct INSERT/UPDATE/DELETE/TRUNCATE privileges.
-- Every future money mutation must add its own narrowly scoped transactional RPC.
revoke all on public.members, public.staff_profiles, public.wallets,
  public.wallet_transactions, public.audit_logs from public, anon, authenticated, service_role;
grant select on public.members, public.staff_profiles, public.wallets,
  public.wallet_transactions, public.audit_logs to authenticated, service_role;

create function public.ensure_member(p_discord_user_id text, p_username text default null, p_display_name text default null)
returns public.members language plpgsql security definer set search_path = '' as $$
declare member_row public.members;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord user ID' using errcode = '22023';
  end if;
  insert into public.members(discord_user_id, discord_username, display_name)
    values(p_discord_user_id, p_username, p_display_name)
    on conflict(discord_user_id) do update set
      discord_username = coalesce(excluded.discord_username, members.discord_username),
      display_name = coalesce(excluded.display_name, members.display_name)
    returning * into member_row;
  return member_row;
end;
$$;

create function public.bootstrap_owner(p_owner_email text, p_discord_user_id text default null)
returns public.staff_profiles language plpgsql security definer set search_path = '' as $$
declare account auth.users; owner_row public.staff_profiles; target public.staff_profiles;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bootstrap required' using errcode = '42501';
  end if;
  if p_owner_email is null or length(trim(p_owner_email)) = 0 then
    raise exception 'OWNER_EMAIL is required' using errcode = '22023';
  end if;
  -- Serialize competing bootstraps, including the initially empty table.
  lock table public.staff_profiles in share row exclusive mode;
  select * into account from auth.users where lower(email) = lower(trim(p_owner_email));
  if account.id is null or account.email_confirmed_at is null then
    raise exception 'OWNER_EMAIL must match an existing confirmed Supabase Auth account' using errcode = '22023';
  end if;
  select * into owner_row from public.staff_profiles where role = 'OWNER' and active;
  if owner_row.id is not null then
    if owner_row.auth_user_id <> account.id then
      raise exception 'OWNER conflict: another active OWNER already exists' using errcode = '23505';
    end if;
    if p_discord_user_id is not null and p_discord_user_id is distinct from owner_row.discord_user_id then
      raise exception 'OWNER already exists; use the audited Discord mapping RPC' using errcode = '22023';
    end if;
    return owner_row;
  end if;
  select * into target from public.staff_profiles where auth_user_id = account.id;
  insert into public.staff_profiles(auth_user_id, email, role, discord_user_id, active)
    values(account.id, account.email, 'OWNER', p_discord_user_id, true)
    on conflict(auth_user_id) do update set role = 'OWNER', active = true,
      email = excluded.email, discord_user_id = coalesce(excluded.discord_user_id, staff_profiles.discord_user_id)
    returning * into owner_row;
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source, action, entity_type, entity_id, old_data, new_data)
    values('SYSTEM', owner_row.id, account.id, 'SYSTEM', 'OWNER_BOOTSTRAPPED', 'staff_profiles', owner_row.id,
      case when target.id is not null then to_jsonb(target) else null end, to_jsonb(owner_row));
  return owner_row;
end;
$$;

create function public.get_staff_session() returns public.staff_profiles
language plpgsql stable security definer set search_path = '' as $$
declare staff public.staff_profiles;
begin
  select * into staff from public.staff_profiles where auth_user_id = (select auth.uid()) and active;
  if staff.id is null then raise exception 'Active staff account required' using errcode = '42501'; end if;
  return staff;
end;
$$;

create function public.record_staff_login() returns void
language plpgsql security definer set search_path = '' as $$
declare staff public.staff_profiles;
begin
  staff := public.get_staff_session();
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source, action, entity_type, entity_id)
    values(staff.role, staff.id, auth.uid(), 'DASHBOARD', 'STAFF_LOGIN', 'staff_profiles', staff.id);
end;
$$;

create function public.owner_set_admin(p_email text, p_discord_user_id text default null,
  p_active boolean default true, p_reason text default null)
returns public.staff_profiles language plpgsql security definer set search_path = '' as $$
declare actor uuid; account auth.users; previous public.staff_profiles; updated public.staff_profiles;
begin
  -- Serialize staff changes so authorization and target changes cannot race a disable.
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_owner();
  if p_active is null or (not p_active and coalesce(length(trim(p_reason)), 0) = 0) then
    raise exception 'Disabling an ADMIN requires a reason' using errcode = '22023';
  end if;
  select * into account from auth.users where lower(email) = lower(trim(p_email));
  if account.id is null or account.email_confirmed_at is null then
    raise exception 'Existing confirmed Supabase Auth account required' using errcode = '22023';
  end if;
  select * into previous from public.staff_profiles where auth_user_id = account.id;
  if previous.role = 'OWNER' then raise exception 'Cannot change OWNER through ADMIN management' using errcode = '42501'; end if;
  if previous.id is null and not p_active then raise exception 'ADMIN does not exist' using errcode = '22023'; end if;
  insert into public.staff_profiles(auth_user_id, email, role, discord_user_id, active)
    values(account.id, account.email, 'ADMIN', p_discord_user_id, p_active)
    on conflict(auth_user_id) do update set email = excluded.email, active = excluded.active,
      discord_user_id = coalesce(excluded.discord_user_id, staff_profiles.discord_user_id)
    returning * into updated;
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source, action, entity_type, entity_id, old_data, new_data, reason)
    values('OWNER', actor, auth.uid(), 'DASHBOARD',
      case when previous.id is null then 'ADMIN_CREATED' when not p_active then 'ADMIN_DISABLED' else 'ADMIN_UPDATED' end,
      'staff_profiles', updated.id, case when previous.id is not null then to_jsonb(previous) else null end, to_jsonb(updated), p_reason);
  return updated;
end;
$$;

create function public.owner_set_staff_discord(p_staff_id uuid, p_discord_user_id text, p_reason text)
returns public.staff_profiles language plpgsql security definer set search_path = '' as $$
declare actor uuid; previous public.staff_profiles; updated public.staff_profiles;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_owner();
  if coalesce(length(trim(p_reason)), 0) = 0 then raise exception 'Mapping change requires a reason' using errcode = '22023'; end if;
  select * into previous from public.staff_profiles where id = p_staff_id;
  if previous.id is null then raise exception 'Staff profile not found' using errcode = '22023'; end if;
  update public.staff_profiles set discord_user_id = p_discord_user_id where id = p_staff_id returning * into updated;
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source, action, entity_type, entity_id, old_data, new_data, reason)
    values('OWNER', actor, auth.uid(), 'DASHBOARD', 'ADMIN_DISCORD_ID_CHANGED', 'staff_profiles', updated.id,
      to_jsonb(previous), to_jsonb(updated), p_reason);
  return updated;
end;
$$;

create function public.authorize_discord(p_discord_user_id text, p_required_role text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare staff public.staff_profiles; member_row public.members;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted bot required' using errcode = '42501'; end if;
  if p_required_role is null or p_required_role not in ('MEMBER', 'ADMIN', 'OWNER') then
    raise exception 'Invalid required role' using errcode = '22023';
  end if;
  if p_required_role = 'MEMBER' then
    select * into member_row from public.members where discord_user_id = p_discord_user_id and status = 'ACTIVE';
    if member_row.id is null then raise exception 'Active member required' using errcode = '42501'; end if;
    return jsonb_build_object('id', member_row.id, 'role', 'MEMBER', 'discord_user_id', member_row.discord_user_id);
  end if;
  select * into staff from public.staff_profiles where discord_user_id = p_discord_user_id and active;
  if staff.id is null or (p_required_role = 'OWNER' and staff.role <> 'OWNER') then
    raise exception 'Insufficient staff permission' using errcode = '42501';
  end if;
  return jsonb_build_object('id', staff.id, 'role', staff.role, 'discord_user_id', staff.discord_user_id);
end;
$$;

-- Explicit function ACLs override Supabase's permissive default grants.
revoke all on function rampage_private.reject_history_mutation(), rampage_private.protect_member_identity(),
  rampage_private.protect_owner(), rampage_private.initialize_wallet(), rampage_private.current_staff_role(),
  rampage_private.current_member_id(), rampage_private.require_owner() from public, anon, authenticated, service_role;
grant execute on function rampage_private.current_staff_role(), rampage_private.current_member_id() to authenticated;
revoke all on function public.ensure_member(text,text,text), public.bootstrap_owner(text,text),
  public.get_staff_session(), public.record_staff_login(), public.owner_set_admin(text,text,boolean,text),
  public.owner_set_staff_discord(uuid,text,text), public.authorize_discord(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_member(text,text,text), public.bootstrap_owner(text,text),
  public.authorize_discord(text,text) to service_role;
grant execute on function public.get_staff_session(), public.record_staff_login(),
  public.owner_set_admin(text,text,boolean,text), public.owner_set_staff_discord(uuid,text,text) to authenticated;

commit;
