# Phase 4 Schema Compatibility Report

## Why `financial_commitment_at` already existed

The linked hosted Supabase project already recorded migration `20260915000200` as
applied. Live schema inspection also confirmed `lobbies.financial_commitment_at`, the
other Phase 4 patch columns, and `join_lobby_self` were present. Executing the original
patch SQL again therefore reached its unconditional `ADD COLUMN
financial_commitment_at` statement and PostgreSQL correctly returned `42701`.

The original applied migration was not changed or reapplied. Its SHA-256 remains:

`8417E3B445F4B02A3E27205B2C212FE5032F9210DBC7FA4C934D7C83F3845832`

## Compatibility change

Added and deployed:

`supabase/migrations/20260915000300_phase4_schema_compatibility.sql`

It uses `ADD COLUMN IF NOT EXISTS` for additive Phase 4 lobby and roster columns. It
uses `DROP CONSTRAINT IF EXISTS` before recreating the named audit-source, lobby-status,
side-bet configuration, Discord snowflake, roster-source, and roster-removal-evidence
checks.

The compatibility migration also safely:

- restores the `DASHBOARD` default and NOT NULL requirement for `added_source`;
- backfills missing source metadata on compatible existing roster history;
- backfills `financial_commitment_at` from the earliest roster participation;
- retains the side-bet minimum participation-floor rule;
- retains all lobby lifecycle, Discord ID, source, and removal-evidence checks;
- performs no DROP TABLE, DROP COLUMN, DELETE, wallet update, ledger update, or audit
  deletion.

The PGlite database harness applies this compatibility migration twice. Both executions
succeed, proving that already-existing additive columns and named constraints are
handled safely.

## Hosted status

- `20260915000200`: already applied; not reapplied.
- `20260915000300`: applied successfully.
- `supabase migration list`: local and remote histories match.
- `supabase db push --dry-run`: remote database is up to date.
- Hosted schema lint: no errors.

## Quality gates

- `pnpm test`: 219 tests passed in 11 files.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm build`: passed.
- `pnpm check:browser`: passed.

No Phase 5 functionality was added.
