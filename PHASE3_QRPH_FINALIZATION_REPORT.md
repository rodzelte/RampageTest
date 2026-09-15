# Phase 3 QR Ph Finalization Report

Completed directly in `C:\Users\Rodzel Te\Documents\Downloads\RampageBot`. Phase 4 was not started.

## 1. Files renamed and changed

Renamed through provider replacements:

- `src/bot/providers/gcash.ts` → `src/bot/providers/qrph.ts`
- `src/bot/providers/MockGCashProvider.ts` → `src/bot/providers/MockQrPhProvider.ts`
- `supabase/functions/gcash-webhook/index.ts` → `supabase/functions/topup-webhook/index.ts`

Updated `src/bot/config.ts`, bot service/command/interaction/client imports, `scripts/simulate-topup.ts`, `supabase/config.toml`, the existing `.env` variable contract, dashboard release/cashout copy, tests, `README.md`, and Phase reports. The empty obsolete local function directory was removed. No separate environment template is retained.

## 2. Legacy top-up GCash references removed

Removed the `GCASH_PROVIDER`, `GCASH_API_KEY`, `GCASH_WEBHOOK_SECRET`, `GCashProvider`, `MockGCashProvider`, provider file name, `gcash-webhook`, `RAMPAGE-MOCK-TOPUP`, and `GCASH TOP-UP` top-up identifiers. The obsolete hosted `gcash-webhook` function and remote `GCASH_PROVIDER` secret were also deleted.

One old top-up phrase remains only in the first comment of the already-applied Phase 3 migration. The migration was deliberately not edited after deployment, avoiding a migration checksum/history mismatch. It has no schema or runtime effect.

## 3. GCash references intentionally retained

The Discord instruction remains “Scan the QR below using GCash,” because members use GCash as a QR Ph scanner. Future Phase 9 copy explicitly says manual GCash cashout and documents the future GCash account name/mobile-number workflow. A test protects that cashout wording.

## 4. `TOPUP_PROVIDER` status

The final development value is `TOPUP_PROVIDER=qrph_mock`. Bot configuration accepts that value, defaults to it for development, and rejects the mock adapter in production. The hosted Edge Function environment now contains `TOPUP_PROVIDER`; local `.env` still needs it.

## 5. `QrPhProvider` status

Complete. The small contract isolates QR creation and webhook verification/normalization from common top-up and wallet logic. It exposes provider payment/reference data, raw QR payload/image options, PHP amount, expiry, and normalized verified events. No production adapter is claimed.

## 6. `MockQrPhProvider` status

Complete. It retains success, failure, mismatch, late-payment, expiry, and duplicate-callback flows. Its real PNG QR contains `RAMPAGE-MOCK-QRPH:<topup-id>:<amount-centavos>`, and provider records use `QRPH_MOCK`.

## 7. `topup-webhook` status

The Edge Function is deployed and ACTIVE on the linked hosted project. The obsolete hosted function was removed. The new endpoint accepts provider callbacks, verifies the QR Ph mock secret, normalizes the event, and invokes the unchanged common `process_verified_topup` RPC. An unsigned live request returns HTTP 401. The existing local `.env` secret was synchronized to the hosted function without displaying it; a correctly signed callback with an unknown provider payment ID reached the database boundary and was safely rejected with HTTP 404.

## 8. Phase 3 migration status

No migration changes were made during QR Ph finalization. The schema was already provider-neutral: `provider`, `provider_payment_id`, `provider_reference`, `provider_paid_amount_centavos`, and `provider_paid_at`. Both Phase 1 and Phase 3 remain applied remotely, and a final dry run reports the remote database is up to date. Phase 3 migration SHA256 is `7C19BE197569751925A87361634165E6196770F6B8FAD38ABC7452F93248CA50`.

## 9. `/topup` UX status

Preserved and updated. The response is ephemeral, titled `QR PH TOP-UP`, shows exact PHP amount and 30-minute expiry, tells the member to scan with GCash, attaches an actual PNG QR, explains automatic verified credit, and contains no public announcement or other member data.

## 10. Tests passing

`pnpm test`: PASS — 142 tests across eight files. Existing exact-credit, correct-member, mismatch, late-payment, five-duplicate-callback, OWNER review, ADMIN read-only, wallet/ledger, QR attachment, and ephemeral-response tests remain green. New tests verify `TOPUP_PROVIDER=qrph_mock`, production mock rejection, and manual GCash cashout copy.

## 11. Typecheck

`pnpm typecheck`: PASS.

## 12. Lint

`pnpm lint`: PASS with zero warnings.

## 13. Build

`pnpm build`: PASS. Browser JavaScript is approximately 840.63 kB, 237.32 kB gzip. Vite's over-500-kB advisory remains nonfatal.

## 14. Browser-secret scan

`pnpm check:browser`: PASS across three built browser files. No configured server secrets, service-role keys, bot tokens, passwords, or QR Ph provider secrets were found.

## 15. Manual configuration still required

The existing local `.env` now has valid `TOPUP_PROVIDER=qrph_mock`, ₱100–₱100,000 limits, 30-minute expiry, and `QRPH_WEBHOOK_SECRET`. The same secret is configured on the hosted Edge Function. The three Discord variables exist but remain empty:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

`QRPH_API_KEY` remains empty and unused until an approved production QR Ph provider is selected. Never put these values in a `VITE_` variable or send them through chat.

## 16. Deployment steps

The migration, `topup-webhook`, provider selection, and webhook secret are already deployed. To finish the mock live flow:

1. Add `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` to the existing local `.env`.
2. Redeploy only if the function source changes: `supabase functions deploy topup-webhook --no-verify-jwt`.
3. Register the canonical guild command: `pnpm bot:register`.
4. Start the bot: `pnpm bot:start`.
5. Run `/topup amount:100`, confirm the ephemeral QR Ph PNG, and copy the top-up ID from Payments.
6. Run `pnpm topup:simulate success TOPUP_ID`; verify one ₱100 wallet credit, one TOPUP ledger entry, `PAID`, one audit event, and a private DM with no public fallback.
7. Repeat with documented mismatch, late, failure, and duplicate simulations as needed.

The live OWNER Payments dashboard was manually verified after finalization: authentication persisted, the page loaded successfully, filters rendered, and the empty state showed zero payment records. The future Cashouts page displayed the preserved manual GCash Phase 9 wording.

Phase 3 QR Ph finalization stops here. No Phase 4 code or schema was added.
