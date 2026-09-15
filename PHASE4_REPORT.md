# Phase 4 Completion Report

The lobby management and Discord self-service follow-up is documented in
`PHASE4_LOBBY_MANAGEMENT_PATCH_REPORT.md`. The combined Phase 4 suite now has 219
passing tests.

1. **Completion status:** Complete. Phase 4 implements the OPEN lobby, 5v5 roster,
   wallet reservation/release, dashboard, Realtime refresh, and retry-safe Discord
   presentation foundation. No Phase 5–7 behavior was added.

2. **Files added:**
   - `PHASE4_REPORT.md`
   - `src/bot/lobbies/lobbyDiscord.ts`
   - `src/dashboard/hooks/useLobbyRealtime.ts`
   - `src/dashboard/pages/LobbiesPage.tsx`
   - `src/dashboard/pages/LobbyDetailPage.tsx`
   - `supabase/migrations/20260915000100_phase4_lobbies.sql`
   - `tests/lobby-discord.test.ts`

3. **Files modified for Phase 4:**
   - `README.md`
   - `.env` (`DEFAULT_PLATFORM_FEE_BPS=500` only; no `.env.example` was created)
   - `vite.config.ts`
   - `src/bot/client/startBot.ts`
   - `src/bot/config.ts`
   - `src/dashboard/hooks/useQuery.ts`
   - `src/dashboard/layouts/DashboardLayout.tsx`
   - `src/dashboard/lib/config.ts`
   - `src/dashboard/lib/data.ts`
   - `src/dashboard/pages/PlaceholderPage.tsx`
   - `src/dashboard/routes/DashboardRoutes.tsx`
   - `src/dashboard/routes/navigation.ts`
   - `src/dashboard/style.css`
   - `src/shared/models.ts`
   - `src/shared/money.ts`
   - `tests/dashboard-data.test.ts`
   - `tests/dashboard.test.tsx`
   - `tests/database.test.ts`
   - `tests/helpers/dashboardClient.ts`
   - `tests/money.test.ts`

   Earlier uncommitted Phase 3 QR/DM patch files remain in the working tree and
   were preserved.

4. **Migration created:** `20260915000100_phase4_lobbies.sql`. It is additive;
   the already-applied Phase 1–3 migrations were not edited.

5. **Tables and columns created:**
   - `discord_channels`: safe guild/channel metadata, posting capability, active
     state, and synchronization time.
   - `lobbies`: OPEN lifecycle configuration, Discord guild/channel/message,
     roster entry centavos, future side-bet configuration, immutable platform fee
     basis points, creator/timestamps, and Discord revision/claim/error metadata.
   - `lobby_players`: member and Discord snapshots, team, stake centavos,
     ACTIVE/REMOVED history, and add/remove actor timestamps.

6. **RPCs and functions created:**
   - Dashboard: `create_lobby`, `add_lobby_player`, `remove_lobby_player`.
   - Bot: `sync_discord_channels`, `claim_lobby_discord_sync`,
     `complete_lobby_discord_sync`, `fail_lobby_discord_sync`.
   - Private guards/triggers enforce active staff, immutable lobby fee/identity,
     active-member/team capacity, and immutable roster history.

7. **RLS and security:** RLS is enabled on all three tables. Only active ADMIN or
   OWNER sessions can read them. Authenticated direct writes are not granted;
   staff mutations run through authorization-checking transactional RPCs. Bot RPCs
   are service-role only and server-side. The browser bundle contains no Discord
   token, Supabase service-role key, or configured private environment value.

8. **Dashboard:** `/lobbies` now provides the lobby list and creation form using
   safe cached channels. `/lobbies/:lobbyId` provides configuration, fee disclosure,
   roster pools, searchable member selection with available balance, insufficient
   balance state, confirmed removal/refund, Discord sync state, and `READY TO LOCK`
   at 5v5 while status stays OPEN.

9. **Discord synchronization:** The bot refreshes safe channels on startup and
   periodically. A Realtime listener plus polling fallback reconciles unsynced lobby
   revisions. It posts one embed, stores its ID, then edits the same message. If
   saving a new message ID fails, retry searches recent bot messages for the lobby
   UUID before posting. Failures remain retryable and cannot roll back database or
   wallet commits.

10. **Wallet reservation/refund:** `add_lobby_player` locks the lobby/member/wallet,
    enforces capacity and uniqueness, transfers entry centavos from available to
    reserved, records one deterministic `LOBBY_ROSTER_RESERVE` event, audits, and
    increments the Discord revision atomically. `remove_lobby_player` works only
    while OPEN, releases the same amount once, appends one deterministic
    `LOBBY_ROSTER_RELEASE`, preserves the REMOVED row, audits, and increments the
    revision.

11. **Platform fee snapshot:** `DEFAULT_PLATFORM_FEE_BPS` defaults to `500` and is
    validated from 0–1000. The dashboard passes it as the creation default; the
    database also defaults to 500. `platform_fee_bps` cannot change after lobby
    creation. It is disclosed as a percentage of winning profit and is not collected.

12. **Tests added:** Database/RPC coverage checks both staff roles, unauthorised
    access, fee/side-bet/channel validation, both teams, duplicate membership, sixth
    player rejection, insufficient/inactive members, wallet/ledger/audit invariants,
    idempotent removal, immutable history, full 5v5 OPEN state, RLS, channel refresh,
    and Discord claims/retries. Bot tests cover safe channel metadata, public embed
    privacy, one-message create/edit/recovery, failures/retry, and full-roster display.
    Dashboard/data/money tests cover routes, exact parsing, forms, member search,
    balance state, refund confirmation, fee disclosure, and Realtime refetch.

13. **Total passing tests:** 219 tests in 11 files after the Phase 4 lobby-management patch.

14. **Typecheck:** `pnpm typecheck` passed.

15. **Lint:** `pnpm lint` passed with zero warnings.

16. **Build:** `pnpm build` passed. Vite transformed 188 modules. It emitted a
    non-failing advisory that the main minified JavaScript chunk is above 500 kB.

17. **Hosted Supabase migration:** Applied successfully. `supabase migration list`
    reports local and remote version `20260915000100`; `supabase db push --dry-run`
    reports the remote database is up to date. Trusted read checks returned OK for
    all three new tables, which currently contain zero rows.

18. **Remaining manual configuration:** Restart/start the dashboard and bot so the
    new code and environment setting load. Give the bot View Channel, Send Messages,
    Embed Links, and Read Message History in the chosen test channel. The first bot
    channel sync populates the dashboard selector. No test lobby was inserted into
    the hosted project, avoiding an unsolicited public Discord post.

19. **Exact manual test steps:**
    1. In separate terminals, run `pnpm dev` and `pnpm bot:start`.
    2. Log in as OWNER and open `/lobbies`.
    3. Create `Lobby 1` in a test channel with entry `100.00`, side betting enabled,
       minimum `50.00`, maximum `5000.00`, and platform fee `5.00`.
    4. Confirm Discord receives one lobby embed with `5% of winning profit`.
    5. Add a funded member to Radiant; verify available decreases and reserved
       increases by exactly ₱100.00, and the same Discord message is edited.
    6. Remove the player; verify the reservation returns exactly once, history stays
       REMOVED, and the same Discord message is edited.
    7. Fill Radiant to 5/5 and verify a sixth member is rejected. Fill Dire to 5/5.
    8. Verify dashboard and Discord show `READY TO LOCK`, while the database status
       remains `OPEN`.
    9. Verify the registered command list contains `/topup` only and no `/addplayer`,
       `/bet`, or `/cancelbet` command.
    10. Verify no lock, LIFO, settlement, payout, or platform-fee collection occurs.

20. **Blockers/issues:** No implementation or migration blocker remains. The manual
    Discord/dashboard flow depends on the bot being online with the listed channel
    permissions and on having funded test members. The Vite chunk-size advisory is
    informational. Side betting execution, lobby locking, LIFO, settlement, payout,
    fee realization, Rampage changes, and cashout remain intentionally deferred.
