# The API

`apps/api` is a Bun + Fastify + graphql-yoga service whose entire entity
surface is derived from the generated manifest
(`apps/api/src/generated/db/manifest.json`) at module load. There is no
per-entity resolver code; a new entity YAML plus `bun run generate` extends
the schema automatically.

Endpoints (`src/roles/api.ts`):

| Route | Purpose |
| --- | --- |
| `POST/GET /api/graphql` | GraphQL (GraphiQL enabled unless `NODE_ENV=production`) |
| `/api/rest/v1/<basePath>[/:id]` | Generated REST (entities that opt in via the `rest:` block) |
| `GET /api/rest/openapi.json` | Generated OpenAPI 3.1 spec for the REST surface |
| `GET /api/health`, `/api/ready`, `/api/graphql/health` | liveness/readiness |

On startup (`onReady`) the API compares the database's applied
generated-schema checksum with the bundled manifest — see
[migrations.md](migrations.md#drift-signals).

## The generic CRUD engine

`src/graphql/generated-entity-schema.ts` builds the SDL and resolvers from
every manifest table with `generatedCrud: true`, not `domainInternal`, a
primary key, and a `source.graphql` block. Per entity `Thing` it emits:

- `type Thing` — one field per column (snake_case → camelCase via
  `sourceField`), plus relationship fields and `<rel>Aggregate:
  AggregateResult!` (`{ count }`).
- `ThingConnection` / `ThingEdge` / `PageInfo`, `ThingFilter`, `ThingSort`,
  `CreateThingInput`, `UpdateThingInput`.
- Queries `thing(id: ID!)` and `things(filter, sort, first, after)`.
- Mutations `createThing(input)`, `updateThing(input)` (input carries `id`),
  `deleteThing(id): Boolean!`.

Engine semantics (`src/graphql/generated-crud.ts`):

- **Filters** — for every field the filter input has `field` and `fieldIn`.
  Text fields match `ilike '%value%'`; other types match equality; `fieldIn`
  is a SQL `IN` list. Null/empty filter values are ignored. Unknown filter
  fields are `BAD_USER_INPUT` errors.
- **Sort** — single field + direction; unknown fields fall back to the
  primary key; direction defaults to `asc`.
- **Cursor pagination** — `first` is clamped to 1..200 (default 50);
  `after` is a base64url-encoded offset cursor. Connections return
  `pageInfo { hasNextPage, endCursor }` and `totalCount`.
- **`totalCount` is opt-in and costs a second pass.** It is a real `count(*)`
  under the same filter, so it cannot stop at `first`, and a text filter
  compiles to an unanchored `ilike '%value%'` that no b-tree index answers. On
  a large tenant it is a sequential scan. It therefore runs **only when the
  query selects the field** (through a fragment or an alias too) — a page that
  does not ask for it issues one statement, not two. REST and MCP always
  publish a count in their list bodies, so they always pay for it; a GraphQL
  client that wants a cheap page simply omits the field.
- **Relationship traversal** — `belongsTo` resolves the single parent via
  the FK on the row; `hasMany` resolves an embedded list (limit 50) filtered
  on the target's FK column, ordered by the target's compiler-derived
  `defaultSort` (from its list presentation) when one exists.
- **Writes** — writable columns exclude the primary key, identity columns,
  `tenant_id`, `created_at`, and `updated_at`. Create injects `tenant_id`
  from the session; update always sets `updated_at = now()`; delete returns
  `true` only when a row (visible to this tenant) was actually removed.

## The generated REST surface

`src/rest/generated-rest-routes.ts` is the REST counterpart of the GraphQL
schema builder. Entities opt in per entity with a `rest:` block in their YAML
(see [authoring.md](authoring.md#rest-generated-rest-exposure)); the compiler
bridges it to `source.rest` in the manifest, and every such table gets routes
under `/api/rest/v1/<basePath>`:

| Route | Operation flag | Success |
| --- | --- | --- |
| `GET /api/rest/v1/<basePath>` | `list` | `200 { items, totalCount, nextCursor }` |
| `GET /api/rest/v1/<basePath>/:id` | `get` | `200` row (`404` if not visible) |
| `POST /api/rest/v1/<basePath>` | `create` | `201` row |
| `PATCH /api/rest/v1/<basePath>/:id` | `update` | `200` row (partial update) |
| `DELETE /api/rest/v1/<basePath>/:id` | `delete` | `204` |

Handlers delegate to the same `generated-crud.ts` functions as the GraphQL
resolvers — same auth (`resolveSessionContext`), same tenant scoping and RLS
session, same role enforcement and field-level classification (see
[below](#authentication--authorization)), same filter/sort/cursor semantics,
same camelCase field names. Disabled operations simply have no route (404).

REST-specific semantics:

- **List query params** — `first`, `after`, `sortField`, `sortDirection` are
  reserved; every other query parameter is an equality filter on the field of
  that name (text fields: `ilike '%value%'`). Repeating a parameter
  (`?status=a&status=b`) or naming it explicitly (`?statusIn=a`, single or
  repeated — the GraphQL filter convention) becomes the `<field>In`
  IN-filter. Values are coerced to the column type; unknown fields are `400`.
- **Bodies** — stricter than GraphQL parity: unknown or non-writable keys in a
  JSON body are rejected with `400` instead of being silently dropped.
  Malformed JSON is `400`. Server-managed fields (`id`, `tenantId`,
  `createdAt`, `updatedAt`) are non-writable on both `POST` and `PATCH`; a field
  authored `immutable` is accepted on `POST` and rejected on `PATCH`, and
  `openapi.json` carries the difference as a separate `<Entity>UpdateInput`
  schema (#177).
- **Errors** — `{ "error": { "code", "message" } }`; the CRUD layer's
  GraphQL error codes map to statuses in `src/rest/http-error.ts`
  (`BAD_USER_INPUT` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403,
  `GENERATED_CRUD_NOT_ENABLED` 404, `DATABASE_NOT_CONFIGURED` 503; anything
  unexpected is a redacted 500).
- **OpenAPI** — `bun run generate` also emits
  `apps/api/src/generated/rest/openapi.json` (always, empty `paths` when no
  entity opts in), served verbatim at `GET /api/rest/openapi.json`.

## The generated MCP surface

A third transport over the same CRUD core, for language models and agents.
Entities opt in with an `mcp:` block; the compiler emits a tool catalog whose
JSON Schemas are built from the authored field definitions (validation bounds,
enumerations, labels), and `POST /api/mcp` serves it over Streamable HTTP.

It differs from REST in two ways that matter for authorization: `tools/list` is
resolved per session, so a caller is never shown a tool it lacks the roles for,
and classified fields are withheld from the advertised schemas as well as
redacted from responses. See [mcp.md](mcp.md).

## The tenant control surface

| Route | Does |
| --- | --- |
| `GET /api/control/v1/tenants` | The registry, ordered by slug, capped with a `truncated` flag. |
| `GET /api/control/v1/tenants/{slug}` | One tenant, plus the Keycloak Organization read back as it actually is. |
| `POST /api/control/v1/tenants` | Provision a tenant. `201` on create, `200` with `"created": false` on replay. |
| `PATCH /api/control/v1/tenants/{slug}` | Change `status` and/or `name`. Nothing else is mutable. |
| `GET /api/control/v1/tenants/{slug}/organizations` | The tenant's sub-organisation tree, nested, in one query off `org_unit` + `org_unit_closure`. |
| `POST /api/control/v1/tenants/{slug}/organizations` | Provision a sub-organisation. |
| `PATCH /api/control/v1/tenants/{slug}/organizations/{orgUnitId}` | Rename and/or reparent one. `parentOrgUnitId: null` means the top level; the slug is refused. |

Everything about this surface is deliberately unlike the three above, because it
is the one surface that is **not** per-tenant.

- **Not on the GraphQL schema.** Every type there is fenced by a tenant
  predicate, and a registry whose rows *are* tenants has no predicate to
  satisfy. Its own mount rather than a segment of `/api/rest/v1`, so keeping the
  control plane off a public ingress is a path rule rather than an exception
  list.
- **Its own realm.** Operators authenticate against `openshapeforge-control`,
  never the tenant realm, and must hold the `platform-operator` realm role. The
  pin is on `azp` rather than `aud`: the control realm has no resource-server
  client, so operator tokens carry no audience, and without the pin a token from
  Keycloak's built-in public `admin-cli` client would be accepted.
- **DB-first, Keycloak-second, link-third.** The row is written, then the
  Organization is created through the identity-configuration SPI, then
  `keycloak_organization_id` is stamped back. A failure between steps leaves a
  row with a null link — a state that is queryable and that replaying the
  identical request heals. Both halves are upsert-shaped, so a replay is a no-op
  that answers `200` with `"created": false` instead of `201`.
- **Audited — reads included.** Every database access runs inside
  `withSystemSession`, so each one leaves a `platform.system_bypass_audit` row
  naming the operation, its target, and the issuer-qualified operator. Reads go
  through it for two reasons: `platform.tenants` carries
  `USING (app.bypass_rls() OR id = app.current_tenant())`, so a session with no
  tenant sees nothing at all without the bypass; and a cross-tenant *read* of
  the registry is not a lesser act than a write to it.
  `Platform.SystemBypass` is never minted into a login token; mapping an
  authenticated operator onto it is a server-side decision made in one place
  (`src/control/authorization.ts`).
- **Cross-realm is structural.** The SPI authenticates its bearer against the
  *target* realm and requires `realm-management` `manage-realm`, so an operator
  token can never call it. `apps/api` reaches it as the
  `openshapeforge-auth-api` service account; the operator's token is never
  forwarded.
- **Not deployed.** The routes are registered unconditionally, but the Helm
  chart sets none of the `OPENSHAPEFORGE_CONTROL_*` variables and does not
  deploy `apps/admin` or the control realm, so `/api/control/v1` answers `503`
  in every deployment the chart produces. `apps/admin` is dev and CI only —
  see [deploy/README.md](../deploy/README.md) for the reasoning and for what
  configuring the control plane would require first.

Keycloak constrains the identifiers more than the SPI does: organization names
and aliases are both unique per realm, the alias validator rejects `/`, and an
alias **cannot be changed once set** (`PUT` with a different one answers
`400 "Cannot change the alias"`). So the derivation splits in two:

- `organizationPath` is the root-to-leaf slug chain — `acme/emea/nl` — and is
  the only derived value that MOVES. A reparent recomputes it for the moved node
  and every descendant.
- alias = name is a value that never moves: the tenant slug for a root
  Organization (`acme`, and a tenant slug is immutable), and
  `<tenant-slug>--<org_unit id>` for a sub-organisation. Binding it to the path
  instead would make a reparent impossible — the alias could not follow, and the
  stale one would still be claimed.

The human-readable name stays in `platform.tenants` / `platform.org_unit`, which
are the system of record for it. Slugs are lowercase alphanumerics in
single-hyphen groups, which is what makes `--` an unambiguous separator.

### Moving a sub-organisation

A reparent is atomic in the registry — one `UPDATE platform.org_unit SET
parent_id`, with the closure trigger rewriting `platform.org_unit_closure` in the
same transaction — and a depth-ordered best effort in Keycloak, which cannot join
that transaction. Everything refusable is refused before the write (unknown unit,
foreign or unprovisioned parent, cycle, the depth cap measured at the deepest
descendant, sibling slug collision). If a node's reprojection then fails, the
call answers `409 CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE` naming each node that
did not land: the move is committed, the mirror is behind, and re-sending the
identical request finishes it. The expected `organizationPath` of every node is
derivable from the registry alone, which is what makes that state reportable.

### What a tenant's lifecycle state means

`status` holds a TENANTSTATUS value — `active`, `inactive` or `suspended` — and
the registry is authoritative for it. The Keycloak projection is one rule: **the
tenant's Organization is enabled if and only if the tenant is `active`.** One
rule rather than a per-status table, so a state added to the catalog cannot land
on "enabled" by omission.

It is applied through **Keycloak's own admin API**
(`PUT /admin/realms/{realm}/organizations/{id}`), not through a new SPI route.
`OrganizationModel.enabled` is a native field with a native endpoint; the SPI
exists for what Keycloak has no concept of, and every method added to it costs a
jar and image rebuild against a runtime whose non-public server SPIs have no
cross-minor stability. The same `openshapeforge-auth-api` service account
reaches both, and its `realm-management` `manage-realm` is exactly what the
organizations admin resource requires. Writes are read-modify-write so the
`openshapeforge.*` hierarchy attributes ride along untouched.

What disabling an Organization does, verified against Keycloak 26.5.3 rather
than inferred: it stops the organization's identity configuration — its identity
providers and the org-aware login flow — from being used. It is **not** a
session kill, and a member can still obtain a token with its own password.
Refusing sign-in for a suspended tenant is an application-side gate and nothing
reads `tenants.status` at session setup yet.

Two consequences worth knowing:

- Provisioning re-applies the projection. The SPI calls `setEnabled(true)` on
  every create and is upsert-shaped, so replaying the create of a suspended
  tenant would otherwise re-enable its Organization silently.
- `PATCH` writes the row first and mirrors second. If Keycloak fails, the status
  is already changed and the call reports why — the same recoverable, replayable
  half-applied state provisioning produces, not a rollback that would pretend
  Keycloak participates in a transaction.

`slug` is **immutable**, in the surface and not only in the console: it is the
Organization alias, the segment every descendant sub-org's path is built from,
and the URL key. A `PATCH` body carrying `slug` (or `id`, or either
`keycloak_*` column) is refused with `400 CONTROL_INVALID_INPUT` naming the
reason, rather than silently dropped — a caller that sends one and receives
`200` would reasonably believe it took effect.

The surface refuses every request with `503 CONTROL_PLANE_NOT_CONFIGURED`,
naming each missing variable, unless the whole `OPENSHAPEFORGE_CONTROL_*` block
is set. There is no partial mode: the dangerous shape is a working operator
login with an unset SPI secret, where provisioning writes the database and
Keycloak silently never happens.

## The page-config catalog

One hand-written query sits beside the generated entity surface:

```graphql
entityPageConfigs(entitySlug: String!): EntityPageConfigs
```

It returns the presentation configuration for one entity's generated web pages
— `listConfigs`, `detailConfigs`, `workspaceConfigs`, `createFormConfigBases`,
`editFormConfigBases`, each a `JSON` blob keyed by context — out of
`platform.entity_page_configs`, which `db:migrate` seeds from the compiler's
catalog. An unknown slug returns `null` so the caller can 404.

It is **authenticated but not role-gated**, deliberately: this is compiler
output describing how to lay out a page, identical for every tenant, and the
renderer needs it before it knows whether the user may read any row. What the
user can actually see is decided by the entity queries, which are role- and
RLS-enforced. The table is `tenantScoped: false` — no tenant column, no RLS —
because there is nothing tenant-specific in it.

## Multi-tenancy and the RLS session

Every operation runs inside `withDbSession` (`src/db/session.ts`): a
transaction that first sets the Postgres GUCs

```
app.tenant_id   app.user_id   app.roles   app.user_groups   app.scope
```

and then executes the query. The generated schema enables **FORCE ROW LEVEL
SECURITY** on every tenant-scoped table with a
`tenant_id = app.current_tenant()` policy (`app.*` helper functions are
created by the migration chain, STABLE/PARALLEL SAFE so the planner evaluates
them once per query). The engine additionally adds explicit
`tenant_id = $session` predicates to its SQL — defense in depth on top of
RLS.

Session rules:

- `tenantId` and `userId` are **required and must be UUIDs**; the session
  layer refuses unscoped/anonymous access before any SQL runs. GraphQL
  resolvers reject sessions without both as `UNAUTHENTICATED` (and missing
  DB config as `DATABASE_NOT_CONFIGURED`).
- `groups` only accepts UUIDs (max 256). Keycloak group *paths* arriving from
  tokens are silently filtered out — path → org-unit-UUID translation is a
  planned, separate concern.
- The richer multi-axis `rowScope` policies (group/user/bypass branches) and
  `app.scope` exist in the emitter and helpers but **no current table declares
  a rowScope** — all authored entities get the plain tenant-isolation policy
  today.
- `withSystemSession` is an audited break-glass wrapper (requires the
  `Platform.SystemBypass` role and a reason; writes
  `platform.system_bypass_audit` rows). It sets `app.bypass_rls`, which every
  emitted policy honours — plain and `rowScope` alike — so it is
  all-or-nothing over every tenant-scoped table in the manifest. In the local
  compose stack the `openshapeforge` superuser is exempt from RLS anyway.

### The worker axis

A background worker that drains a queue is cross-tenant by nature: it claims
every tenant's pending rows so no tenant needs a worker of its own. Doing that
with `app.bypass_rls` works, but the grant is far wider than the need — a
worker that has to read 3 tables would get read *and write* on all 20
tenant-scoped ones, business data included.

So a table may instead name the worker role permitted to reach it across
tenants:

```ts
{ schema: "workflow", name: "control_commands", tenantScoped: true,
  workerAccess: "workflow-worker", /* … */ }
```

which emits one extra disjunct in **that table's** policy and nowhere else:

```sql
USING (app.bypass_rls()
       OR app.current_worker_role() = 'workflow-worker'
       OR (tenant_id = app.current_tenant()))
```

`app.current_worker_role()` reads the `app.worker_role` GUC, which a worker
sets on its own transaction (`applyWorkerSession` in the workflow plugin's
`control-command-worker.ts`). Nothing is bypassed, so nothing is audited —
the break-glass trail stays readable rather than being buried under a poll
loop's heartbeat.

Three tables declare it today: `workflow.control_commands`,
`workflow.schedules` and `workflow.schedule_fires`. Notably *not*
`workflow.instances` or `workflow.node_states` — those are reached only after
a command is claimed, from a session scoped to that command's tenant.

Two properties worth being explicit about:

- **It widens.** Every other axis narrows within a tenant; this one crosses
  the boundary. It belongs on queue-shaped tables a worker drains, never on
  one holding tenant business data. The compiler rejects it on a table that is
  not `tenantScoped`, where it would grant nothing while reading as a grant.
- **It is not authentication.** `app.worker_role` is a GUC, so anything that
  can set a GUC can claim to be a worker — exactly as true of
  `app.bypass_rls`. The boundary is that the request path never sets it and a
  worker's boot path does: a code boundary, not a database one. Making it a
  database boundary means a separate Postgres role with its own grants.

## Authentication / authorization

`resolveSessionContext` (`src/auth/identity.ts`) supports three paths:

**1. Keycloak bearer** — active when `OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI`
and `..._ISSUER` are set (`..._AUDIENCE` optional). When an
`Authorization: Bearer` header is present, the token is verified against the
JWKS; **verification failure fails closed** to an empty session — it never
falls back to trusted-context, so bearer auth is not downgrade-attackable.
Claims used: `tid` (tenant UUID — the dev realm sets it as a user attribute
mapped to the `tid` claim), `sub` (user id), `realm_access.roles` **unioned
with every `resource_access.<client>.roles` list** (Keycloak expands realm
composites like `directie` into per-client entity roles under
`resource_access`, so realm roles alone would never match the entity role
lists), and `groups` (requires the group-membership protocol mapper).

**2. Customer-provisioned API keys** — `Authorization: Bearer osf_live_…`.
Routed by prefix BEFORE the JWKS path and never falling through, for the same
non-downgradable reason. A key is not a second source of roles: it names an
INTEGRATION, whose Keycloak service account is the identity, and the token
obtained for that service account is verified by the verifier above — same
JWKS, same pinned audience, same claim parsing. An optional per-key
`role_subset` is INTERSECTED with the resulting roles, never unioned, so a
subset written when the integration held more roles cannot resurrect them.
Requires `OPENSHAPEFORGE_API_KEY_SECRET_KEYS` (its own keyring, deliberately
not the connector one) and a complete bearer verifier; absent either, keys are
rejected rather than half-honoured. Provisioning lives at `/api/api-keys` and
on the GraphQL surface, gated by `Platform.ApiKeys.Manage` and by a privilege
ceiling — a caller cannot grant roles it does not hold, and an api-key session
may never manage keys at all.

**3. Trusted-context HMAC headers (v2)** — the internal service-to-service
path (`packages/auth/src/trusted-context.ts`). Header names:

| Header | Content |
| --- | --- |
| `x-tenant-id` | tenant UUID |
| `x-user-id` | user UUID |
| `x-user-roles` | comma-separated roles |
| `x-user-groups` | comma-separated Keycloak group paths |
| `x-openshapeforge-context-timestamp` | `Date.now()` milliseconds |
| `x-openshapeforge-context-signature` | hex HMAC-SHA256 |

The signature covers the newline-joined payload
`"v2" \n timestamp \n tenantId \n userId \n roles \n groups` using
`OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET`; verification enforces a ±5-minute
timestamp window and constant-time comparison. v1 (unsigned-groups) payloads
are no longer accepted. **If the secret env var is unset, all
trusted-context headers are rejected** (signed or not); the `allowUnsigned`
escape hatch is honored only when no secret is configured and is meant for
unit tests. The signing scripts in this repo (`scripts/e2e-crud-proof.ts`,
the e2e harness, the k6 suite) default the secret to
`openshapeforge-local-dev-context-secret`; `apps/api/.env.example` ships the
same value, so an `.env` copied from the example works with them against a
running API out of the box.

**Role enforcement:** the generated CRUD engine enforces the per-entity
`authorization.roles` lists at request time, **fail closed**, for GraphQL and
REST alike (`requireEntityOperation` in `src/graphql/generated-crud.ts` —
both APIs delegate to the same functions). Per operation (list/get → `read`,
create, update, delete) the session's roles must intersect the entity's
allow-list or the request is rejected with `FORBIDDEN` (HTTP 403 on REST)
**before any SQL runs** — forbidden mutations open no transaction and journal
no entity events. Details:

- The allow-lists come from the manifest's `source.authorization.roles`
  block: per operation, the deduplicated sorted **union of the authored
  (Dutch) role names and their Keycloak-normalized (English) forms** — bearer
  tokens carry the normalized names from the generated realm, trusted-context
  callers typically send the authored names; both match. Comparison is exact
  and case-sensitive.
- A generatedCrud table without role metadata (stale artifacts predating the
  bridge) is **denied** with a distinct "no role metadata" message.
- Error messages name only the entity and operation, never the allowed role
  list (no role enumeration for authenticated probes).
- Relationship traversal requires the **target** entity's `read` roles.
- An empty-body update is authorized by the `update` role alone.
- Profile-level read roles (`profileAuthorizations`) are **not** enforced —
  deferred; no profile surface exists in the generic CRUD engine today.
- Trusted-context callers MUST send (and sign) `x-user-roles`; a session with
  no matching role is 403 on every entity operation.

**Field-level classification:** columns carrying a restricting data
classification (`pii` / `bsn` / `confidential`, from the field's own
`classification` block or its semantic type) are enforced in that same shared
layer — `redactRow` and `assertClassifiedQueryFieldsAllowed` in
`src/graphql/generated-authz.ts`, called from `generated-crud.ts` — so every
transport inherits them:

- A session holding **no write grant** on the entity (none of the roles listed
  under `create`/`update`/`delete`) reads those columns as `null` on the
  single, list and relationship-traversal paths.
- The same session is refused with `FORBIDDEN` (HTTP 403 on REST) when it
  filters or sorts a list by a classified field — `totalCount` and ordering
  would otherwise recover the value redaction withheld. A `<field>In` filter
  counts as that field.
- A compiler-derived embedded default sort on a classified column is dropped
  for such a session (falling back to primary-key order) rather than failing
  an otherwise legitimate traversal.
- Create/update responses are not redacted: the operation already required the
  write grant that authorizes reading the column.
- **A classified column is nullable in the GraphQL schema however it is
  authored.** Redaction produces a `null` the read contract has to admit;
  rendering a `required: true` classified column as `String!` would turn that
  null into a non-null execution error that propagates to the nearest nullable
  parent, so one redacted field would null the whole row — and inside a
  non-null connection, the whole page. The column stays `NOT NULL` in Postgres
  and required on create; only reads may answer `null`.
- No entity shipped in this repo declares a classification, so these controls
  are inert here until an authoring layer adds one.

Entity-derived roles are appended to the `erp-provider` client during realm
generation (deduplicated against the hand-authored role list, first wins);
with the current entities they all coincide with hand-authored roles, so they
act as a safety net for future entities rather than adding rows today.

Scope resolution: a role listed in `APP_TENANT_BYPASS_ROLES` (env,
comma-separated) yields scope `tenant`; else `group` when groups exist; else
`self`. With no rowScope policies live, scope currently has no effect on
visibility.

## The entity-event journal

`platform.entity_events` (defined in `config/platform-schema.yaml`;
tenant-scoped, RLS'd, `domainInternal` so it has no GraphQL surface):
`id, tenant_id, aggregate_type, aggregate_id, event_type, payload (jsonb),
sequence (identity bigint), occurred_at`.

**What emits:** every generated CRUD `create`/`update`/`delete` appends
exactly one event **inside the mutating transaction**
(`src/platform/entity-events.ts`), with `aggregate_type` = the entity's
single-query name (e.g. `relation`), `aggregate_id` = the row id, and payload
`{ table, schema, operation }`. Reads append nothing; failed cross-tenant
mutations journal nothing (the e2e suite asserts all of this).

**What does not exist yet:** there are **no consumers** — no outbox enqueue,
realtime dirty-marker projection, or cross-replica fanout ships in this
runtime. There is also **no API query**
over the journal; `listEntityEvents` exists in code and is used by the e2e
suite reading Postgres directly through the same RLS session layer. The
journal is append-only by design (`test:perf` runs accumulate rows).

## Environment configuration

From `apps/api/.env.example` (copy to `apps/api/.env`; defaults match the
compose stack):

| Variable | Purpose |
| --- | --- |
| `OPENSHAPEFORGE_ROLE` | which role `src/index.ts` starts; `api` (default) is this server, any other value names a module-contributed worker role ([plugins.md](plugins.md#worker-roles)) |
| `PORT` / `HOST` | listen address (default `3001` / `0.0.0.0`) |
| `NODE_ENV` | `production` disables GraphiQL and makes schema drift fatal |
| `LOG_LEVEL` | fastify log level (`debug` surfaces the drift-ok line) |
| `DATABASE_URL` | Postgres; without it the API serves `DATABASE_NOT_CONFIGURED` errors |
| `OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI` / `_ISSUER` / `_AUDIENCE` | Keycloak bearer verification (unset ⇒ bearer ignored) |
| `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET` | trusted-context HMAC secret; the example default matches the repo's signing scripts (unset ⇒ trusted-context rejected) |
| `APP_TENANT_BYPASS_ROLES` | comma-separated roles that grant `tenant` scope |
| `OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER` / `_JWKS_URI` / `_CLIENT_ID` | control-realm operator verification; `_CLIENT_ID` pins `azp`, not `aud` |
| `OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL` + `KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API` | how provisioning reaches the SPI in the tenant realm; the secret shares its name with the realm generator's |
| `OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM` / `_CLIENT_ID` | optional overrides (default `openshapeforge` / `openshapeforge-auth-api`) |
| `API_RATE_LIMIT_MAX` / `_WINDOW_MS` | anonymous budget per window (default 600 / 60s) |
| `API_RATE_LIMIT_MAX_TRUSTED` | budget for a signed trusted-context caller (default 5× the anonymous budget) |
| `API_RATE_LIMIT_REDIS_URL` | shared limiter store; unset ⇒ in-memory, budget enforced per instance |
| `API_REQUEST_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | whole-request and per-request statement budgets |
| `GRAPHQL_MAX_DEPTH` / `_ALIASES` / `_COST` / `_TOKENS` / `_DIRECTIVES` | query-hardening caps |

## Rate limiting

The limiter runs **before** authentication — that ordering is the control, not
an accident: it is what protects the authentication path itself. So the budget
a request gets is chosen from what it can prove about itself *there*, with no
network call, no JWKS fetch and no database read.

| Tier | Key | Budget |
| --- | --- | --- |
| anonymous | client IP (via `trustProxy`) | `API_RATE_LIMIT_MAX` |
| trusted | tenant + user from a trusted-context header whose **HMAC verifies** | `API_RATE_LIMIT_MAX_TRUSTED` |

Sending the identity headers without a valid signature does not buy the higher
tier — it falls back to the IP-keyed anonymous budget. Trusted callers are keyed
per tenant+user rather than per service, so one runaway integration cannot
consume the allowance of everything else holding the same secret.

There is deliberately **no bearer-token tier**. Keying on an unverified `sub`
would hand out a fresh budget per forged token, and verifying the token here
would put JWKS work in front of the limit that exists to protect it. Per-identity
budgets for bearer callers belong after session resolution, keyed on the
verified subject.

**API keys get no tier of their own either**, for the same reason. It is
tempting: a key is checksum-verifiable with no I/O, so the limiter could
classify one without a database read. But the CRC32 in an `osf_` key is a
format check, not a MAC — anyone can mint a syntactically valid key — so a tier
keyed on it would hand out a second budget to any caller willing to fabricate
one. API key traffic is therefore counted in the anonymous IP tier alongside
everything else unverified.

The consequence is worth stating plainly: several external parties behind one
egress IP share one budget, and a busy integration can crowd out interactive
traffic from the same address. The levers for that are `API_RATE_LIMIT_MAX` and
a shared Redis store, not a new tier. A genuine per-key quota belongs after
session resolution, keyed on the verified key id — the same place per-subject
bearer budgets belong.

**Across replicas.** With `API_RATE_LIMIT_REDIS_URL` set, all instances share one
budget (counter and TTL move in a single atomic Redis call). Without it the
store is in-memory and N replicas mean up to N × the budget — still bounded,
just loosely. If the store is unreachable the request proceeds **uncounted**
rather than failing: a store outage must not become an API outage. Those are
counted in `rateLimitMetrics.storeErrors`.

Health and readiness probes are never throttled.

## Local stack

`docker-compose.local.yml` (`docker compose -f docker-compose.local.yml up
-d --build`):

| Service | Image / build | Port | Notes |
| --- | --- | --- | --- |
| `platform-db` | `pgvector/pgvector:pg17` | **5434**→5432 | `openshapeforge` / `openshapeforge` / db `openshapeforge_dev` |
| `keycloak-db` | `postgres:17-alpine` | internal | Keycloak's own DB |
| `keycloak` | built from `packages/keycloak-spi` | **8181**→8080 (`KEYCLOAK_PORT`) | `start-dev --import-realm`, org feature on, admin `admin`/`admin` |

Keycloak imports **two generated** realms — regenerate both with `bun run
generate` before first compose up. `--import-realm` imports every file in the
import directory, and the compose file mounts one bind per realm.

`keycloak/openshapeforge-realm.json` (realm `openshapeforge`) is the **tenant**
realm. Dev users (password `test`) carry a `tid` tenant attribute:
`acme-directie`, `acme-vastgoedbeheerder`, `acme-wijkbeheerder`,
`acme-verhuurconsulent`, `acme-noaccess` (tenant `11111111-…`), and
`beta-verhuurconsulent` (tenant `33333333-…`). The interactive client is
`openshapeforge-gateway` (secret `dev-secret`) — the e2e suite uses it for the
password-grant bearer test.

`keycloak/openshapeforge-control-realm.json` (realm `openshapeforge-control`)
is the **control** realm `apps/admin` signs platform operators in against —
separate on purpose, so no operator identity exists in the realm tenants log
into. Dev users (password `test`): `platform-operator` (holds the
`platform-operator` realm role) and `platform-noaccess` (holds none). The
interactive client is `openshapeforge-admin-gateway` (secret
`admin-dev-secret`). No user here carries a `tid` — an operator is in no
tenant.

`bun scripts/e2e-crud-proof.ts` walks a full signed-header CRUD lifecycle
against a running API and doubles as a live smoke test (remember to set the
context secret, above).
