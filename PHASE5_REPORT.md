# Phase 5 Completion Report

## Status

Phase 5 side betting, live pools, platform-fee preview, and the available-lobby discovery
UX patch are complete. Phase 6 and Phase 7 behavior was not implemented.

## Lobby discovery and matchup UX patch

The hosted-data investigation found that the bot and dashboard use the same Supabase
project and that the bot constructs its client with the service-role credential. The
only hosted OPEN lobby at verification time was `ADDD`, and its authoritative
`side_betting_enabled` value was `false`. It was therefore correct for `/bet` to return
no choices; the same lobby is visible in `/lobbies` because roster discovery does not
require betting to be enabled.

Autocomplete now loads the complete OPEN set through the trusted bot client, filters
betting eligibility and friendly search text in memory, and returns at most 25 UUID
options. Empty search works immediately. Safe structured logs record OPEN and eligible
counts plus returned lobby IDs, names, and statuses. Bet placement still delegates to
the transactional database RPC, which rechecks OPEN and betting-enabled state and
returns the canonical stale-lobby error when either condition changes.

`/lobbies` now uses an ephemeral select menu with 25 options per page and Previous/Next
controls. Selecting a lobby replaces the private response with a compact configuration,
roster, matchup, and combined-pool summary while retaining navigation. A shared matchup
helper selects the earliest ACTIVE member for each team by `added_at`, then UUID, and
shows `TBD` for an empty side. Removed roster members and side bettors are excluded.
The same matchup appears in autocomplete, private discovery, the public lobby embed,
and dashboard list/detail views.

## Migration

`20260915000400_phase5_side_betting.sql` is additive and is applied to the linked
hosted Supabase project. Earlier migrations were not edited or replayed. The hosted
migration list has matching local/remote version `20260915000400`; the final dry run
reports no pending migrations.

## Database and security

The migration creates `public.side_bets` with a UUID primary key and an independent
identity-backed bigint `bet_number`. Each row records member and Discord identity,
side, requested and accepted integer-centavo amounts, lifecycle timestamps, and
non-secret Discord interaction IDs. Multiple rows per member/lobby are allowed.

RLS permits active ADMIN and OWNER reads. No member or browser mutation grant exists.
`place_side_bet_self` and `cancel_side_bet_self` are service-role-only security-definer
RPCs. Both lock the lobby and wallet; cancellation also locks the position. Immutable
triggers prevent direct history changes and deletion.

Placement checks the member, OPEN state, enabled configuration, roster/min/max floors,
available balance, side, and Discord interaction ID. It transfers available to reserved,
adds one `LOBBY_SIDE_BET_RESERVE` ledger record, sets the first financial commitment,
audits `LOBBY_SIDE_BET_PLACED`, and increments the Discord revision atomically.

Cancellation scopes identity to `interaction.user.id`, releases only the member's active
bet, adds one `LOBBY_SIDE_BET_RELEASE`, audits `LOBBY_SIDE_BET_CANCELLED`, and is
idempotent after cancellation. Lobby cancellation now refunds remaining active roster
and side-bet positions in the same transaction and records separate refund totals.

## Discord

The canonical command registry contains `/topup`, `/lobbies`, `/bet`, and `/cancelbet`;
all four were registered to the configured guild with `pnpm bot:register`. `/lobbies`
privately shows every OPEN lobby available for roster participation, including lobbies
where side betting is disabled. `/bet` offers only OPEN, betting-enabled lobbies through
autocomplete. The slash command and modal submit use the exact PHP parser and return
ephemeral confirmations. Bet buttons open private amount modals.

The existing public lobby message is edited after each committed revision. It shows
active roster pools, side-bet pools, combined totals, absolute difference, leading side,
and bounded active-bet lists. Long lists show `+ N more active bets`. It contains no
wallet balance, top-up, QR, or payment-reference data.

## Platform fee preview

Shared BigInt helpers calculate winning profit, gross return, fee, and estimated net
return. Fee calculation is `floor(winning_profit_centavos * platform_fee_bps / 10000)`.
The projection is display-only; no revenue or settlement row is created.

## Dashboard and realtime

The lobby detail page shows roster pool, side-bet pool, combined total, pool difference,
leader, and complete active/cancelled side-bet history. Realtime refresh now listens to
`side_bets` as well as lobbies and rosters, with the existing timed refetch fallback.

## Verification

- `pnpm test`: PASS — 255 tests across 12 files
- PostgreSQL/PGlite database suite: PASS — 71 tests
- `pnpm typecheck`: PASS
- `pnpm lint`: PASS — zero warnings
- `pnpm build`: PASS — 188 modules
- `pnpm check:browser`: PASS — no private environment values or service keys
- `supabase db lint --linked --level warning`: PASS — no schema errors
- `supabase migration list`: PASS — `20260915000400` local and remote
- `supabase db push --dry-run`: PASS — hosted database is up to date
- Hosted schema smoke check: PASS — table columns available; RPC authorization path live
- Hosted dashboard smoke check: PASS — `ADDD`, `TBD vs TBD`, OPEN status, 0/5 vs 0/5,
  ₱200 entry, betting disabled, and 5% fee render in list and detail views
- `pnpm bot:register`: PASS — four canonical guild commands registered
- `pnpm bot:start`: PASS — Discord ready event received during the bounded smoke test

The production build retains the existing informational Vite chunk-size advisory.

## Manual verification

1. Start the dashboard with `pnpm dev` and the bot with `pnpm bot:start`.
2. Create an OPEN lobby with ₱100 entry, betting enabled, ₱100–₱5,000 range, and 5% fee.
3. Create another OPEN lobby with betting disabled, run `/lobbies`, and confirm both are
   shown privately while only the enabled lobby appears in `/bet` autocomplete.
4. Verify the disabled lobby still has Join Radiant, Join Dire, and Leave Lobby controls,
   with no Bet Radiant or Bet Dire buttons.
5. Verify a member with ₱80 gets a private insufficient-balance response.
6. Give the member ₱500 available and place separate ₱100 Radiant, ₱150 Radiant, and
   ₱100 Dire bets. Verify three rows, three bet numbers, ₱150 available, and ₱350 reserved.
7. Verify the original public lobby message updates its pools without exposing balances.
8. Cancel one bet by number twice. Verify one release and the other positions remain active.
9. Postpone and verify `/lobbies` excludes it and placement/cancellation reject without
   refunds; resume and retry.
10. Cancel the lobby and verify active roster and side-bet funds return exactly once.
11. Confirm no lock, LIFO, winner, settlement, payout, or platform revenue exists.

## Issues

No Phase 5 blockers remain. The browser build is successful with Vite's existing
non-failing large-chunk advisory.
