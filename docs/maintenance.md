# Trusted maintenance lifecycle

Installed runtime modules may contribute maintenance code for disposable
application data and fixtures. `RuntimeModule.maintenance` registers a name, a
stable actor UUID, the complete canonical Operation allowlist, an optional
seed-owned acting-Relation source authority, and an optional CLI entry.
These are trusted installed modules: their SQL store retains the existing
privileged seed authority. The facade scopes lifecycle, provenance and audit;
it does not sandbox SQL or grant permission to erase customer data.

A registered module's canonical Control handler receives `context.runSeed` only
inside its active core-owned invocation. Core checks the Control credential,
`platform-operator` role, token expiry and the live session capability before
opening maintenance resources. A tenant bearer cannot elevate. A contribution
must belong to that handler's installed module. The host still owns its
production/staging deployment policy and action validation.

```typescript
await context.runSeed!({ contribution: "example-fixtures", tenantSlug: "demo", reason: "apply fixture" }, async maintenance => {
  await maintenance.store.pinned(async connection => {
    await connection.query("select pg_advisory_lock(hashtext($1))", [maintenance.provenance.tenantId]);
    try {
      await connection.transaction(transaction => transaction.query(
        "update erp.relations set display_name=$1 where tenant_id=$2::uuid and id=$3::uuid",
        ["Example", maintenance.provenance.tenantId, fixtureRelationId],
      ));
      const result = await maintenance.operations.execute("Relation.get", { id: fixtureRelationId });
      if ("error" in result) throw new Error(result.error.message);
    } finally {
      await connection.query("select pg_advisory_unlock(hashtext($1))", [maintenance.provenance.tenantId]);
    }
  });
});
```

`provenance` is an immutable tenant ID/slug, contribution name, invocation ID
and operator or job identity. `store.query`, `store.transaction` and
`store.pinned` keep connection ownership in core. Each transaction uses the
existing audited system session, including failure audit after rollback.
Pinned callbacks can retain a session-level advisory lock across independently
committed units. Started child work drains before a transaction, connection or
runtime closes; retained or foreign invocation facades refuse new calls.

Canonical execution uses the separate restricted application connection and
normal RLS, authorization and business guards. Core derives roles from the
complete registered allowlist, supplies current version/edit-lease controls,
and may perform the target's ordinary authorized `get` internally for a version.
An acting Relation is read under app RLS and must be an active person in the
same tenant with the registered seed source authority. Caller-supplied display
names and identity objects are not authority. A canonical error envelope marks
the maintenance run failed even if the contribution catches it.

The SQL and canonical halves are independently committed. Core does not promise
whole-run atomicity. A contribution must retain its domain-specific claim/marker
transactions and reconciliation checks so interrupted work can resume safely.
Finance/contact fixtures can use only the store with an empty Operation allowlist.

For migrations, `ModuleSeed.maintenanceOptIn()` supplies the existing host gate.
The migration owner matches the seed by identity to its installed module and
provides the same `runSeed` lifecycle. An absent or false gate cannot start a
maintenance job. Ordinary module seed callbacks retain their existing database
argument; the new service does not change that trust baseline.

The core CLI loads installed contributions independently and selects their
registered `run` entry; it exports no pool, session or headless runtime factory:

```sh
bun apps/api/src/db/maintenance.ts --contribution example-fixtures --tenant demo --action status --confirm-seed
```

The host may pass `--date` as product input. `DATABASE_URL` must be the restricted
app connection; `OPENSHAPEFORGE_MIGRATE_DATABASE_URL` owns privileged store work.
A superuser or `BYPASSRLS` app connection is refused. Actual opened store and app connections must report the same server address/port, postmaster start, database name and database OID; live maintenance also checks the verified invocation platform connection. Credentials and URL aliases are not compared. A database override that selects a different database fails before the maintenance callback. Installed module load/init
failures identify their module and reason and prevent a partial headless runtime.

## Managed tenant provisioning command

The API OCI image also owns a closed trusted-process command:

```sh
bun apps/api/src/control/maintenance.ts --action provision --tenant example \
  --name Example --confirm-managed-maintenance
bun apps/api/src/control/maintenance.ts --action get --tenant example \
  --confirm-managed-maintenance
```

It prints the existing provisioning/read result as one JSON value (`null` for an
absent read). Errors do not print credentials or provider response bodies. No
caller bearer token, session, audit principal or runtime factory is accepted.
The command obtains its own existing service-account credential from the pinned
HTTPS endpoint and checks its issuer, client and subject before audited access.

Required environment: `OPENSHAPEFORGE_MIGRATE_DATABASE_URL`,
`OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE`,
`OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE_ROLE`,
`OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL`,
`OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM`,
`OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID`,
`KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API`,
`OPENSHAPEFORGE_PUBLIC_ORIGIN` and `OPENSHAPEFORGE_MCP_CLIENTS`.
Additional resource origins use `OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS`.
`OPENSHAPEFORGE_CONTROL_KEYCLOAK_CONNECT_URL` reuses the existing HTTPS ingress
route with the public TLS server name and certificate validation. Host source
configuration, including `OPENSHAPEFORGE_ORGANIZATION_CONTEXT`, remains in force.
Actual database/current role/session role are checked before provider access;
the host remains responsible for its deployment-specific network and staging gate.

Managed replay always preserves an existing organization binding. For an already
bound tenant, the SPI response is checked before registry/name/starter-group
mutation and reused once by existing `provisionTenant`. A replacement refuses
without these database mutations; the audited read remains. The SPI upsert may
already have provider effects. Fresh tenants keep normal partial-commit
provisioning and replay recovery; this command does not claim distributed
atomicity or replace the host's identity/member orchestration.

The optional seed CLI flag `--input-stdin` accepts up to 64 KiB of JSON object
data for the installed descriptor (for example a verified provider subject).
Contribution, tenant and opt-in remain command flags; session/provenance/role
fields are refused. Action and snapshot date flags cannot be overridden by input.
This is descriptor data, not a seed language or a caller-provided authority.

Use the pinned connection inside `store.pinned`, and use the supplied query inside
a transaction. Acquiring the base store again, nesting pinned scopes or acquiring
another transaction from the pinned connection inside its transaction fails
immediately. The facade cannot sandbox arbitrary raw SQL from trusted seed code;
start `runSeed` outside a separately owned raw migration transaction.

An owner drains already started work. A discarded failing job fails its enclosing
migration/CLI owner; an explicitly awaited/caught refusal can be reconciled by the
trusted callback. Borrowed initialized modules/platform are reused without a
second `init` or a caller-owned `close`; headless CLI modules initialize once.
Registered seed roles are the union of the stable operation contracts, including
required transitive business reads. These are trusted seed authority, not browser
credentials. The outward executor remains bounded by the immutable contribution
allowlist, while ordinary authorization and business guards still run.

A trusted installed contribution can register `storeConnection: "application"`
for bounded maintenance SQL whose existing policies apply only to the application
role, such as identity/link tables. Core owns that connection and its audited
system session; no session or connection factory is exported. The default store
remains the migration connection. Both must refer to the same actual database,
and the application role must remain non-superuser without `BYPASSRLS`. This does
not add role membership or widen database policies. Normal tenant sessions retain
their existing RLS restrictions after the maintenance transaction ends.
