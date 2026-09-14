-- Phase 3 only: private GCash top-ups and verified wallet credit.
-- Additive migration. Phase 1 tables and functions are preserved.
begin;

create table public.topups (
  id uuid primary key,
  user_id uuid not null references public.members(id) on delete restrict,
  amount_centavos bigint not null
    check (amount_centavos between 1 and 10000000),
  currency text not null default 'PHP' check (currency = 'PHP'),
  provider text not null check (length(trim(provider)) > 0),
  provider_payment_id text unique,
  provider_reference text,
  provider_event_id text,
  status text not null check (status in (
    'PENDING', 'PAID', 'EXPIRED', 'LATE_PAID_REVIEW',
    'AMOUNT_MISMATCH_REVIEW', 'FAILED', 'REJECTED', 'RESOLVED'
  )),
  qr_created_at timestamptz,
  expires_at timestamptz not null,
  provider_paid_amount_centavos bigint
    check (provider_paid_amount_centavos between 0 and 9007199254740991),
  provider_paid_at timestamptz,
  credited_at timestamptz,
  reviewed_by uuid references public.staff_profiles(id) on delete restrict,
  review_note text,
  review_resolution text check (review_resolution in ('APPROVED_CREDIT', 'REJECTED_CREDIT')),
  resolved_at timestamptz,
  notification_claimed_at timestamptz,
  notification_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint topup_expiry_after_creation check (expires_at > created_at),
  constraint topup_paid_evidence_together check (
    (provider_paid_amount_centavos is null) = (provider_paid_at is null)
  ),
  constraint topup_review_fields_consistent check (
    (review_resolution is null and resolved_at is null)
    or (review_resolution is not null and resolved_at is not null and review_note is not null)
  )
);
create unique index topups_provider_event_unique
  on public.topups(provider, provider_event_id) where provider_event_id is not null;
create index topups_created_time on public.topups(created_at desc);
create index topups_status_time on public.topups(status, created_at desc);
create index topups_member_time on public.topups(user_id, created_at desc);
create index topups_provider_reference on public.topups(provider_reference)
  where provider_reference is not null;

create function rampage_private.protect_topup_evidence() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.amount_centavos is distinct from old.amount_centavos
      or new.currency is distinct from old.currency
      or new.provider is distinct from old.provider
      or new.expires_at is distinct from old.expires_at
      or new.created_at is distinct from old.created_at then
    raise exception 'Original top-up identity and request are immutable' using errcode = '42501';
  end if;
  if (old.provider_payment_id is not null and new.provider_payment_id is distinct from old.provider_payment_id)
      or (old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference)
      or (old.qr_created_at is not null and new.qr_created_at is distinct from old.qr_created_at)
      or (old.provider_event_id is not null and new.provider_event_id is distinct from old.provider_event_id)
      or (old.provider_paid_amount_centavos is not null and new.provider_paid_amount_centavos is distinct from old.provider_paid_amount_centavos)
      or (old.provider_paid_at is not null and new.provider_paid_at is distinct from old.provider_paid_at)
      or (old.credited_at is not null and new.credited_at is distinct from old.credited_at) then
    raise exception 'Provider and credit evidence are immutable once recorded' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger topup_evidence_immutable before update on public.topups
  for each row execute function rampage_private.protect_topup_evidence();
create trigger topup_history_no_delete before delete or truncate on public.topups
  for each statement execute function rampage_private.reject_history_mutation();

alter table public.topups enable row level security;
create policy topups_read_self_or_staff on public.topups for select to authenticated
  using (
    user_id = (select rampage_private.current_member_id())
    or (select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER')
  );

revoke all on public.topups from public, anon, authenticated, service_role;
grant select on public.topups to authenticated, service_role;

create function public.create_topup(
  p_topup_id uuid,
  p_user_id uuid,
  p_amount_centavos bigint,
  p_provider text,
  p_expires_at timestamptz
) returns public.topups
language plpgsql security definer set search_path = '' as $$
declare member_row public.members; topup_row public.topups;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  if p_topup_id is null or p_amount_centavos is null
      or p_amount_centavos < 1 or p_amount_centavos > 10000000 then
    raise exception 'Invalid top-up amount' using errcode = '22023';
  end if;
  if p_provider is null or length(trim(p_provider)) = 0 then
    raise exception 'Provider is required' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > clock_timestamp() + interval '24 hours' then
    raise exception 'Invalid top-up expiry' using errcode = '22023';
  end if;
  select * into member_row from public.members where id = p_user_id and status = 'ACTIVE';
  if member_row.id is null then
    raise exception 'Active member required' using errcode = '42501';
  end if;
  insert into public.topups(id, user_id, amount_centavos, provider, status, expires_at)
    values(p_topup_id, p_user_id, p_amount_centavos, upper(trim(p_provider)), 'PENDING', p_expires_at)
    returning * into topup_row;
  insert into public.audit_logs(actor_type, actor_discord_id, source, action, entity_type, entity_id, new_data)
    values('MEMBER', member_row.discord_user_id, 'DISCORD', 'TOPUP_CREATED', 'topups', topup_row.id,
      jsonb_build_object('amount_centavos', topup_row.amount_centavos, 'currency', topup_row.currency,
        'provider', topup_row.provider, 'expires_at', topup_row.expires_at));
  return topup_row;
end;
$$;

create function public.set_topup_provider(
  p_topup_id uuid,
  p_provider_payment_id text,
  p_provider_reference text default null
) returns public.topups
language plpgsql security definer set search_path = '' as $$
declare topup_row public.topups;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0 then
    raise exception 'Provider payment ID is required' using errcode = '22023';
  end if;
  select * into topup_row from public.topups where id = p_topup_id for update;
  if topup_row.id is null then raise exception 'Top-up not found' using errcode = 'P0002'; end if;
  if topup_row.status <> 'PENDING' or topup_row.provider_payment_id is not null then
    raise exception 'Top-up cannot accept provider details' using errcode = '22023';
  end if;
  update public.topups set provider_payment_id = trim(p_provider_payment_id),
      provider_reference = nullif(trim(p_provider_reference), ''), qr_created_at = now()
    where id = p_topup_id returning * into topup_row;
  return topup_row;
end;
$$;

create function public.fail_topup_creation(p_topup_id uuid, p_reason text)
returns public.topups language plpgsql security definer set search_path = '' as $$
declare topup_row public.topups;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  select * into topup_row from public.topups where id = p_topup_id for update;
  if topup_row.id is null then raise exception 'Top-up not found' using errcode = 'P0002'; end if;
  if topup_row.status = 'PENDING' then
    update public.topups set status = 'FAILED' where id = p_topup_id returning * into topup_row;
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, reason)
      values('SYSTEM', 'SYSTEM', 'TOPUP_FAILED', 'topups', topup_row.id,
        left(coalesce(nullif(trim(p_reason), ''), 'Provider QR creation failed'), 500));
  end if;
  return topup_row;
end;
$$;

create function public.expire_pending_topups()
returns integer language plpgsql security definer set search_path = '' as $$
declare topup_row public.topups; expired_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted worker required' using errcode = '42501';
  end if;
  for topup_row in
    select * from public.topups where status = 'PENDING' and expires_at < clock_timestamp() for update skip locked
  loop
    update public.topups set status = 'EXPIRED' where id = topup_row.id;
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
      values('SYSTEM', 'SYSTEM', 'TOPUP_EXPIRED', 'topups', topup_row.id,
        jsonb_build_object('expired_at', topup_row.expires_at));
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end;
$$;

create function public.process_verified_topup(
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_paid_amount_centavos bigint,
  p_currency text,
  p_paid_at timestamptz,
  p_success boolean
) returns public.topups
language plpgsql security definer set search_path = '' as $$
declare topup_row public.topups; wallet_row public.wallets; updated_topup public.topups;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Verified payment worker required' using errcode = '42501';
  end if;
  if p_provider_payment_id is null or length(trim(p_provider_payment_id)) = 0
      or p_provider_event_id is null or length(trim(p_provider_event_id)) = 0 then
    raise exception 'Provider payment and event IDs are required' using errcode = '22023';
  end if;
  select * into topup_row from public.topups
    where provider = upper(trim(p_provider)) and provider_payment_id = trim(p_provider_payment_id)
    for update;
  if topup_row.id is null then raise exception 'Unknown provider payment ID' using errcode = 'P0002'; end if;

  -- Terminal states make provider retries safe and audit/credit idempotent.
  if topup_row.status in ('PAID', 'LATE_PAID_REVIEW', 'AMOUNT_MISMATCH_REVIEW', 'FAILED', 'REJECTED', 'RESOLVED') then
    return topup_row;
  end if;
  if upper(trim(p_currency)) <> 'PHP' then
    raise exception 'Payment currency must be PHP' using errcode = '22023';
  end if;
  if p_paid_amount_centavos is null or p_paid_amount_centavos < 0
      or p_paid_amount_centavos > 9007199254740991 or p_paid_at is null then
    raise exception 'Invalid provider payment evidence' using errcode = '22023';
  end if;
  if p_paid_at < coalesce(topup_row.qr_created_at, topup_row.created_at) - interval '5 minutes'
      or p_paid_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Invalid provider payment timestamp' using errcode = '22023';
  end if;

  if not p_success then
    update public.topups set status = 'FAILED', provider_event_id = trim(p_provider_event_id),
        provider_paid_amount_centavos = p_paid_amount_centavos, provider_paid_at = p_paid_at
      where id = topup_row.id returning * into updated_topup;
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
      values('PAYMENT_WEBHOOK', 'PAYMENT_WEBHOOK', 'TOPUP_FAILED', 'topups', topup_row.id,
        jsonb_build_object('provider_event_id', p_provider_event_id));
    return updated_topup;
  end if;

  if p_paid_amount_centavos <> topup_row.amount_centavos then
    update public.topups set status = 'AMOUNT_MISMATCH_REVIEW', provider_event_id = trim(p_provider_event_id),
        provider_paid_amount_centavos = p_paid_amount_centavos, provider_paid_at = p_paid_at
      where id = topup_row.id returning * into updated_topup;
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
      values('PAYMENT_WEBHOOK', 'PAYMENT_WEBHOOK', 'TOPUP_AMOUNT_MISMATCH', 'topups', topup_row.id,
        jsonb_build_object('requested_amount_centavos', topup_row.amount_centavos,
          'paid_amount_centavos', p_paid_amount_centavos, 'paid_after_expiry', p_paid_at > topup_row.expires_at));
    return updated_topup;
  end if;

  if p_paid_at > topup_row.expires_at then
    update public.topups set status = 'LATE_PAID_REVIEW', provider_event_id = trim(p_provider_event_id),
        provider_paid_amount_centavos = p_paid_amount_centavos, provider_paid_at = p_paid_at
      where id = topup_row.id returning * into updated_topup;
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
      values('PAYMENT_WEBHOOK', 'PAYMENT_WEBHOOK', 'TOPUP_LATE_PAYMENT', 'topups', topup_row.id,
        jsonb_build_object('paid_at', p_paid_at, 'expires_at', topup_row.expires_at));
    return updated_topup;
  end if;

  select * into wallet_row from public.wallets where user_id = topup_row.user_id for update;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode = 'P0002'; end if;
  if wallet_row.available_centavos + topup_row.amount_centavos > 9007199254740991 then
    raise exception 'Wallet balance exceeds supported range' using errcode = '22003';
  end if;
  update public.wallets set available_centavos = available_centavos + topup_row.amount_centavos,
      updated_at = now() where user_id = topup_row.user_id;
  insert into public.wallet_transactions(
      user_id, type, amount_centavos, available_before, available_after,
      reserved_before, reserved_after, source_type, source_id, actor_type,
      actor_id, idempotency_key, metadata)
    values(topup_row.user_id, 'TOPUP', topup_row.amount_centavos,
      wallet_row.available_centavos, wallet_row.available_centavos + topup_row.amount_centavos,
      wallet_row.reserved_centavos, wallet_row.reserved_centavos, 'TOPUP', topup_row.id::text,
      'PAYMENT_WEBHOOK', trim(p_provider_event_id), 'topup:' || topup_row.id::text || ':credit',
      jsonb_build_object('provider', topup_row.provider, 'provider_payment_id', topup_row.provider_payment_id,
        'provider_event_id', p_provider_event_id));
  update public.topups set status = 'PAID', provider_event_id = trim(p_provider_event_id),
      provider_paid_amount_centavos = p_paid_amount_centavos, provider_paid_at = p_paid_at,
      credited_at = now() where id = topup_row.id returning * into updated_topup;
  insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
    values('PAYMENT_WEBHOOK', 'PAYMENT_WEBHOOK', 'TOPUP_PAID', 'topups', topup_row.id,
      jsonb_build_object('amount_centavos', topup_row.amount_centavos,
        'provider_payment_id', topup_row.provider_payment_id, 'provider_event_id', p_provider_event_id));
  return updated_topup;
end;
$$;

create function public.owner_resolve_topup_review(
  p_topup_id uuid,
  p_decision text,
  p_reason text,
  p_credit_amount_centavos bigint default null
) returns public.topups
language plpgsql security definer set search_path = '' as $$
declare actor uuid; topup_row public.topups; wallet_row public.wallets; updated_topup public.topups;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_owner();
  if p_decision not in ('APPROVE', 'REJECT') or coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'A valid decision and reason are required' using errcode = '22023';
  end if;
  select * into topup_row from public.topups where id = p_topup_id for update;
  if topup_row.id is null then raise exception 'Top-up not found' using errcode = 'P0002'; end if;
  if topup_row.status not in ('LATE_PAID_REVIEW', 'AMOUNT_MISMATCH_REVIEW')
      or topup_row.credited_at is not null or topup_row.review_resolution is not null then
    raise exception 'Top-up is not awaiting review' using errcode = '22023';
  end if;

  if p_decision = 'REJECT' then
    update public.topups set status = 'RESOLVED', reviewed_by = actor,
        review_note = trim(p_reason), review_resolution = 'REJECTED_CREDIT', resolved_at = now()
      where id = topup_row.id returning * into updated_topup;
    insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source,
        action, entity_type, entity_id, old_data, new_data, reason)
      values('OWNER', actor, auth.uid(), 'DASHBOARD', 'TOPUP_REVIEW_REJECTED', 'topups', topup_row.id,
        to_jsonb(topup_row), to_jsonb(updated_topup), trim(p_reason));
    return updated_topup;
  end if;

  if p_credit_amount_centavos is null or p_credit_amount_centavos <= 0
      or p_credit_amount_centavos is distinct from topup_row.provider_paid_amount_centavos then
    raise exception 'Explicit credit amount must equal verified provider-paid amount' using errcode = '22023';
  end if;
  select * into wallet_row from public.wallets where user_id = topup_row.user_id for update;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode = 'P0002'; end if;
  if wallet_row.available_centavos + p_credit_amount_centavos > 9007199254740991 then
    raise exception 'Wallet balance exceeds supported range' using errcode = '22003';
  end if;
  update public.wallets set available_centavos = available_centavos + p_credit_amount_centavos,
      updated_at = now() where user_id = topup_row.user_id;
  insert into public.wallet_transactions(
      user_id, type, amount_centavos, available_before, available_after,
      reserved_before, reserved_after, source_type, source_id, actor_type,
      actor_id, idempotency_key, metadata)
    values(topup_row.user_id, 'TOPUP', p_credit_amount_centavos,
      wallet_row.available_centavos, wallet_row.available_centavos + p_credit_amount_centavos,
      wallet_row.reserved_centavos, wallet_row.reserved_centavos, 'TOPUP', topup_row.id::text,
      'OWNER', actor::text, 'topup:' || topup_row.id::text || ':credit',
      jsonb_build_object('review_reason', trim(p_reason), 'requested_amount_centavos', topup_row.amount_centavos,
        'provider_paid_amount_centavos', topup_row.provider_paid_amount_centavos,
        'approved_credit_amount_centavos', p_credit_amount_centavos));
  update public.topups set status = 'RESOLVED', credited_at = now(), reviewed_by = actor,
      review_note = trim(p_reason), review_resolution = 'APPROVED_CREDIT', resolved_at = now()
    where id = topup_row.id returning * into updated_topup;
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source,
      action, entity_type, entity_id, old_data, new_data, reason)
    values('OWNER', actor, auth.uid(), 'DASHBOARD', 'TOPUP_REVIEW_APPROVED', 'topups', topup_row.id,
      to_jsonb(topup_row), jsonb_build_object('topup', to_jsonb(updated_topup),
        'approved_credit_amount_centavos', p_credit_amount_centavos), trim(p_reason));
  return updated_topup;
end;
$$;

create function public.claim_topup_notification(p_topup_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare topup_row public.topups; member_row public.members; wallet_row public.wallets;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  select * into topup_row from public.topups where id = p_topup_id for update;
  if topup_row.id is null or topup_row.notification_claimed_at is not null
      or not (topup_row.status = 'PAID'
        or (topup_row.status = 'RESOLVED' and topup_row.review_resolution = 'APPROVED_CREDIT')) then
    return null;
  end if;
  update public.topups set notification_claimed_at = now() where id = topup_row.id;
  select * into member_row from public.members where id = topup_row.user_id;
  select * into wallet_row from public.wallets where user_id = topup_row.user_id;
  return jsonb_build_object(
    'topup_id', topup_row.id,
    'discord_user_id', member_row.discord_user_id,
    'credited_amount_centavos', case when topup_row.status = 'PAID' then topup_row.amount_centavos
      else topup_row.provider_paid_amount_centavos end,
    'available_centavos', wallet_row.available_centavos
  );
end;
$$;

create function public.record_topup_notification_failure(p_topup_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted bot required' using errcode = '42501';
  end if;
  update public.topups set notification_failure_at = now()
    where id = p_topup_id and notification_claimed_at is not null
      and notification_failure_at is null;
  if found then
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, reason)
      values('SYSTEM', 'SYSTEM', 'TOPUP_PRIVATE_NOTIFICATION_FAILED', 'topups', p_topup_id,
        left(coalesce(nullif(trim(p_reason), ''), 'Discord DM failed'), 500));
  end if;
end;
$$;

-- Explicit function ACLs keep all money mutations behind their intended actor.
revoke all on function rampage_private.protect_topup_evidence(),
  public.create_topup(uuid,uuid,bigint,text,timestamptz),
  public.set_topup_provider(uuid,text,text), public.fail_topup_creation(uuid,text),
  public.expire_pending_topups(),
  public.process_verified_topup(text,text,text,bigint,text,timestamptz,boolean),
  public.owner_resolve_topup_review(uuid,text,text,bigint),
  public.claim_topup_notification(uuid), public.record_topup_notification_failure(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_topup(uuid,uuid,bigint,text,timestamptz),
  public.set_topup_provider(uuid,text,text), public.fail_topup_creation(uuid,text),
  public.expire_pending_topups(),
  public.process_verified_topup(text,text,text,bigint,text,timestamptz,boolean),
  public.claim_topup_notification(uuid), public.record_topup_notification_failure(uuid,text)
  to service_role;
grant execute on function public.owner_resolve_topup_review(uuid,text,text,bigint)
  to authenticated;

-- Realtime is used only to wake the bot for private DMs; the claim RPC prevents duplicates.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.topups';
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;

commit;
