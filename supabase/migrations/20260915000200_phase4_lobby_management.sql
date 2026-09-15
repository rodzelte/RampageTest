-- Phase 4 patch only: Discord self-service roster participation, editable unused
-- lobbies, postpone/resume, cancellation refunds, and soft archival.
-- No side-bet placement, locking, settlement, payout, or platform revenue.
begin;

alter table public.audit_logs drop constraint audit_logs_source_check;
alter table public.audit_logs add constraint audit_logs_source_check
  check (source in ('DISCORD', 'DISCORD_SELF_SERVICE', 'DASHBOARD', 'PAYMENT_WEBHOOK', 'SYSTEM'));

alter table public.lobbies drop constraint lobbies_status_check;
alter table public.lobbies add constraint lobbies_status_check
  check (status in ('OPEN', 'POSTPONED', 'LOCKED', 'SETTLED', 'CANCELLED', 'ARCHIVED'));
alter table public.lobbies add column financial_commitment_at timestamptz;
alter table public.lobbies add column archived_at timestamptz;
alter table public.lobbies add column discord_previous_channel_id text
  check (discord_previous_channel_id is null or discord_previous_channel_id ~ '^[0-9]{17,20}$');
alter table public.lobbies add column discord_previous_message_id text
  check (discord_previous_message_id is null or discord_previous_message_id ~ '^[0-9]{17,20}$');
alter table public.lobbies drop constraint side_bet_configuration_valid;
alter table public.lobbies add constraint side_bet_configuration_valid check (
  (not side_betting_enabled and side_bet_min_centavos is null and side_bet_max_centavos is null)
  or (side_betting_enabled and side_bet_min_centavos >= roster_entry_centavos
    and side_bet_max_centavos >= side_bet_min_centavos)
);

alter table public.lobby_players alter column added_by drop not null;
alter table public.lobby_players add column added_source text not null default 'DASHBOARD'
  check (added_source in ('DASHBOARD', 'DISCORD_SELF_SERVICE'));
alter table public.lobby_players add column removed_source text
  check (removed_source in ('DASHBOARD', 'DISCORD_SELF_SERVICE', 'LOBBY_CANCELLED'));
update public.lobby_players set removed_source = 'DASHBOARD' where status = 'REMOVED';
alter table public.lobby_players drop constraint lobby_player_removal_evidence;
alter table public.lobby_players add constraint lobby_player_removal_evidence check (
  (status = 'ACTIVE' and removed_by is null and removed_at is null and removed_source is null)
  or (status = 'REMOVED' and removed_at is not null and removed_source is not null
    and ((removed_source = 'DISCORD_SELF_SERVICE' and removed_by is null)
      or (removed_source in ('DASHBOARD', 'LOBBY_CANCELLED') and removed_by is not null)))
);

update public.lobbies l set financial_commitment_at = history.first_commitment
from (
  select lobby_id, min(added_at) first_commitment
  from public.lobby_players group by lobby_id
) history
where l.id = history.lobby_id and l.financial_commitment_at is null;

create or replace function rampage_private.protect_lobby_configuration()
returns trigger language plpgsql set search_path = '' as $$
declare committed boolean;
begin
  if new.id is distinct from old.id or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at then
    raise exception 'Lobby identity is immutable' using errcode = '42501';
  end if;
  if old.financial_commitment_at is not null
      and new.financial_commitment_at is distinct from old.financial_commitment_at then
    raise exception 'Financial commitment timestamp is immutable' using errcode = '42501';
  end if;
  if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
    raise exception 'Archive timestamp is immutable' using errcode = '42501';
  end if;
  committed := old.financial_commitment_at is not null
    or exists(select 1 from public.lobby_players where lobby_id = old.id);
  if committed and (new.roster_entry_centavos is distinct from old.roster_entry_centavos
      or new.side_betting_enabled is distinct from old.side_betting_enabled
      or new.side_bet_min_centavos is distinct from old.side_bet_min_centavos
      or new.side_bet_max_centavos is distinct from old.side_bet_max_centavos
      or new.platform_fee_bps is distinct from old.platform_fee_bps
      or new.discord_channel_id is distinct from old.discord_channel_id
      or new.discord_guild_id is distinct from old.discord_guild_id) then
    raise exception 'Financial lobby terms and channel are immutable after participation'
      using errcode = '42501';
  end if;
  if new.discord_channel_id is distinct from old.discord_channel_id then
    new.discord_previous_channel_id := old.discord_channel_id;
    new.discord_previous_message_id := old.discord_message_id;
    new.discord_message_id := null;
    new.discord_synced_revision := 0;
    new.discord_sync_claimed_at := null;
    new.discord_sync_error := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function rampage_private.protect_lobby_player_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.lobby_id is distinct from old.lobby_id
      or new.user_id is distinct from old.user_id
      or new.discord_user_id is distinct from old.discord_user_id
      or new.display_name is distinct from old.display_name
      or new.team is distinct from old.team or new.stake_centavos is distinct from old.stake_centavos
      or new.added_by is distinct from old.added_by or new.added_at is distinct from old.added_at
      or new.added_source is distinct from old.added_source
      or (old.status = 'REMOVED' and new is distinct from old) then
    raise exception 'Roster financial history is immutable' using errcode = '42501';
  end if;
  if old.status = 'ACTIVE' and new.status = 'REMOVED'
      and (new.removed_at is null or new.removed_source is null) then
    raise exception 'Roster removal evidence is required' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function rampage_private.reserve_lobby_player(
  p_lobby_id uuid, p_member_id uuid, p_team text, p_staff_id uuid,
  p_source text, p_actor_discord_id text
) returns public.lobby_players language plpgsql security definer set search_path = '' as $$
declare lobby_row public.lobbies; member_row public.members; wallet_row public.wallets;
  player_row public.lobby_players; staff_row public.staff_profiles; team_count integer;
  actor_type_value text; actor_id_value text; audit_action text;
begin
  if p_source not in ('DASHBOARD', 'DISCORD_SELF_SERVICE') then
    raise exception 'Invalid roster source' using errcode = '22023';
  end if;
  if p_team is null or upper(trim(p_team)) not in ('RADIANT', 'DIRE') then
    raise exception 'Team must be RADIANT or DIRE' using errcode = '22023';
  end if;
  if p_source = 'DASHBOARD' then
    select * into staff_row from public.staff_profiles where id = p_staff_id and active;
    if staff_row.id is null then raise exception 'Active staff account required' using errcode = '42501'; end if;
    actor_type_value := staff_row.role;
    actor_id_value := staff_row.id::text;
    audit_action := 'LOBBY_PLAYER_ADDED';
  else
    if p_staff_id is not null or p_actor_discord_id is null then
      raise exception 'Invalid self-service actor' using errcode = '42501';
    end if;
    actor_type_value := 'MEMBER';
    actor_id_value := p_actor_discord_id;
    audit_action := 'LOBBY_PLAYER_SELF_JOINED';
  end if;
  select * into lobby_row from public.lobbies where id = p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode = 'P0002'; end if;
  if lobby_row.status <> 'OPEN' then
    raise exception 'Joining requires an OPEN lobby' using errcode = '22023';
  end if;
  select * into member_row from public.members where id = p_member_id and status = 'ACTIVE';
  if member_row.id is null then raise exception 'Active member required' using errcode = '42501'; end if;
  if p_source = 'DISCORD_SELF_SERVICE' and member_row.discord_user_id <> p_actor_discord_id then
    raise exception 'Discord member identity mismatch' using errcode = '42501';
  end if;
  if exists(select 1 from public.lobby_players where lobby_id = p_lobby_id
      and user_id = p_member_id and status = 'ACTIVE') then
    raise exception 'Member is already active in this lobby' using errcode = '23505';
  end if;
  select count(*) into team_count from public.lobby_players where lobby_id = p_lobby_id
    and team = upper(trim(p_team)) and status = 'ACTIVE';
  if team_count >= 5 then raise exception 'Team already has five active players' using errcode = '23514'; end if;
  select * into wallet_row from public.wallets where user_id = member_row.id for update;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode = 'P0002'; end if;
  if wallet_row.available_centavos < lobby_row.roster_entry_centavos then
    raise exception 'Insufficient available balance' using errcode = '22003';
  end if;
  if wallet_row.reserved_centavos + lobby_row.roster_entry_centavos > 9007199254740991 then
    raise exception 'Reserved balance exceeds supported range' using errcode = '22003';
  end if;
  insert into public.lobby_players(lobby_id,user_id,discord_user_id,display_name,
      team,stake_centavos,added_by,added_source)
    values(lobby_row.id,member_row.id,member_row.discord_user_id,
      coalesce(nullif(trim(member_row.display_name), ''), nullif(trim(member_row.discord_username), ''), member_row.discord_user_id),
      upper(trim(p_team)),lobby_row.roster_entry_centavos,p_staff_id,p_source)
    returning * into player_row;
  update public.wallets set available_centavos = available_centavos - player_row.stake_centavos,
      reserved_centavos = reserved_centavos + player_row.stake_centavos, updated_at = now()
    where user_id = member_row.id;
  insert into public.wallet_transactions(user_id,type,amount_centavos,
      available_before,available_after,reserved_before,reserved_after,source_type,source_id,
      actor_type,actor_id,idempotency_key,metadata)
    values(member_row.id,'LOBBY_ROSTER_RESERVE',0,
      wallet_row.available_centavos,wallet_row.available_centavos-player_row.stake_centavos,
      wallet_row.reserved_centavos,wallet_row.reserved_centavos+player_row.stake_centavos,
      'LOBBY_ROSTER',player_row.id::text,actor_type_value,actor_id_value,
      'lobby:' || lobby_row.id::text || ':roster:' || player_row.id::text || ':reserve',
      jsonb_build_object('lobby_id',lobby_row.id,'lobby_player_id',player_row.id,
        'team',player_row.team,'stake_centavos',player_row.stake_centavos,'source',p_source));
  insert into public.audit_logs(actor_type,actor_staff_id,actor_discord_id,actor_auth_user_id,
      source,action,entity_type,entity_id,new_data)
    values(actor_type_value,p_staff_id,p_actor_discord_id,
      case when p_source='DASHBOARD' then auth.uid() else null end,
      p_source,audit_action,'lobby_players',player_row.id,
      jsonb_build_object('lobby_id',lobby_row.id,'member_id',member_row.id,
        'team',player_row.team,'stake_centavos',player_row.stake_centavos));
  update public.lobbies set financial_commitment_at = coalesce(financial_commitment_at,now()),
      discord_revision = discord_revision + 1 where id = lobby_row.id;
  return player_row;
end;
$$;

create function rampage_private.release_lobby_player(
  p_lobby_player_id uuid, p_staff_id uuid, p_source text, p_actor_discord_id text
) returns public.lobby_players language plpgsql security definer set search_path = '' as $$
declare lobby_id_value uuid; lobby_row public.lobbies; player_row public.lobby_players;
  wallet_row public.wallets; staff_row public.staff_profiles; actor_type_value text;
  actor_id_value text; audit_action text;
begin
  if p_source not in ('DASHBOARD', 'DISCORD_SELF_SERVICE') then
    raise exception 'Invalid roster source' using errcode = '22023';
  end if;
  if p_source = 'DASHBOARD' then
    select * into staff_row from public.staff_profiles where id = p_staff_id and active;
    if staff_row.id is null then raise exception 'Active staff account required' using errcode = '42501'; end if;
    actor_type_value := staff_row.role;
    actor_id_value := staff_row.id::text;
    audit_action := 'LOBBY_PLAYER_REMOVED';
  else
    if p_staff_id is not null or p_actor_discord_id is null then
      raise exception 'Invalid self-service actor' using errcode = '42501';
    end if;
    actor_type_value := 'MEMBER';
    actor_id_value := p_actor_discord_id;
    audit_action := 'LOBBY_PLAYER_SELF_LEFT';
  end if;
  select lobby_id into lobby_id_value from public.lobby_players where id = p_lobby_player_id;
  if lobby_id_value is null then raise exception 'Lobby player not found' using errcode = 'P0002'; end if;
  select * into lobby_row from public.lobbies where id = lobby_id_value for update;
  select * into player_row from public.lobby_players where id = p_lobby_player_id for update;
  if p_source = 'DISCORD_SELF_SERVICE' and player_row.discord_user_id <> p_actor_discord_id then
    raise exception 'Discord member identity mismatch' using errcode = '42501';
  end if;
  if player_row.status = 'REMOVED' then return player_row; end if;
  if lobby_row.status <> 'OPEN' then
    raise exception 'Leaving requires an OPEN lobby' using errcode = '22023';
  end if;
  select * into wallet_row from public.wallets where user_id = player_row.user_id for update;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode = 'P0002'; end if;
  if wallet_row.reserved_centavos < player_row.stake_centavos then
    raise exception 'Reserved balance invariant failed' using errcode = '23514';
  end if;
  if wallet_row.available_centavos + player_row.stake_centavos > 9007199254740991 then
    raise exception 'Available balance exceeds supported range' using errcode = '22003';
  end if;
  update public.wallets set available_centavos = available_centavos + player_row.stake_centavos,
      reserved_centavos = reserved_centavos - player_row.stake_centavos, updated_at = now()
    where user_id = player_row.user_id;
  update public.lobby_players set status='REMOVED',removed_by=p_staff_id,removed_at=now(),
      removed_source=p_source where id=player_row.id returning * into player_row;
  insert into public.wallet_transactions(user_id,type,amount_centavos,
      available_before,available_after,reserved_before,reserved_after,source_type,source_id,
      actor_type,actor_id,idempotency_key,metadata)
    values(player_row.user_id,'LOBBY_ROSTER_RELEASE',0,
      wallet_row.available_centavos,wallet_row.available_centavos+player_row.stake_centavos,
      wallet_row.reserved_centavos,wallet_row.reserved_centavos-player_row.stake_centavos,
      'LOBBY_ROSTER',player_row.id::text,actor_type_value,actor_id_value,
      'lobby:' || lobby_row.id::text || ':roster:' || player_row.id::text || ':release',
      jsonb_build_object('lobby_id',lobby_row.id,'lobby_player_id',player_row.id,
        'team',player_row.team,'stake_centavos',player_row.stake_centavos,'source',p_source));
  insert into public.audit_logs(actor_type,actor_staff_id,actor_discord_id,actor_auth_user_id,
      source,action,entity_type,entity_id,old_data,new_data)
    values(actor_type_value,p_staff_id,p_actor_discord_id,
      case when p_source='DASHBOARD' then auth.uid() else null end,
      p_source,audit_action,'lobby_players',player_row.id,
      jsonb_build_object('status','ACTIVE','lobby_id',lobby_row.id,'member_id',player_row.user_id,
        'team',player_row.team,'stake_centavos',player_row.stake_centavos),to_jsonb(player_row));
  update public.lobbies set discord_revision=discord_revision+1 where id=lobby_row.id;
  return player_row;
end;
$$;

create or replace function public.create_lobby(
  p_display_name text, p_discord_guild_id text, p_discord_channel_id text,
  p_roster_entry_centavos bigint, p_side_betting_enabled boolean,
  p_side_bet_min_centavos bigint default null, p_side_bet_max_centavos bigint default null,
  p_platform_fee_bps integer default 500
) returns public.lobbies language plpgsql security definer set search_path = '' as $$
declare actor public.staff_profiles; channel_row public.discord_channels; lobby_row public.lobbies;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  if p_display_name is null or length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'Lobby name must be 1 to 80 characters' using errcode='22023'; end if;
  if p_roster_entry_centavos is null or p_roster_entry_centavos not between 1 and 9007199254740991 then
    raise exception 'Invalid roster entry amount' using errcode='22023'; end if;
  if p_platform_fee_bps is null or p_platform_fee_bps not between 0 and 1000 then
    raise exception 'Platform fee must be between 0 and 1000 BPS' using errcode='22023'; end if;
  if p_side_betting_enabled is null
      or (not p_side_betting_enabled and (p_side_bet_min_centavos is not null or p_side_bet_max_centavos is not null))
      or (p_side_betting_enabled and (p_side_bet_min_centavos is null
        or p_side_bet_min_centavos < p_roster_entry_centavos
        or p_side_bet_max_centavos is null or p_side_bet_max_centavos < p_side_bet_min_centavos)) then
    raise exception 'Side-bet minimum must be at least the roster entry and maximum must be at least the minimum'
      using errcode='22023';
  end if;
  select * into channel_row from public.discord_channels
    where channel_id=p_discord_channel_id and guild_id=p_discord_guild_id and active and can_post;
  if channel_row.channel_id is null then
    raise exception 'Select an active Discord channel where the bot can post' using errcode='22023'; end if;
  insert into public.lobbies(display_name,discord_guild_id,discord_channel_id,
      roster_entry_centavos,side_betting_enabled,side_bet_min_centavos,
      side_bet_max_centavos,platform_fee_bps,created_by)
    values(trim(p_display_name),p_discord_guild_id,p_discord_channel_id,p_roster_entry_centavos,
      p_side_betting_enabled,case when p_side_betting_enabled then p_side_bet_min_centavos end,
      case when p_side_betting_enabled then p_side_bet_max_centavos end,p_platform_fee_bps,actor.id)
    returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,
      action,entity_type,entity_id,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_CREATED','lobbies',lobby_row.id,
      jsonb_build_object('display_name',lobby_row.display_name,
        'discord_channel_id',lobby_row.discord_channel_id,
        'roster_entry_centavos',lobby_row.roster_entry_centavos,
        'side_betting_enabled',lobby_row.side_betting_enabled,
        'side_bet_min_centavos',lobby_row.side_bet_min_centavos,
        'side_bet_max_centavos',lobby_row.side_bet_max_centavos,
        'platform_fee_bps',lobby_row.platform_fee_bps));
  return lobby_row;
end;
$$;

create or replace function public.add_lobby_player(p_lobby_id uuid,p_member_id uuid,p_team text)
returns public.lobby_players language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  return rampage_private.reserve_lobby_player(p_lobby_id,p_member_id,p_team,actor.id,'DASHBOARD',null);
end;
$$;

create or replace function public.remove_lobby_player(p_lobby_player_id uuid)
returns public.lobby_players language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  return rampage_private.release_lobby_player(p_lobby_player_id,actor.id,'DASHBOARD',null);
end;
$$;

create function public.join_lobby_self(
  p_lobby_id uuid,p_discord_user_id text,p_team text,p_discord_message_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare lobby_row public.lobbies; member_row public.members; player_row public.lobby_players;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023'; end if;
  select * into lobby_row from public.lobbies where id=p_lobby_id;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status <> 'OPEN' then raise exception 'Joining requires an OPEN lobby' using errcode='22023'; end if;
  if lobby_row.discord_message_id is null or lobby_row.discord_message_id <> p_discord_message_id then
    raise exception 'This lobby message is no longer active' using errcode='22023'; end if;
  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then raise exception 'Active Rampage member required' using errcode='42501'; end if;
  player_row := rampage_private.reserve_lobby_player(
    p_lobby_id,member_row.id,p_team,null,'DISCORD_SELF_SERVICE',p_discord_user_id);
  select * into lobby_row from public.lobbies where id=p_lobby_id;
  return jsonb_build_object('lobby_name',lobby_row.display_name,
    'entry_centavos',player_row.stake_centavos,'team',player_row.team,'player',to_jsonb(player_row));
end;
$$;

create function public.leave_lobby_self(
  p_lobby_id uuid,p_discord_user_id text,p_discord_message_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare lobby_row public.lobbies; member_row public.members; player_row public.lobby_players;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023'; end if;
  select * into lobby_row from public.lobbies where id=p_lobby_id;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status <> 'OPEN' then raise exception 'Leaving requires an OPEN lobby' using errcode='22023'; end if;
  if lobby_row.discord_message_id is null or lobby_row.discord_message_id <> p_discord_message_id then
    raise exception 'This lobby message is no longer active' using errcode='22023'; end if;
  select * into member_row from public.members where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then raise exception 'Active Rampage member required' using errcode='42501'; end if;
  select * into player_row from public.lobby_players
    where lobby_id=p_lobby_id and user_id=member_row.id
    order by (status='ACTIVE') desc,added_at desc limit 1;
  if player_row.id is null then raise exception 'You are not active in this lobby' using errcode='P0002'; end if;
  if player_row.status='ACTIVE' then
    player_row := rampage_private.release_lobby_player(
      player_row.id,null,'DISCORD_SELF_SERVICE',p_discord_user_id);
  end if;
  return jsonb_build_object('lobby_name',lobby_row.display_name,
    'entry_centavos',player_row.stake_centavos,'team',player_row.team,'player',to_jsonb(player_row));
end;
$$;

create function public.update_lobby(
  p_lobby_id uuid,p_display_name text,p_discord_channel_id text,
  p_roster_entry_centavos bigint,p_side_betting_enabled boolean,
  p_side_bet_min_centavos bigint,p_side_bet_max_centavos bigint,p_platform_fee_bps integer
) returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; old_row public.lobbies; new_row public.lobbies;
  channel_row public.discord_channels; committed boolean;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select * into old_row from public.lobbies where id=p_lobby_id for update;
  if old_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if old_row.status not in ('OPEN','POSTPONED') then
    raise exception 'Only OPEN or POSTPONED lobbies can be edited' using errcode='22023'; end if;
  if p_display_name is null or length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'Lobby name must be 1 to 80 characters' using errcode='22023'; end if;
  if p_roster_entry_centavos is null or p_roster_entry_centavos not between 1 and 9007199254740991 then
    raise exception 'Invalid roster entry amount' using errcode='22023'; end if;
  if p_platform_fee_bps is null or p_platform_fee_bps not between 0 and 1000 then
    raise exception 'Platform fee must be between 0 and 1000 BPS' using errcode='22023'; end if;
  if p_side_betting_enabled is null
      or (not p_side_betting_enabled and (p_side_bet_min_centavos is not null or p_side_bet_max_centavos is not null))
      or (p_side_betting_enabled and (p_side_bet_min_centavos is null
        or p_side_bet_min_centavos < p_roster_entry_centavos
        or p_side_bet_max_centavos is null or p_side_bet_max_centavos < p_side_bet_min_centavos)) then
    raise exception 'Side-bet minimum must be at least the roster entry and maximum must be at least the minimum'
      using errcode='22023';
  end if;
  if p_discord_channel_id is distinct from old_row.discord_channel_id then
    select * into channel_row from public.discord_channels where channel_id=p_discord_channel_id
      and guild_id=old_row.discord_guild_id and active and can_post;
    if channel_row.channel_id is null then
      raise exception 'Select an active Discord channel where the bot can post' using errcode='22023'; end if;
  end if;
  committed := old_row.financial_commitment_at is not null
    or exists(select 1 from public.lobby_players where lobby_id=old_row.id);
  if committed and (p_discord_channel_id is distinct from old_row.discord_channel_id
      or p_roster_entry_centavos is distinct from old_row.roster_entry_centavos
      or p_side_betting_enabled is distinct from old_row.side_betting_enabled
      or p_side_bet_min_centavos is distinct from old_row.side_bet_min_centavos
      or p_side_bet_max_centavos is distinct from old_row.side_bet_max_centavos
      or p_platform_fee_bps is distinct from old_row.platform_fee_bps) then
    raise exception 'Financial lobby terms and channel are immutable after participation'
      using errcode='42501';
  end if;
  update public.lobbies set display_name=trim(p_display_name),discord_channel_id=p_discord_channel_id,
      roster_entry_centavos=p_roster_entry_centavos,side_betting_enabled=p_side_betting_enabled,
      side_bet_min_centavos=case when p_side_betting_enabled then p_side_bet_min_centavos end,
      side_bet_max_centavos=case when p_side_betting_enabled then p_side_bet_max_centavos end,
      platform_fee_bps=p_platform_fee_bps,discord_revision=discord_revision+1
    where id=old_row.id returning * into new_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,
      action,entity_type,entity_id,old_data,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_UPDATED','lobbies',old_row.id,
      jsonb_build_object('display_name',old_row.display_name,'discord_channel_id',old_row.discord_channel_id,
        'roster_entry_centavos',old_row.roster_entry_centavos,'side_betting_enabled',old_row.side_betting_enabled,
        'side_bet_min_centavos',old_row.side_bet_min_centavos,'side_bet_max_centavos',old_row.side_bet_max_centavos,
        'platform_fee_bps',old_row.platform_fee_bps),
      jsonb_build_object('display_name',new_row.display_name,'discord_channel_id',new_row.discord_channel_id,
        'roster_entry_centavos',new_row.roster_entry_centavos,'side_betting_enabled',new_row.side_betting_enabled,
        'side_bet_min_centavos',new_row.side_bet_min_centavos,'side_bet_max_centavos',new_row.side_bet_max_centavos,
        'platform_fee_bps',new_row.platform_fee_bps));
  return new_row;
end;
$$;

create function public.postpone_lobby(p_lobby_id uuid)
returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; lobby_row public.lobbies;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status='POSTPONED' then return lobby_row; end if;
  if lobby_row.status<>'OPEN' then raise exception 'Only an OPEN lobby can be postponed' using errcode='22023'; end if;
  update public.lobbies set status='POSTPONED',discord_revision=discord_revision+1
    where id=p_lobby_id returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,action,entity_type,entity_id,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_POSTPONED','lobbies',lobby_row.id,
      jsonb_build_object('status','POSTPONED'));
  return lobby_row;
end;
$$;

create function public.resume_lobby(p_lobby_id uuid)
returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; lobby_row public.lobbies;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status='OPEN' then return lobby_row; end if;
  if lobby_row.status<>'POSTPONED' then raise exception 'Only a POSTPONED lobby can be resumed' using errcode='22023'; end if;
  update public.lobbies set status='OPEN',discord_revision=discord_revision+1
    where id=p_lobby_id returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,action,entity_type,entity_id,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_RESUMED','lobbies',lobby_row.id,
      jsonb_build_object('status','OPEN'));
  return lobby_row;
end;
$$;

create function public.cancel_lobby(p_lobby_id uuid)
returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; lobby_row public.lobbies; player_row public.lobby_players;
  wallet_row public.wallets; total_refunded bigint:=0;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status='CANCELLED' then return lobby_row; end if;
  if lobby_row.status not in ('OPEN','POSTPONED') then
    raise exception 'Only an OPEN or POSTPONED lobby can be cancelled' using errcode='22023'; end if;
  for player_row in select * from public.lobby_players
      where lobby_id=p_lobby_id and status='ACTIVE' order by id for update
  loop
    select * into wallet_row from public.wallets where user_id=player_row.user_id for update;
    if wallet_row.user_id is null or wallet_row.reserved_centavos < player_row.stake_centavos then
      raise exception 'Reserved balance invariant failed' using errcode='23514'; end if;
    if wallet_row.available_centavos + player_row.stake_centavos > 9007199254740991 then
      raise exception 'Available balance exceeds supported range' using errcode='22003'; end if;
    update public.wallets set available_centavos=available_centavos+player_row.stake_centavos,
        reserved_centavos=reserved_centavos-player_row.stake_centavos,updated_at=now()
      where user_id=player_row.user_id;
    update public.lobby_players set status='REMOVED',removed_by=actor.id,removed_at=now(),
        removed_source='LOBBY_CANCELLED' where id=player_row.id;
    insert into public.wallet_transactions(user_id,type,amount_centavos,
        available_before,available_after,reserved_before,reserved_after,source_type,source_id,
        actor_type,actor_id,idempotency_key,metadata)
      values(player_row.user_id,'LOBBY_ROSTER_RELEASE',0,
        wallet_row.available_centavos,wallet_row.available_centavos+player_row.stake_centavos,
        wallet_row.reserved_centavos,wallet_row.reserved_centavos-player_row.stake_centavos,
        'LOBBY_ROSTER',player_row.id::text,actor.role,actor.id::text,
        'lobby:'||lobby_row.id::text||':roster:'||player_row.id::text||':cancel-release',
        jsonb_build_object('lobby_id',lobby_row.id,'lobby_player_id',player_row.id,
          'stake_centavos',player_row.stake_centavos,'source','LOBBY_CANCELLED'));
    total_refunded := total_refunded + player_row.stake_centavos;
  end loop;
  update public.lobbies set status='CANCELLED',discord_revision=discord_revision+1
    where id=p_lobby_id returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,
      action,entity_type,entity_id,old_data,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_CANCELLED','lobbies',lobby_row.id,
      jsonb_build_object('status','OPEN_OR_POSTPONED'),
      jsonb_build_object('status','CANCELLED','total_refunded_centavos',total_refunded));
  return lobby_row;
end;
$$;

create function public.archive_lobby(p_lobby_id uuid)
returns public.lobbies language plpgsql security definer set search_path='' as $$
declare actor public.staff_profiles; lobby_row public.lobbies; committed boolean;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  if actor.role <> 'OWNER' then raise exception 'OWNER role required' using errcode='42501'; end if;
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.status='ARCHIVED' then return lobby_row; end if;
  committed := lobby_row.financial_commitment_at is not null
    or exists(select 1 from public.lobby_players where lobby_id=lobby_row.id);
  if committed and lobby_row.status not in ('CANCELLED','SETTLED') then
    raise exception 'A lobby with financial history must be CANCELLED or SETTLED before archive'
      using errcode='22023';
  end if;
  if not committed and lobby_row.status not in ('OPEN','POSTPONED','CANCELLED') then
    raise exception 'This lobby cannot be archived' using errcode='22023'; end if;
  update public.lobbies set status='ARCHIVED',archived_at=now(),discord_revision=discord_revision+1
    where id=p_lobby_id returning * into lobby_row;
  insert into public.audit_logs(actor_type,actor_staff_id,actor_auth_user_id,source,
      action,entity_type,entity_id,new_data)
    values(actor.role,actor.id,auth.uid(),'DASHBOARD','LOBBY_ARCHIVED','lobbies',lobby_row.id,
      jsonb_build_object('status','ARCHIVED','had_financial_commitment',committed));
  return lobby_row;
end;
$$;

create or replace function public.complete_lobby_discord_sync(
  p_lobby_id uuid,p_revision bigint,p_discord_message_id text
) returns public.lobbies language plpgsql security definer set search_path='' as $$
declare lobby_row public.lobbies; created_message boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501'; end if;
  if p_revision is null or p_revision<1 or p_discord_message_id is null
      or p_discord_message_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord synchronization result' using errcode='22023'; end if;
  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  if lobby_row.discord_message_id is not null
      and lobby_row.discord_message_id<>p_discord_message_id then
    raise exception 'Lobby Discord message identity cannot change' using errcode='23505'; end if;
  created_message := lobby_row.discord_message_id is null;
  update public.lobbies set discord_message_id=coalesce(discord_message_id,p_discord_message_id),
      discord_synced_revision=greatest(discord_synced_revision,least(p_revision,discord_revision)),
      discord_sync_claimed_at=null,discord_sync_error=null,
      discord_previous_channel_id=null,discord_previous_message_id=null
    where id=lobby_row.id returning * into lobby_row;
  if created_message then
    insert into public.audit_logs(actor_type,source,action,entity_type,entity_id,new_data)
      values('SYSTEM','SYSTEM','LOBBY_DISCORD_MESSAGE_CREATED','lobbies',lobby_row.id,
        jsonb_build_object('discord_channel_id',lobby_row.discord_channel_id,
          'discord_message_id',lobby_row.discord_message_id));
  end if;
  return lobby_row;
end;
$$;

revoke all on function rampage_private.reserve_lobby_player(uuid,uuid,text,uuid,text,text),
  rampage_private.release_lobby_player(uuid,uuid,text,text),
  public.join_lobby_self(uuid,text,text,text),public.leave_lobby_self(uuid,text,text),
  public.update_lobby(uuid,text,text,bigint,boolean,bigint,bigint,integer),
  public.postpone_lobby(uuid),public.resume_lobby(uuid),public.cancel_lobby(uuid),
  public.archive_lobby(uuid) from public,anon,authenticated,service_role;
grant execute on function public.update_lobby(uuid,text,text,bigint,boolean,bigint,bigint,integer),
  public.postpone_lobby(uuid),public.resume_lobby(uuid),public.cancel_lobby(uuid),
  public.archive_lobby(uuid) to authenticated;
grant execute on function public.join_lobby_self(uuid,text,text,text),
  public.leave_lobby_self(uuid,text,text) to service_role;

commit;
