-- Phase 5 only: OPEN-lobby side-bet reservations, cancellations, pool projection,
-- and cancellation refunds. No lobby locking, LIFO, settlement, or revenue.
begin;

create table if not exists public.side_bets (
  id uuid primary key default gen_random_uuid(),
  bet_number bigint generated always as identity unique,
  lobby_id uuid not null references public.lobbies(id) on delete restrict,
  user_id uuid not null references public.members(id) on delete restrict,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{17,20}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  side text not null check (side in ('RADIANT','DIRE')),
  requested_amount_centavos bigint not null check (requested_amount_centavos between 1 and 9007199254740991),
  accepted_amount_centavos bigint not null check (accepted_amount_centavos between 0 and requested_amount_centavos),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CANCELLED')),
  placed_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_source text check (cancelled_source in ('DISCORD_SELF_SERVICE','LOBBY_CANCELLED')),
  discord_interaction_id text not null unique check (discord_interaction_id ~ '^[0-9]{17,20}$'),
  cancel_interaction_id text unique check (cancel_interaction_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint side_bet_phase5_amount check (
    status <> 'ACTIVE' or accepted_amount_centavos = requested_amount_centavos
  ),
  constraint side_bet_cancellation_evidence check (
    (status='ACTIVE' and cancelled_at is null and cancelled_source is null and cancel_interaction_id is null)
    or (status='CANCELLED' and cancelled_at is not null and cancelled_source is not null
      and (cancelled_source='LOBBY_CANCELLED' or cancel_interaction_id is not null))
  )
);
create index if not exists side_bets_lobby_active_side
  on public.side_bets(lobby_id,side,placed_at,bet_number) where status='ACTIVE';
create index if not exists side_bets_lobby_history
  on public.side_bets(lobby_id,placed_at desc,bet_number desc);
create index if not exists side_bets_member_history
  on public.side_bets(user_id,placed_at desc,bet_number desc);

create function rampage_private.protect_side_bet_history()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.id is distinct from old.id or new.bet_number is distinct from old.bet_number
      or new.lobby_id is distinct from old.lobby_id or new.user_id is distinct from old.user_id
      or new.discord_user_id is distinct from old.discord_user_id
      or new.display_name is distinct from old.display_name or new.side is distinct from old.side
      or new.requested_amount_centavos is distinct from old.requested_amount_centavos
      or new.accepted_amount_centavos is distinct from old.accepted_amount_centavos
      or new.discord_interaction_id is distinct from old.discord_interaction_id
      or new.placed_at is distinct from old.placed_at or new.created_at is distinct from old.created_at
      or old.status='CANCELLED' or new.status <> 'CANCELLED'
      or new.cancelled_at is null or new.cancelled_source is null then
    raise exception 'Side-bet financial history is immutable' using errcode='42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger side_bet_history_immutable before update on public.side_bets
  for each row execute function rampage_private.protect_side_bet_history();
create trigger side_bet_history_no_delete before delete or truncate on public.side_bets
  for each statement execute function rampage_private.reject_history_mutation();

alter table public.side_bets enable row level security;
create policy side_bets_read_staff on public.side_bets for select to authenticated
  using ((select rampage_private.current_staff_role()) in ('ADMIN','OWNER'));
revoke all on public.side_bets from public,anon,authenticated,service_role;
grant select on public.side_bets to authenticated,service_role;
grant usage,select on sequence public.side_bets_bet_number_seq to service_role;

create function public.place_side_bet_self(
  p_lobby_id uuid,p_discord_user_id text,p_side text,p_amount_centavos bigint,
  p_discord_interaction_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare lobby_row public.lobbies; member_row public.members; wallet_row public.wallets;
  bet_row public.side_bets; fee bigint; gross bigint; net bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023'; end if;
  if p_discord_interaction_id is null or p_discord_interaction_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord interaction identity' using errcode='22023'; end if;
  if p_side is null or upper(trim(p_side)) not in ('RADIANT','DIRE') then
    raise exception 'Bet side must be RADIANT or DIRE' using errcode='22023'; end if;

  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status <> 'OPEN' then raise exception 'Betting requires an OPEN lobby' using errcode='22023'; end if;
  if not lobby_row.side_betting_enabled then raise exception 'SIDE BETTING DISABLED' using errcode='22023'; end if;

  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then raise exception 'Active Rampage member required' using errcode='42501'; end if;

  select * into bet_row from public.side_bets
    where discord_interaction_id=p_discord_interaction_id;
  if bet_row.id is not null then
    if bet_row.user_id <> member_row.id then
      raise exception 'Discord interaction identity conflict' using errcode='42501'; end if;
    fee := (bet_row.accepted_amount_centavos*lobby_row.platform_fee_bps)/10000;
    gross := bet_row.accepted_amount_centavos*2;
    net := gross-fee;
    return jsonb_build_object('duplicate',true,'lobby_name',lobby_row.display_name,
      'platform_fee_bps',lobby_row.platform_fee_bps,'bet',to_jsonb(bet_row),
      'winning_profit_centavos',bet_row.accepted_amount_centavos,
      'gross_return_centavos',gross,'platform_fee_centavos',fee,'net_return_centavos',net);
  end if;

  if p_amount_centavos is null or p_amount_centavos < lobby_row.roster_entry_centavos
      or p_amount_centavos < lobby_row.side_bet_min_centavos then
    raise exception 'Bet amount is below the lobby minimum' using errcode='22023'; end if;
  if p_amount_centavos > lobby_row.side_bet_max_centavos then
    raise exception 'Bet amount exceeds the lobby maximum' using errcode='22023'; end if;
  select * into wallet_row from public.wallets where user_id=member_row.id for update;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode='P0002'; end if;
  if wallet_row.available_centavos < p_amount_centavos then
    raise exception 'Insufficient available balance' using errcode='22003'; end if;
  if wallet_row.reserved_centavos+p_amount_centavos > 9007199254740991 then
    raise exception 'Reserved balance exceeds supported range' using errcode='22003'; end if;

  insert into public.side_bets(lobby_id,user_id,discord_user_id,display_name,side,
      requested_amount_centavos,accepted_amount_centavos,discord_interaction_id)
    values(lobby_row.id,member_row.id,member_row.discord_user_id,
      coalesce(nullif(trim(member_row.display_name),''),nullif(trim(member_row.discord_username),''),member_row.discord_user_id),
      upper(trim(p_side)),p_amount_centavos,p_amount_centavos,p_discord_interaction_id)
    returning * into bet_row;
  update public.wallets set available_centavos=available_centavos-p_amount_centavos,
      reserved_centavos=reserved_centavos+p_amount_centavos,updated_at=now()
    where user_id=member_row.id;
  insert into public.wallet_transactions(user_id,type,amount_centavos,
      available_before,available_after,reserved_before,reserved_after,source_type,source_id,
      actor_type,actor_id,idempotency_key,metadata)
    values(member_row.id,'LOBBY_SIDE_BET_RESERVE',0,
      wallet_row.available_centavos,wallet_row.available_centavos-p_amount_centavos,
      wallet_row.reserved_centavos,wallet_row.reserved_centavos+p_amount_centavos,
      'LOBBY_SIDE_BET',bet_row.id::text,'MEMBER',p_discord_user_id,
      'lobby:'||lobby_row.id::text||':sidebet:'||bet_row.id::text||':reserve',
      jsonb_build_object('lobby_id',lobby_row.id,'side_bet_id',bet_row.id,
        'bet_number',bet_row.bet_number,'side',bet_row.side,'amount_centavos',p_amount_centavos));
  insert into public.audit_logs(actor_type,actor_discord_id,source,action,entity_type,entity_id,new_data)
    values('MEMBER',p_discord_user_id,'DISCORD_SELF_SERVICE','LOBBY_SIDE_BET_PLACED','side_bets',bet_row.id,
      jsonb_build_object('lobby_id',lobby_row.id,'side_bet_id',bet_row.id,'bet_number',bet_row.bet_number,
        'member_id',member_row.id,'side',bet_row.side,'amount_centavos',p_amount_centavos));
  update public.lobbies set financial_commitment_at=coalesce(financial_commitment_at,now()),
      discord_revision=discord_revision+1 where id=lobby_row.id;
  fee := (p_amount_centavos*lobby_row.platform_fee_bps)/10000;
  gross := p_amount_centavos*2;
  net := gross-fee;
  return jsonb_build_object('duplicate',false,'lobby_name',lobby_row.display_name,
    'platform_fee_bps',lobby_row.platform_fee_bps,'bet',to_jsonb(bet_row),
    'winning_profit_centavos',p_amount_centavos,'gross_return_centavos',gross,
    'platform_fee_centavos',fee,'net_return_centavos',net);
end;
$$;

create function public.cancel_side_bet_self(
  p_bet_number bigint,p_discord_user_id text,p_discord_interaction_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare lobby_id_value uuid; lobby_row public.lobbies; member_row public.members;
  bet_row public.side_bets; wallet_row public.wallets; release_amount bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  if p_bet_number is null or p_bet_number<1 then raise exception 'Invalid bet number' using errcode='22023'; end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023'; end if;
  if p_discord_interaction_id is null or p_discord_interaction_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord interaction identity' using errcode='22023'; end if;
  select lobby_id into lobby_id_value from public.side_bets where bet_number=p_bet_number;
  if lobby_id_value is null then raise exception 'Side bet not found' using errcode='P0002'; end if;
  select * into lobby_row from public.lobbies where id=lobby_id_value for update;
  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then raise exception 'Active Rampage member required' using errcode='42501'; end if;
  select * into bet_row from public.side_bets where bet_number=p_bet_number for update;
  if bet_row.user_id<>member_row.id then raise exception 'You can cancel only your own side bet' using errcode='42501'; end if;
  if bet_row.status='CANCELLED' then
    return jsonb_build_object('duplicate',true,'lobby_name',lobby_row.display_name,'bet',to_jsonb(bet_row));
  end if;
  if lobby_row.status<>'OPEN' then raise exception 'Bet cancellation requires an OPEN lobby' using errcode='22023'; end if;
  release_amount := bet_row.accepted_amount_centavos;
  select * into wallet_row from public.wallets where user_id=bet_row.user_id for update;
  if wallet_row.user_id is null or wallet_row.reserved_centavos<release_amount then
    raise exception 'Reserved balance invariant failed' using errcode='23514'; end if;
  if wallet_row.available_centavos+release_amount>9007199254740991 then
    raise exception 'Available balance exceeds supported range' using errcode='22003'; end if;
  update public.wallets set available_centavos=available_centavos+release_amount,
      reserved_centavos=reserved_centavos-release_amount,updated_at=now() where user_id=bet_row.user_id;
  update public.side_bets set status='CANCELLED',cancelled_at=now(),
      cancelled_source='DISCORD_SELF_SERVICE',cancel_interaction_id=p_discord_interaction_id
    where id=bet_row.id returning * into bet_row;
  insert into public.wallet_transactions(user_id,type,amount_centavos,
      available_before,available_after,reserved_before,reserved_after,source_type,source_id,
      actor_type,actor_id,idempotency_key,metadata)
    values(bet_row.user_id,'LOBBY_SIDE_BET_RELEASE',0,
      wallet_row.available_centavos,wallet_row.available_centavos+release_amount,
      wallet_row.reserved_centavos,wallet_row.reserved_centavos-release_amount,
      'LOBBY_SIDE_BET',bet_row.id::text,'MEMBER',p_discord_user_id,
      'lobby:'||lobby_row.id::text||':sidebet:'||bet_row.id::text||':release',
      jsonb_build_object('lobby_id',lobby_row.id,'side_bet_id',bet_row.id,
        'bet_number',bet_row.bet_number,'side',bet_row.side,'amount_centavos',release_amount));
  insert into public.audit_logs(actor_type,actor_discord_id,source,action,entity_type,entity_id,old_data,new_data)
    values('MEMBER',p_discord_user_id,'DISCORD_SELF_SERVICE','LOBBY_SIDE_BET_CANCELLED','side_bets',bet_row.id,
      jsonb_build_object('status','ACTIVE','lobby_id',lobby_row.id,'member_id',member_row.id,
        'side',bet_row.side,'amount_centavos',release_amount),to_jsonb(bet_row));
  update public.lobbies set discord_revision=discord_revision+1 where id=lobby_row.id;
  return jsonb_build_object('duplicate',false,'lobby_name',lobby_row.display_name,'bet',to_jsonb(bet_row));
end;
$$;

create or replace function public.cancel_lobby(p_lobby_id uuid)
returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; lobby_row public.lobbies; player_row public.lobby_players;
  bet_row public.side_bets; wallet_row public.wallets; roster_refunded bigint:=0; side_bets_refunded bigint:=0;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status='CANCELLED' then return lobby_row; end if;
  if lobby_row.status not in ('OPEN','POSTPONED') then
    raise exception 'Only an OPEN or POSTPONED lobby can be cancelled' using errcode='22023'; end if;
  for player_row in select * from public.lobby_players where lobby_id=p_lobby_id and status='ACTIVE' order by user_id,id for update loop
    select * into wallet_row from public.wallets where user_id=player_row.user_id for update;
    if wallet_row.user_id is null or wallet_row.reserved_centavos<player_row.stake_centavos then
      raise exception 'Reserved balance invariant failed' using errcode='23514'; end if;
    update public.wallets set available_centavos=available_centavos+player_row.stake_centavos,
      reserved_centavos=reserved_centavos-player_row.stake_centavos,updated_at=now() where user_id=player_row.user_id;
    update public.lobby_players set status='REMOVED',removed_by=actor.id,removed_at=now(),removed_source='LOBBY_CANCELLED' where id=player_row.id;
    insert into public.wallet_transactions(user_id,type,amount_centavos,available_before,available_after,reserved_before,reserved_after,
      source_type,source_id,actor_type,actor_id,idempotency_key,metadata)
    values(player_row.user_id,'LOBBY_ROSTER_RELEASE',0,wallet_row.available_centavos,
      wallet_row.available_centavos+player_row.stake_centavos,wallet_row.reserved_centavos,
      wallet_row.reserved_centavos-player_row.stake_centavos,'LOBBY_ROSTER',player_row.id::text,actor.role,actor.id::text,
      'lobby:'||lobby_row.id::text||':roster:'||player_row.id::text||':cancel-release',
      jsonb_build_object('lobby_id',lobby_row.id,'lobby_player_id',player_row.id,'stake_centavos',player_row.stake_centavos,'source','LOBBY_CANCELLED'));
    roster_refunded:=roster_refunded+player_row.stake_centavos;
  end loop;
  for bet_row in select * from public.side_bets where lobby_id=p_lobby_id and status='ACTIVE' order by user_id,id for update loop
    select * into wallet_row from public.wallets where user_id=bet_row.user_id for update;
    if wallet_row.user_id is null or wallet_row.reserved_centavos<bet_row.accepted_amount_centavos then
      raise exception 'Reserved balance invariant failed' using errcode='23514'; end if;
    update public.wallets set available_centavos=available_centavos+bet_row.accepted_amount_centavos,
      reserved_centavos=reserved_centavos-bet_row.accepted_amount_centavos,updated_at=now() where user_id=bet_row.user_id;
    update public.side_bets set status='CANCELLED',cancelled_at=now(),cancelled_source='LOBBY_CANCELLED' where id=bet_row.id;
    insert into public.wallet_transactions(user_id,type,amount_centavos,available_before,available_after,reserved_before,reserved_after,
      source_type,source_id,actor_type,actor_id,idempotency_key,metadata)
    values(bet_row.user_id,'LOBBY_SIDE_BET_RELEASE',0,wallet_row.available_centavos,
      wallet_row.available_centavos+bet_row.accepted_amount_centavos,wallet_row.reserved_centavos,
      wallet_row.reserved_centavos-bet_row.accepted_amount_centavos,'LOBBY_SIDE_BET',bet_row.id::text,actor.role,actor.id::text,
      'lobby:'||lobby_row.id::text||':sidebet:'||bet_row.id::text||':cancel-release',
      jsonb_build_object('lobby_id',lobby_row.id,'side_bet_id',bet_row.id,'bet_number',bet_row.bet_number,
        'amount_centavos',bet_row.accepted_amount_centavos,'source','LOBBY_CANCELLED'));
    side_bets_refunded:=side_bets_refunded+bet_row.accepted_amount_centavos;
  end loop;
  update public.lobbies set status='CANCELLED',discord_revision=discord_revision+1 where id=p_lobby_id returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,action,entity_type,entity_id,old_data,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_CANCELLED','lobbies',lobby_row.id,
      jsonb_build_object('status','OPEN_OR_POSTPONED'),jsonb_build_object('status','CANCELLED',
        'roster_refunded_centavos',roster_refunded,'side_bets_refunded_centavos',side_bets_refunded,
        'total_refunded_centavos',roster_refunded+side_bets_refunded));
  return lobby_row;
end;
$$;

create or replace function public.claim_lobby_discord_sync()
returns jsonb language plpgsql security definer set search_path='' as $$
declare lobby_row public.lobbies; channel_name_value text; players jsonb; bets jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  select * into lobby_row from public.lobbies where discord_synced_revision<discord_revision
    and (discord_sync_claimed_at is null or discord_sync_claimed_at<now()-interval '1 minute')
    order by updated_at,id for update skip locked limit 1;
  if lobby_row.id is null then return null; end if;
  update public.lobbies set discord_sync_claimed_at=now(),discord_sync_error=null where id=lobby_row.id returning * into lobby_row;
  select channel_name into channel_name_value from public.discord_channels where channel_id=lobby_row.discord_channel_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'discord_user_id',discord_user_id,'display_name',display_name,
      'team',team,'stake_centavos',stake_centavos,'added_at',added_at) order by added_at,id),'[]'::jsonb)
    into players from public.lobby_players where lobby_id=lobby_row.id and status='ACTIVE';
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'bet_number',bet_number,'discord_user_id',discord_user_id,
      'display_name',display_name,'side',side,'accepted_amount_centavos',accepted_amount_centavos,'placed_at',placed_at)
      order by placed_at,bet_number),'[]'::jsonb) into bets
    from public.side_bets where lobby_id=lobby_row.id and status='ACTIVE';
  return to_jsonb(lobby_row)||jsonb_build_object('discord_channel_name',channel_name_value,'players',players,'side_bets',bets);
end;
$$;

revoke all on function rampage_private.protect_side_bet_history(),
  public.place_side_bet_self(uuid,text,text,bigint,text),public.cancel_side_bet_self(bigint,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.place_side_bet_self(uuid,text,text,bigint,text),
  public.cancel_side_bet_self(bigint,text,text) to service_role;

-- Dashboard reads are staff-only through RLS; financial writes remain service-role RPCs.
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.side_bets';
  exception when duplicate_object or undefined_object then null; end;
end $$;

commit;
