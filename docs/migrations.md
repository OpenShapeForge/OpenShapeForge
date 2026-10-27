# Schema: build, migrate, reset

An empty database is **built** from the compiled manifest —
`packages/compiler/config/platform-schema.yaml` plus the authoring layers,
compiled to `apps/api/src/generated/db/schema.sql`. A built database is
**migrated** to a newer manifest: the versioned migrations it has not run
yet transform it, and the additive roll-forward adds what remains. A
disposable development database may instead be **reset**: dropped and built
again. Three commands do this, and all three run the same chain under the
same advisory lock (`apps/api/src/db/bootstrap.ts`):

| | what it does |
| --- | --- |
| `bun run db:migrate` | Builds an empty database; carries a built one forward (pending versioned migrations, then the additive roll-forward); refuses drift that is neither. Re-applies the invariants and re-runs the seeds every time. |
| `bun run db:reset` | Development only. Drops the migrate URL's database `with (force)`, recreates it, and builds it. Destroys every row — see below for what it refuses. |
| API first start | Outside production, an API that finds an **empty** database builds it through `OPENSHAPEFORGE_MIGRATE_DATABASE_URL` before serving (`roles/api-readiness.ts`). |

A database whose data matters — any deployed environment — is only ever
migrated. Every schema change that the roll-forward cannot apply on its own
therefore ships with a versioned migration in the same change
([below](#versioned-migrations)); `db:reset` is the development shortcut, not
the upgrade path.

There is exactly **one declared source of truth per table**: the manifest.
The runtime-owned platform bookkeeping (`platform.identities`,
`platform.identity_relations`, `platform.employee_invitations`,
`platform.update_notices`, `platform.operation_execution_receipts`, the
blueprint tables, `platform.system_bypass_audit`, …) is declared in
`platform-schema.yaml` like every other table. What the manifest cannot
express — check constraints, foreign keys over anything but a tenant pair,
expression indexes, functions, triggers, `SECURITY DEFINER` ownership and
every bespoke row-level policy — lives in idempotent DDL under
`apps/api/src/db/migrations/`, applied after the generated step on every run.
Nothing there creates a table.

## The chain

`apps/api/src/db/migration-chain.ts`, on a single connection, serialized
across replicas with `pg_advisory_lock` and a bounded 5s `lock_timeout` for
the DDL itself:

**Verify**

0. **Role contract** — every declared database role exists
   (`db/database-roles.ts`) with `LOGIN` / `NOSUPERUSER` / `NOBYPASSRLS` as
   declared, and the migrate role is a member of the definer roles. Roles are
   cluster-wide; the host provisions them (`bun run db:provision-roles`), the
   chain never creates one. The two restricted login roles then get `CONNECT`
   and their default privileges.

**Create / migrate**

1. **App helpers** — the `app` schema and the RLS helper functions every
   policy references.
   - **Versioned migrations** — on a built database, the registered
     migrations its ledger does not hold yet, in order, each in its own
     transaction with its ledger row (`migrations/versioned-runner.ts`).
     Nothing on an empty database.
2. **Generated schema** — `schema.sql`: every table, index, generated policy
   and foreign key, from the one declaration. A key into a tenant-scoped
   table is always `(tenant, column) -> (tenant_id, id)`; the compiler
   refuses any other shape (`packages/compiler/src/tenant-bound-references.ts`).
   On a built database this is the checksum no-op, the roll-forward, or the
   refusal (below).
3. **Invariants** — plain idempotent DDL, no ledger, no version:
   - `core-invariants.ts`: the org-unit closure trigger, the document
     authority guards and tenant-qualified compound keys, the logical
     document commands (`document_internal.*`), the artifact binding;
   - `identity-link.ts`, `employee-invitations.ts`, `capability-grants.ts`,
     `organization-relation-link.ts`, `update-notices.ts`,
     `operation-execution-receipts.ts`, `blueprints.ts`: the checks,
     expression indexes, functions and policies of the runtime tables;
   - compiler-plugin invariants (`generated-plugin-migrations.ts`): a
     plugin's `constraints` (rendered by the compiler as name-guarded DO
     blocks) and its free-form `schemaMigrations`, which the plugin must
     write idempotently — every registry entry runs on every migrate, in
     plugin-then-version order, each in its own transaction, and nothing
     records that it ran;
   - compiler-owned value checks, through the same registry under
     `osf-compiler` (`authoring/field-value-checks.ts`): `CHECK (col IN (...))`
     for a single-valued field whose `options` are static items, and
     `CHECK (col ~ '<pattern>')` for a `validation.pattern` PostgreSQL reads
     the way ECMA-262 does (no lookarounds, backreferences, `\b`, unicode
     escapes or lazy quantifiers — those stay runtime-only). Text columns
     only; a referentiedata options source is data, not schema. Each is named
     `<table>_<column>_options_check` or `_pattern_check`, and is reconciled
     by definition on a carried-forward database
     ([below](#compiler-rendered-constraints)).
4. **Grants** — the app role's whole-schema DML sweep, the blueprint
   re-narrowing, then the worker role's enumerated grants, re-evaluated from
   the manifest on every run.

**Seed**

5. **Catalog seeds** — the entity page configs and every seed a loaded
   runtime module contributes, in registration order. Data, not DDL; each is
   skippable (a checksum over the row set), authoritative (rows the seed no
   longer describes are deleted), and optional (absent seed, no-op).

## Database roles: declared, provisioned, verified

Postgres roles are cluster-wide; the chain is per database and runs as the
migrate role, which on a managed instance has neither `SUPERUSER` nor
`CREATEROLE`. So the chain never creates a role. The compiler declares the
roles the generated schema depends on in `apps/api/src/generated/db/manifest.json`
under `databaseRoles` — the runtime login role, the worker login role and the
`nologin` definer roles that own the cross-tenant blueprint read function, the
identity-registry point lookups and the record-action lookup — and step 0
verifies them, failing *before any schema exists* with the exact administrator
statements that satisfy the contract.

A definer role exists so one function can read what its caller may not, and
owns nothing else. `openshapeforge_record_action_resolver` is the narrowest of
them: per entity that declares a record action it holds column-level `SELECT`
on the key, the tenant column, the ACL column and that action's declared read
fields, plus the `UPDATE` privilege `SELECT … FOR SHARE` requires behind a
`WITH CHECK (false)` policy — so it may lock an ACL row to serialize a check
against a concurrent policy change, and may never write one. Its two functions
are not executable by the worker connection or by `PUBLIC`. Adding a role is a
host provisioning step: `db:provision-roles` before the next `db:migrate`, or
step 0 refuses the chain and names the statements.

```sh
OPENSHAPEFORGE_ADMIN_DATABASE_URL=postgres://admin:...@host/db \
OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://migrator:...@host/db \
  bun run db:provision-roles          # once per cluster; then db:migrate
bun run db:provision-roles -- --print # render the statements for an operator
```

Login roles are created with `OPENSHAPEFORGE_APP_PASSWORD` and
`OPENSHAPEFORGE_WORKER_PASSWORD`; existing roles are never altered unless an
operator explicitly rotates them with `*_PASSWORD_ROTATE=1 bun run
db:provision-roles` through the administrator connection.
Locally and in CI the migrate role owns the instance, so the migrate URL
doubles as the administrator connection when no admin URL is set.

## `db:reset` (development)

A development or task database holds disposable rows; rebuilding it from
the manifest is often quicker than writing the versioned migration a
branch's work-in-progress schema would need. A deployed database is never
reset.

```sh
OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://migrator:...@host/openshapeforge_dev \
OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION=openshapeforge_dev \
  bun run db:reset
```

`apps/api/src/db/reset.ts` refuses, before touching anything:

- under `NODE_ENV=production` — a production database is reset with the
  provider's tooling, never by a script that happens to hold its credentials;
- without `OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION`, or with one that does
  not name the target database exactly — a value copied from another
  environment's job spec must not authorise a reset here;
- when the target is a maintenance or template database.

`DROP DATABASE` cannot run from inside the database being dropped, so the
drop and create go through a maintenance connection: the administrator URL
(`OPENSHAPEFORGE_ADMIN_DATABASE_URL`, or the migrate URL where the migrate
role owns the instance) re-pointed at `postgres`
(`OPENSHAPEFORGE_RESET_MAINTENANCE_DATABASE` names another). A managed
instance whose administrator cannot reach one drops and creates the database
with the provider's API and then runs `db:migrate`, which on the empty
database is the same build. Roles are untouched; the chain re-grants
`CONNECT`, which a managed provider clears when a database is recreated.

A reset destroys everything the database held, including what it held *for
other systems*: the identity links a Keycloak account resolves through, the
blueprint copies other tenants recorded, the seed ledgers a host keeps. Reset
the paired systems with it, or expect identities to re-link on next sign-in.

## The empty-database bootstrap

`bootstrapIfEmpty` (`apps/api/src/db/bootstrap.ts`) runs the chain if, and
only if, the database has no generated-schema record **and** no table at all
in a manifest-covered schema. A database that was built from another
manifest, and one carrying tables without a record — another branch's, a
legacy layout — are both left for `db:reset`. Both probes run
again under the lock, so a second replica finds the database built rather
than building it twice.

The API's startup check calls it outside production when the database is
unmigrated and `OPENSHAPEFORGE_MIGRATE_DATABASE_URL` names the **same**
database as `DATABASE_URL` — a migrate URL left over from another setup can
never build into somewhere else. In production an unmigrated database refuses
to serve; the schema is the deploy's responsibility there.

## The checksum: build, no-op, roll forward, or refuse

`apps/api/src/db/migrations/generated-schema.ts` records the applied
manifest checksum in `platform.schema_migrations` under
`0001_generated_platform_schema`. On every run:

- **No record, and no table in any manifest-covered schema** → build: apply
  `schema.sql`, record the checksum, and record every registered versioned
  migration as applied (the *baseline*: the manifest already has the shape
  they transform towards) — all in one transaction.
- **No record, but tables in a covered schema** → refuse, listing them.
  `schema.sql` is `CREATE … IF NOT EXISTS` throughout, so applying it over
  leftovers — a legacy layout, another branch's build, a declared table
  someone created by hand — would stamp the checksum onto a database nobody
  verified.
- **Checksum equal, nothing undeclared** → no-op for the generated step; the
  invariants, grants and seeds that follow still run, because they are the
  idempotent parts.
- **Checksum equal, but a table or column the manifest does not declare** →
  refuse, listing it. One declared source of truth per table, whatever the
  checksum says.
- **Checksum differs** → diff the bundled manifest against the live
  `information_schema` (tables and columns of every covered schema) and
  classify every difference.

**Additive — applied automatically, in one transaction with the new
checksum:**

- a manifest table missing from the database;
- a manifest column missing from an existing table, when Postgres can add it
  without a backfill: it is nullable, **or** has a default, **or** is an
  identity column, **or** the table has no rows.

The roll-forward runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for each
missing column, re-applies the idempotent `schema.sql` (new tables and
indexes, refreshed RLS policies, guarded foreign keys) and records the new
checksum. `db:migrate` reports what it added under `rollForward`.

**Non-additive — refused with the exact listing, nothing changed:**

- a required, no-default, non-identity column missing from a table **with
  rows** (it needs a backfill);
- a primary-key column missing from an existing table;
- a column or table in the database that the manifest does not declare (a
  dropped or renamed field);
- a type, nullability, identity or default mismatch on a column both sides
  have;
- a manifest column type with no known `information_schema` mapping.

Defaults are compared in Postgres' own spelling: the manifest's default
expressions are declared on a temporary table and read back, so `'x'` and
`'x'::text`, or a jsonb literal with re-ordered keys, compare as the same
default without any hand-written normalisation.

What the diff does **not** see is a changed object under an unchanged name: an
index, a generated policy expression or a foreign key's column set.
`schema.sql` guards those by name, so the roll-forward leaves the old one in
place (policies excepted — they are dropped and re-created on every apply).
Such a change needs a versioned migration that drops the old object; the
roll-forward then creates the new one.

## Versioned migrations

For everything the roll-forward refuses — renames, retypes, backfills, drops,
data moves — and for a changed index or key:

```sh
bun run db:migration:new <kebab-name>     # e.g. split-relation-address
```

The scaffolder (`apps/api/src/db/migrations/new-migration.ts`) writes the next
file under `apps/api/src/db/migrations/versioned/` and registers it in
`versioned/index.ts`. Implement `up(db)` with Kysely or raw SQL, then run
`bun run db:migrate`.

- **Numbering** — `NNNN_kebab-name`, strictly ascending, from **0016**: 0001 is
  the generated-schema record, and 0002–0015 belong to the chain retired in
  e91ad87a, whose ledger rows older databases still hold.
- **Order** — versioned migrations run *before* the generated step, against
  the database as it was, so `up()` transforms it until the remaining diff is
  additive (or nothing). A rename is `ALTER TABLE … RENAME COLUMN`, not a
  dropped and an added column, and the rows survive.
- **Only on built databases** — a fresh build records the whole registry as
  applied without running it. `up()` therefore never needs to cope with an
  empty database, and never runs on one.
- **Immutability** — each applied migration records the sha256 of its source
  file; editing an applied file fails every later run. List a previous hash in
  `supersededChecksums` only for an edit that cannot have changed what the
  migration did (a licence header, a comment), and say which commit caused it.
- **Atomic** — each `up()` runs in its own `BEGIN`/`COMMIT` with its ledger
  row and is rolled back as a unit on failure.
- **Tested** — a migration ships with a test that builds a database, puts it
  in the shape the previous manifest produced (rows included), and runs the
  chain with the migration registered: see "a versioned migration settles a
  rename the roll-forward refuses" in `src/db/__tests__/migrations.test.ts`.
- Tables belong in the authoring YAML; a migration transforms what the
  manifest declares, it never declares schema of its own.

## Compiler-rendered constraints

The compiler's constraints (options, pattern and requires checks, entity-value
checks, the tenant-identity check) reach the database through the plugin
migration registry as DO blocks guarded by constraint **name**. On a carried
forward database that is not enough: an options list that gains a value keeps
its name, and an entity-value check is renamed by the digest of its
definition. `generated-plugin-migrations.ts` therefore recognises each
rendered block and:

- reconciles a CHECK by definition (`ensureCheckConstraint`: a rolled-back
  `NOT VALID` probe gives Postgres' canonical form; only a difference pays the
  drop-and-revalidate);
- marks every recognised constraint with the comment
  `osf:plugin-constraint:<plugin>`;
- drops a marked constraint no entry renders any more, after the new ones
  are in place, and reports it under `pluginConstraintsRemoved`.

A narrowed value set that existing rows violate fails the re-add and leaves
the old constraint in place: settle the rows in a versioned migration first.
A test asserts that every `osf-compiler` registry entry is recognised, so a
renderer change cannot silently stop the reconciliation.

## Drift signals

Two independent tripwires compare the database's recorded checksum against
the manifest bundled with the running code (`apps/api/src/db/schema-drift.ts`
— statuses `ok` / `behind` / `unmigrated`), and `findUndeclaredDatabaseSchema`
answers the question the checksum cannot: is the database behind, or is it
another branch's?

- **API startup** (`roles/api-readiness.ts`, on `onReady`, 5s timeout):

  | | empty | behind / foreign | check unverifiable |
  | --- | --- | --- | --- |
  | **production** | fatal | fatal | fatal |
  | **development** | bootstrapped (same-database migrate URL) | warning banner naming `db:migrate` (or a versioned migration / `db:reset` for foreign schema), keeps serving | error log, keeps serving |

  In production the Helm migrate Job runs before new pods roll, so a pod only
  sees a behind database when that Job failed.

- **Readiness** (`/api/ready`): the schema check raises
  `GENERATED_SCHEMA_BEHIND`, `GENERATED_SCHEMA_UNMIGRATED` or — on a
  matching checksum with a table or column beside the manifest —
  `GENERATED_SCHEMA_FOREIGN`; nothing else about the schema gates readiness.

- **e2e preflight** — `schema-drift.e2e.test.ts` fails the suite fast with
  the recorded vs bundled checksums and the remediation that fits:
  `db:migrate` for an empty database or one that is behind, and a scratch
  database for one that carries schema the branch does not declare — that
  one is someone else's build.

## Caveats

- **A partial schema is foreign schema.** Every table and every column in a
  manifest-covered schema must be in the manifest; there is no exemption
  list, at either level. A plugin that needs a column on a generated table
  declares it in the manifest (an `entityPatch` layer or
  `contributePlatformTables`), not in free-form DDL.
- **Plugin `schemaMigrations` are invariants, not history.** They run on
  every migrate. A bare `CREATE FUNCTION` or `ADD CONSTRAINT` fails on the
  second run, is rolled back, and is named in the error; write
  `CREATE OR REPLACE`, `IF NOT EXISTS`, or a guarded DO block.
- **A matching checksum is not the whole story.** A column added with
  `psql` keeps the recorded checksum; the chain, the e2e preflight, the
  API's startup check and `/api/ready` all run the undeclared-schema probe
  (`findUndeclaredDatabaseSchema`) on a matching checksum as well, so it is
  refused or reported rather than carried along. (`bootstrapIfEmpty` never
  sees a matching checksum: it stops at "migrated" and leaves the probe to
  the startup check that called it.) What none of them see on a matching
  checksum is a *declared* object altered in place — a retyped column, a
  rewritten generated index: the column diff runs only when the checksum
  moves, and nothing compares indexes at all.

`(cd apps/api && bun test src/db)` exercises the chain — build, no-op, the
additive roll-forward and its refusals, versioned migrations and their
baseline, constraint reconciliation, the one-source-of-truth invariant, the
hand-written `CHECK` replacement, `db:reset` and the bootstrap — against
throwaway scratch databases ([testing.md](testing.md#migration-tests)).
