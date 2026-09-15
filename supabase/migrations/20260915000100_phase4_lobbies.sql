-- Phase 4 only: OPEN lobbies, roster reservations, safe Discord channel cache,
-- and retryable same-message Discord presentation. No betting or settlement.
begin;

create table public.discord_channels (
  channel_id text primary key check (channel_id ~ '^[0-9]{17,20}$'),
  guild_id text not null check (guild_id ~ '^[0-9]{17,20}$'),
  channel_name text not null check (length(trim(channel_name)) between 1 and 100),
  channel_type text not null check (channel_type in ('GUILD_TEXT', 'GUILD_ANNOUNCEMENT')),
  can_post boolean not null default false,
  active boolean not null default true,
  last_synced_at timestamptz not null default now()
);
create index discord_channels_guild_active on public.discord_channels(guild_id, active, channel_name);

create table public.lobbies (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  status text not null default 'OPEN' check (status in ('OPEN', 'LOCKED', 'SETTLED', 'CANCELLED')),
  discord_guild_id text not null check (discord_guild_id ~ '^[0-9]{17,20}$'),
  discord_channel_id text not null references public.discord_channels(channel_id) on delete restrict,
  discord_message_id text check (discord_message_id ~ '^[0-9]{17,20}$'),
  roster_entry_centavos bigint not null check (roster_entry_centavos between 1 and 9007199254740991),
  side_betting_enabled boolean not null default false,
  side_bet_min_centavos bigint check (side_bet_min_centavos between 1 and 9007199254740991),
  side_bet_max_centavos bigint check (side_bet_max_centavos between 1 and 9007199254740991),
  platform_fee_bps integer not null default 500 check (platform_fee_bps between 0 and 1000),
  winner text check (winner in ('RADIANT', 'DIRE')),
  created_by uuid not null references public.staff_profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  discord_revision bigint not null default 1 check (discord_revision >= 1),
  discord_synced_revision bigint not null default 0 check (
    discord_synced_revision >= 0 and discord_synced_revision <= discord_revision
  ),
  discord_sync_claimed_at timestamptz,
  discord_sync_error text,
  constraint side_bet_configuration_valid check (
    (not side_betting_enabled and side_bet_min_centavos is null and side_bet_max_centavos is null)
    or (side_betting_enabled and side_bet_min_centavos > 0
      and side_bet_max_centavos >= side_bet_min_centavos)
  )
);
create index lobbies_created on public.lobbies(created_at desc, id);
create index lobbies_discord_pending on public.lobbies(discord_synced_revision, discord_revision)
  where discord_synced_revision < discord_revision;

create table public.lobby_players (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references public.lobbies(id) on delete restrict,
  user_id uuid not null references public.members(id) on delete restrict,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{17,20}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  team text not null check (team in ('RADIANT', 'DIRE')),
  stake_centavos bigint not null check (stake_centavos between 1 and 9007199254740991),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REMOVED')),
  added_by uuid not null references public.staff_profiles(id) on delete restrict,
  added_at timestamptz not null default now(),
  removed_by uuid references public.staff_profiles(id) on delete restrict,
  removed_at timestamptz,
  constraint lobby_player_removal_evidence check (
    (status = 'ACTIVE' and removed_by is null and removed_at is null)
    or (status = 'REMOVED' and removed_by is not null and removed_at is not null)
  )
);
create unique index one_active_lobby_position_per_member
  on public.lobby_players(lobby_id, user_id) where status = 'ACTIVE';
create index lobby_players_active_team on public.lobby_players(lobby_id, team, added_at)
  where status = 'ACTIVE';

create function rampage_private.require_active_staff()
returns public.staff_profiles language plpgsql stable security definer set search_path = '' as $$
declare staff public.staff_profiles;
begin
  select * into staff from public.staff_profiles
    where auth_user_id = (select auth.uid()) and active;
  if staff.id is null then
    raise exception 'Active staff account required' using errcode = '42501';
  end if;
  return staff;
end;
$$;

create function rampage_private.protect_lobby_configuration()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or new.platform_fee_bps is distinct from old.platform_fee_bps then
    raise exception 'Lobby identity and platform fee snapshot are immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger lobby_configuration_immutable before update on public.lobbies
  for each row execute function rampage_private.protect_lobby_configuration();
create trigger lobby_history_no_delete before delete or truncate on public.lobbies
  for each statement execute function rampage_private.reject_history_mutation();

create function rampage_private.enforce_lobby_player_constraints()
returns trigger language plpgsql set search_path = '' as $$
declare lobby_row public.lobbies; member_row public.members; active_count integer;
begin
  if new.status = 'ACTIVE' then
    select * into lobby_row from public.lobbies where id = new.lobby_id for update;
    if lobby_row.id is null then raise exception 'Lobby not found' using errcode = 'P0002'; end if;
    if lobby_row.status <> 'OPEN' then raise exception 'Lobby is not OPEN' using errcode = '22023'; end if;
    select * into member_row from public.members where id = new.user_id and status = 'ACTIVE';
    if member_row.id is null then raise exception 'Active member required' using errcode = '42501'; end if;
    select count(*) into active_count from public.lobby_players
      where lobby_id = new.lobby_id and team = new.team and status = 'ACTIVE'
        and id is distinct from new.id;
    if active_count >= 5 then raise exception 'Team already has five active players' using errcode = '23514'; end if;
  elsif tg_op = 'UPDATE' and old.status = 'REMOVED' then
    raise exception 'Removed roster history cannot be reactivated or changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger lobby_player_capacity before insert or update on public.lobby_players
  for each row execute function rampage_private.enforce_lobby_player_constraints();

create function rampage_private.protect_lobby_player_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.lobby_id is distinct from old.lobby_id
      or new.user_id is distinct from old.user_id
      or new.discord_user_id is distinct from old.discord_user_id
      or new.display_name is distinct from old.display_name
      or new.team is distinct from old.team or new.stake_centavos is distinct from old.stake_centavos
      or new.added_by is distinct from old.added_by or new.added_at is distinct from old.added_at
      or (old.status = 'REMOVED' and new is distinct from old) then
    raise exception 'Roster financial history is immutable' using errcode = '42501';
  end if;
  if old.status = 'ACTIVE' and new.status = 'REMOVED'
      and (new.removed_by is null or new.removed_at is null) then
    raise exception 'Roster removal evidence is required' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger lobby_player_history_immutable before update on public.lobby_players
  for each row execute function rampage_private.protect_lobby_player_history();
create trigger lobby_player_history_no_delete before delete or truncate on public.lobby_players
  for each statement execute function rampage_private.reject_history_mutation();

alter table public.discord_channels enable row level security;
alter table public.lobbies enable row level security;
alter table public.lobby_players enable row level security;

create policy discord_channels_read_staff on public.discord_channels for select to authenticated
  using ((select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));
create policy lobbies_read_staff on public.lobbies for select to authenticated
  using ((select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));
create policy lobby_players_read_staff on public.lobby_players for select to authenticated
  using ((select rampage_private.current_staff_role()) in ('ADMIN', 'OWNER'));

revoke all on public.discord_channels, public.lobbies, public.lobby_players
  from public, anon, authenticated, service_role;
grant select on public.discord_channels, public.lobbies, public.lobby_players
  to authenticated, service_role;

create function public.create_lobby(
  p_display_name text,
  p_discord_guild_id text,
  p_discord_channel_id text,
  p_roster_entry_centavos bigint,
  p_side_betting_enabled boolean,
  p_side_bet_min_centavos bigint default null,
  p_side_bet_max_centavos bigint default null,
  p_platform_fee_bps integer default 500
) returns public.lobbies language plpgsql security definer set search_path = '' as $$
declare actor public.staff_profiles; channel_row public.discord_channels; lobby_row public.lobbies;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  if p_display_name is null or length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'Lobby name must be 1 to 80 characters' using errcode = '22023';
  end if;
  if p_roster_entry_centavos is null or p_roster_entry_centavos < 1
      or p_roster_entry_centavos > 9007199254740991 then
    raise exception 'Invalid roster entry amount' using errcode = '22023';
  end if;
  if p_platform_fee_bps is null or p_platform_fee_bps not between 0 and 1000 then
    raise exception 'Platform fee must be between 0 and 1000 BPS' using errcode = '22023';
  end if;
  if p_side_betting_enabled is null
      or (not p_side_betting_enabled and (p_side_bet_min_centavos is not null or p_side_bet_max_centavos is not null))
      or (p_side_betting_enabled and (p_side_bet_min_centavos is null or p_side_bet_min_centavos <= 0
        or p_side_bet_max_centavos is null or p_side_bet_max_centavos < p_side_bet_min_centavos)) then
    raise exception 'Invalid future side-bet range' using errcode = '22023';
  end if;
  select * into channel_row from public.discord_channels
    where channel_id = p_discord_channel_id and guild_id = p_discord_guild_id
      and active and can_post;
  if channel_row.channel_id is null then
    raise exception 'Select an active Discord channel where the bot can post' using errcode = '22023';
  end if;
  insert into public.lobbies(display_name, discord_guild_id, discord_channel_id,
      roster_entry_centavos, side_betting_enabled, side_bet_min_centavos,
      side_bet_max_centavos, platform_fee_bps, created_by)
    values(trim(p_display_name), p_discord_guild_id, p_discord_channel_id,
      p_roster_entry_centavos, p_side_betting_enabled,
      case when p_side_betting_enabled then p_side_bet_min_centavos end,
      case when p_side_betting_enabled then p_side_bet_max_centavos end,
      p_platform_fee_bps, actor.id)
    returning * into lobby_row;
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source,
      action, entity_type, entity_id, new_data)
    values(actor.role, actor.id, auth.uid(), 'DASHBOARD', 'LOBBY_CREATED', 'lobbies', lobby_row.id,
      jsonb_build_object('display_name', lobby_row.display_name,
        'discord_channel_id', lobby_row.discord_channel_id,
        'roster_entry_centavos', lobby_row.roster_entry_centavos,
        'side_betting_enabled', lobby_row.side_betting_enabled,
        'side_bet_min_centavos', lobby_row.side_bet_min_centavos,
        'side_bet_max_centavos', lobby_row.side_bet_max_centavos,
        'platform_fee_bps', lobby_row.platform_fee_bps));
  return lobby_row;
end;
$$;

create function public.add_lobby_player(p_lobby_id uuid, p_member_id uuid, p_team text)
returns public.lobby_players language plpgsql security definer set search_path = '' as $$
declare actor public.staff_profiles; lobby_row public.lobbies; member_row public.members;
  wallet_row public.wallets; player_row public.lobby_players; team_count integer;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  if p_team is null or upper(trim(p_team)) not in ('RADIANT', 'DIRE') then
    raise exception 'Team must be RADIANT or DIRE' using errcode = '22023';
  end if;
  select * into lobby_row from public.lobbies where id = p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode = 'P0002'; end if;
  if lobby_row.status <> 'OPEN' then raise exception 'Roster changes require an OPEN lobby' using errcode = '22023'; end if;
  select * into member_row from public.members where id = p_member_id and status = 'ACTIVE';
  if member_row.id is null then raise exception 'Active member required' using errcode = '42501'; end if;
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
  insert into public.lobby_players(lobby_id, user_id, discord_user_id, display_name,
      team, stake_centavos, added_by)
    values(lobby_row.id, member_row.id, member_row.discord_user_id,
      coalesce(nullif(trim(member_row.display_name), ''), nullif(trim(member_row.discord_username), ''), member_row.discord_user_id),
      upper(trim(p_team)), lobby_row.roster_entry_centavos, actor.id)
    returning * into player_row;
  update public.wallets set
      available_centavos = available_centavos - lobby_row.roster_entry_centavos,
      reserved_centavos = reserved_centavos + lobby_row.roster_entry_centavos,
      updated_at = now()
    where user_id = member_row.id;
  insert into public.wallet_transactions(user_id, type, amount_centavos,
      available_before, available_after, reserved_before, reserved_after,
      source_type, source_id, actor_type, actor_id, idempotency_key, metadata)
    values(member_row.id, 'LOBBY_ROSTER_RESERVE', 0,
      wallet_row.available_centavos, wallet_row.available_centavos - lobby_row.roster_entry_centavos,
      wallet_row.reserved_centavos, wallet_row.reserved_centavos + lobby_row.roster_entry_centavos,
      'LOBBY_ROSTER', player_row.id::text, actor.role, actor.id::text,
      'lobby:' || lobby_row.id::text || ':roster:' || player_row.id::text || ':reserve',
      jsonb_build_object('lobby_id', lobby_row.id, 'lobby_player_id', player_row.id,
        'team', player_row.team, 'stake_centavos', player_row.stake_centavos));
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source,
      action, entity_type, entity_id, new_data)
    values(actor.role, actor.id, auth.uid(), 'DASHBOARD', 'LOBBY_PLAYER_ADDED',
      'lobby_players', player_row.id, jsonb_build_object('lobby_id', lobby_row.id,
        'member_id', member_row.id, 'team', player_row.team,
        'stake_centavos', player_row.stake_centavos));
  update public.lobbies set discord_revision = discord_revision + 1 where id = lobby_row.id;
  return player_row;
end;
$$;

create function public.remove_lobby_player(p_lobby_player_id uuid)
returns public.lobby_players language plpgsql security definer set search_path = '' as $$
declare actor public.staff_profiles; lobby_id_value uuid; lobby_row public.lobbies;
  player_row public.lobby_players; wallet_row public.wallets;
begin
  lock table public.staff_profiles in share row exclusive mode;
  actor := rampage_private.require_active_staff();
  select lobby_id into lobby_id_value from public.lobby_players where id = p_lobby_player_id;
  if lobby_id_value is null then raise exception 'Lobby player not found' using errcode = 'P0002'; end if;
  select * into lobby_row from public.lobbies where id = lobby_id_value for update;
  select * into player_row from public.lobby_players where id = p_lobby_player_id for update;
  if player_row.status = 'REMOVED' then return player_row; end if;
  if lobby_row.status <> 'OPEN' then raise exception 'Roster removal requires an OPEN lobby' using errcode = '22023'; end if;
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
  update public.lobby_players set status = 'REMOVED', removed_by = actor.id, removed_at = now()
    where id = player_row.id returning * into player_row;
  insert into public.wallet_transactions(user_id, type, amount_centavos,
      available_before, available_after, reserved_before, reserved_after,
      source_type, source_id, actor_type, actor_id, idempotency_key, metadata)
    values(player_row.user_id, 'LOBBY_ROSTER_RELEASE', 0,
      wallet_row.available_centavos, wallet_row.available_centavos + player_row.stake_centavos,
      wallet_row.reserved_centavos, wallet_row.reserved_centavos - player_row.stake_centavos,
      'LOBBY_ROSTER', player_row.id::text, actor.role, actor.id::text,
      'lobby:' || lobby_row.id::text || ':roster:' || player_row.id::text || ':release',
      jsonb_build_object('lobby_id', lobby_row.id, 'lobby_player_id', player_row.id,
        'team', player_row.team, 'stake_centavos', player_row.stake_centavos));
  insert into public.audit_logs(actor_type, actor_staff_id, actor_auth_user_id, source,
      action, entity_type, entity_id, old_data, new_data)
    values(actor.role, actor.id, auth.uid(), 'DASHBOARD', 'LOBBY_PLAYER_REMOVED',
      'lobby_players', player_row.id,
      jsonb_build_object('status', 'ACTIVE', 'lobby_id', lobby_row.id,
        'member_id', player_row.user_id, 'team', player_row.team,
        'stake_centavos', player_row.stake_centavos), to_jsonb(player_row));
  update public.lobbies set discord_revision = discord_revision + 1 where id = lobby_row.id;
  return player_row;
end;
$$;

create function public.sync_discord_channels(p_guild_id text, p_channels jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; synced integer := 0; channel_id_value text; name_value text; type_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode = '42501';
  end if;
  if p_guild_id is null or p_guild_id !~ '^[0-9]{17,20}$'
      or jsonb_typeof(p_channels) <> 'array' or jsonb_array_length(p_channels) > 500 then
    raise exception 'Invalid Discord channel synchronization payload' using errcode = '22023';
  end if;
  update public.discord_channels set active = false, can_post = false, last_synced_at = now()
    where guild_id = p_guild_id;
  for item in select value from jsonb_array_elements(p_channels)
  loop
    channel_id_value := item->>'channel_id';
    name_value := nullif(trim(item->>'channel_name'), '');
    type_value := item->>'channel_type';
    if channel_id_value is null or channel_id_value !~ '^[0-9]{17,20}$'
        or name_value is null or length(name_value) > 100
        or type_value not in ('GUILD_TEXT', 'GUILD_ANNOUNCEMENT')
        or jsonb_typeof(item->'can_post') <> 'boolean' then
      raise exception 'Invalid Discord channel metadata' using errcode = '22023';
    end if;
    insert into public.discord_channels(channel_id, guild_id, channel_name, channel_type,
        can_post, active, last_synced_at)
      values(channel_id_value, p_guild_id, name_value, type_value,
        (item->>'can_post')::boolean, true, now())
      on conflict(channel_id) do update set guild_id = excluded.guild_id,
        channel_name = excluded.channel_name, channel_type = excluded.channel_type,
        can_post = excluded.can_post, active = true, last_synced_at = now();
    synced := synced + 1;
  end loop;
  return synced;
end;
$$;

create function public.claim_lobby_discord_sync()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare lobby_row public.lobbies; channel_name_value text; players jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode = '42501';
  end if;
  select * into lobby_row from public.lobbies
    where discord_synced_revision < discord_revision
      and (discord_sync_claimed_at is null or discord_sync_claimed_at < now() - interval '1 minute')
    order by updated_at, id for update skip locked limit 1;
  if lobby_row.id is null then return null; end if;
  update public.lobbies set discord_sync_claimed_at = now(), discord_sync_error = null
    where id = lobby_row.id returning * into lobby_row;
  select channel_name into channel_name_value from public.discord_channels
    where channel_id = lobby_row.discord_channel_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'discord_user_id', discord_user_id, 'display_name', display_name,
      'team', team, 'stake_centavos', stake_centavos, 'added_at', added_at)
      order by added_at, id), '[]'::jsonb) into players
    from public.lobby_players where lobby_id = lobby_row.id and status = 'ACTIVE';
  return to_jsonb(lobby_row) || jsonb_build_object(
    'discord_channel_name', channel_name_value, 'players', players);
end;
$$;

create function public.complete_lobby_discord_sync(
  p_lobby_id uuid, p_revision bigint, p_discord_message_id text
) returns public.lobbies language plpgsql security definer set search_path = '' as $$
declare lobby_row public.lobbies; created_message boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode = '42501';
  end if;
  if p_revision is null or p_revision < 1 or p_discord_message_id is null
      or p_discord_message_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord synchronization result' using errcode = '22023';
  end if;
  select * into lobby_row from public.lobbies where id = p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode = 'P0002'; end if;
  if lobby_row.discord_message_id is not null
      and lobby_row.discord_message_id <> p_discord_message_id then
    raise exception 'Lobby Discord message identity cannot change' using errcode = '23505';
  end if;
  created_message := lobby_row.discord_message_id is null;
  update public.lobbies set discord_message_id = coalesce(discord_message_id, p_discord_message_id),
      discord_synced_revision = greatest(discord_synced_revision, least(p_revision, discord_revision)),
      discord_sync_claimed_at = null, discord_sync_error = null
    where id = lobby_row.id returning * into lobby_row;
  if created_message then
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, new_data)
      values('SYSTEM', 'SYSTEM', 'LOBBY_DISCORD_MESSAGE_CREATED', 'lobbies', lobby_row.id,
        jsonb_build_object('discord_channel_id', lobby_row.discord_channel_id,
          'discord_message_id', lobby_row.discord_message_id));
  end if;
  return lobby_row;
end;
$$;

create function public.fail_lobby_discord_sync(
  p_lobby_id uuid, p_revision bigint, p_error text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode = '42501';
  end if;
  update public.lobbies set discord_sync_claimed_at = null,
      discord_sync_error = left(coalesce(nullif(trim(p_error), ''), 'Discord synchronization failed'), 500)
    where id = p_lobby_id and discord_synced_revision < discord_revision;
  if found then
    insert into public.audit_logs(actor_type, source, action, entity_type, entity_id, reason, new_data)
      values('SYSTEM', 'SYSTEM', 'LOBBY_DISCORD_SYNC_FAILED', 'lobbies', p_lobby_id,
        left(coalesce(nullif(trim(p_error), ''), 'Discord synchronization failed'), 500),
        jsonb_build_object('revision', p_revision));
  end if;
end;
$$;

revoke all on function rampage_private.require_active_staff(),
  rampage_private.protect_lobby_configuration(),
  rampage_private.enforce_lobby_player_constraints(),
  rampage_private.protect_lobby_player_history(),
  public.create_lobby(text,text,text,bigint,boolean,bigint,bigint,integer),
  public.add_lobby_player(uuid,uuid,text), public.remove_lobby_player(uuid),
  public.sync_discord_channels(text,jsonb), public.claim_lobby_discord_sync(),
  public.complete_lobby_discord_sync(uuid,bigint,text),
  public.fail_lobby_discord_sync(uuid,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_lobby(text,text,text,bigint,boolean,bigint,bigint,integer),
  public.add_lobby_player(uuid,uuid,text), public.remove_lobby_player(uuid)
  to authenticated;
grant execute on function public.sync_discord_channels(text,jsonb),
  public.claim_lobby_discord_sync(), public.complete_lobby_discord_sync(uuid,bigint,text),
  public.fail_lobby_discord_sync(uuid,bigint,text)
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.discord_channels';
    exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.lobbies';
    exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.lobby_players';
    exception when duplicate_object then null; end;
  end if;
end;
$$;

commit;
