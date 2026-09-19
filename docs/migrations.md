# Schema: the reset model

The schema is versioned by git. A database is **built** from the compiled
manifest — `packages/compiler/config/platform-schema.yaml` plus the authoring
layers, compiled to `apps/api/src/generated/db/schema.sql` — and never
migrated through a hand-written history. Three commands do the building, and
all three run the same chain under the same advisory lock
(`apps/api/src/db/bootstrap.ts`):

| | what it does |
| --- | --- |
| `bun run db:migrate` | Builds an empty database; on a built one with the same manifest checksum, re-applies the invariants and re-runs the seeds; on any other built one, refuses. |
| `bun run db:reset` | Drops the migrate URL's database `with (force)`, recreates it, and builds it. Destroys every row — see below for what it refuses. |
| API first start | Outside production, an API that finds an **empty** database builds it through `OPENSHAPEFORGE_MIGRATE_DATABASE_URL` before serving (`roles/api-readiness.ts`). |

There is exactly **one declared source of truth per table**: the manifest.
The runtime-owned platform bookkeeping (`platform.identities`,
`platform.identity_relations`, `platform.employee_invitations`,
`platform.update_notices`, `platform.operation_execution_receipts`, the
blueprint tables, `platform.system_bypass_audit`, …) is declared in
`platform-schema.yaml` like every other table. What the manifest cannot
express — check constraints, compound and cross-module foreign keys,
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

**Create**

1. **App helpers** — the `app` schema and the RLS helper functions every
   policy references.
2. **Generated schema** — `schema.sql`: every table, index, generated policy
   and single-column foreign key, from the one declaration. On a built
   database this is the checksum no-op, or the refusal (below).
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
     `<table>_<column>_options_check` or `_pattern_check`; a changed options
     list changes the manifest checksum, so a built database is rebuilt
     rather than left with a stale CHECK.
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
`nologin` definer role that owns the cross-tenant blueprint read function —
and step 0 verifies them, failing *before any schema exists* with the exact
administrator statements that satisfy the contract.

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

## `db:reset`

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

## The checksum: build, no-op, or refuse

`apps/api/src/db/migrations/generated-schema.ts` records the applied
manifest checksum in `platform.schema_migrations` under
`0001_generated_platform_schema`. On every run:

- **No record, and no table in any manifest-covered schema** → build: apply
  `schema.sql`, record the checksum.
- **No record, but tables in a covered schema** → refuse, listing them.
  `schema.sql` is `CREATE … IF NOT EXISTS` throughout, so applying it over
  leftovers — a legacy layout, another branch's build, a declared table
  someone created by hand — would stamp the checksum onto a database nobody
  verified, and the mismatch refusal would never fire again.
- **Checksum equal, nothing undeclared** → no-op for the generated step; the
  invariants, grants and seeds that follow still run, because they are the
  idempotent parts.
- **Checksum equal, but a table or column the manifest does not declare** →
  refuse, listing it. One declared source of truth per table, whatever the
  checksum says.
- **Checksum differs** → refuse, before touching anything, with both
  checksums and the remediation: `bun run db:reset`.

That is the whole rule. The chain never asks *what* differs between a built
database and the manifest, whether the difference would have been safe to
add, or whether a table has rows — a database is built from the manifest on
an empty database, and one built from another manifest is rebuilt. Nothing in the chain can `ALTER` a built database toward the
manifest, and nothing needs to: the cost of a rebuild is a disposable
database's rows, and the alternative was a migrator that could add columns
but not change an index, a foreign key's column set or a `CHECK`
expression, and then recorded the new checksum over a database that still
differed.

What the manifest checksum covers is what `schema.sql` and the plugin
constraint registry are rendered from: tables, columns, indexes, generated
policies and every plugin `constraints` entry. The hand-written invariants
under `apps/api/src/db/migrations/` are outside it, which is why they
reconcile themselves: `ensureCheckConstraint` compares the definition
Postgres holds with the intended one (through a rolled-back `NOT VALID`
probe, since Postgres re-spells a `CHECK` in its own canonical form) and
drops and re-adds the constraint only when they differ; `ensureForeignKey`
does the same for a key whose column set has changed.

## Drift signals

Two independent tripwires compare the database's recorded checksum against
the manifest bundled with the running code (`apps/api/src/db/schema-drift.ts`
— statuses `ok` / `behind` / `unmigrated`), and `findUndeclaredDatabaseSchema`
answers the question the checksum cannot: is the database behind, or is it
another branch's?

- **API startup** (`roles/api-readiness.ts`, on `onReady`, 5s timeout):

  | | empty | built from another manifest / foreign | check unverifiable |
  | --- | --- | --- | --- |
  | **production** | fatal | fatal | fatal |
  | **development** | bootstrapped (same-database migrate URL) | warning banner naming `db:reset`, keeps serving | error log, keeps serving |

- **Readiness** (`/api/ready`): the schema check raises
  `GENERATED_SCHEMA_BEHIND`, `GENERATED_SCHEMA_UNMIGRATED` or — on a
  matching checksum with a table or column beside the manifest —
  `GENERATED_SCHEMA_FOREIGN`; nothing else about the schema gates readiness.

- **e2e preflight** — `schema-drift.e2e.test.ts` fails the suite fast with
  the recorded vs bundled checksums and the remediation that fits:
  `db:migrate` for an empty database, `db:reset` for one built from another
  manifest, and a scratch database for one that carries schema the branch
  does not declare — that one is someone else's build.

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
  the startup check that called it.) What none of them see is a *declared* object
  altered in place — a retyped column, a rewritten generated index — because
  nothing compares a built database's shape to the manifest; that is what
  the checksum stands for, and a `db:reset` is the only way to be sure.

`(cd apps/api && bun test src/db)` exercises the chain — build, no-op, the
checksum refusal, the one-source-of-truth invariant, the hand-written
`CHECK` replacement, `db:reset` and the bootstrap — against throwaway
scratch databases ([testing.md](testing.md#migration-tests)).
