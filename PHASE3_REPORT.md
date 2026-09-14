# Phase 3 Completion Report — Private QR Ph Top-ups

Implemented directly in `C:\Users\Rodzel Te\Documents\Downloads\RampageBot`. Phase 4 has not started.

## Completion status

The Phase 3 code, additive database migration, Edge Function, Discord `/topup` flow, mock provider, dashboard, and automated verification are complete. The migration and Edge Function are deployed to the linked hosted Supabase project. A real Discord smoke test still requires configuration that is not present: Discord bot credentials and a mock webhook secret. No production provider integration is claimed.

## 1. Files changed

Modified: `package.json`, `pnpm-lock.yaml`, `README.md`, `supabase/config.toml`, `src/shared/models.ts`, `src/dashboard/lib/data.ts`, `src/dashboard/pages/OverviewPage.tsx`, `src/dashboard/pages/PlaceholderPage.tsx`, `src/dashboard/routes/DashboardRoutes.tsx`, `src/dashboard/style.css`, `tests/database.test.ts`, `tests/dashboard-data.test.ts`, and `tests/helpers/dashboardClient.ts`.

Added: `supabase/migrations/20260914000200_phase3_topups.sql`, `supabase/functions/topup-webhook/index.ts`, the `src/bot` files listed in section 6, `src/dashboard/pages/PaymentsPage.tsx`, `scripts/register-bot.ts`, `scripts/simulate-topup.ts`, `tests/topup.test.ts`, and this report. Local configuration uses the existing gitignored `.env`; no `.env.example` is retained.

The Phase 1 migration was not changed. Its SHA256 remains `AA59453485753D05D4E5928971FFB6B8036D45AE3478EE4DAB27B353EAC5B257`.

## 2. Migration added

`20260914000200_phase3_topups.sql` is additive. It does not drop, rename, or replace Phase 1 tables, data, OWNER records, RLS helpers, audit history, or wallet history.

## 3. New tables and columns

Added `public.topups` with immutable member/request identity, integer centavos, PHP currency, provider payment/reference/event IDs, lifecycle status, QR/expiry/payment/credit timestamps, OWNER review evidence, and private-notification claim/failure timestamps. Unique and query indexes cover provider payment IDs, provider events, status/time, member/time, and references. No QR bytes are stored.

## 4. New RPCs and functions

- `create_topup`: service-only active-member request creation and `TOPUP_CREATED` audit.
- `set_topup_provider`: service-only one-time provider identity/QR timestamp storage.
- `fail_topup_creation`: service-only safe failure transition.
- `expire_pending_topups`: service-only stale `PENDING` to `EXPIRED` worker.
- `process_verified_topup`: service-only, locked, atomic verified-payment processing and wallet credit.
- `owner_resolve_topup_review`: authenticated active-OWNER review approval/rejection with explicit reason and credit amount.
- `claim_topup_notification`: service-only durable, once-only private notification claim.
- `record_topup_notification_failure`: service-only DM failure audit.
- `rampage_private.protect_topup_evidence`: prevents mutation of original request/provider/credit evidence.

Function ACLs are explicit. Application roles have no direct top-up or wallet mutation grants.

## 5. Edge Function added

Added public HTTPS `topup-webhook` with JWT verification disabled at the gateway so a QR Ph payment provider can call it. The function itself allows POST only, requires `TOPUP_PROVIDER=qrph_mock`, rejects `NODE_ENV=production`, verifies the mock webhook secret in constant-time form, validates the event, and calls the transactional service-role RPC. Unknown payment IDs and invalid callbacks fail without disclosing secrets.

## 6. Discord bot files added

- `src/bot/index.ts`
- `src/bot/client/startBot.ts`
- `src/bot/config.ts`
- `src/bot/commands/registry.ts`
- `src/bot/commands/topup.ts`
- `src/bot/interactions/handleInteraction.ts`
- `src/bot/services/topups.ts`
- `src/bot/providers/qrph.ts`
- `src/bot/providers/MockQrPhProvider.ts`
- `src/bot/notifications/topupNotifications.ts`

The canonical registry is used by `pnpm bot:register`, which replaces the guild command set with the currently implemented commands and therefore does not create duplicates.

## 7. `/topup` implementation status

Complete. It uses a required Discord string amount, the existing exact PHP parser, configurable minimum/expiry, the mandatory ₱100,000 ceiling, `interaction.user.id`, existing `ensure_member`, and active MEMBER authorization. It creates a unique top-up/provider payment pair and never changes a wallet when creating the request.

## 8. QR image implementation

Complete. `qrcode` renders a genuine PNG from provider payloads. Provider image buffers are attached directly; future HTTPS image URLs are downloaded with content-type, timeout, and size validation. The Discord response embeds `attachment://...png` and is deferred with the Discord ephemeral flag. The mock payload clearly begins `RAMPAGE-MOCK-QRPH`; it is not represented as a real payment.

## 9. MockQrPhProvider status

Complete for development. It creates unique payment IDs/references and mock QR payloads. Protected tooling supports success, mismatch, late, failure, and five-repeat duplicate simulations. Simulation refuses production mode and non-mock provider configuration.

## 10. Webhook implementation

Complete for the mock provider. It verifies the shared secret, normalizes provider evidence, resolves exclusively through `provider_payment_id`, validates PHP currency, amount, success, and timestamp, and delegates all state/wallet changes to one PostgreSQL transaction. It never accepts a member ID from the caller.

## 11. Exact amount verification

Automatic credit occurs only when the confirmed amount exactly equals the immutable requested amount. Centavos remain integers throughout. PostgreSQL also bounds requested amounts at 1–10,000,000 centavos.

## 12. Expiry behavior

The bot calls `expire_pending_topups` once per minute. Stale unpaid requests become `EXPIRED` with one audit event. The webhook independently compares `provider_paid_at` to `expires_at`, so worker timing cannot cause a late auto-credit.

## 13. Late-payment behavior

An exact payment after expiry becomes `LATE_PAID_REVIEW`. No wallet or ledger change occurs. OWNER may approve the exact verified amount or reject it with a reason.

## 14. Amount-mismatch behavior

A successful callback with a different amount becomes `AMOUNT_MISMATCH_REVIEW`. Requested and provider-paid amounts remain visible and immutable. OWNER approval requires an explicit credit amount equal to the verified provider-paid cash; the amount and reason are recorded in ledger metadata and audit data.

## 15. Idempotency protections

Provider payment IDs are unique; provider event IDs are unique per provider; the top-up row is locked; terminal states are no-ops on retries; wallet rows are locked; the ledger key `topup:<topup-id>:credit` is unique; OWNER review requires an unresolved review row; original evidence cannot be rewritten. The five-callback test produces one credit and one TOPUP transaction.

## 16. Payments dashboard changes

The Phase 2 placeholder is replaced by a real OWNER/ADMIN page with date, status, Discord ID, and provider-reference filters; pagination; loading/error/empty states; all requested payment/evidence timestamps and amounts; and read-only ADMIN access. OWNER receives approve/reject dialogs only for review states, with requested and paid amounts shown together, an explicit credit amount, reason, and confirmation.

## 17. Overview Cash In changes

`Total Cash In` and `Today's Cash In` are real and sum only positive `TOPUP` ledger entries already credited to wallets. The scan paginates beyond Supabase's default row limit and uses integer centavos. Cash Out remains unavailable for Phase 9.

## 18. Tests added

Phase 3 coverage includes amount boundaries/decimals, active Discord identity linkage, distinct same-amount requests, real PNG generation, ephemeral QR attachment, provider signature verification, failed QR handling, pending/no-wallet behavior, exact credit/correct member, other-member isolation, five duplicate callbacks, ledger before/after/reserved values, expiry, late review, mismatch review, OWNER approve/reject, ADMIN denial, repeat-review prevention, unknown payment ID, direct-write denial, evidence immutability, Payments filters, Cash In, and browser secret exclusion.

## 19. Tests passing

`pnpm test`: PASS — 142 tests across eight files after QR Ph finalization. This includes 36 PostgreSQL migration/RLS/RPC tests. Tests use PGlite and stubbed SDK hosts and do not access the configured Supabase project or real payment systems.

## 20. Typecheck result

`pnpm typecheck`: PASS.

## 21. Lint result

`pnpm lint`: PASS with zero warnings.

## 22. Build result

`pnpm build`: PASS. Output JavaScript is approximately 840.63 kB, 237.31 kB gzip. Vite emits its nonfatal over-500-kB advisory. `pnpm check:browser`: PASS across three built browser files; no configured private environment values, service-role keys, webhook secrets, passwords, or bot tokens were found.

## 23. Manual smoke-test result

Local database behavior was exercised through the actual two migrations in PostgreSQL/PGlite, including RLS, correct-member credit, duplicate callback, mismatch, late payment, expiry, review, and immutable ledger/evidence. The production dashboard compiles with the real Payments route.

Hosted Supabase verification completed after authenticating and linking the CLI. Both local migrations now appear in remote migration history. The Phase 3 migration applied successfully; `topups` is reachable and empty; exactly one active OWNER remains; all four existing audit records remain; and anonymous `topups` reads fail with `42501`. The original top-up webhook was subsequently renamed during QR Ph finalization; see `PHASE3_QRPH_FINALIZATION_REPORT.md` for current deployment status.

The live Payments route opens and correctly requires staff login. A post-login dashboard check and real Discord `/topup` flow remain pending because the current browser session is signed out and the Discord/mock webhook credentials are absent. No fake charge, real provider call, staff mutation, or ad hoc database DDL was attempted.

## 24. Configuration still required

- Set the remaining Edge Function secret: a random `QRPH_WEBHOOK_SECRET` of at least 16 characters. `TOPUP_PROVIDER=qrph_mock` and `NODE_ENV=development` are the final remote configuration.
- Set local `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID`.
- Set local `TOPUP_PROVIDER=qrph_mock`, the same `QRPH_WEBHOOK_SECRET`, and optional top-up limit/expiry overrides. Defaults are ₱100 minimum, ₱100,000 maximum, and 30 minutes.
- Sign in to the visible localhost dashboard and confirm Payments loads after authentication.
- Run `pnpm bot:register`, `pnpm bot:start`, and the documented manual flow in `README.md`.

No actual server secret belongs in tracked source or any `VITE_` variable.

## 25. Real approved QR Ph provider blockers

An approved QR Ph merchant/payment provider, production credentials, its signed-webhook specification, dynamic/fixed-amount QR API documentation, production callback requirements, and explicit approval to implement that provider are still required. The `QrPhProvider` contract is ready for that adapter. Manual GCash cashout remains separate for Phase 9. No scraping, OCR, screenshot verification, personal-QR automation, or merchant-restriction workaround exists.

Phase 3 stops here. No lobby, betting, LIFO, settlement, Rampage, cashout, referral, or autopost functionality was added.
