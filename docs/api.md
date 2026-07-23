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
  `totalCount` (a real `count(*)` under the same filter) and
  `pageInfo { hasNextPage, endCursor }`.
- **Relationship traversal** — `belongsTo` resolves the single parent via
  the FK on the row; `hasMany` resolves an embedded list (limit 50) filtered
  on the target's FK column, ordered by the target's compiler-derived
  `defaultSort` (from its list presentation) when one exists.
- **Writes** — writable columns exclude the primary key, identity columns,
  `tenant_id`, `created_at`, and `updated_at`. Create injects `tenant_id`
  from the session; update always sets `updated_at = now()`; delete returns
  `true` only when a row (visible to this tenant) was actually removed.

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
  `app.scope`/`app.bypass_rls` exist in the emitter and helpers but **no
  current table declares a rowScope** — all authored entities get the plain
  tenant-isolation policy today.
- `withSystemSession` is an audited break-glass wrapper (requires the
  `Platform.SystemBypass` role and a reason; writes
  `platform.system_bypass_audit` rows). Note the plain tenant policies do not
  include a bypass branch — only rowScope policies do; in the local compose
  stack the `openshapeforge` superuser is exempt from RLS anyway.

## Authentication / authorization

`resolveSessionContext` (`src/auth/identity.ts`) supports two paths:

**1. Keycloak bearer** — active when `OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI`
and `..._ISSUER` are set (`..._AUDIENCE` optional). When an
`Authorization: Bearer` header is present, the token is verified against the
JWKS; **verification failure fails closed** to an empty session — it never
falls back to trusted-context, so bearer auth is not downgrade-attackable.
Claims used: `tid` (tenant UUID — the dev realm sets it as a user attribute
mapped to the `tid` claim), `sub` (user id), `realm_access.roles`, and
`groups` (requires the group-membership protocol mapper).

**2. Trusted-context HMAC headers (v2)** — the internal service-to-service
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

**Role enforcement:** the generated CRUD engine authenticates and
tenant-isolates but does **not** check the per-entity `authorization.roles`
lists at request time — roles flow into `app.roles` for future policies and
into Keycloak realm generation. Entity-derived roles are appended to the
`erp-provider` client during realm generation (deduplicated against the
hand-authored role list, first wins); with the current entities they all
coincide with hand-authored roles, so they act as a safety net for future
entities rather than adding rows today.

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

**What does not exist yet:** there are **no consumers** — the upstream
outbox enqueue, realtime dirty-marker projection, and cross-replica fanout
were deliberately removed from this runtime. There is also **no API query**
over the journal; `listEntityEvents` exists in code and is used by the e2e
suite reading Postgres directly through the same RLS session layer. The
journal is append-only by design (`test:perf` runs accumulate rows).

## Environment configuration

From `apps/api/.env.example` (copy to `apps/api/.env`; defaults match the
compose stack):

| Variable | Purpose |
| --- | --- |
| `PORT` / `HOST` | listen address (default `3001` / `0.0.0.0`) |
| `NODE_ENV` | `production` disables GraphiQL and makes schema drift fatal |
| `LOG_LEVEL` | fastify log level (`debug` surfaces the drift-ok line) |
| `DATABASE_URL` | Postgres; without it the API serves `DATABASE_NOT_CONFIGURED` errors |
| `OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI` / `_ISSUER` / `_AUDIENCE` | Keycloak bearer verification (unset ⇒ bearer ignored) |
| `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET` | trusted-context HMAC secret; the example default matches the repo's signing scripts (unset ⇒ trusted-context rejected) |
| `APP_TENANT_BYPASS_ROLES` | comma-separated roles that grant `tenant` scope |

## Local stack

`docker-compose.local.yml` (`docker compose -f docker-compose.local.yml up
-d --build`):

| Service | Image / build | Port | Notes |
| --- | --- | --- | --- |
| `platform-db` | `pgvector/pgvector:pg17` | **5434**→5432 | `openshapeforge` / `openshapeforge` / db `openshapeforge_dev` |
| `keycloak-db` | `postgres:17-alpine` | internal | Keycloak's own DB |
| `keycloak` | built from `packages/keycloak-spi` | **8181**→8080 (`KEYCLOAK_PORT`) | `start-dev --import-realm`, org feature on, admin `admin`/`admin` |

Keycloak imports the **generated** realm
`keycloak/openshapeforge-dev-realm.json` (realm `openshapeforge-dev`) — regenerate it
with `bun run generate` before first compose up. Dev users (password `test`)
carry a `tid` tenant attribute: `acme-directie`, `acme-vastgoedbeheerder`,
`acme-wijkbeheerder`, `acme-verhuurconsulent`, `acme-noaccess` (tenant
`11111111-…`), and `beta-verhuurconsulent` (tenant `33333333-…`). The
interactive client is `openshapeforge-gateway` (secret `dev-secret`) — the e2e
suite uses it for the password-grant bearer test.

`bun scripts/e2e-crud-proof.ts` walks a full signed-header CRUD lifecycle
against a running API and doubles as a live smoke test (remember to set the
context secret, above).
