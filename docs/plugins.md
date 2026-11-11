# Plugins

In production, outbound HTTP calls require one initialized runtime module to
provide the egress owner. Without one, the API emits startup warning
`EGRESS_OWNER_REQUIRED` and refuses outbound calls with HTTP 503 of that code;
connector invocations, OAuth exchanges and provider discovery cannot succeed.
Deployments that intentionally make no outbound calls may run without an owner.
Configure exactly one owner and its host allowlists before enabling outbound
integrations. This requirement does not relax any TLS, DNS or host checks.

Core does not leave private-address blocking to the owner. For every request an
owner receives — connector calls and each redirect hop, declarative MCP
execution, OAuth exchanges and discovery — core resolves the host, refuses it if
any answer is a loopback, link-local, private or otherwise non-public address,
and passes the checked addresses as `resolvedAddresses`. In every environment
the owner must declare `pinsResolvedAddresses: true`, a promise to dial only
those addresses while keeping the hostname for TLS; an owner without it is
reported at startup and every outbound call fails with 503
`EGRESS_OWNER_REQUIRED`.

`platform.egress.request(session, grant, request)` sends one HTTPS POST for a
Connection resolved through `platform.secrets`. The destination must pass that
Connection's Adapter allow-list, and the `egressGrant` works once, only in the
session that resolved it, for at most five minutes. Core refuses a host with any non-public
address and passes the checked addresses to the owner as `resolvedAddresses`.
Every environment requires an owner that declares
`pinsResolvedAddresses: true`, a promise to dial only those addresses while
keeping the hostname for TLS; otherwise the call fails with 503
`EGRESS_OWNER_REQUIRED`. The request is never
retried and a redirect is a refusal. The body is buffered up to a budget: an SSE
response is returned once the upstream closes it, and one still open at the
deadline fails, so this does not carry streaming notifications.

`platform.egress.connect(session, grant, request)` opens a raw socket to a
`host:port` the Adapter grants. Core resolves the name itself, refuses the
connection if any answer is a loopback, link-local, private or otherwise
non-public address, and dials only the checked addresses while keeping the name
for TLS. A module's `rejectUnauthorized: false` is ignored unless the deployment
sets `OSF_SOCKET_EGRESS_ALLOW_INSECURE_TLS=1`; leave it unset outside test
environments.

Canonical read handlers can call `platform.readProgress?.report(session, {data, message})`
to publish provisional evidence while the original request is still running.
The ordinary final result remains mandatory and unchanged. Core accepts only
the current verified session and the root read operation (data read, external
none/read); nested operations and writes cannot publish snapshots. Delivery is
optional and bounded: 20 delivery attempts, 64 KiB each, 512 KiB per invocation. A failed
notification never replaces the final result. Providers must project data for
the caller before reporting it, just as for their final output. This includes
free-text messages: never include credentials. Reporting awaits delivery, so
report between transaction-heavy stages rather than on every record. Each
delivery waits at most 250 ms and observes read cancellation; the normal final
result is retained when delivery fails or stalls. Clients ignore late progress
after the original RPC finishes. Opt-in cancellation applies only to top-level
reads and their inherited nested reads; ordinary clients and writes retain
their existing cancellation behavior.

MCP clients opt in with `_meta["openshapeforge/read-progress"]: {version: 1}`
and a standard progress token. Snapshots travel in that namespace on standard
progress notifications, with core-issued operation ID, sequence and read-only
marker. A client may display available evidence and later reconcile the final
result of the same RPC. Other clients simply await that final result. This
capability stores no source data and does not repeat provider reads.

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
session/public/capability/custom authentication; tenant and idempotency semantics; a runtime handler key;
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
security scheme, and only available through its REST projection. A
`capability` Operation is REST-only too, but core owns its credential: a
hashed, expiring, recipient-bound **capability grant** that core resolves
into a grant session (`credential: "grant"`, tenant, no roles,
`session.grant`) before the handler runs, and counts as used inside the
handler's transaction — see [capability-grants.md](capability-grants.md).

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
Authentication-service unavailability (a bearer verifier that is not
configured or cannot be reached, an API key path that is not fully
configured) is always answered with `503 AUTHENTICATION_UNAVAILABLE`, on every
transport and whether or not the operation declares that error; a declaration
only lets the operation carry a fixed body for it.

For `idempotency-key` operations, the canonical input field is required on all
transports. REST clients supply it only through the declared required header;
the runtime injects that header into canonical input before validation.
Core then binds the key to the verified tenant and actor, the canonical
Operation contract, and normalized authored input. Completed JSON results are
replayed before one-shot version, lease, or confirmation controls are consumed
again; current session and record authorization is still checked on every
call. A concurrent call receives `OPERATION_IN_PROGRESS`, while reusing the
same key for different authored input receives `IDEMPOTENCY_KEY_REUSED`.
Database-only effects and their receipt share one transaction. An external
write first persists a running receipt; if its outcome is lost, core returns
`OPERATION_OUTCOME_UNKNOWN` and never repeats the effect automatically.
Schema, authorization, version, lease, and confirmation refusals that happen
before authored effects leave no receipt, so corrected input may reuse the key.

### Derived-tool execution bindings

A plugin that projects stored rows as MCP tools through its temporary
`executionCompatibility` seam names where the ordered binding
rows live with **`bindingsRelation`**: an owned `hasMany` collection on the
owner. The compiler resolves the collection's target, checks that the target
carries the execution vocabulary (`operationRef` as a `belongsTo` relationship
to `operationEntity` with a foreign key, `parentRef` as a `belongsTo` to the
owner with a foreign key, plus required integer `order`, boolean `optional`,
object `when`, object-collection `inputMapping` / `outputMapping`, and object
`forEach`), and projects the target table and parent foreign key into the
catalog. The runtime then joins those rows under the caller's session (RLS /
tenant scope) and orders them by `order`. The compiler refuses a missing
`bindingsRelation` and names the owner entity.

Do not author `bindingsEntity` or `parentRef`: they are inferred from the
owned collection. The catalog still carries the resolved names so the runtime
can join without knowing the plugin.

**Audience.** The roles a session must hold for the rows to project as tools
and to execute are, by default, the roles of the definition entity's canonical
read — "may use the tools" then means "may read the definitions". A plugin
whose users may call what only its administrators may read names the wider
set on the record as `audience: ["integration_user", "integration_admin"]`;
the entity's read roles stay as authored. Every audience role must exist in
the generated realm (declared in `authorization.yaml`, or named by an entity
or Operation the realm generator emits); an unknown role or an empty audience
fails the build.

```ts
executionCompatibility: {
  version: 1,
  records: [{
    entity: "Service",
    // ...
    audience: ["integration_user", "integration_admin"], // optional; default: Service read roles
    execution: {
      bindingsRelation: "capabilityBindings", // owned hasMany on Service
      operationRef: "capabilityId",
      operationEntity: "Capability",
      providerRef: "adapterId",
      providerEntity: "Adapter",
      connectionEntity: "Connection",
      connectionProviderRef: "adapterId",
      connectionValuesField: "configurationValues",
    },
  }],
}
```

### Binding a run to one provider account

A Service invoked from a canonical Operation
(`context.invokeDeclarativeService`) runs against whichever Connection the live
session is authorized for **now**. For a plugin that synchronizes records that
is not enough: the provider ids it queued mean something in exactly one
account, and an administrator may retire, replace or add a Connection between
the first page of a run and the last. Writing a queued record's provider ids
through a replacement would address the wrong account with working
credentials.

Two halves of one contract close that, and neither selects a Connection:

- **`connectionUse`** on a SUCCESSFUL result says what the invocation actually
  obtained provider credentials from, as core observed it at each credential
  boundary. `{ outcome: "one-connection", expectedConnection }` — every
  provider call used one Connection, and here is the expectation that names it.
  `{ outcome: "no-single-connection" }` — credentials came from more than one
  Connection (two Adapters, say, or a personal plus an organization
  Connection), or from one core cannot name for this session. `{ outcome:
  "no-provider-call" }` — every binding that ran was the platform-owned native
  transport, so nothing external was addressed. A failure, including a
  composition that stopped part-way, carries no `connectionUse` at all.
- **`expectedConnection`** on a request refuses the invocation unless every
  binding that obtains Connection credentials obtains them from exactly the
  Connection it names. It is a refusal, never a selection: core authorizes
  Connections exactly as it would without it, then compares. It is verified per
  binding where the credentials are read, so a replacement that lands mid-call
  fails closed rather than reaching the new account, and a composed call is
  checked over all its captured steps before the first binding runs. A binding
  the Service declares `optional` does not absorb it either: `optional` means a
  source may be unavailable, and this says the step would have run in another
  account — so it fails the invocation rather than being reported as a skipped
  step. The one answer is `EXPECTED_CONNECTION_UNAVAILABLE` (409), deliberately
  the same whether the Connection was retired, replaced, deleted with nothing
  in its place, never this session's to use, or named by a value this session
  cannot resolve at all.

The reference is core-minted, opaque and not constructible: it commits the
tenant, the scope, the acting person for a personal scope, the connection table
and the connection ROW. A replacement holding byte-identical credentials is a
different row, and therefore refused.

A caller may also name the Connection by its own id instead; see *Binding the
first call* below for when that is the right one to set.

Both halves cover the whole invocation, not only the Service's own bindings. A
binding on the platform-owned native transport runs a canonical Operation
in-process, and that Operation may open a Connection's credentials
(`platform.secrets.resolveConnectionValues`) or invoke a further declarative
Service. Those are credential boundaries of the same invocation: each is held
to the same expectation and recorded into the same capture. So a Service that
reads from one account and synchronizes through an Operation that reaches a
second is reported as `no-single-connection` rather than as either of them, and
a nested invocation may confirm the inherited expectation — by presenting the
same value, or by naming the same Connection the other way — but cannot replace
it with another Connection. What no expectation covers is work a nested
Operation *defers* rather than performs: a durable job or queued outbox entry
runs later under its own invocation and carries no expectation from this one.

So a paginated run wires up as: invoke the first page bound to the id of the
Connection it was planned against (below), require
`connectionUse.outcome === "one-connection"`, persist that `expectedConnection`
with the queue state, and present it verbatim on every
later page. From the second call onwards the run is bound to one account, and
the moment that account's Connection is no longer the one in use the run fails
closed instead of continuing in another. A run that cannot get a single
identity — `no-single-connection` or `no-provider-call` — has nothing to bind
to and should refuse rather than pick one.

Neither half discloses anything. A reference naming no Connection this session
may use refuses with the same answer as one that was replaced, and
`connectionUse` only ever names a Connection the invocation already used under
the caller's own authority.

#### Binding the first call, before there is a reference

"From the second call onwards" is a gap, and the first call is where a run's
records are captured. A sync reads the Connection it means to synchronize from,
holds that Connection's id, and only then invokes the Service — and an
administrator may replace the Connection in between. The first page then runs
against the replacement and stores its records under the id of the Connection
the sync believed it read.

So `expectedConnection` may instead carry the Connection's own id, scoped to
the tenant of the session that presents it:

```ts
// First page: bind to the Connection this run was planned against.
const first = await context.invokeDeclarativeService({
  definition, input,
  expectedConnection: { connectionId, appliesTo: "every-provider-call" },
});
// Later pages: present what core captured, which commits more than an id does.
```

Same control, same refusal, one call earlier — and the same scope, so a nested
invocation and anything a native binding's Operation opens are held to it too.
It authorizes nothing and selects nothing: an id naming a Connection this
session may not use refuses identically to one that was replaced, so it
discloses nothing either, and a malformed id refuses rather than matching
loosely.

The two representations are mutually exclusive by shape — exactly `appliesTo`
plus exactly one of `sourceReference` and `connectionId` — and core checks
that, so a caller cannot present an id a host reads next to a reference it
ignores. Where both end up in force (an invocation bound by id that nests one
presenting the reference, or the reverse) the invocation is held to **both**:
each is resolved against the row at every credential boundary, and a row that
is not the one each of them names refuses. Neither is dropped and neither is
preferred.

Prefer the captured reference wherever a run has one. The id commits the tenant
and the row; the reference also commits the scope and the connection table, and
cannot be constructed by a caller at all.

#### Check that the host enforces it, first

`expectedConnection` is a refusal, so a host that did not implement it would
ignore the property, run the invocation against whichever Connection the live
session is authorized for, and answer an ordinary success — in the wrong
account. A result cannot tell the two apart, and `connectionUse` is core's
observation of the call just made, not proof that the control was armed before
it. So ask before invoking:

```ts
const enforced = context.declarativeServiceCapabilities?.expectedConnection;
if (!enforced?.includes("every-provider-call")) {
  return refuseThisPage();            // core is never asked
}
return context.invokeDeclarativeService({ definition, input, expectedConnection });
```

`declarativeServiceCapabilities` (`RuntimeDeclarativeServiceCapabilities`) is on
the `RuntimeOperationExecutionContext` a record-derived Operation provider is
handed, and on `platform` (`PluginPlatformServices.declarativeServiceCapabilities`)
for a canonical Operation handler, which holds `platform` rather than that
context. One frozen object from one source: the host's registered declarative
engine states what it enforces on itself, core narrows that claim to the checks
it actually performs, and the platform slot is a setter-less, non-configurable
accessor — so no module, plugin or MCP interceptor can claim, widen or withdraw
the signal, for itself or for anybody else.

Read it as a list, and fail closed. The whole property is absent on an OSF that
predates the control and reads `undefined` on a runtime with no declarative
engine; either way a plugin that needs the control must refuse rather than
invoke the Service and hope. A scope missing from the list is not enforced, and
an invocation that sets one is refused by the same parser rather than run with
a weaker expectation than it believes it set.

The signal advertises capability only. It says nothing about which Connections
or Services the caller may reach: a denied invocation is denied identically on a
host that advertises everything, and a reference naming a Connection this
session may not use still answers `EXPECTED_CONNECTION_UNAVAILABLE`.

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
  operationCatalog: {
    version: 1;
    operations: readonly (
      | CompiledStaticEntityOperation
      | CompiledPluginOperation
    )[];
  };                                  // complete static Operation catalog
  fieldSchemas: FieldSchemaCompiler;  // canonical FieldDefinition projector
};

export type CompiledEntityInfo = {
  slug: string;
  path: string;                        // repo-root-relative provenance path
  origin: "core";
  contract: CompiledEntityContract;    // storage, model, graphql, views, …
};

export type GeneratedArtifact = { path: string; contents: string };
```

A plugin module **default-exports** a `CompilerPlugin` with a non-empty
string `name`; duplicate names across registered plugins are an error.

`operationCatalog` is the public consumer boundary for plugins that derive
workflow nodes, audit policy, or another projection from Operations. It is
compiled once from the resolved layers, contains both canonical entity CRUD
and authored entity/module plugin Operations, rejects duplicate ids across
those sources, and is sorted by stable Operation id. Plugin Operations carry
`id === key` and `intent: "invoke"`; entity Operations keep their canonical
CRUD intent and symbolic entity input/output contract, and additionally carry
concrete `inputSchema`/`outputSchema` for build-time consumers. Those schemas
describe the shared executor boundary (`values` plus platform-owned mutation
controls), not a flattened transport request. They are projected from the same
compiled field-schema helpers as the generated interfaces, including writable
field eligibility and implicit relationship keys. A plugin should consume this
catalog instead of parsing entity YAML or inferring actions from transport
routes.

`fieldSchemas` is bound to the resolved component, osf-type and reference-
data catalogs for the current host. A generator that publishes configurable
fields can call `fieldSchemas.field(definition)` for one value schema or
`fieldSchemas.object(definitions)` for a strict object schema. Both paths use
the entity field compiler, including nested `children`/`item`, defaults,
options, shared validation and collection cardinality bounds. The pure
`createFieldSchemaCompiler`, `compiledFieldSchema`, `compiledObjectSchema` and
`resolveModelFields` helpers are also exported from the compiler package root
for build-time tooling. Runtime modules that must turn stored, user-authored
FieldDefinitions into an Operation interaction schema use
`context.platform.schemas.fields.object(definitions)`. The host validates the
definitions against the generated authoring schema and binds the same projector
to its active osf-type and reference-data registries; plugins neither
import the compiler at runtime nor supply a fallback catalog.

The compiler also emits
`apps/api/src/generated/compiler/field-authoring-registry.json` for a host that
mounts a shared FieldDefinition editor. Its stable envelope is
`{ version: 1, fieldAuthoringProfiles, osfTypes, referentiedata }`. These
are the raw, layer-resolved catalog values: profile and osf-type extension
properties, reference-group metadata, and multilingual item labels are kept
intact. A host may inject this JSON into an interface-specific renderer; the
renderer must not parse authoring YAML or maintain a second field-schema
compiler. The artifact lives API-side so it is available to headless and
`apps/product-web` hosts without implying an `apps/web` implementation.

### Registration

In `authoring.config.yaml`:

```yaml
plugins:
  - ./examples/plugins/entity-docs.ts       # local module (relative/absolute path)
  - ./examples/plugins/notebook/index.ts    # local package-style plugin
  # - "@openshapeforge/plugin-notebook"         # or a workspace/npm package specifier
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
  a `source.graphql` block: `generatedCrudEligible: true` and not
  `domainInternal`.
- A contributed table may declare **`workerAccess: "<role>"`** to let a
  background worker reach it across tenants without `app.bypass_rls`. It
  requires `tenantScoped: true`, widens rather than narrows, and belongs only
  on queue-shaped tables a worker drains — see
  [api.md](api.md#the-worker-axis). The manifest loader validates the field
  for YAML-authored tables; the emitter repeats both checks, because
  `contributePlatformTables` never passes through the loader.
- A column `references` into a **tenant-scoped** table must bind the tenant:
  `references: { schema, table, column: "id", localColumns: ["tenant_id",
  "<column>"], targetColumns: ["tenant_id", "id"] }`. A global table names
  its own tenant column in `localColumns` instead. The emitter refuses the
  single-column form and provisions the `(tenant_id, id)` unique key on the
  target.
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

`db:migrate` applies every entry after the generated tables exist and before
the grant sweep, on every run, in plugin-then-version order, each in its own
transaction — and keeps no ledger. A database is built from the manifest, so
there is no earlier phase in which legacy ownership could be transformed: a
contributed table's shape is declared, not migrated to. `constraints` are
rendered by the compiler as name-guarded DO blocks, so they are repeatable by
construction; free-form `schemaMigrations` must be written that way by the
plugin (`CREATE OR REPLACE`, `IF NOT EXISTS`, a guarded DO block), because an
entry that fails on its second run is rolled back and named in the error.
Changing a constraint moves the manifest checksum and the built database is
refused until it is rebuilt with `bun run db:reset`; the version is an
ordering key within the plugin, not a history.

### `ownedPaths` and the gates

Declaring `ownedPaths` opts your output into the same freshness/orphan gates
the core enjoys:

- **Stale**: `check:generated` compares every emitted artifact against disk.
- **Orphan**: every existing file under an owned `root` (or listed `file`)
  that a fresh generation would **not** emit fails the check — so deleted
  outputs cannot rot on disk.
- Declare roots that don't exist yet if you will emit into them later (a
  plugin with web-side artifacts declares its `apps/web/**` roots up front);
  missing roots are simply skipped.

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
  mcp?: RuntimeMcpContribution;                     // per-session MCP surfaces and policy refinements
  graphql?(ctx): ModuleGraphqlContribution;         // typeDefs + root fields + resolvers
  restRoutes?(routes, ctx): void;                   // fastify, inside the rate-limited scope
  seeds?: ModuleSeed[];                             // appended to the migration chain
  workers?: Record<string, ModuleWorker>;           // background roles, keyed by role name
  jobHandlers?: Record<string, ModuleJobHandler>;   // durable job kinds, keyed by kind — see jobs.md
  executionPolicies?: readonly ModuleExecutionPolicy[]; // host-wide execution admission — see execution-policies.md
};
```

Seven properties are worth knowing:

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
- **Direct lookup is distinct from discovery.** A module may provide
  `mcp.getTool(name, context)` as its complete live lookup for one own tool.
  It returns the same available contract as `tools(context)`, or `undefined`
  when absent. Core uses it for namespaced calls and ownership checks while
  retaining collision checks for the requested name, decorators, authorization
  and interceptors. Whole-projection uniqueness is still checked at discovery.
  `tools(context)` still owns discovery; modules without `getTool` keep their
  full projection. Keep discovery-only instruction or onboarding reads out of
  exact lookup. Resolve availability from the current session and canonical
  Operation rather than caching task data or trusting an earlier listing.
- **Module authorization only narrows or claims.** `mcp.authorize(session,
  request)` receives the verified session capability and typed subject. Return
  `undefined` to abstain, an allowed decision to claim the module's registered
  tool or exact/template resource, or narrow visible fields, or an existing
  typed denial. Entity rows remain core-only. Core denials remain authoritative,
  any module denial wins, and bounded field allowlists are intersected. The hook
  receives no platform service or recursive callback. Malformed decisions fail
  closed. A derived-tool projection can name its canonical output definitions
  with `derivedTools.outputFieldsField`; core then removes secret-classified
  fields before exposing the allowlist to module refiners.

`jobHandlers` is how a module takes part in the core job queue: an Operation
handler enqueues (`platform.jobs.enqueue`) inside its own transaction, and the
core `job-worker` runs the handler registered for that kind later, under a
tenant session for the job's tenant. A kind two modules both register fails
composition at boot. The queue, its states — including `outcome_unknown`, the
job form of `OPERATION_OUTCOME_UNKNOWN` — the `mail.deliver` kind and the
operator Operations are described in [jobs.md](jobs.md).

`executionPolicies` is the orthogonal seam: not one authored action on one
record, but whether this tenant may change anything at all right now. Core
evaluates every contributed policy before it runs a governed canonical
Operation — any data write or delete, or an external write — on every
transport, and before a claimed job reaches a contributed `jobHandlers`
handler, under the caller's own tenant-scoped transaction and verified session.
Reads, sign-in and core's own identity bookkeeping stay outside it; a host that
contributes none keeps its current behaviour exactly. Three consequences for a
module that contributes one: a decision must be a read — core evaluates it in a
read-only savepoint it rolls back either way, though it sandboxes neither the
SQL nor the JavaScript a trusted module runs there; a module that declares a
policy and then throws in `init` stops the process from starting, in the API
role and in the worker role alike; and a host that cannot afford to lose the
owner names it in `OPENSHAPEFORGE_REQUIRED_EXECUTION_POLICY_MODULES`, which
also catches the module that never imported at all. The contract, the
composition rule, the `EXECUTION_NOT_PERMITTED` refusal and the limits are in
[execution-policies.md](execution-policies.md).

`platform.principals` is how a module learns **who** is calling it, as the
host classified it: `classOf(session)` answers `person`, `application`,
`service` or `unknown`, and `application(session)` answers
`{ integrationId }` for a resolved API key and `undefined` for every other
carrier ([api.md](api.md) lists which carriers produce which). `person` means
the host positively verified a human login, so a module that branches on it
must treat `unknown` as "not shown to be a person" rather than as a default —
a linked Relation is not a classification, and a trusted-context producer that
has not been redeployed to sign the class answers `unknown`. A module acting
for an external application needs that identity for three things authorization
does not give it — the namespace its idempotency keys live in, the provenance
it stores on the rows it writes, and the actor it appends an event for — and
every one of those must survive a hostile caller, so **none of them may come
from request input**: not a header, not a path parameter, not a key id a client
happens to know. Two limits make the service safe to hand to plugin code. It
answers for the live session this invocation was handed and refuses any other
object, so a module cannot build a session naming an integration of its choice;
and it authorizes nothing — the answer is an identity, never a permission. A
module that needs to know whether it MAY act asks `platform.records`.

`platform.records` carries the record ACL's two axes. `assertAccess` /
`assertAccessMany` authorize a record PERMISSION through the entity's own
Operation, and three calls serve the named-action axis
([authoring.md](authoring.md)): `assertAction` refuses unless the session holds
one named action on one record, `readForAction` returns exactly the fields that
action declared under `reads`, and `holdsAction` answers the same question as a
boolean. The third exists for the case the other two cannot serve: a
**plugin-owned table whose rows belong to a host record** — no entity, no ACL,
no CRUD of its own. Rather than copy the host's policy or read its ACL, the
module asks the one question core can answer and decides for itself what the
answer means for its rows.

Called inside the module's active transaction — an Operation's, or one opened
through `platform.db.withSession`, which the host treats as the same
transaction — the check holds the record's ACL-row lock there until that
transaction commits, so the module's writes happen under the lock that
admitted them and a concurrent revocation cannot interleave with them. Called
outside one it is an early answer and holds nothing. None of the three makes
the record readable: a holder of an action has no `view`, so the row-scope
policy still hides it from the module's own SQL, and `readForAction` is the
whole execution capability. `examples/plugins/notebook` is the worked example
— `Notebook.deliver` plus `notebook.notebook_deliveries`.

`readForAction` is additionally **bound to the Operation's own target**. The
other two answer a question about the session's grant; this one discloses
record fields the session has no `view` on, so it serves the one record and the
one action the host authorized this invocation on — `auth.recordAction` on
`target.inputField` — and refuses every other record the same grant reaches. A
session granted `deliver` on fifty records holds the action on all fifty; the
handler reads the one its caller named. The target is stated by the dispatcher
inside the Operation's transaction, after the decisive check and under the
ACL-row lock it took, and a handler that dispatches a second Operation does not
lend its target to that Operation's handler. Outside a record-action Operation
there is no target and `readForAction` reads nothing; `holdsAction` is the call
that still works there.

#### The module database trust boundary

That target binding, and the verified principal `platform.principals` reports,
are enforced **in this process**. They are not database boundaries and cannot
be made into ones as the module database surface stands: `platform.db
.withSession` hands the module the Operation's own transaction on the app
role's connection, so core's statements and the module's are the same database
principal and PostgreSQL cannot tell them apart. A module that writes its own
SQL can call `app.record_action_read` directly (EXECUTE is granted to the app
role) and can overwrite the `app.*` session placeholders that carry the
verified identity — `revoke set on parameter` records nothing for a placeholder
GUC, verified on PostgreSQL 17.11, which is also why
`db/migrations/record-actions.ts` refuses to depend on `app.bypass_rls`.

The credential fence ([authoring.md](authoring.md)) sits on the same side of
that boundary: `platform.records` asks `app.record_action_principal_live()`
before the lookup, so every route core offers a module is fenced, and raw SQL
that calls `app.record_action_allows` itself is not. What a module reaches that
way is bounded as below — another declared projection of the same shape — and
widening it to another live credential of the same tenant, which is the most
the placeholders admit, reaches no further.

What the database enforces regardless, for core and module alike, is the
resolver role's **column** grants: only the columns an action declared under
`reads` are selectable at all, the ACL column and the tenant column are refused
outright, and the app role's own view of the table is never widened. So the
most a hostile module reaches by going around the service is another declared
projection of the same shape — never an undeclared column, never the ACL, never
the record itself.

Closing the rest needs a **database role of its own for module SQL**, on its
own connection, without EXECUTE on `app.record_action_*` and with its own
privilege and policy surface, so that core's guards run as a principal the
module cannot impersonate. That is a change to the module database boundary
rather than another check inside it, and it is the boundary the in-process bind
stands in for until it lands. Reviewing a module's SQL remains part of
admitting the module.

`platform.webhookSecrets`, when the host provides it, is how a plugin accepts
signed inbound webhooks without reading the signing secret: `seal` encrypts a
credential's secret under the host keyring, and `verify` /
`withVerifiedSignature` check a delivery's hex HMAC-SHA256 over
`timestamp + "." + eventId + "." + rawBody`, with the timestamp at most 300
seconds from the host clock (`packages/plugin-runtime/src/webhook-secrets.ts`).
A valid signature proves who sent the bytes, not that this is the first time
they arrived: core keeps no record of accepted deliveries, so the same signed
delivery verifies again for as long as its timestamp is inside the window.
**A plugin that accepts webhooks must dedupe them itself** — record each
accepted delivery's credential id, event id and signature for at least the
300-second window, refuse one whose event id or signature was already accepted,
and make the effect of a delivery idempotent where the provider's own retries
can repeat it.

### Worker roles

`apps/api` has one entry point and several roles. `OPENSHAPEFORGE_ROLE` picks
which; `api` is the default, so an existing deployment keeps starting the
server it always did. Any other value is looked up among the worker roles the
loaded modules contribute:

```sh
OPENSHAPEFORGE_ROLE=job-worker bun apps/api/src/index.ts
```

```ts
workers: {
  "my-worker": {
    start({ db, log }) {
      return startTheLoop(db);          // -> { stop(): Promise<void> }
    },
  },
},
```

Core contributes one worker role of its own, `job-worker`, which drains the
job queue every module enqueues into ([jobs.md](jobs.md#the-worker)); it is
started the same way and holds the same contract.

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

`init` runs before any worker starts — a module that hydrates a catalog there
would otherwise have its worker claim commands it cannot resolve, spending the
retry bound on a configuration problem.

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

## Shipped example 2: `notebook`

`examples/plugins/notebook/` — a plugin that is an authoring layer plus one
canonical plugin Operation: no generators and no platform tables. Its two entities,
`Notebook` and `NotebookVersion`, are declared in module `notebook`, so their
tables are `notebook.notebooks` and `notebook.notebook_versions` rather than
anything under `erp`, and `Notebook` declares the generic
`versioning: publishedSnapshot`.

That is the case the versioning runtime has to handle without knowing the
entity. The compiler binds the exact storage of both sides into the head
table's manifest source (`source.versioning.storage`: head schema and table,
version schema and table, and the version table's foreign key back to the
head); the API serves that through `platform.schemas.versioning`, and
`Notebook.publish` executes against those names and nothing derived from
`"Notebook"`. `apps/api/src/graphql/__tests__/plugin-versioning.e2e.test.ts`
creates a notebook, publishes it twice and reads the versions back through the
generated GraphQL surface.

`notebook.import` is the plugin Operation: a keyed command (`Idempotency-Key`
on REST, `idempotencyKey` everywhere else) with a REST path parameter, an MCP
tool and a GraphQL mutation, declared through the compiler contract's
`operations` and bound to the handler in `runtime.ts`, which replaces a draft
notebook's body inside the caller's tenant session. It is the one module-level
plugin Operation this repository composes, so the operations runtime and the
transport tests exercise every plugin-Operation path through it: binding
(`bindOperationHandlers` refuses a catalog Operation without a loaded module),
contract validation, idempotency keys and session authorization
(`apps/api/src/operations/runtime.test.ts`).

### Compiled runtime configuration

A compiler plugin may implement `runtimeConfiguration({ entities })` to derive
nonsecret JSON from the host's compiled entity contracts. The compiler records
that value in the module registry. Configuration must contain finite JSON data:
cycles, undefined values, sparse arrays, accessors and symbol properties are
refused. Credentials and request/session authority belong in the existing
platform ports, never in this generated artifact.

A configured runtime exports a factory `(configuration: unknown) => RuntimeModule`
instead of a singleton module object. The loader passes a detached configuration
and checks the returned module name against the compiler registration. The
factory must validate its own configuration and create isolated handlers; an
invalid factory is reported as a load failure, and canonical operation boot
validation remains fail closed. Packages must never import configuration from a
consumer source tree. For example, branding derives Tenant.logo transforms;
another plugin can derive locale/format settings without sharing mutable state
between hosts. Ordinary modules without build configuration export their module
object directly.

"Isolated" means isolated *state*: each configured instance gets its own
detached copy of the configuration and its own handlers. It is not a sandbox.
A runtime module is imported into the API process and runs with its
privileges — `process.env` (including the secret keyring), the database
handle, the network — exactly as the
[connector execution trust model](connectors.md#execution-trust-model)
describes for connector packages. Load only reviewed modules.


### Predefined tenant variables

A runtime module may contribute `tenantSettingDefaults`: ordinary `namespace`,
`key`, canonical stored `definition`, optional `value` and `description` metadata.
The same runtime field-schema compiler that validates typed CRUD values validates
these defaults. A confidential definition must start unset; never ship provider
keys or other plaintext secrets in defaults. Duplicate contributed slots are
refused before persistence.

Platform tenant provisioning and the closed managed-tenant provisioning command
insert missing declared variables. `db:migrate` reconciles existing tenants under
an audited system session. Existing rows, definitions, values, ciphertext and
versions are never rewritten. The normal tenant-variable CRUD operations own
subsequent edits. The core palette uses this same insert-only reconciliation.
