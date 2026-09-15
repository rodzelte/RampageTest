# Phase 3 Patch Completion Report — Private Ephemeral QR Cleanup

## Status

Complete. The QR Ph image remains only in the invoking member's ephemeral
`/topup` response. Terminal payment states now try to replace that same response,
explicitly removing its attachment. Every successfully claimed paid top-up also
sends exactly one private Discord DM receipt. No Phase 4 code was added.

## Files changed

- `src/bot/commands/topup.ts`
- `src/bot/interactions/handleInteraction.ts`
- `src/bot/client/startBot.ts`
- `src/bot/notifications/topupNotifications.ts`
- `src/bot/notifications/topupEphemeral.ts` (new)
- `tests/topup.test.ts`
- `tests/topup-ephemeral.test.ts` (new)
- `tests/database.test.ts`
- `README.md`
- `PHASE3_EPHEMERAL_QR_PATCH_REPORT.md` (new)

No `.env.example` was created or modified. The application continues to use only
`C:\Users\Rodzel Te\Documents\Downloads\RampageBot\.env`.

## Implementation approach

`/topup` still defers its original reply with `MessageFlags.Ephemeral`, attaches
the generated QR PNG only to that reply, and creates no channel message, normal
reply, or follow-up. After sending the QR, the bot keeps a short-lived interaction
editor in an in-memory map keyed by top-up UUID. The map is process-local, expires
entries after 35 minutes, and is never written to Supabase.

The Supabase Realtime listener now processes every relevant terminal top-up state:

- `PAID` and OWNER-approved `RESOLVED` replace the QR with a payment confirmation.
- `EXPIRED` replaces it with the QR-expired notice.
- `FAILED` replaces it with the failure notice.
- `AMOUNT_MISMATCH_REVIEW` and `LATE_PAID_REVIEW` replace it with the matching
  private review notice.
- Rejected reviews close the private response without exposing financial data.

Every terminal edit sends `attachments: []` and `files: []`, which explicitly
removes the original QR image. The registry consumes the handle before attempting
the edit so repeated events cannot reuse it.

Paid notification claiming remains a durable, idempotent database operation.
Concurrent Realtime deliveries share one in-flight ephemeral edit result. The bot
then claims the private notification once and always sends exactly one private DM,
regardless of whether the ephemeral edit succeeded, failed, or was unavailable. The
DM contains the credited amount, PAID status, available balance, provider reference,
and Asia/Manila payment time without attaching the QR. The edit and DM results are
never passed to payment processing and cannot change the top-up, wallet, ledger, or
authoritative payment status. A bot restart intentionally loses interaction handles;
startup catch-up delivers any unclaimed paid notification by private DM.

No code posts QR images, amounts, balances, payment references, or payment status to
a public Discord channel. Browser code receives no Discord interaction handle,
interaction token, bot token, or provider secret.

## Database and security impact

No migration, table, column, RPC, trigger, or RLS policy changed. Discord interaction
tokens and message handles are not persisted. The Phase 3 migration hash remains:

`7C19BE197569751925A87361634165E6196770F6B8FAD38ABC7452F93248CA50`

The existing database protections remain authoritative: unique provider payment
IDs, provider event idempotency, locked terminal transitions, wallet row locks,
exact integer-centavo comparison, and deterministic TOPUP ledger idempotency. The
existing five-duplicate-callback database test still proves one exact ledger credit.

## Tests added

Thirteen tests were added in `tests/topup-ephemeral.test.ts`, covering:

1. QR attachment removal and exact private content for `PAID`.
2. QR attachment removal for `EXPIRED`.
3. QR attachment removal for `FAILED`.
4. QR attachment removal for `AMOUNT_MISMATCH_REVIEW`.
5. QR attachment removal for `LATE_PAID_REVIEW`.
6. Successful paid replacement plus the required private DM receipt.
7. DM receipt fields, provider reference, Manila payment time, and absence of QR.
8. Expired/rejected interaction behavior without mutating the payment object.
9. Private DM delivery after the ephemeral edit fails.
10. DM failure recording without affecting the successful ephemeral edit or payment.
11. Coalesced ephemeral edits and once-only paid notification behavior across
    concurrent terminal events.
12. No wallet mutation RPC from the Discord presentation handler.
13. No notification RPC or public-channel API for expired, failed, or review-only
    presentation updates.

The existing `/topup` privacy test was strengthened to verify the ephemeral flag,
the real QR PNG attachment, the in-memory handle, and zero calls to `reply`,
`followUp`, or `channel.send`. The existing PostgreSQL duplicate-webhook test sends
five identical callbacks and still verifies exactly one wallet credit and one TOPUP
ledger entry.

## Verification results

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS with zero warnings
- `pnpm test`: PASS — 155 tests across 9 files
- Focused top-up tests: PASS — 29 tests across 2 files
- `pnpm build`: PASS — Vite's existing nonfatal large-chunk advisory remains
- `pnpm check:browser`: PASS — 3 browser build files contain no private environment
  values or service keys

The automated suite uses stub Discord/Supabase clients and PGlite. It does not send
real Discord messages or alter the hosted database.

## Manual test steps

1. Start the bot with `pnpm bot:start`.
2. From a Discord member account, run `/topup amount:400`.
3. Confirm only the invoking account sees the ephemeral QR, amount, and status, and
   confirm the channel receives no message.
4. Copy the top-up UUID from the OWNER/ADMIN Payments page and run
   `pnpm topup:simulate success TOPUP_UUID`.
5. Confirm the original ephemeral response has no QR attachment and now shows
   `PAYMENT RECEIVED`, `₱400.00`, `PAID`, and the credited message. Confirm the bot
   also sends exactly one private success DM containing the amount, PAID status,
   wallet credit, provider reference, and Manila payment time without a QR.
6. Confirm Payments shows `PAID`, the wallet increased once by 40,000 centavos, and
   one TOPUP ledger entry exists. Re-run the duplicate simulation and confirm those
   values do not increase again.
7. Repeat with `failure`, `mismatch`, and `late` simulations and confirm each original
   ephemeral QR is replaced by its private terminal/review notice with no wallet
   credit for the review cases.
8. For the unavailable-handle fallback, create a pending top-up, restart the bot so
   its process-local handle is gone, then simulate success. Confirm settlement and
   wallet credit still succeed, the member receives a private DM, a generic UI update
   warning is logged, and nothing appears in a public channel.

## Deferred work

Phase 4 remains untouched. Lobby betting, future-game abstractions, LIFO, Rampage
changes, cashout, and unrelated later-phase work remain deferred.
