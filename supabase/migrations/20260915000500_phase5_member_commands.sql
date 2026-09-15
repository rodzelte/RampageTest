-- Phase 5 final member commands: idempotent slash roster actions and private wallet reads.
begin;

alter table public.lobby_players
  add column if not exists join_interaction_id text,
  add column if not exists leave_interaction_id text;

alter table public.lobby_players
  drop constraint if exists lobby_players_join_interaction_id_check;
alter table public.lobby_players
  add constraint lobby_players_join_interaction_id_check check (
    join_interaction_id is null or join_interaction_id ~ '^[0-9]{17,20}$'
  );
alter table public.lobby_players
  drop constraint if exists lobby_players_leave_interaction_id_check;
alter table public.lobby_players
  add constraint lobby_players_leave_interaction_id_check check (
    leave_interaction_id is null or leave_interaction_id ~ '^[0-9]{17,20}$'
  );

create unique index if not exists lobby_players_join_interaction_unique
  on public.lobby_players(join_interaction_id)
  where join_interaction_id is not null;
create unique index if not exists lobby_players_leave_interaction_unique
  on public.lobby_players(leave_interaction_id)
  where leave_interaction_id is not null;

create or replace function rampage_private.stamp_lobby_interaction()
returns trigger language plpgsql set search_path = '' as $$
declare interaction_id text;
begin
  interaction_id := nullif(current_setting('rampage.discord_interaction_id', true), '');
  if interaction_id is null then return new; end if;
  if interaction_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord interaction identity' using errcode='22023';
  end if;
  if tg_op = 'INSERT' and new.added_source = 'DISCORD_SELF_SERVICE' then
    new.join_interaction_id := interaction_id;
  elsif tg_op = 'UPDATE' and old.status = 'ACTIVE' and new.status = 'REMOVED'
      and new.removed_source = 'DISCORD_SELF_SERVICE' then
    new.leave_interaction_id := interaction_id;
  end if;
  return new;
end;
$$;

drop trigger if exists a_lobby_player_interaction_stamp on public.lobby_players;
create trigger a_lobby_player_interaction_stamp
  before insert or update on public.lobby_players
  for each row execute function rampage_private.stamp_lobby_interaction();

create or replace function rampage_private.protect_lobby_player_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.lobby_id is distinct from old.lobby_id
      or new.user_id is distinct from old.user_id
      or new.discord_user_id is distinct from old.discord_user_id
      or new.display_name is distinct from old.display_name
      or new.team is distinct from old.team
      or new.stake_centavos is distinct from old.stake_centavos
      or new.added_by is distinct from old.added_by
      or new.added_at is distinct from old.added_at
      or new.added_source is distinct from old.added_source
      or new.join_interaction_id is distinct from old.join_interaction_id
      or (
        new.leave_interaction_id is distinct from old.leave_interaction_id
        and not (
          old.status = 'ACTIVE' and new.status = 'REMOVED'
          and old.leave_interaction_id is null
          and new.leave_interaction_id is not null
        )
      )
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

create or replace function rampage_private.active_lobby_players_json(p_lobby_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'discord_user_id', p.discord_user_id,
        'display_name', p.display_name,
        'team', p.team,
        'status', p.status,
        'added_at', p.added_at
      ) order by p.added_at, p.id
    ),
    '[]'::jsonb
  )
  from public.lobby_players p
  where p.lobby_id = p_lobby_id and p.status = 'ACTIVE';
$$;

create function public.join_lobby_self_with_amount(
  p_lobby_id uuid,
  p_discord_user_id text,
  p_team text,
  p_entry_centavos bigint,
  p_discord_interaction_id text,
  p_discord_message_id text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lobby_row public.lobbies;
  member_row public.members;
  player_row public.lobby_players;
  existing_player public.lobby_players;
  normalized_team text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501';
  end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023';
  end if;
  if p_discord_interaction_id is null or p_discord_interaction_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord interaction identity' using errcode='22023';
  end if;
  normalized_team := upper(trim(p_team));
  if normalized_team not in ('RADIANT', 'DIRE') then
    raise exception 'Team must be RADIANT or DIRE' using errcode='22023';
  end if;
  if p_discord_message_id is not null and p_discord_message_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord message identity' using errcode='22023';
  end if;

  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;

  select * into existing_player from public.lobby_players
    where join_interaction_id=p_discord_interaction_id;
  if existing_player.id is not null then
    if existing_player.lobby_id <> p_lobby_id
        or existing_player.discord_user_id <> p_discord_user_id
        or existing_player.team <> normalized_team then
      raise exception 'Discord interaction identity conflict' using errcode='42501';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'lobby_name', lobby_row.display_name,
      'entry_centavos', existing_player.stake_centavos,
      'team', existing_player.team,
      'player', to_jsonb(existing_player),
      'active_players', rampage_private.active_lobby_players_json(lobby_row.id)
    );
  end if;

  if lobby_row.status <> 'OPEN' then
    raise exception 'Joining requires an OPEN lobby' using errcode='22023';
  end if;
  if p_discord_message_id is not null
      and (lobby_row.discord_message_id is null
        or lobby_row.discord_message_id <> p_discord_message_id) then
    raise exception 'This lobby message is no longer active' using errcode='22023';
  end if;
  if p_entry_centavos is null and p_discord_message_id is null then
    raise exception 'Explicit roster entry confirmation is required' using errcode='22023';
  end if;
  if p_entry_centavos is not null
      and (p_entry_centavos < 1 or p_entry_centavos > 9007199254740991) then
    raise exception 'Invalid roster entry amount' using errcode='22023';
  end if;
  if p_entry_centavos is not null
      and p_entry_centavos <> lobby_row.roster_entry_centavos then
    raise exception 'Incorrect entry amount' using errcode='22023',
      detail=lobby_row.display_name || '|' || lobby_row.roster_entry_centavos::text;
  end if;

  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then
    raise exception 'Active Rampage member required' using errcode='42501';
  end if;
  select * into existing_player from public.lobby_players
    where lobby_id=p_lobby_id and user_id=member_row.id and status='ACTIVE';
  if existing_player.id is not null then
    raise exception 'Already in lobby: %', existing_player.team using errcode='23505';
  end if;
  if (select count(*) from public.lobby_players
      where lobby_id=p_lobby_id and team=normalized_team and status='ACTIVE') >= 5 then
    raise exception '% is full', normalized_team using errcode='23514';
  end if;

  perform set_config('rampage.discord_interaction_id', p_discord_interaction_id, true);
  player_row := rampage_private.reserve_lobby_player(
    p_lobby_id, member_row.id, normalized_team, null,
    'DISCORD_SELF_SERVICE', p_discord_user_id
  );
  return jsonb_build_object(
    'duplicate', false,
    'lobby_name', lobby_row.display_name,
    'entry_centavos', player_row.stake_centavos,
    'team', player_row.team,
    'player', to_jsonb(player_row),
    'active_players', rampage_private.active_lobby_players_json(lobby_row.id)
  );
end;
$$;

create function public.leave_lobby_self_with_interaction(
  p_lobby_id uuid,
  p_discord_user_id text,
  p_discord_interaction_id text,
  p_discord_message_id text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lobby_row public.lobbies;
  member_row public.members;
  player_row public.lobby_players;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501';
  end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023';
  end if;
  if p_discord_interaction_id is null or p_discord_interaction_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord interaction identity' using errcode='22023';
  end if;
  if p_discord_message_id is not null and p_discord_message_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord message identity' using errcode='22023';
  end if;

  select * into lobby_row from public.lobbies where id=p_lobby_id for update;
  if lobby_row.id is null then raise exception 'Lobby not found' using errcode='P0002'; end if;
  select * into player_row from public.lobby_players
    where leave_interaction_id=p_discord_interaction_id;
  if player_row.id is not null then
    if player_row.lobby_id <> p_lobby_id or player_row.discord_user_id <> p_discord_user_id then
      raise exception 'Discord interaction identity conflict' using errcode='42501';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'lobby_name', lobby_row.display_name,
      'entry_centavos', player_row.stake_centavos,
      'team', player_row.team,
      'player', to_jsonb(player_row),
      'active_players', rampage_private.active_lobby_players_json(lobby_row.id)
    );
  end if;

  if lobby_row.status <> 'OPEN' then
    raise exception 'Leaving requires an OPEN lobby' using errcode='22023';
  end if;
  if p_discord_message_id is not null
      and (lobby_row.discord_message_id is null
        or lobby_row.discord_message_id <> p_discord_message_id) then
    raise exception 'This lobby message is no longer active' using errcode='22023';
  end if;
  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then
    raise exception 'Active Rampage member required' using errcode='42501';
  end if;
  select * into player_row from public.lobby_players
    where lobby_id=p_lobby_id and user_id=member_row.id and status='ACTIVE'
    order by added_at desc, id desc limit 1 for update;
  if player_row.id is null then
    raise exception 'You are not active in this lobby' using errcode='P0002';
  end if;

  perform set_config('rampage.discord_interaction_id', p_discord_interaction_id, true);
  player_row := rampage_private.release_lobby_player(
    player_row.id, null, 'DISCORD_SELF_SERVICE', p_discord_user_id
  );
  return jsonb_build_object(
    'duplicate', false,
    'lobby_name', lobby_row.display_name,
    'entry_centavos', player_row.stake_centavos,
    'team', player_row.team,
    'player', to_jsonb(player_row),
    'active_players', rampage_private.active_lobby_players_json(lobby_row.id)
  );
end;
$$;

create function public.get_discord_wallet(p_discord_user_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare member_row public.members; wallet_row public.wallets;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501';
  end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023';
  end if;
  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then
    raise exception 'Active Rampage member required' using errcode='42501';
  end if;
  select * into wallet_row from public.wallets where user_id=member_row.id;
  if wallet_row.user_id is null then raise exception 'Wallet not found' using errcode='P0002'; end if;
  return jsonb_build_object(
    'user_id', member_row.id,
    'available_centavos', wallet_row.available_centavos,
    'reserved_centavos', wallet_row.reserved_centavos,
    'total_centavos', wallet_row.available_centavos + wallet_row.reserved_centavos,
    'updated_at', wallet_row.updated_at
  );
end;
$$;

create function public.get_discord_transactions(
  p_discord_user_id text,
  p_limit integer default 11,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare member_row public.members; transaction_rows jsonb; total_rows integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted Discord bot required' using errcode='42501';
  end if;
  if p_discord_user_id is null or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid Discord member identity' using errcode='22023';
  end if;
  if p_limit is null or p_limit not between 1 and 25
      or p_offset is null or p_offset not between 0 and 10000 then
    raise exception 'Invalid transaction page' using errcode='22023';
  end if;
  select * into member_row from public.members
    where discord_user_id=p_discord_user_id and status='ACTIVE';
  if member_row.id is null then
    raise exception 'Active Rampage member required' using errcode='42501';
  end if;
  select count(*)::integer into total_rows
    from public.wallet_transactions where user_id=member_row.id;
  select coalesce(jsonb_agg(to_jsonb(history) order by history.created_at desc, history.id desc), '[]'::jsonb)
    into transaction_rows
    from (
      select t.id,t.type,t.amount_centavos,t.available_before,t.available_after,
        t.reserved_before,t.reserved_after,t.source_type,t.source_id,t.metadata,t.created_at,
        l.display_name as lobby_name,b.bet_number,
        coalesce(b.side,t.metadata->>'team') as side
      from public.wallet_transactions t
      left join public.lobbies l on l.id::text=t.metadata->>'lobby_id'
      left join public.side_bets b
        on t.source_type='LOBBY_SIDE_BET' and b.id::text=t.source_id
      where t.user_id=member_row.id
      order by t.created_at desc,t.id desc
      limit p_limit offset p_offset
    ) history;
  return jsonb_build_object(
    'user_id', member_row.id,
    'total', total_rows,
    'transactions', transaction_rows
  );
end;
$$;

revoke all on function rampage_private.stamp_lobby_interaction(),
  rampage_private.active_lobby_players_json(uuid),
  public.join_lobby_self_with_amount(uuid,text,text,bigint,text,text),
  public.leave_lobby_self_with_interaction(uuid,text,text,text),
  public.get_discord_wallet(text),
  public.get_discord_transactions(text,integer,integer)
  from public,anon,authenticated,service_role;

grant execute on function
  public.join_lobby_self_with_amount(uuid,text,text,bigint,text,text),
  public.leave_lobby_self_with_interaction(uuid,text,text,text),
  public.get_discord_wallet(text),
  public.get_discord_transactions(text,integer,integer)
  to service_role;

commit;
