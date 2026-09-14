# Rampage — Phase 3 private QR Ph top-ups

Implemented directly in `C:\Users\Rodzel Te\Documents\Downloads\RampageBot`.
Phase 3 extends the working Phase 1 and Phase 2 foundation. The existing foundation is deployed,
the OWNER is bootstrapped, and the configured localhost application has been
smoke-tested with the existing OWNER session. Phase 1 tables, RLS, RPCs, money
helpers, and bootstrap remain intact. Phase 3 adds one additive migration and the
`topup-webhook` Edge Function.

## Local checks

Requires Node 22.12+ and pnpm 11.19.0.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:browser
```

Database tests execute the actual migration using PGlite (PostgreSQL compiled to
WASM). Tests provide a minimal Supabase Auth schema and JWT helpers, then exercise
real PostgreSQL grants, roles, RLS, constraints, triggers, and RPCs. SDK tests use
stub HTTP responses; they do not connect to Supabase or Discord. These checks do
not replace a migration rehearsal and Auth smoke test against your Supabase project.

## Supabase setup and data preservation

The following setup instructions apply to a new environment only. The current
project already has the Phase 1 migration and OWNER deployed. Do not rerun or
replace it. Apply the additive Phase 3 migration after reviewing it and taking a backup.

Before applying to an existing project, inspect its migration history and schema,
back up its data, and compare the five table names below and the isolated
`rampage_private` helper schema. Rehearse against a copy.
The initial migration uses `CREATE TABLE`, not `DROP`, destructive replacements,
or `CREATE TABLE IF NOT EXISTS` that could hide incompatibilities. A name collision
fails transactionally. If existing tables are discovered, stop and create an
explicit additive compatibility migration; do not rename/delete data to force
this migration through. Existing `auth.users` accounts are preserved and linked.

With Supabase CLI installed and authenticated:

```powershell
supabase link --project-ref YOUR_PROJECT_REF
supabase migration list
supabase db push --dry-run
# After the schema review and backup, apply the reviewed migration:
supabase db push
```

For local development with Docker and the Supabase CLI:

```powershell
supabase start
supabase migration up --local
```

Local `supabase/config.toml` disables public signup. For a hosted project, configure
email/password Auth and disable public signup in that project's Auth settings too;
the local configuration does not update hosted Auth settings.

## Required configuration and OWNER bootstrap

Use the existing `C:\Users\Rodzel Te\Documents\Downloads\RampageBot\.env` file for local configuration.
Use the Supabase **anon/publishable key** for browser variables. The service-role
key belongs only to trusted Node processes and must never be assigned to a `VITE_`
variable. Vite's client code imports only dashboard/shared modules. Vite rejects
service/secret keys in the public-key setting before serving or bundling them.

1. Create a confirmed email/password account for the owner using Supabase Auth's
   administrative user-management tools. No public registration/rank flow is added.
2. Set `OWNER_EMAIL` to that existing account's email. Optionally set
   `OWNER_DISCORD_USER_ID` to the owner's immutable Discord snowflake.
3. Apply the reviewed migration, then run:

```powershell
pnpm owner:bootstrap
```

The server script passes `OWNER_EMAIL` to a service-only RPC. The RPC matches the
existing confirmed Auth account, serializes competing bootstraps, links/creates
the OWNER profile, and appends an audit record. Rerunning for the same account is
idempotent. A different existing OWNER produces an error without modifying it.
Once bootstrapped, the OWNER cannot be disabled, demoted, reassigned, deleted, or
duplicated through normal application operations. The fresh schema has zero
owners **until this mandatory bootstrap succeeds**; do not operate it before then.
An ownership transfer/recovery workflow is outside this phase.

## Multiple ADMIN accounts and Discord mapping

Create each ADMIN's confirmed email/password account using Supabase Auth's
administrative tools. Set `STAFF_LOGIN_EMAIL` and `STAFF_LOGIN_PASSWORD` temporarily
to the active OWNER's credentials in the untracked `.env`. Then:

```powershell
pnpm staff:link-admin admin@example.com 123456789012345678
```

Remove those temporary login credentials from `.env` afterward. The CLI uses an
anon-key client signed in as the OWNER. The database RPC independently verifies
the OWNER. ADMIN profiles cannot call this RPC successfully themselves.

The Phase 2 owner administration UI uses these existing RPCs:

- `owner_set_admin(p_email, p_discord_user_id, p_active, p_reason)` links an existing
  account, enables/disables an ADMIN, and audits the change. A disable requires a
  reason. A null Discord argument preserves an existing mapping on update.
- `owner_set_staff_discord(p_staff_id, p_discord_user_id, p_reason)` assigns/replaces
  an OWNER or ADMIN's mapping; null explicitly clears it. A reason is mandatory.
  Discord IDs are unique across staff, including inactive profiles.

Users without active staff profiles cannot obtain a staff dashboard session,
even if Supabase Auth accepted their password. Discord staff authorization checks
the invoking `interaction.user.id` against the current active staff profile on
every call; Discord guild role labels and client metadata confer no privileges.
Future mutation RPCs must recheck the actor in the same transaction as the write.
Do not cache a successful authorization result for later financial writes.

## Dashboard

```powershell
pnpm dev
```

Open the Vite localhost URL. The dashboard reuses email/password sign in, server
session validation, login auditing, and local sign out. Supabase continues handling
persistence and token refresh. The Auth provider revalidates staff on auth events,
window focus/visibility, and once per minute while visible; rejected staff are
signed out. Database/RPC authorization is authoritative for every sensitive write.
An invalid or inactive staff account sees: "You are not authorized to access this dashboard."

| Route            | Access       | Behavior                                                                                       |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `/login`         | Public       | Existing staff email/password login                                                            |
| `/`, `/overview` | OWNER, ADMIN | Real Phase 1 counts and wallet liability; unavailable future metrics                           |
| `/members`       | OWNER        | Searchable, paginated member and wallet read view                                              |
| `/admins`        | OWNER        | Link existing Auth users, activate/disable admins, edit Discord mappings through existing RPCs |
| `/audit`         | OWNER        | Read-only audit history with date, source, action, and actor filters                           |
| `/settings`      | OWNER        | Non-secret application/timezone/environment information                                        |
| `/lobbies`       | OWNER, ADMIN | Phase 4 placeholder                                                                            |
| `/rampage`       | OWNER, ADMIN | Phase 8 placeholder                                                                            |
| `/payments`      | OWNER, ADMIN | Phase 3 placeholder                                                                            |
| `/cashouts`      | OWNER, ADMIN | Phase 9 placeholder                                                                            |
| `/autopost`      | OWNER, ADMIN | Phase 10 placeholder                                                                           |

Direct URL access is checked centrally by React Router guards. No client-provided
role is trusted. ADMIN liability visibility preserves the deployed Phase 1 staff
wallet read permissions; ADMIN never receives the OWNER administration/audit UI.
Financial and audit pages have no edit/delete controls. No fake members or
financial records are seeded. Browser history fallback is required if this Vite
app is later hosted on a static server; local Vite already supplies it.

Admin changes use `owner_set_admin` and `owner_set_staff_discord` with confirmation
dialogs and required reasons where applicable. Existing RPC auditing is reused,
including established `ADMIN_UPDATED` naming. The UI does not append a second audit
event. New ADMIN Auth accounts still must be created/invited and confirmed through
Supabase Auth before linking; no browser service credential or invite backend is added.

Overview wallet queries paginate past Supabase's default row cap and sum integer
centavos exactly before using the existing PHP formatter. Tables are paginated;
queries have loading/error/empty states and abort stale results on unmount.
Date displays and calendar filters use `APP_TIMEZONE` (default `Asia/Manila`).
Only the non-secret timezone, application name, and build environment are
explicitly exposed through Vite's application configuration; secrets remain in Node.

Run `pnpm check:browser` after building. It checks the built files against configured
private environment values and recognizable service keys without printing them.

## Phase 3 local top-up flow

Phase 3 uses `MockQrPhProvider` only. It generates a real PNG QR containing a
clearly marked `RAMPAGE-MOCK-QRPH` payload. Members scan the QR Ph code using GCash,
but the top-up integration is not modeled as a direct GCash API. Automatic production
payment confirmation still requires an approved QR Ph provider, production credentials,
and that provider's webhook documentation.

Set the Phase 3 values in the existing `.env`. Use a random secret of at least
16 characters for `QRPH_WEBHOOK_SECRET`, and set the same secret for the Edge
Function. Keep all Discord and provider secrets outside `VITE_` variables.

```powershell
# Apply the additive migration, then deploy the public HTTPS callback.
supabase db push
supabase secrets set TOPUP_PROVIDER=qrph_mock QRPH_WEBHOOK_SECRET=YOUR_RANDOM_SECRET
supabase functions deploy topup-webhook --no-verify-jwt

# Register the single canonical guild command and start the bot.
pnpm bot:register
pnpm bot:start
```

Manual success flow:

1. In Discord, run `/topup amount:100`. Confirm the response is ephemeral and
   includes the actual QR image.
2. Open Payments in the dashboard and copy the new top-up UUID.
3. Run `pnpm topup:simulate success TOPUP_UUID`.
4. Confirm the wallet gains exactly ₱100.00, Payments shows `PAID`, the audit log
   contains `TOPUP_PAID`, and the member receives a DM. Nothing is posted publicly.

Use `pnpm topup:simulate mismatch TOPUP_UUID 90` for an amount-mismatch review.
Use `pnpm topup:simulate failure TOPUP_UUID` for provider failure. For a late-payment
test, set `TOPUP_EXPIRY_MINUTES=1`, create the request, wait until it expires, then
run `pnpm topup:simulate late TOPUP_UUID`. Use `duplicate` to submit the same verified
event five times; the database credits once. Mock simulation refuses to run when
`NODE_ENV=production` or `TOPUP_PROVIDER` is not `qrph_mock`.

The bot expires stale pending records once per minute. Successful credits and
OWNER-approved reviews are claimed once for a private Discord DM. If DMs are
disabled, the credit remains committed, the failure is audited, and no public
message is used as fallback.

## Tables and RLS

| Table                 | Read access for authenticated users            | Writes                                                                                  |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `members`             | Own linked member row; active ADMIN/OWNER      | Trusted `ensure_member` RPC                                                             |
| `staff_profiles`      | Own profile; OWNER sees all                    | Service-only owner bootstrap; OWNER administration RPCs                                 |
| `wallets`             | Own linked wallet; active ADMIN/OWNER          | Zero wallet automatically created with member; no application balance write path        |
| `wallet_transactions` | Own linked history; active ADMIN/OWNER         | No application writer in Phase 1; immutable triggers protect updates/deletes/truncation |
| `audit_logs`          | Active OWNER only                              | Controlled RPCs append; immutable triggers protect updates/deletes/truncation           |
| `topups`              | Own future Auth-linked row; active ADMIN/OWNER | Trusted bot/webhook RPCs; OWNER-only review RPC; no direct application writes           |

Anonymous users have no access. Inactive staff lose privileged reads and RPC
access immediately, though they can still read their own staff profile. No
INSERT/UPDATE/DELETE/TRUNCATE policies or grants are provided to application
roles. Even service-role clients have no direct table write grants in this phase.
Database administrators remain trusted infrastructure operators.

Discord is the member identity. `ensure_member` atomically upserts by immutable
`discord_user_id`; an insert trigger creates exactly one zero wallet. The optional
unique `members.auth_user_id` supports own-row RLS if a verified member Auth link
is introduced later. No browser/Discord caller can assign that link. Discord
members do not need an Auth account or registration; the trusted adapter scopes
wallet reads to the invoking user's member ID. No member web login is added.

All money columns are `bigint` integer centavos bounded by JavaScript's safe-integer
range. Shared Zod validation rejects fractions, negatives, and unsafe integers;
the PHP parser converts decimal strings using BigInt rather than floating-point
rounding. PostgreSQL's bigint type is the storage guarantee; future RPCs must also
validate raw amounts before any cast (PostgreSQL can round numeric-to-bigint casts).
Ledger `amount_centavos` is the signed change in total wallet liability; a reserve
transfer has net zero with the movement preserved in before/after columns. Every
ledger entry has a unique idempotency key and must reconcile those values. There
is intentionally no wallet correction or other balance mutation API in Phase 1.

## Source structure

```text
src/dashboard/           Auth provider, router, shell, pages, query helpers
src/server/              Trusted clients, OWNER bootstrap, Discord identity/guards
src/shared/              Runtime schemas, integer money helpers, staff Auth client
scripts/                 OWNER bootstrap, ADMIN linking, browser bundle security check
supabase/migrations/     Versioned Phase 1 SQL
tests/                   SQL/RLS, SDK, dashboard routes/forms/data, money and bundle tests
```

Supabase integration follows the official [RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [email/password sign-in API](https://supabase.com/docs/reference/javascript/auth-signinwithpassword).

## Deferred work

Future phases: lobbies/bets, LIFO, settlement, Rampage functionality, cashouts,
referrals, autopost, realtime, and storage integration. No future-game or sportsbook
models are included.

Phase 9 cashout remains a separate manual GCash workflow using the member's GCash
account name and mobile number. The QR Ph top-up provider does not model cashouts.
#   R a m p a g e T e s t  
 
