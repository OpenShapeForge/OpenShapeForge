# Schema migrations

`bun run db:migrate` runs the ordered migration chain
(`apps/api/src/db/migration-chain.ts`) on a single connection, serialized
across replicas with a Postgres advisory lock and a bounded 5s `lock_timeout`
for the DDL itself:

1. **App helpers** — the `app` schema and the STABLE RLS helper functions
   (`app.current_tenant()`, `app.current_user_id()`, `app.current_groups()`,
   `app.has_scope()`, `app.bypass_rls()`, `app.current_worker_role()`).
2. **System bypass audit** — `platform.system_bypass_audit` (break-glass
   audit; not manifest-managed).
3. **Versioned bespoke migrations** — hand-written transformations (below).
   They run **before** the generated step precisely so a bespoke migration
   can eliminate non-additive drift before the roll-forward evaluates it.
4. **Generated roll-forward** — the manifest-driven apply/diff.

## The roll-forward additive migrator

`apps/api/src/db/migrations/generated-schema.ts`. The applied
generated-manifest checksum is recorded in `platform.schema_migrations`
under version `0001_generated_platform_schema`. On every run:

- **No row** → fresh install: apply the full generated `schema.sql`, record
  the checksum.
- **Checksum equal** → no-op.
- **Checksum differs** → diff the bundled manifest against the live
  `information_schema` (tables + columns of every schema the manifest
  covers) and classify every difference:

**Additive (applied automatically, atomically):**

- A manifest table missing in the database.
- A manifest column missing on an existing table, when Postgres can add it
  **without a backfill**: the column is nullable, **or** has a default,
  **or** is an identity column, **or** the table has no rows (probed with a
  cached `select exists(...)`).

The roll-forward then executes `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for
each missing column, re-applies the full **idempotent** `schema.sql`
(`CREATE … IF NOT EXISTS` throughout; RLS policies `DROP IF EXISTS` +
`CREATE`; guarded FK adds) — which creates new tables/indexes, refreshes
policies, and ensures FKs — and rolls the recorded checksum forward. All of
it plus the ledger update runs in one explicit `BEGIN`/`COMMIT`.

**Non-additive (hard error with an exact listing):**

- A **required, no-default, non-identity** column missing on a table **with
  rows** (needs a backfill).
- A database column that is absent from the manifest (dropped/renamed
  fields).
- A **type, nullability, identity, or default mismatch** between the live
  column and the manifest (defaults are only compared where the manifest
  declares one — see [Column defaults](#column-defaults)).
- A database table in a manifest-covered schema that is not in the manifest
  (except the explicitly non-manifest-managed `platform.schema_migrations`
  and `platform.system_bypass_audit`).
- A manifest column type with no known `information_schema` mapping.

The error message lists every difference and the remediation: write a
versioned migration, or reset the database volume (destroys all data).

## Versioned bespoke migrations

For everything non-additive — drops, renames, retypes, backfills:

```sh
bun run db:migration:new <kebab-name>     # e.g. split-relation-address
```

The scaffolder (`apps/api/src/db/migrations/new-migration.ts`) computes the
next number (0001 is reserved for the generated baseline, so bespoke
migrations start at **0002**), writes a template file under
`apps/api/src/db/migrations/versioned/`, and registers it in
`versioned/index.ts` via marker comments. You implement `up(db)` (raw
Kysely/SQL) and rerun `bun run db:migrate`.

Rules enforced by the runner (`versioned-runner.ts`):

- **Ordering** — versions must match `NNNN_kebab-name` and be strictly
  ascending; the registry is validated before any SQL runs. Versioned
  migrations always execute **before** the generated roll-forward evaluates
  drift — transform the live schema so the remaining manifest diff becomes
  additive (or a no-op).
- **Immutability** — each applied migration records the **sha256 of its
  source file** in `platform.schema_migrations` (the generated baseline
  records the manifest checksum). On every later run the file is re-hashed;
  a mismatch fails loudly: applied migrations are immutable — revert the
  edit and write a new migration instead.
- **Superseded checksums** — the one sanctioned exception. A file hash cannot
  tell a licence header from a DDL change, so an edit that provably could not
  change what the migration did would otherwise wedge every environment that
  already ran it, permanently and with no way out (commit 8aa19b2 did exactly
  this by adding an SPDX line to three applied migrations). List the old hash
  in the entry's `supersededChecksums` and the runner reconciles the ledger to
  the current one — once; the next run takes the plain skip path, and
  `db:migrate` reports the reconciliation under `versionedReconciled`. Any hash
  not listed still fails. This is **not** a way to change an applied migration:
  the ledger cannot re-run it, so reconciling a real change would assert an
  effect that never happened. Deciding a diff is inert is a review judgement —
  make it in a PR, and record which commit caused it in a comment.
- Each `up()` runs in its own `BEGIN`/`COMMIT` together with its ledger
  insert and is rolled back as a unit on failure.
- If you create permanent tables in a bespoke migration, prefer moving them
  into authoring YAML afterwards so the manifest owns them.

## The page-config seed

The last step of the chain is data, not DDL:
`apps/api/src/db/migrations/entity-page-configs-seed.ts` loads the compiler's
page-config catalog
(`apps/api/src/generated/page-configs/entity-page-configs.seed.json`) into
`platform.entity_page_configs`. It runs after the grant sweep, so the table
exists and the runtime role can already read it.

- **Skippable.** The seed carries one sha256 over its whole serialized row
  set. When every row in the table already carries that checksum and the row
  count agrees, the run is a no-op — `db:migrate` on an unchanged repo does
  not rewrite the catalog.
- **Authoritative.** Rows the seed no longer describes are deleted. An entity
  that stops emitting page configs — renamed, or its generated CRUD switched
  off — must not leave a stale row for the renderer to pick up.
- **Optional.** No seed file (a repo with no `apps/web`) is a no-op, reported
  as absent rather than as an error.

`configs` is bound as an object, never a pre-stringified string: the pg driver
serializes object parameters itself, so stringifying first stores a jsonb
*string* containing JSON and every reader gets a string back. There is a
regression test for exactly that
(`src/db/__tests__/entity-page-configs-seed.test.ts`).

## Drift signals

Two independent tripwires compare the DB's recorded checksum against the
manifest bundled with the running code (`apps/api/src/db/schema-drift.ts` —
statuses `ok` / `behind` / `unmigrated`):

- **API startup** (`src/roles/api.ts`, on `onReady`, 5s timeout):

  | | drift detected | check unverifiable (DB unreachable) |
  | --- | --- | --- |
  | **production** (`NODE_ENV=production`) | fatal — refuses to serve | fatal |
  | **development** | loud warning banner, keeps serving | error log, keeps serving |

- **e2e preflight** — `schema-drift.e2e.test.ts` fails the suite fast with
  the recorded vs bundled checksums and "run `bun run db:migrate`" guidance,
  instead of letting a stale schema produce confusing downstream failures.

## Column defaults

`manifest.json` carries each column's **verbatim authoring default**, and the
diff compares it against `information_schema.column_default`. A **changed**
default is non-additive: the roll-forward cannot `ALTER` a default in place
(the idempotent `CREATE TABLE IF NOT EXISTS` skips existing tables), so it is
surfaced as a hard error rather than silently left stale. Change a default on
an existing table with a versioned migration.

Postgres re-serializes `column_default` into its own canonical form, so the
authored spelling and the reported one need not be identical. **A redundant
cast on a quoted literal is normalized away before comparing**, on both sides
and only when the cast names the column's own type — so on a `text` column
`'process'` and `'process'::text` are the same default, and either spelling is
accepted. The same holds for the other types Postgres canonicalises this way
(`uuid`, `jsonb`, `date`).

Nothing else is normalized. A cast naming a different type, a chain of casts,
a parenthesised or dollar-quoted expression, or anything that is not exactly
one quoted literal plus a cast (`now()`, `gen_random_uuid()`,
`upper('x'::text)`, `now() - interval '1 day'`) is compared as written, so a
genuine expression change still registers as drift. Two Postgres rewrites are
therefore **not** absorbed and are best avoided in authoring: boolean, integer
and numeric literals are const-folded to an unquoted token (`'false'::boolean`
is reported as `false`), and a `timestamptz` literal is re-rendered into
Postgres' own timestamp spelling. Author those in the folded form (`false`,
`0`, `now()`).

## Caveats

- **Type equivalents are non-additive.** The diff compares
  `information_schema.data_type` strings through a fixed exact map
  (`text`→`text`, `timestamptz`→`timestamp with time zone`, …). A live
  column that is semantically compatible but spelled differently
  (`varchar` vs `text`, a domain type, a pre-existing `serial`) counts as a
  type mismatch, and any manifest type outside the map is refused rather
  than guessed at. Likewise, changing a field's scalar type in YAML is
  always non-additive — even where Postgres could cast implicitly.
- Row-count probes honor RLS; the migration role is expected to be the
  superuser/owner used by `db:migrate`. Misclassification is fail-safe: a
  wrongly-additive `ADD COLUMN … NOT NULL` would be rejected by Postgres
  itself.

`bun run --cwd apps/api test:migrations` exercises the full chain — fresh
install, no-op, additive roll-forward, non-additive refusal, immutability —
against throwaway scratch databases ([testing.md](testing.md#migration-tests)).
