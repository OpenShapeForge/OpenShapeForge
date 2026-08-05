# The generated MCP server

OpenShapeForge serves the same generated CRUD core over three transports:
GraphQL, REST, and **MCP** (Model Context Protocol) — the last for language
models and agents.

MCP is not REST with different framing. Its consumer *reads the schema to
decide what to do*, which makes the authored field definition the product
rather than decoration. Where the OpenAPI generator collapses a field to a bare
scalar, the MCP tool catalog carries the labels, validation bounds,
enumerations, and AI hints the author already wrote.

## Opting in

Per entity, in the entity YAML — the same fail-closed shape as `rest:`:

```yaml
mcp: true                 # every operation, prefix derived from the entity name
```

```yaml
mcp:
  enabled: true
  toolPrefix: contact     # default: entity name in snake_case
  tools: dedicated        # or `generic` — see "Tool surface"
  operations:
    delete: false         # each flag defaults to true
```

Absent or `false` means no tools at all. An `mcp:` block on an entity that is
not generated-CRUD enabled fails the build, exactly as `rest:` does — MCP tools
delegate to the CRUD layer, so the authoring intent would otherwise evaporate
silently.

## Endpoint

`POST /api/mcp` — Streamable HTTP transport, stateless (no session
persistence, so no affinity is needed across replicas). Authentication is the
same bearer token, customer-provisioned API key, or signed trusted-context
headers every other transport takes; an unauthenticated request is `401` before
any dispatch.

### Discovery

The MCP specification makes authorization OPTIONAL and conformance a SHOULD for
HTTP transports, but a server that participates MUST publish OAuth 2.0
Protected Resource Metadata (RFC 9728) and clients MUST use it to find the
authorization server. Two pieces, and neither works alone:

- `GET /.well-known/oauth-protected-resource` (and the path-suffixed
  `/.well-known/oauth-protected-resource/api/mcp`) returns the resource
  identifier, the Keycloak realm as `authorization_servers`, and
  `bearer_methods_supported: ["header"]`. Public and unauthenticated by
  construction — it is what a client reads precisely because it cannot yet
  authenticate, and it discloses only the realm URL, already public in every
  issued token.
- Every `401` from `/api/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="…"` pointing at that document.

The resource identifier is derived from the request (honouring
`x-forwarded-proto`, so a TLS ingress does not yield an `http://` identifier)
rather than configured separately: it has to match both what the client sends
as `resource` and what the token carries as audience, and a mismatch between
those is the confused-deputy case the parameter exists to prevent.

No `scope` is advertised in the challenge. This deployment authorizes by ROLE,
resolved per entity from the compiled manifest, not by OAuth scope — naming a
scope the authorization server does not issue would send clients to request
something meaningless. The audience half of the spec is already satisfied by
`OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE`, which is fatal in production when
unset.

The server is registered inside the rate-limited plugin scope, so the API's
request-rate boundary applies.

## Tool surface

Two catalog styles, chosen per entity:

- **`dedicated`** (default) — one tool per enabled operation:
  `relation_list`, `relation_get`, `relation_create`, `relation_update`,
  `relation_delete`. The authored labels and enumerations land directly in each
  tool's schema, which is what makes them usable by a model.
- **`generic`** — the entity is routed through shared `osf_list` / `osf_get` /
  `osf_create` / `osf_update` / `osf_delete` tools taking an `entity`
  parameter, keeping the advertised tool count flat.

Tool-selection quality degrades well before a model runs out of context, so the
compiler **fails the build** when the dedicated tool count would exceed 60,
naming the entities to switch to `generic`. This is a build failure rather than
a runtime surprise, matching how the rest of the compiler fails closed.

Every tool carries annotations derived mechanically from its operation:
`readOnlyHint` on list/get, `idempotentHint` on update/delete, and
`destructiveHint` on delete.

## What the field definition contributes

The catalog is generated from the compiled contracts (`model.fields`), not the
runtime manifest — the manifest carries storage columns, which is everything
SQL needs and almost nothing a model needs.

| Authored | Becomes |
| --- | --- |
| `valueType`, `cardinality` | JSON Schema `type`; `array` + `items` for collections |
| `cardinality.{min,max}`, `validation.minItems` | `minItems` / `maxItems` |
| `validation.minLength` / `maxLength` | `minLength` / `maxLength` |
| `validation.min` / `max` | `minimum` / `maximum` |
| `validation.pattern`, `.format` | `pattern`, `format` |
| `required` | the parent schema's `required[]` |
| `defaultValue` | `default` |
| `options` (static or `referentiedata`) | `enum`, with value→label pairs in the description |
| `label`, `description`, `help`, `unit` | a composed parameter `description` |
| `hints.aiInstructions` | appended to that description |
| `relationship` | a pointer to the target entity's tools |
| `sortable` scalars | the `sortField` enum on the list tool |
| `classification` | withheld fields and redaction (below) — never the schema |

Computed and server-managed fields (`id`, `tenantId`, `createdAt`,
`updatedAt`) are **omitted** from write schemas rather than marked: the CRUD
layer would reject them, and an absent property is a clearer instruction to a
model than a present-but-forbidden one.

Authored `readOnly` is **not** consulted. In this vocabulary it is a
presentation flag — it selects a display component instead of an input one — and
no transport enforces it, so honouring it here would advertise a narrower write
surface than REST and GraphQL actually accept.

Authored `immutable` **is** consulted, and only on update: the field appears in
the create schema and is absent from the update schema. That is the flag which
carries the API contract, and it reaches the CRUD layer through the manifest
column, so the advertised update schema and the server's `400` come from one
authored fact rather than two rules that can drift (#177).

### Enumerations

`options.type: referentiedata` expands to concrete values at compile time from
the referentiedata snapshot. This is the largest single gain: `Relation.relationType`
is an unconstrained `text` column in every other transport, and a closed
three-value enum here.

The generator also reads `render.props.referentieGroep`, the shape the UI
select components consume, because entities in this repo author the group
there. That fallback is local to the MCP generator on purpose — teaching the
shared `resolveFieldOptions()` about it would move `CompiledField.options` into
the GraphQL profile types and web form generators, changing generated output
for consumers that gain nothing from it.

## Authorization

Function-level authorization is the CRUD layer's `requireEntityOperation()`,
unchanged and fail-closed, exactly as for GraphQL and REST.

On top of that, MCP does two things the other transports do not, both because
its consumer reads schemas:

1. **`tools/list` is resolved per session.** A caller is shown only the tools
   whose entity roles it holds. A read-only session sees `relation_list` and
   `relation_get` and no write tools at all; a session with no roles sees an
   empty catalog. An unknown tool and an unauthorized one get the same
   `NOT_FOUND`, so the error cannot be used to enumerate entities.
2. **Classified fields are withheld from schemas.** For a caller without a
   write grant, fields classified `pii`/`bsn`/`confidential` are stripped from
   the input schemas handed out by `tools/list` — otherwise the schema would
   enumerate precisely the fields redaction exists to hide.

Field-level classification is enforced on the call path too:

- rows are passed through `redactRow()` before being returned,
- `assertClassifiedQueryFieldsAllowed()` refuses a filter or sort on a
  classified field, closing the oracle,
- writes to a classified field are refused for a caller who could not read the
  value back.

## Errors

A failed tool call returns an MCP tool result with `isError: true` and the CRUD
layer's error code as text (`FORBIDDEN: Not authorized to delete Relation`)
rather than a protocol-level error. A model that receives the reason as content
can adapt; a transport failure just terminates the call.

Transport-level problems — no credentials, no database — are still HTTP status
codes (`401`, `503`) with the REST error body shape.

## Generated artifact

`bun run generate` emits `apps/api/src/generated/mcp/tools.json` (gitignored,
like every generated artifact). It is hashed by `bun run check:generated` for
determinism, staleness, and orphans along with everything else.

## See also

- [api.md](api.md) — the CRUD engine, RLS, auth, and the REST surface
- [authoring.md](authoring.md) — entity YAML anatomy and field definitions
- [architecture.md](architecture.md) — where this sits in the pipeline
