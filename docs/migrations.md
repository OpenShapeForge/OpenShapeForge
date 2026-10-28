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
fields, plus the `UPDATE` privilege `SELECT … FOR SHARE` requires — so it may
lock an ACL row to serialize a check against a concurrent policy change, and
may never write one. Its two functions are not executable by the worker
connection or by `PUBLIC`.

Those grants are bounded by four policies per entity, and the load-bearing
ones are `AS RESTRICTIVE`. Permissive policies are combined with `OR`, and
every tenant-scoped table already carries the generated row policy, which names
no role and whose write check any row of the session's own tenant satisfies; a
role-targeted `WITH CHECK (false)` is OR-ed with it and refuses nothing. So
beside the two permissive policies that admit the resolver to its own tenant's
rows for `SELECT` and for the lock, `<table>_record_action_fence` is a
restrictive `FOR ALL` policy — AND-ed, and therefore not widenable by any
policy added later — and `<table>_record_action_delete_fence` is a restrictive
`FOR DELETE` policy, because a `FOR ALL` policy's `WITH CHECK` is applied to
`INSERT` and `UPDATE` only while `DELETE` is bounded by `USING`, which the
`FOR ALL` fence has to leave true for the tenant's own rows or `FOR SHARE`
stops working.

Both fences exempt one thing: a session holding the privileges of the table's
own owner, read from `pg_class` at evaluation time. That is a privilege, not a
role name, and the distinction matters. RLS matches `TO` with
`has_privs_of_role`, so a `TO <resolver>` policy also covers every member of
the resolver — the migrate role, which the contract makes a member of every
definer role, and anything else a deployment grants it. An exemption written as
`current_user <> '<resolver>'` covered all of them, and a second member then
held `UPDATE (<acl column>)` with nothing refusing it. The owner's privileges
exempt the migrate role that created the table (and any second migrator) while
staying false for the resolver and for a member that owns nothing. The step
refuses to grant anything on a table whose row security is not enabled *and*
forced, or whose owner is a role the resolver holds the privileges of, because
in either case the policies bound nothing.

Privileges are replaced, not added to: the step revokes everything on the table
from the resolver, grants exactly the declared column `SELECT` and the ACL
column `UPDATE`, then reads `pg_class.relacl` and `pg_attribute.attacl` back
and fails if the result is not that exact set. `TRUNCATE` is why — it ignores
row security completely, so no policy bounds it — and a grant made by a second
grantor survives the owner's revoke. `revoke all` does reach column grants, so
an entity that stops reading a field loses that column `SELECT` on the next
migrate.

`PUBLIC` is a grantee like any other, and the resolver holds everything
`PUBLIC` holds — a `revoke` addressed to the resolver does not reach it. So the
step reads `PUBLIC`'s privileges from the same two ACL columns, with
`acldefault` standing in where the column is `NULL` (which means the built-in
default, not "nothing"), and **refuses the table** before its first grant if
`PUBLIC` holds anything on it. It does not revoke the grant: a `PUBLIC` grant
belongs to every role in the cluster, so a migration silently revoking it would
be taking a privilege away from whoever it was made for. The error names the
`revoke … from public` an administrator runs if the grant was a mistake.
Reaching the resolver's inherited `PUBLIC` privileges needs an explicit
`PUBLIC` grant on an entity table *and* the ability to execute as the resolver,
so this closes a gap between the claimed and the actual privilege set rather
than an externally reachable hole.

The per-entity loop only visits the entities the manifest declares today, which
leaves nothing behind for an entity whose projection changed but does leave the
grants and the four policies of an entity the new manifest **dropped** — or of
one whose last action was dropped, which is the same thing one step earlier.
The step therefore also takes back the resolver's grants on every table it
still reaches that no declared entity names, and drops the record-action
policies there by the name the catalog holds, so a renamed table is covered
too. Only the resolver's own grants: another grantee's privileges on the same
table, and `PUBLIC`'s, are left exactly as the deployment set them. Schema
`USAGE` stays granted — it is not a table privilege and opens nothing on a
table the resolver holds nothing on.

The whole step is one transaction: the grants, the four policies per entity,
that cleanup and both function bodies. The migration lock is a *session*
advisory lock, so without it a concurrent session could observe the table
between `DROP POLICY` and `CREATE POLICY`, or — across entities — the new
grants under the *old* function bodies, whose branches read columns the new
grant set no longer covers. The cost is that the `ACCESS EXCLUSIVE` locks
`CREATE POLICY` takes are held until the step commits, so a long-running reader
of one entity table delays the DDL on all of them and a session holding row
locks across two can deadlock with the step. Either way the step rolls back and
the deployment stays on the grants and policies it had.

The role contract covers attributes and membership too. No declared role may be
`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`; a definer
role must be `NOINHERIT` and a member of nothing, since its functions are
`SECURITY DEFINER` and would otherwise run with whatever it inherits; and the
only roles that may *act as* a definer role are the migrate identity and the
owner of the current database, both compared by role **name**, besides a
superuser, which the check cannot bound either way.

Comparing by name is the rule, not a detail. `pg_has_role(current_user, X,
'USAGE')` answers "does the caller hold X's privileges", which is true for
every role granted *to* the migrate role and true for every role when the
caller is a superuser — so using it to ask "is this member the migrator?"
admitted a helper role granted to both the migrate role and a definer role, and
admitted every member of every definer role whenever a superuser ran the check.
A member of the record-action resolver inherits its column grants, is matched by
the policies written `TO` it, and *owns* its two `SECURITY DEFINER` functions,
because object ownership is resolved with `has_privs_of_role` as well: with the
`CREATE` on schema `app` that the same membership carries it can
`CREATE OR REPLACE app.record_action_allows` and decide every record action
itself. The fences bound that member's writes to entity tables; nothing bounds
a replaced function body.

"Act as" is **reachability in the membership graph**, not a direct grant. The
two admitted roles are ordinary roles, so a third role granted one of *them*
reaches the definer role through it: with `grant <definer> to <owner>` and
`grant <owner> to <third>`, that third role runs `set role <owner>; set role
<definer>; create or replace app.record_action_allows(...)` and decides every
record action — while a direct scan of `pg_auth_members` shows it as a member
of nothing. So the check walks outwards from each definer role transitively,
through the admitted roles as well, and reports every role on a path that is
neither of the two, with the chain it travels and the `revoke` that cuts that
route. Superusers are not reported — they are outside row security and every
privilege check regardless — but the walk still passes *through* them.

One role can reach a definer role by **several routes**, and a `revoke` cuts
exactly one of them: the first hop of the route it is read off. Granted both
admitted roles — `grant <owner> to <third>` and `grant <migrate> to <third>` —
that third role is there twice over, and following one printed remedy would
leave the other route live. So the refusal names one route per distinct first
hop out of the reported role, each with its own `revoke`, and says that every
statement has to be run. Running all of them removes every edge by which a
reported role reaches a definer role; it is not an iterative hunt. The walk
stops at 16 hops, and that is not a way past the check: the nearest reported
role on a longer chain fails it and carries the `revoke` that cuts the chain,
so hiding behind the bound means 16 *admitted* hops — 16 superusers, since the
migrate identity and the database owner are one role each.

What the 16 hops do **not** do is bound the walk's cost. Reading one row per
route off an enumeration of paths costs the number of paths, and on a dense
acyclic lattice that is exponential in its depth: eight layers of six roles,
every role granted to every role in the next, is 264 edges and 2,015,544
paths, and the enumeration spent 20s producing the 264 rows. A few more layers
is unresponsive — a grant graph large enough would refuse a deployment its
migration rather than report a verdict on it. So the walk is over **roles**:
`UNION` rather than `UNION ALL`, keyed on `(definer role, role, depth)`, so a
role that several grants lead to is visited once per level instead of once per
path. Its shortest-distance tree is reconstructed after it and the routes are
read off each reached role's outgoing edges, which is where the one row per
first hop comes from. The rows are the ones the enumeration produced — same
triples, same shortest chain length each — and nothing is capped: a role
reachable by ten routes still gets ten rows and ten `revoke`s. The cost is now
bounded by the size of the grant graph, as
`apps/api/src/db/__tests__/definer-role-reachability.test.ts` measures on that
same lattice.

No membership option makes an edge safe, so the walk does not look at them.
`INHERIT` hands over the definer role's privileges and the ownership of its
functions, `SET` lets the member become it, and `ADMIN` alone is enough because
the member may `grant <role> to <itself> with inherit true, set true`. An edge
carrying none of the three confers nothing today and has no purpose on the path
to a definer role either, so it is reported rather than classified as harmless.

For the same reason the migrate identity's own membership must be a **direct**
grant carrying `INHERIT` and `SET`
(`grant <definer> to <migrate role> with inherit true, set true`), or the
migrate role must be a superuser, which needs no grant. Both halves are read
off the edge itself: `pg_has_role` answers for the whole graph, so a direct
grant carrying neither option passes it whenever a third role supplies the
privilege. One `(role, member)` pair may carry several grants from different
grantors — a `createrole_self_grant` edge beside the host's, for instance — and
holding one that carries both options satisfies the contract.

Both options are read from `pg_auth_members.inherit_option` and
`.set_option`, which exist from **PostgreSQL 16** — the floor the database
suite runs on in CI, and therefore the oldest server this contract supports.
On an older server the check errors on the missing columns rather than passing;
upgrade the cluster to 16 or later before `db:migrate`.

Anything else is reported with the `alter role`, `grant` or `revoke` that fixes
it — and only reported. The chain runs as the migrate role, which is
deliberately not a role administrator, so it fails closed rather than changing
an attribute or revoking a membership an operator set. The record-action step
repeats this check on the resolver before it grants anything, because a host
can call that step directly.

An attribute deviation is reported as **one `alter role` per role**, naming
that role and only the attributes it must not keep —
`alter role openshapeforge_record_action_resolver nosuperuser nocreatedb;` for
a role that is a superuser and may create databases, and nothing for the
attributes that are already right. No other role is named, and the statement is
never run for you. `db:provision-roles` does not stand in for it: the script
creates the roles that do not exist and grants the migrate identity its
membership, and a role that already exists keeps the attribute that failed, so
the next `db:migrate` refuses on it again until the printed `alter role` is run.
Postgres reserves `SUPERUSER`, `REPLICATION` and `BYPASSRLS` to superusers, so
the refusal says when a `CREATEROLE` administrator connection is not enough for
the statement it just printed.

Adding a role is a host provisioning step:
`db:provision-roles` before the next `db:migrate`, or step 0 refuses the chain
and names the statements.

### Two OpenShapeForge databases in one cluster

That membership rule is the point where a cluster-wide object meets a
per-database check. Roles and role memberships live in the cluster, but both
things the rule holds a member against are per database: the migrate identity
step 0 is connected as, and `datdba`. The same member list must therefore be
accounted for in **both** databases.

What it is accounted for against is a **predicate on each member**, evaluated
once per database — not a count of owners or of migrate identities. A reachable
member passes in a database on one of three grounds: it is a superuser (outside
row security and privilege checks regardless of membership), it **is** the
migrate identity step 0 is connected as, or it **is** the owner of that
database — the last two by role **name**. Every other reachable role is
refused. A role that merely *holds* an owner's privileges is not admitted,
because as a definer member it would gain ownership of that role's `SECURITY
DEFINER` functions, which the privileges alone do not confer.

A cluster passes exactly when every member of the definer roles satisfies that
predicate in every OpenShapeForge database on it. Three shapes are worth
naming:

- **One migrate identity for both databases** satisfies the contract however
  their owners differ, as long as it is the only member of the definer roles:
  each database recognises it as the identity it is connected as. **Tested.**
- **Two migrate identities**, both members of the definer roles and neither a
  superuser, are refused when **each owns the database it migrates**. In each
  database the other's migrator is none of the three grounds, so step 0 refuses
  in both, each naming the other's migrator against all three definer roles.
  That refusal is symmetric — no provisioning order satisfies both, the
  `revoke` each error names would break the other database, and two roles
  cannot be members of each other, so no repair keeps both. Granting one
  migrator the other database's owner does not help either: privileges are not
  identity. **Tested**, in both directions.
- **Two migrate identities that are each the other database's owner** are not
  refused by this predicate: if the database `m1` migrates is owned by `m2` and
  the database `m2` migrates is owned by `m1`, each database admits one member
  as its own `current_user` and the other as its own `datdba`. **Untested** —
  no test provisions it, and the role contract is not the only condition such a
  deployment must meet: nothing here establishes that the rest of a migration
  run holds when the migrate identity does not own the database it migrates. It
  is named so the refusal above is not read as a ban on two migrate identities
  as such, and it is not a configuration to adopt on the strength of this
  paragraph.

Sharing an owner is not what passes and distinct owners are not what fails:
what counts is what each member of the definer roles **is** in the database
doing the checking.

What is verified, by `database-role-contract.test.ts` on PostgreSQL 17.11: it
provisions a second database in the test cluster and runs `verifyDatabaseRoles`
in both databases. Two databases each owned by the distinct non-superuser role
that migrates it refuse symmetrically; the same two databases with distinct
owners under **one** migrate identity pass in both; and a second migrate
identity is still refused in the database whose owner's privileges it has been
granted, while the first database refuses it too. `definer-role-membership.test.ts`
adds the owner case directly: a definer member that is a database owner is
admitted in the database it owns and refused in its sibling. The check cannot
admit a member for being *some* database's owner, nor for holding an owner's
privileges: either would let the owner of any database in the cluster — or
anyone granted that owner — hold the definer roles' grants in this one.

One cluster per deployment, which is what `db:provision-roles` ("once per
cluster") assumes, needs none of this. For two deployments on shared hardware,
separate clusters are the arrangement to reach for first; a shared cluster
works only under the predicate above, and what to check before relying on it is
each definer member's standing in each database — the migrate identities and
the memberships they hold, not the database owners alone.

The record-action step's privilege guarantees are per-database for the same
reason. It reads `pg_class`, `pg_attribute` and `pg_policy`, all of which are
per-database, so "the resolver holds exactly what this manifest declares" is a
statement about the database being migrated. The resolver is one cluster-wide
role, and its grants in a sibling database are neither visible to nor revocable
from this one; what bounds them there is that database's own migrate run. In a
database no OpenShapeForge migration manages, nothing here bounds them at all.

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

### A database owner on a shared cluster

Roles are cluster-wide: the definer roles are named once in the manifest and
shared by every OpenShapeForge database on the cluster. "The owner of the
current database" is not. A role that is a member of the definer roles and owns
**another** database on the cluster is therefore admitted there and refused
here, and that is the supported policy rather than an oversight: admitting any
database owner would admit whoever a `CREATEDB` role made one. The refusal says
so when the reported role owns another database, so it is not mistaken for a
broken grant, and the sentence it adds states the predicate the check applies:
a member is admitted in a database only when it **is** that database's migrate
identity or owner, so owning another one admits it there and not here. The
remedy is the `revoke` the refusal already carries, or separate clusters.

That sentence does not ask for one owner and one migrate identity across the
cluster. Such a cluster satisfies the contract, but it is not what the check
requires — a cluster whose databases differ in owner passes under one migrate
identity, as does one whose two migrate identities each own the other's
database. See the section above for the rule itself.

Differing owners alone do not cause a refusal: an owner is only measured
against the predicate if it is a member of the definer roles, or reaches one
through another member. An owner that holds no definer-role membership is never
reported.

What this costs an existing deployment, exactly: a single-database cluster
whose migrate identity is its database owner is unaffected, and so is one whose
migrate identity is a direct member of the definer roles with `INHERIT` and
`SET`. `db:migrate` now refuses, before touching the schema, when a role that
is neither the migrate identity nor this database's owner can reach a definer
role — including through either of those two — and when the migrate identity's
own grant is indirect or carries neither option. On a shared cluster that
includes a sibling database's owner or migrate identity, when it is a definer
member and is neither this database's `current_user` nor its owner. It also
refuses when a declared role that already exists carries `SUPERUSER`,
`BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`, or the wrong login
flag, which `db:provision-roles` does not repair. Each refusal names the exact
`alter role`, `grant` or `revoke` — one per deviating role and one per route,
so run all of them; none of them is applied for you. Run
`db:provision-roles -- --print` and the reported statements against the cluster
before the upgrade window if any of those shapes may be present.

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
