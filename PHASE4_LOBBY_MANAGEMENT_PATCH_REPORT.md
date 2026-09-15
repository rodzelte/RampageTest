# Phase 4 Lobby Management Patch Report

## Completion status

Complete. Discord self-service roster participation, participation balance rules,
lobby editing, postpone/resume, transactional cancellation, and soft archival are
implemented. Phase 5 was not started.

## Migration

`supabase/migrations/20260915000200_phase4_lobby_management.sql`

The migration is additive and leaves the deployed Phase 1–4 migrations unchanged.
It has been applied to the linked hosted Supabase project. Migration list and dry-run
both confirm that local and remote schemas are current.

Schema changes:

- Lobby statuses now include OPEN, POSTPONED, LOCKED, SETTLED, CANCELLED, and ARCHIVED.
  This patch implements only OPEN, POSTPONED, CANCELLED, and ARCHIVED transitions.
- `lobbies` adds financial commitment, archival, and previous Discord message/channel
  metadata.
- `lobby_players` records dashboard or Discord self-service add/remove sources and
  permits a null staff actor for a Discord member action.
- Audit source validation includes `DISCORD_SELF_SERVICE`.
- Side-bet configuration requires `side_bet_min_centavos >= roster_entry_centavos`.
- Existing removed roster rows are backfilled as dashboard removals, and existing
  lobby-player history backfills the first financial commitment timestamp.

## RPCs and database functions

Public RPCs added:

- `join_lobby_self`
- `leave_lobby_self`
- `update_lobby`
- `postpone_lobby`
- `resume_lobby`
- `cancel_lobby`
- `archive_lobby`

Private shared functions now perform reservation and release accounting for both the
dashboard and Discord. Existing `add_lobby_player` and `remove_lobby_player` call this
shared core. All financial changes lock the lobby and wallet, use integer centavos,
append deterministic ledger entries, write audits, and increment Discord revision in
one transaction.

## Status and edit rules

- OPEN: joins, leaves, staff add/remove, safe editing, postponement, and cancellation.
- POSTPONED: roster and reservations remain; participation is rejected; staff may
  resume, cancel, or edit permitted fields.
- CANCELLED: all active roster entries have been released; OWNER may archive.
- ARCHIVED: read-only history, hidden by the default Active filter, and no interactive
  Discord components.
- LOCKED and SETTLED remain reserved for later phases.

Before the first financial commitment, OWNER/ADMIN may edit the name, Discord channel,
entry, future side-bet configuration, and fee. After any roster participation, the
entry, side-bet settings, fee, and Discord channel are immutable. The display name
remains editable. Changing the default fee never changes an existing lobby snapshot.

## Cancellation and refunds

Cancellation accepts OPEN or POSTPONED lobbies, locks the lobby, processes every
ACTIVE roster row, releases the exact stake, marks history REMOVED with cancellation
evidence, and appends a `LOBBY_ROSTER_RELEASE` entry using:

`lobby:<lobby_id>:roster:<lobby_player_id>:cancel-release`

The lobby becomes CANCELLED and one audit records total refunded centavos. A repeated
cancel returns the existing state without another wallet change, ledger event, or
audit. No platform fee, revenue, payout, or settlement is created.

## Discord self-service

The public OPEN lobby message has Join Radiant, Join Dire, and Leave Lobby buttons.
Responses are ephemeral. The bot passes only the invoking `interaction.user.id` and
current Discord message ID to service-role-only RPCs. The database resolves the active
member and rejects caller-supplied alternate identities, stale messages, duplicate
positions, full teams, non-OPEN lobbies, and insufficient available balance.

POSTPONED and CANCELLED messages retain disabled components. ARCHIVED messages have no
components. A pre-commit channel move retires the previous message and posts one new
message. Even if Discord cannot retire the old presentation, stale-message validation
prevents its buttons from changing authoritative state.

## Dashboard

- Lobby list filters: Active, Open, Postponed, Cancelled, Archived, and All.
- Status-aware action menu.
- Edit dialog with commitment-aware disabled financial fields.
- Postpone and resume controls.
- Cancellation confirmation explaining the full roster refund.
- OWNER-only Delete Lobby label for unused soft archival and Archive Lobby for
  cancelled financial history.
- Archived lobby detail remains readable; restore is not implemented.

## Files added

- `supabase/migrations/20260915000200_phase4_lobby_management.sql`
- `src/bot/lobbies/lobbyInteractions.ts`
- `tests/lobby-self-service.test.ts`
- `PHASE4_LOBBY_MANAGEMENT_PATCH_REPORT.md`

## Files modified

- `README.md`
- `src/bot/interactions/handleInteraction.ts`
- `src/bot/lobbies/lobbyDiscord.ts`
- `src/dashboard/lib/data.ts`
- `src/dashboard/pages/LobbiesPage.tsx`
- `src/dashboard/pages/LobbyDetailPage.tsx`
- `src/dashboard/style.css`
- `src/shared/models.ts`
- `tests/dashboard-data.test.ts`
- `tests/dashboard.test.tsx`
- `tests/database.test.ts`
- `tests/helpers/dashboardClient.ts`
- `tests/lobby-discord.test.ts`

## Automated verification

- `pnpm test`: 219 tests passed in 11 files.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm build`: passed.
- `pnpm check:browser`: passed; no private environment values or service keys were
  found in the browser build.
- Hosted `supabase db lint --linked --level warning`: passed with no schema errors.
- Hosted schema verification found the new lobby columns and the `join_lobby_self`
  RPC. No live lobby or roster test records were created.

## Manual verification

1. Run `pnpm dev` and `pnpm bot:start` in separate terminals.
2. Sign in as OWNER and create Lobby A with entry `100.00`, side-bet minimum `100.00`,
   maximum `5000.00`, and fee `5.00`.
3. In Discord, use a member with ₱80.00 available and click Join Radiant. Confirm the
   response is private and rejects the balance without displaying the wallet balance.
4. Top up the member to at least ₱100.00, click Join Radiant, and confirm available
   decreases and reserved increases by exactly ₱100.00.
5. Click Leave Lobby and confirm one private response and one exact release.
6. Join again, postpone the lobby, and confirm the roster and reservation remain while
   all participation buttons are disabled. Resume and confirm buttons are enabled.
7. Create an unused lobby and edit its name, channel, entry, side-bet range, and fee.
8. After a member joins, confirm entry, fee, side-bet settings, and channel cannot be
   edited while the name can.
9. Cancel the financial lobby and confirm all active roster reservations return once,
   status becomes CANCELLED, and Discord shows disabled buttons.
10. Repeat cancellation and confirm there is no second release.
11. Archive as OWNER, confirm the Active filter hides the lobby, select Archived, and
    confirm roster, ledger, and audit history remains available.
12. Confirm no `/bet`, `/cancelbet`, lock, LIFO, settlement, payout, or platform-revenue
    behavior exists.
