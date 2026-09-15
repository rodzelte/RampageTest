-- Phase 4 schema compatibility only. The original Phase 4 patch is already
-- applied and remains immutable. This migration safely reconciles additive
-- columns and named checks when schema elements already exist.
begin;

alter table public.lobbies
  add column if not exists financial_commitment_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists discord_previous_channel_id text,
  add column if not exists discord_previous_message_id text;

alter table public.lobby_players
  add column if not exists added_source text,
  add column if not exists removed_source text;

alter table public.lobby_players alter column added_by drop not null;
alter table public.lobby_players alter column added_source set default 'DASHBOARD';
update public.lobby_players
  set added_source = 'DASHBOARD'
  where added_source is null;
update public.lobby_players
  set removed_source = 'DASHBOARD'
  where status = 'REMOVED' and removed_source is null;
alter table public.lobby_players alter column added_source set not null;

update public.lobbies l
  set financial_commitment_at = history.first_commitment
from (
  select lobby_id, min(added_at) first_commitment
  from public.lobby_players
  group by lobby_id
) history
where l.id = history.lobby_id and l.financial_commitment_at is null;

alter table public.audit_logs drop constraint if exists audit_logs_source_check;
alter table public.audit_logs add constraint audit_logs_source_check
  check (source in (
    'DISCORD', 'DISCORD_SELF_SERVICE', 'DASHBOARD', 'PAYMENT_WEBHOOK', 'SYSTEM'
  ));

alter table public.lobbies drop constraint if exists lobbies_status_check;
alter table public.lobbies add constraint lobbies_status_check
  check (status in (
    'OPEN', 'POSTPONED', 'LOCKED', 'SETTLED', 'CANCELLED', 'ARCHIVED'
  ));

alter table public.lobbies
  drop constraint if exists side_bet_configuration_valid;
alter table public.lobbies add constraint side_bet_configuration_valid check (
  (not side_betting_enabled
    and side_bet_min_centavos is null
    and side_bet_max_centavos is null)
  or (side_betting_enabled
    and side_bet_min_centavos >= roster_entry_centavos
    and side_bet_max_centavos >= side_bet_min_centavos)
);

alter table public.lobbies
  drop constraint if exists lobbies_discord_previous_channel_id_check;
alter table public.lobbies add constraint lobbies_discord_previous_channel_id_check
  check (
    discord_previous_channel_id is null
    or discord_previous_channel_id ~ '^[0-9]{17,20}$'
  );

alter table public.lobbies
  drop constraint if exists lobbies_discord_previous_message_id_check;
alter table public.lobbies add constraint lobbies_discord_previous_message_id_check
  check (
    discord_previous_message_id is null
    or discord_previous_message_id ~ '^[0-9]{17,20}$'
  );

alter table public.lobby_players
  drop constraint if exists lobby_players_added_source_check;
alter table public.lobby_players add constraint lobby_players_added_source_check
  check (added_source in ('DASHBOARD', 'DISCORD_SELF_SERVICE'));

alter table public.lobby_players
  drop constraint if exists lobby_players_removed_source_check;
alter table public.lobby_players add constraint lobby_players_removed_source_check
  check (removed_source in (
    'DASHBOARD', 'DISCORD_SELF_SERVICE', 'LOBBY_CANCELLED'
  ));

alter table public.lobby_players
  drop constraint if exists lobby_player_removal_evidence;
alter table public.lobby_players add constraint lobby_player_removal_evidence check (
  (status = 'ACTIVE'
    and removed_by is null
    and removed_at is null
    and removed_source is null)
  or (status = 'REMOVED'
    and removed_at is not null
    and removed_source is not null
    and (
      (removed_source = 'DISCORD_SELF_SERVICE' and removed_by is null)
      or (
        removed_source in ('DASHBOARD', 'LOBBY_CANCELLED')
        and removed_by is not null
      )
    ))
);

commit;
