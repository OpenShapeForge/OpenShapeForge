# Plugins

A plugin extends the platform without living in it. It has two halves, loaded at
two different times by two different processes:

| Half | Entry point | Loaded by | Contributes |
| --- | --- | --- | --- |
| **Compiler plugin** | `<plugin>` | `bun run generate` | platform tables, generated artifacts, an authoring layer |
| **Runtime module** | `<plugin>/runtime` | the API at boot | operations, GraphQL, workers, readiness checks, cleanup |

Both are registered by the same `plugins:` entry in `authoring.config.yaml`, so
a deployment cannot end up running one half without the other. Shipping only a
compiler half is normal — `entity-docs` has nothing to do at runtime.

Contracts and loaders: `packages/compiler/src/plugins.ts` (tests in
`plugins.test.ts`) and `apps/api/src/modules/contract.ts` (tests in
`apps/api/src/modules/__tests__/`).

## Canonical operations

Commands and purpose-built queries belong in `CompilerPlugin.operations`, not
in transport-specific fragments. Each operation has one stable, plugin-prefixed
key; method/path; JSON Schema 2020-12 input, output, and errors; authenticated
session/public/custom authentication; tenant and idempotency semantics; a runtime handler key;
and explicit REST, MCP, GraphQL, and TypeScript projections.

Generation validates the whole catalog before emitting anything. Duplicate
keys, REST routes, MCP tools, or plugin/entity/connector GraphQL fields fail the build.
Collisions with host-owned core GraphQL fields fail closed when the API composes its schema at boot. Custom-auth
operations may only project to REST, while binary/streaming REST operations
must either expose a separate JSON artifact-handle operation or record why MCP
and GraphQL are disabled. Disabled projections always require a reason, so a
missing transport can never look accidental.

The compiler emits the canonical catalog under
`apps/api/src/generated/operations/`, merges operations into OpenAPI 3.1 and
the MCP and GraphQL documentation catalogs, and exposes those same declarations
through the live runtime. The runtime module binds compiler-side handler keys:

```ts
const runtimeModule: RuntimeModule = {
  name: "example",
  operationHandlers: {
    async publishQuote(input, { db, session, transport }) {
      return { value: await publish(db, session, input), status: 201 };
    },
  },
};
```

An active module missing a declared handler, or carrying an undeclared handler,
fails closed during surface composition. Input and JSON output are validated at
the runtime boundary on REST, MCP, and GraphQL. Session roles and OAuth scopes
are enforced centrally across verified bearer, API-key, and signed trusted-context
identities. API keys deliberately cannot invoke operations that require OAuth
scopes until keys have their own persisted scope subset; a custom scheme is handler-owned, fully described as an OpenAPI
security scheme, and only available through its REST projection.

A handler can return a declared failure without throwing an untyped transport
error:

```ts
return {
  ok: false,
  status: 409,
  code: "CONFLICT",
  body: { error: { code: "CONFLICT", message: "Already published." } },
  headers: { "retry-after": "5" },
  contentType: "application/problem+json",
};
```

The status and code must identify one entry in the operation's `errors` list,
and the body must validate against that entry's schema. Without an explicit
schema, the body must use the platform `{ error: { code, message } }` envelope
and its embedded code must match. A handler-provided content type must match
the error's declared `rest.contentType` (or the default `application/json`), so
the runtime response cannot contradict OpenAPI. Error content types are limited
to bare JSON media types (`application/json` or a `+json` subtype, without
parameters), matching the JSON Schema body contract and its UTF-8 encoding.
REST sends the validated body
and response metadata unchanged. GraphQL raises an error with the code, status,
and body in `extensions`; MCP returns an `isError` tool result instead of
successful content.

Several error codes may share one HTTP status, but each status-and-code pair
must be unique. OpenAPI keeps the single-error response shape unchanged. For a
shared status it publishes one response, orders the alternatives by code, and
groups their schemas and fixed examples by declared JSON media type. Default
error envelopes are represented as code-discriminated `oneOf` alternatives;
custom schemas use `anyOf` because arbitrary JSON Schemas may overlap.

An error declaration may also include a fixed, schema-validated `body` in its
REST projection. It is used only when a matching
platform `HttpError` occurs before the handler, such as centralized session or
role authorization. This keeps authentication in core while allowing a
compatibility route to retain a previously published REST error body. Thrown
errors without such a declaration keep the platform's standard normalization.
Authentication-service unavailability remains the historical unauthenticated
response unless the operation explicitly declares the
`503 AUTHENTICATION_UNAVAILABLE` error.

For `idempotency-key` operations, the canonical input field is required on all
transports. REST clients supply it only through the declared required header;
the runtime injects that header into canonical input before validation.

## The compiler half

### The contract

The real types (from `plugins.ts` / `schema.ts`):

```ts
export type CompilerPlugin = {
  name: string;
  /** Extra platform tables merged into the base manifest BEFORE authoring
   *  entities are promoted. Colliding with an existing schema.table errors. */
  contributePlatformTables?(context: PluginBaseContext): TableDefinition[];
  /** Immutable PostgreSQL DDL for functions, triggers, and other invariants
   *  that are not representable as table constraints. */
  schemaMigrations?:
    | { version: string; sql: string }[]
    | ((context: PluginBaseContext) => { version: string; sql: string }[]);
  /** Emit artifacts; paths are repo-root-relative like all compiler output. */
  generate?(
    context: PluginGenerateContext,
  ): GeneratedArtifact[] | Promise<GeneratedArtifact[]>;
  /** Generated paths this plugin owns, so check:generated extends its
   *  stale/orphan gates to them. */
  ownedPaths?: { roots?: string[]; files?: string[] };
};

export type PluginBaseContext = {
  repoRoot: string;
  authoringDir: string;   // the RESOLVED authoring dir (post-layer-merge)
  webPresent: boolean;    // existsSync(<repoRoot>/apps/web)
};

export type PluginGenerateContext = PluginBaseContext & {
  manifest: PlatformSchemaManifest;   // full merged manifest
  entities: CompiledEntityInfo[];     // every compiled entity contract
};

export type CompiledEntityInfo = {
  slug: string;
  path: string;                        // repo-root-relative provenance path
  origin: "core" | "contextFull";
  contract: CompiledEntityContract;    // storage, model, graphql, views, …
};

export type GeneratedArtifact = { path: string; contents: string };
```

A plugin module **default-exports** a `CompilerPlugin` with a non-empty
string `name`; duplicate names across registered plugins are an error.

### Registration

In `authoring.config.yaml`:

```yaml
plugins:
  - ./examples/plugins/entity-docs.ts       # local module (relative/absolute path)
  - ./examples/plugins/workflow/index.ts    # local package-style plugin
  # - "@openshapeforge/plugin-workflow"         # or a workspace/npm package specifier
```

Path specifiers must exist; bare specifiers resolve via `Bun.resolveSync`.
Loading is memoized per repo root.

A plugin may also ship an **authoring layer**: an `authoring/` directory next
to the plugin module (for path specifiers) or at the package root (for
package specifiers) is appended to the configured layers automatically — see
[layers.md](layers.md). It is held to the same schemas as the base layer:
`bun run check:authoring-schemas` derives its scan roots from the same
resolver, so shipping authoring through a plugin is not a way around the gate
([authoring.md](authoring.md#the-schemas-are-enforced)).

### The compile-once context

`loadActivePlatformCompile(repoRoot)` (in `src/active-manifest.ts`) does the
expensive work exactly once per repo root and shares it:

1. Load plugins.
2. Load the base `config/platform-schema.yaml` manifest.
3. `mergePluginPlatformTables` — each plugin's `contributePlatformTables`
   result is appended to the base manifest; a `schema.table` that already
   exists is an error.
4. Compile every authoring entity **once** and promote the results into the
   manifest. The same `CompiledEntityInfo[]` array is what your `generate`
   hook receives — plugins never recompile entities.

Two shape details worth knowing when consuming the manifest in a plugin:

- **In-memory `TableDefinition`s carry `schema` and `name` separately**
  (`table.name` is the bare table name, e.g. `relations`). Only the
  *serialized* `manifest.json` uses a qualified `name` (`"erp.relations"`)
  with separate `schema`/`table` fields. Render qualified names yourself:
  `` `${table.schema}.${table.name}` ``.
- CRUD-eligible tables are selected with `isGeneratedCrudEligible(table)` and
  a `source.graphql` block. The helper understands both the current
  `generatedCrudEligible` marker and legacy manifests.
- A contributed table may declare **`workerAccess: "<role>"`** to let a
  background worker reach it across tenants without `app.bypass_rls`. It
  requires `tenantScoped: true`, widens rather than narrows, and belongs only
  on queue-shaped tables a worker drains — see
  [api.md](api.md#the-worker-axis). The manifest loader validates the field
  for YAML-authored tables; the emitter repeats both checks, because
  `contributePlatformTables` never passes through the loader.
- A contributed table must declare **`workerDml: true`** if a worker touches it
  at all, even inside a single tenant's session. A worker connects as its own
  PostgreSQL role, and that role gets an enumerated grant rather than the app
  role's whole-schema sweep — so a table nobody declares is a table a worker
  gets `permission denied` on. Legal on a global table, unlike `workerAccess`,
  and implied by it. Generated-CRUD-eligible tables need no declaration: a generated
  entity node exists for each, so the sweep derives them.

Schemas are covered automatically: `applyAppRoleGrants` derives the schema
list from the generated manifest, so a schema your plugin introduces gets
USAGE and DML grants for the restricted runtime role on the next
`bun run db:migrate` without a bespoke migration. The **worker** role is the
deliberate exception: `applyWorkerRoleGrants` enumerates tables rather than
sweeping schemas, so a plugin's table reaches a worker only by saying so.

### Database invariants

A contributed table can declare versioned, explicitly named `constraints` for
compound primary keys, compound unique constraints, compound foreign keys, and
checks. The compiler validates key and foreign-key columns before it
emits SQL:

```ts
contributePlatformTables: () => [{
  schema: "cpq",
  name: "request_lines",
  tenantScoped: true,
  columns: [/* ... */],
  constraints: [
    {
      version: "0001_request-line-key",
      name: "request_lines_request_position_key",
      kind: "unique",
      columns: ["request_id", "position"],
    },
    {
      version: "0002_request-line-request-fk",
      name: "request_lines_request_fk",
      kind: "foreignKey",
      columns: ["tenant_id", "request_id"],
      references: {
        schema: "cpq",
        table: "requests",
        columns: ["tenant_id", "id"],
      },
      onDelete: "CASCADE",
      deferrable: true,
      initiallyDeferred: true,
    },
  ],
}],
```

Functions, triggers, and other PostgreSQL invariants use the deliberately
narrow `schemaMigrations` contract. Every contribution has a plugin-local
`NNNN_kebab-name` version and SQL body. Constraints and SQL migrations share
that namespace, so their order is explicit and duplicate versions fail the
compile. Use a later version when a function must exist before its trigger or
a unique key before a foreign key. Across plugins, migrations apply by plugin
name and then version; the compiler rejects a structured foreign key when its
target key would therefore be installed later. Use the context callback form
when invariant DDL must be gated by the same host capabilities as contributed
tables.

When at least one contribution exists, the compiler emits
`apps/api/src/generated/plugin-migrations/registry.json`. The registry is
deterministically sorted and covered by the compiler's stale, orphan, and
double-generation gates. With no contributions the file is absent, preserving
the existing generated output byte-for-byte.

`db:migrate` applies the registry after the generated tables and before the
grant sweep. Each migration and its ledger write run in one transaction under
`plugin:<plugin>:<version>` in `platform.schema_migrations`. The ledger stores
the exact SQL checksum. A rerun skips an identical entry; changing its SQL or
checksum fails migration and readiness. Ledger entries absent from an older
registry are reported as unexpected but tolerated so an image rollback remains
serviceable. Applied contributions are still immutable: retain old entries in
forward builds and add a new version for an additive roll-forward.

### `ownedPaths` and the gates

Declaring `ownedPaths` opts your output into the same freshness/orphan gates
the core enjoys:

- **Stale**: `check:generated` compares every emitted artifact against disk.
- **Orphan**: every existing file under an owned `root` (or listed `file`)
  that a fresh generation would **not** emit fails the check — so deleted
  outputs cannot rot on disk.
- Declare roots that don't exist yet if you will emit into them later (the
  workflow plugin declares its `apps/web/**` roots up front); missing roots
  are simply skipped.

Artifact **path collisions** across core + all plugins are rejected globally
(`collectAllArtifacts` throws if two artifacts share a path).

### Determinism requirements

`check:generated` runs the whole pipeline **twice** and hashes each plugin's
artifact group independently — any byte of drift between the two runs fails
with "plugin <name> artifacts are nondeterministic". Practical rules:

- Sort everything you iterate (directory listings, `Map` entries built from
  scans, your returned artifact array).
- No timestamps, randomness, absolute paths, or environment-dependent
  content in artifact bodies.
- Hooks must be pure: same repo state in, same bytes out.

## The runtime half

`apps/api` imports nothing from `packages/compiler`: it consumes generated
artifacts, has no YAML parser, and in a container the repo layout
`authoring.config.yaml` describes is not what it reads. So the compiler emits
**which plugins ship a runtime half** as an artifact —
`apps/api/src/generated/modules/registry.json`, always present, empty when none
do — and the API resolves those specifiers at boot.

The compiler records a specifier and never imports it. Resolving one would make
output depend on `node_modules` and break the determinism gates, which is the
same reason connector packages resolve at boot
(`apps/api/src/connectors/loader.ts`). Existence of a path plugin's `runtime.ts`
IS checked, because that is repo state like `webPresent`.

```ts
export type RuntimeModule = {
  name: string;                                     // must match the compiler plugin's
  init?(ctx): Promise<void>;                        // awaited before anything serves
  readinessChecks?: readonly ModuleReadinessCheck[]; // required dependencies for /api/ready
  close?(): Promise<void>;                          // awaited during process shutdown
  graphql?(ctx): ModuleGraphqlContribution;         // typeDefs + root fields + resolvers
  restRoutes?(routes, ctx): void;                   // fastify, inside the rate-limited scope
  seeds?: ModuleSeed[];                             // appended to the migration chain
  workers?: Record<string, ModuleWorker>;           // background roles, keyed by role name
};
```

Six properties are worth knowing:

- **Loading is fail-soft.** A module that throws on import, loads as something
  other than a `RuntimeModule`, or disagrees with its registration about its own
  name, is recorded as a failure and skipped. One broken plugin must not take the
  API down. Every failure is logged once at startup, because its surfaces are
  otherwise silently absent.
- **Root-field collisions are refused at boot.** `Query` and `Mutation`
  resolvers are merged per type, not spread; a module claiming a field the core
  or another module already owns fails startup rather than shadowing it. The
  reserved set is derived from the SDL, so it grows with the authoring YAML.
- **GraphQL is split into typeDefs / query fields / mutation fields** rather than
  one SDL blob, because the root types are assembled: `type Query` appears once
  and every module adds fields inside it.
- **Workers are separate processes, not timers.** See below.
- **Readiness stays one host-owned route.** A module contributes lowercase
  check names matching `[a-z][a-z0-9_]*`; it does not add a route. Names are
  unique across modules and cannot use the core `database`, `schema`, or
  `runtime_modules` names. Invalid or colliding names fail startup. Module
  checks are sorted by name after the core checks and use the same timeout,
  redaction, caching, and `503` behavior as every other `/api/ready` check.
- **Cleanup is awaited.** `close()` runs for every initialized module in reverse
  initialization order, both for the API and worker roles. A rejection does not
  skip the remaining module or host cleanup; shutdown rejects with an aggregate
  error after all cleanup has been attempted.

`restRoutes` is declared but unimplemented by the shipped workflow module,
which stays that way until the webhook trigger lands rather than being stubbed.

### Worker roles

`apps/api` has one entry point and several roles. `OPENSHAPEFORGE_ROLE` picks
which; `api` is the default, so an existing deployment keeps starting the
server it always did. Any other value is looked up among the worker roles the
loaded modules contribute:

```sh
OPENSHAPEFORGE_ROLE=workflow-worker bun apps/api/src/index.ts
```

```ts
workers: {
  "workflow-worker": {
    start({ db, log }) {
      return startTheLoop(db);          // -> { stop(): Promise<void> }
    },
  },
},
```

A worker is its own process rather than a timer inside the API, for three
reasons: a poll loop and a request path have unrelated failure modes and
unrelated scaling needs; a wedged worker must not take GraphQL down with it;
and the database connection differs — a worker connects as the
`openshapeforge_worker` role and presents `app.worker_role`, and the queue
policies check both ([api.md](api.md#the-worker-axis)).

Where the API role degrades, the worker role fails closed:

- **No `OPENSHAPEFORGE_WORKER_DATABASE_URL` is fatal, and there is no fallback
  to `DATABASE_URL`.** GraphQL without a database can still answer
  `DATABASE_NOT_CONFIGURED`; a queue-draining worker without one has nothing to
  do, and a process that idles while looking healthy is the worst outcome
  available. `DATABASE_URL` carries the API's role, which the queue policies do
  not admit, so falling back to it would produce exactly that process — the
  same value copied into the worker variable, and a URL naming any other role,
  are refused for the same reason.
- **A module that failed to load or initialise is fatal *if it owns the
  requested role*.** The API tolerates a missing module because its other
  surfaces still work; here the module *is* the process. The error names the
  load failure rather than reporting an unknown role, which would send an
  operator hunting a typo.
- **A role name claimed by two modules is refused at boot**, exactly as a
  colliding GraphQL field is.

`init` runs before any worker starts — the workflow module hydrates its node
catalog there, and a worker that claimed commands first would fail every one of
them with `NO_BRIDGE`, spending the retry bound on a configuration problem.

`stop()` must settle **after** the in-flight tick. `SIGTERM` (what a container
runtime sends) drains before exiting; a `stop()` that returned early would
leave one claimed command per replica `processing` until the visibility timeout
reclaimed it — every redeploy, costing the next worker a delay and an attempt.

In a cluster that contract is what `terminationGracePeriodSeconds` has to be
sized against. The Helm chart deploys a worker role as its own Deployment —
`workers.enabled=true`, `workers.role=<role>`, off by default — with no Service,
no Ingress and no probes, because a worker serves no traffic. See
[`deploy/README.md`](../deploy/README.md#worker-workload-optional-off-by-default).

## Shipped example 1: `entity-docs`

`examples/plugins/entity-docs.ts` — the minimal single-file plugin
(~50 lines). It has no platform tables and no authoring layer:

- `ownedPaths: { files: ["docs/entities.generated.md"] }`
- `generate({ manifest })` filters CRUD-eligible tables with
  `source.graphql`, sorts them, and emits one markdown file per run: entity
  heading (`TypeName (\`schema.table\`)`), the authored English label +
  provenance path, the enabled GraphQL operation names, and a column table.

The output, `docs/entities.generated.md`, is the always-current entity
reference for this repo (gitignored; recreate with `bun run generate`).

## Shipped example 2: `workflow`

`examples/plugins/workflow/` — a package-style plugin that exercises every
extension point at once. It packages the workflow node-catalog machinery
**as a standalone plugin** rather than as a built-in compiler feature: the
generators live in the plugin and run behind the web-gated UI path, so the
compiler core stays focused on the data layer.

**Contributed platform tables** (`contributePlatformTables`) — three global,
tenant-agnostic catalog tables (`tenantScoped: false`, `domainInternal:
true`, so no RLS and no generated CRUD/GraphQL surface):

| Table | Contents |
| --- | --- |
| `platform.workflow_node_catalog_entries` | one row per workflow node type (standard + entity catalogs), keyed by `catalog_checksum` |
| `platform.entity_trigger_registry` | one row per workflow-triggerable entity + its designer filter fields |
| `platform.entity_field_suggestions` | per-entity `Field[]` suggestion arrays for condition/variable pickers |

`db:migrate` fills them from the generated seed documents (see below). The
node-catalog table is shared by two seeds discriminated on `catalog`, so each is
authoritative over its own slice only — the mechanics live in
`apps/api/src/db/migrations/catalog-seed.ts`.

It also contributes the tenant-scoped `workflow.*` data and execution tables.
Five of those — `control_commands`, `schedules`, `schedule_fires`, `waits`,
`collection_waits` — declare `workerAccess: "workflow-worker"`, the queue a
worker claims across tenants; the rest get the plain tenant-isolation policy
and declare `workerDml: true` so the worker role can reach them one tenant at a
time. See [api.md](api.md#the-worker-axis).

**Contributed worker role** (`workers`) — `workflow-worker`, one process
draining `workflow.control_commands`. It connects as the `openshapeforge_worker`
database role, so it needs its own connection string and will not start on the
API's:

```sh
OPENSHAPEFORGE_ROLE=workflow-worker \
OPENSHAPEFORGE_WORKER_DATABASE_URL=postgres://openshapeforge_worker:openshapeforge_worker@localhost:5434/openshapeforge_dev \
  bun apps/api/src/index.ts
```

Whether it dispatches in-process or through a durable-execution service is the
deployment's choice and is logged once at boot; correctness does not depend on
the answer, because idempotency comes from the command row's conditional
consume rather than from whoever dispatches.

**Restored authoring layer** — `examples/plugins/workflow/authoring/` is
picked up as a layer automatically and ships:

- `workflow-nodes/**` — the node-config YAMLs the generators compile into
  the `standard` catalog: `flow/`, `triggers/`, `integrations/` and
  `orchestrator/`, fifteen node types in all. The packs that describe
  capabilities this repo does not provide — `ai/`, `messaging/`, `billing/`,
  case handling — moved to the `workflow-domain-nodes` plugin, which seeds
  them into the same table under `catalog='domain'`.
- `entities/core/relation.yaml` with `kind: entityPatch` — the **Relation
  entityPatch**: it strategically merges a `workflow.nodes.actions` block
  (create/getOne/list/update/delete: true) back onto the base Relation
  entity, opting it into entity workflow-node generation. This is the
  worked demonstration of plugin + authoring-layer + entityPatch
  composition.

**Generated artifacts** — `generate({ authoringDir, webPresent })` runs the
extracted generators against the *resolved* authoring dir and maps their
old repo paths to service paths:

- **api-side (always emitted)**, under `apps/api/src/generated/workflow/`:
  `node-catalog.ts` (types + the checksum that keys the runtime cache/seed —
  the catalog *data* lives in the Postgres tables above),
  `entity-workflow-nodes.generated.json` (one entry per entity action node,
  e.g. `entity.core.relation.create`), and the four seed documents
  `db:migrate` loads into the three tables above: `node-catalog.seed.json`
  (`catalog='standard'`), `entity-catalog.seed.json` (`catalog='entity'`),
  `entity-trigger-registry.seed.json` and `entity-field-suggestions.seed.json`.
  The last three are produced by the entity-node generator, which names them
  under web paths; the plugin maps them API-side because `apps/api` owns the
  tables — the same split the core applies to the page-config catalog. A host
  repo that deletes `apps/web` keeps its node catalogs.
- **web-side (only when `apps/web` exists)**: the workflow contract, designer
  registries, and renderer seeds under `apps/web/src/generated/workflow/`,
  `apps/web/src/features/renderer/generated/`, and
  `apps/web/src/features/workflow/lib/nodes/generated/` — mirroring the
  core's web gating.
- The `compiler/` and `generated/compiler/` prefixes carry the web client's
  copies of the field contract. Despite the workflow-named generator these
  are the *renderer's* core type surface — `@/generated/compiler/field-contract`
  alone has ~87 importers across `features/renderer` and `components/entity` —
  so both are mapped into `apps/web/src/`, with byte-identical content.
- Any other unmapped prefix is dropped entirely, matching the core's
  greenfield-safe behaviour.

`ownedPaths.roots` declares the api root **and** all three web roots, so the
stale/orphan gates cover the web side; they deactivate along with generation
if a host repo removes `apps/web`.

**Runtime half** — `examples/plugins/workflow/runtime.ts` contributes one seed
step, `workflowCatalogs`, which loads the four generated documents into the three
tables above. That is the whole reason the runtime contract exists here: before
it, `apps/api` carried a hardcoded path to a plugin's generated output, and a
repo that dropped the workflow plugin had to edit the migration chain to stop
seeding. `db:migrate` reports the result under the seed's name.
