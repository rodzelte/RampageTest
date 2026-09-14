# Phase 1 implementation report

Date: 2026-09-14

Project: `C:\Users\Rodzel Te\Documents\Downloads\RampageBot`

Status: **Phase 1 implemented and verified locally. Remote Supabase deployment and
OWNER bootstrap are pending configuration. Phase 2 has not started.**

The repository folder was empty on both inspections. There were no existing
migrations, data files, working components, or KEEP classifications available.
All project work was performed inside the requested RampageBot folder; no second
project folder or checkout was created. No real secrets were added.

## 1. Files changed

All 33 project files below are new. Dependency installs also generated ignored
`node_modules/`; the verification build generated ignored `dist/`.

```text
.env (local, gitignored configuration)
.gitignore
.prettierignore
.prettierrc.json
eslint.config.js
index.html
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.json
vite.config.ts
vitest.config.ts
README.md
PHASE1_REPORT.md
scripts/bootstrap-owner.ts
scripts/link-admin.ts
src/dashboard/App.tsx
src/dashboard/client.ts
src/dashboard/main.tsx
src/dashboard/style.css
src/server/bootstrap-owner.ts
src/server/clients.ts
src/server/discord-auth.ts
src/shared/models.ts
src/shared/money.ts
src/shared/public-key.ts
src/shared/staff-auth.ts
supabase/config.toml
supabase/migrations/20260914000100_phase1_foundation.sql
tests/database.test.ts
tests/integration.test.ts
tests/money.test.ts
tests/public-key.test.ts
```

## 2. Migrations

Added `20260914000100_phase1_foundation.sql`. No prior migrations were modified.
The migration creates the five tables, the isolated `rampage_private` helper
schema, indexes, immutable-history/identity triggers, RLS, restricted grants, and
seven public RPCs. It runs transactionally and fails on existing object collisions
instead of overwriting unknown structures. Tested locally using PGlite; it has
not been applied to a hosted Supabase project.

Public RPCs:

- Service-only: `ensure_member`, `bootstrap_owner`, `authorize_discord`.
- Authenticated staff: `get_staff_session`, `record_staff_login`.
- Authenticated OWNER only, checked inside the database: `owner_set_admin`,
  `owner_set_staff_discord`.

## 3. Tables

| Table                 | Foundation behavior                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `members`             | Unique immutable Discord ID; no rank or registration; optional protected Auth linkage                             |
| `staff_profiles`      | Existing Supabase Auth account linkage; one active OWNER; multiple ADMINs; active flag and unique Discord mapping |
| `wallets`             | One zero-initialized wallet per member; nonnegative safe-integer bigint available/reserved centavos               |
| `wallet_transactions` | Append-only ledger structure, before/after values, reconciliation constraint, unique idempotency key              |
| `audit_logs`          | Append-only actor/source/action/reason history for bootstrap, staff login, ADMIN changes, and Discord mappings    |

No application role receives direct balance editing or ledger insertion privileges.
No money mutation RPC was added. Member creation and zero-wallet creation are atomic.

## 4. RLS policies

All five tables have RLS enabled. All policies are SELECT-only:

| Policy                            | Scope                                       |
| --------------------------------- | ------------------------------------------- |
| `members_read_self_or_staff`      | Own Auth-linked member; active ADMIN/OWNER  |
| `staff_read_self_or_owner`        | Own staff profile; active OWNER sees all    |
| `wallets_read_self_or_staff`      | Own Auth-linked wallet; active ADMIN/OWNER  |
| `transactions_read_self_or_staff` | Own Auth-linked history; active ADMIN/OWNER |
| `audit_read_owner`                | Active OWNER only                           |

Anonymous access is denied. No application role, including the service role, has
direct table write grants. Privileged RPC permissions and live staff state are
checked server-side. An ADMIN cannot promote themselves, manage staff, bootstrap
an OWNER, or read full audit logs. Disabling staff immediately removes privileged
RPC/read access. Discord staff checks use `interaction.user.id`, never guild roles.

The browser uses only a public key. Runtime configuration and a pre-bundle Vite
guard reject service/secret keys in the public-key setting. Shared models contain
no service credentials; server modules are excluded from browser imports.

## 5. Tests added

66 test cases across four files:

- Database: 26 cases exercising the actual SQL migration, member uniqueness,
  identity immutability, zero wallets, bigint bounds, suspended members, OWNER
  uniqueness/conflicts/idempotency/protection, multiple ADMINs, owner-only RPCs,
  inactive staff, mappings, login auditing, RLS isolation, write restrictions,
  append-only history triggers, and ledger idempotency.
- Supabase SDK integration: 15 cases for email/password login, token verification,
  active staff validation, login audit failures, logout after rejection, Discord
  invoking-user routing, and OWNER_EMAIL bootstrap configuration/conflicts.
- Money: 18 cases for exact decimal parsing, integer validation, bounds, and PHP
  formatting without floating-point rounding.
- Public-key validation: 7 cases accepting anon/publishable keys and rejecting
  service/secret or malformed keys.

Database tests use real PostgreSQL behavior through PGlite with a small mocked
Supabase Auth schema/JWT interface. SDK tests use stub HTTP responses. Hosted
Supabase Auth, PostgREST, email delivery, and multi-connection concurrency were
not exercised. Database locking and uniqueness protections are implemented but
should also be verified in a Supabase staging rehearsal before live use.

## 6. Verification results

| Check                                 | Result                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm typecheck`                      | PASS                                                                             |
| `pnpm lint`                           | PASS; zero warnings                                                              |
| `pnpm test`                           | PASS; 66/66, four files                                                          |
| `pnpm build`                          | PASS                                                                             |
| `pnpm peers check`                    | PASS; no peer dependency issues                                                  |
| Deliberately invalid public-key build | Correctly rejected before bundling                                               |
| Browser bundle scan                   | No server-role configuration, server source paths, or test-secret sentinel found |

The build emits a nonfatal chunk-size advisory: approximately 524 kB JavaScript
before gzip, 149 kB after gzip. UI bundle splitting is left for dashboard work.
TypeScript was pinned to the compatible 6.0 release line to resolve the linter's
peer dependency constraint. Only esbuild's dependency build script is allowlisted.

## 7. Existing-data and deployment concerns

No existing local application data was found or changed. No live database was
connected, so remote schema compatibility cannot be asserted. Before deployment,
review Supabase migration history, inspect table/schema collisions, back up data,
and rehearse the migration. If compatible legacy structures exist remotely, add
an explicit compatibility migration after inspecting them; do not overwrite them.

OWNER bootstrap requires an existing confirmed email/password Supabase Auth
account matching `OWNER_EMAIL`. The script does not create Auth accounts or a
second OWNER. It fails safely on conflicts and missing accounts. The fresh schema
has zero owners until the mandatory bootstrap succeeds; afterward constraints
and triggers preserve exactly one active OWNER through normal application use.

ADMIN accounts are provisioned through Supabase Auth's administrative tools, then
linked through the owner-authenticated CLI or OWNER RPC. No public signup flow was
added. Configure hosted Auth signup settings explicitly; local Supabase config
does not change hosted Auth configuration. Detailed setup is in `README.md`.

No `.env` with real values was created, no OWNER account was bootstrapped remotely,
and no Discord command registration or production login was performed.

## 8. Intentionally left for Phase 2 and later

Phase 2: dashboard layout, role-specific routes, overview, management screens,
OWNER ADMIN-management UI, and OWNER audit UI. Only the requested Phase 1
email/password sign-in/session/sign-out screen exists now.

Later phases: bot command runtime/registration, QR Ph top-up, lobby betting,
LIFO, settlement, Rampage behavior, cashout, referral, autopost, realtime, and
storage integration. No sportsbook or future-game abstractions were added.
