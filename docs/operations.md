# GraphQL operations and observability

The API exposes two GraphQL transport profiles. In production, `/api/graphql`
accepts arbitrary operations only after verified integration authentication,
authorization, tenant isolation, rate limits, and GraphQL Armor. The generated
web app uses `/api/graphql/persisted`: its build-generated manifest maps the
SHA-256 of each canonical operation to the query. That endpoint rejects raw,
unknown, or stale operations. A deliberate integration-only web call may opt
back into the integration profile in `executeGraphqlRequest`. During a rolling
deployment, the authenticated web server retries Yoga's exact persisted-query
miss once through that integration profile, but only when its own generated
manifest contains the canonical operation. Other errors and runtime-built
documents never trigger a fallback; the first attempt is hash-only, so a
mutation cannot execute twice.

## Observability package boundary

`packages/observability` is owned and released with this repository as a small
private workspace package. Its framework-neutral registry, redaction,
readiness, and telemetry bootstrap sit below thin Fastify and Yoga adapters;
the API supplies every OSF schema, context, label, dependency, and policy
decision. The dependency direction is therefore API to observability and never
observability to the compiler, generated schema, authentication, or tenant
model.

The API host is the first consumer; other OSF process roles are the intended
second consumer when they need the same lifecycle primitives. Keeping this in
`apps/api` would make that reuse duplicative, while `packages/compiler` and
`packages/auth` have unrelated ownership and dependency graphs. A separate
repository would add publication and coordinated-version overhead before a
second release consumer exists. The workspace boundary still gives that later
extraction a stable configuration API, so upgrades do not couple product
schema changes to observability infrastructure.

## Consumer-owned CORS

The API will not start without an explicit CORS choice:

- `OPENSHAPEFORGE_GRAPHQL_CORS_MODE=disabled` emits no CORS response headers.
- `OPENSHAPEFORGE_GRAPHQL_CORS_MODE=allowlist` requires exact HTTP(S) origins
  in `OPENSHAPEFORGE_GRAPHQL_CORS_ORIGINS`.
- `OPENSHAPEFORGE_GRAPHQL_CORS_CREDENTIALS=true` is optional and safe only
  with that exact allowlist.

There is no wildcard or permissive default. A programmatic host may instead
pass a dynamic policy to `createApiApp`; every returned policy is validated.
Helm consumers set these variables through `extraEnv`, making the deployment
choice visible in their values rather than hiding it in the shared package.

## Operational endpoints

- `/api/health` is process liveness and does not contact dependencies.
- `/api/ready` checks the database, the generated-schema checksum (was this
  database built from the bundled manifest?), plus runtime module
  initialization. A
  one-second cache and single-flight execution bound probe bursts. It returns
  503 until every dependency is ready and exposes only fixed names/statuses.
- `/api/metrics` requires a valid signed internal context and returns 401 to
  anonymous callers. Prometheus text uses one registry per process. GraphQL
  labels are limited to operation type, build-known operation names, fixed
  phase, and expected/unexpected classification. Resolver, path, raw URL,
  tenant, user, variables, headers, and arbitrary operation-name labels are
  intentionally absent.

Readiness and metrics use the ordinary request-rate boundary; only constant-time
liveness is exempt.

Unexpected GraphQL exceptions are masked for callers and centrally reduced to
a category, allowlisted error type, and optional allowlisted operational code.
Messages, stacks, causes, headers, variables, and request data never enter that
report. Structured request logs likewise retain only the HTTP method and
response status, not URLs, addresses, or user-agent fingerprints.

## Tracing and GraphiQL

OpenTelemetry starts before framework and database imports. It remains off
unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is
set; non-local exporters require HTTPS. `OTEL_TRACES_EXPORTER=none` disables it
explicitly. The consumer owns exporter infrastructure and sampling policy.
Automatic instrumentation directly loads only HTTP and Fastify. Raw URLs,
paths, query strings, client/peer addresses, ports, and user-agent fingerprints
are replaced with fixed values. GraphQL document/resolver and database spans
are disabled so tenant data cannot enter the exporter by default.

GraphiQL is available only outside production. Its default health query is
safe without credentials and explains where a local bearer header belongs;
it contains no token, tenant, or trusted-context value. Root fields appear in
stable product groups, alphabetized within each group, while descriptions
remain visible through introspection.

## Transitions

A status field can be authored as a state machine instead of a free column.
Each rule compiles to an ordinary record Operation, so the lifecycle of a
record is described once, in YAML, and every interface shows the same verbs:

```yaml
fields:
  - key: status
    osfType: string
    required: true
    defaultValue: draft
    options:
      type: static
      items:
        - { value: draft, label: { en: Draft, nl: Concept } }
        - { value: submitted, label: { en: Submitted, nl: Ingediend } }
    transitions:
      initial: draft
      rules:
        - key: submit                       # Operation <Entity>.submit
          from: [draft]
          to: submitted
          label: { en: Submit, nl: Indienen }
          auth: { roles: [Cases.All.ReadWrite] }        # default: the entity's update roles
          preconditions: [ { field: reviewerId, present: true } ]
          writes: [submittedAt, submittedBy]            # only this rule may set them
          confirmation: { mode: acknowledgement }       # or none (default)
```

What the compiler makes of it:

- One canonical Operation `<Entity>.<key>` per rule, implemented by the core
  `osf-transitions` runtime — no per-entity code. Its input is `{ id,
  expectedVersion, ...writes }` (plus `leaseToken`/`confirmed` when the rule
  asks for them), its output the record, its declared errors `VALIDATION`,
  `FORBIDDEN`, `NOT_FOUND`, `INVALID_STATE` and `VERSION_CONFLICT`. It is
  projected as `POST /api/rest/v1/<basePath>/:id/<key>`, the MCP tool
  `<entity>_<key>`, the GraphQL mutation `<entity><Key>` and a web record
  action; the tool description names the `from` and `to` states.
- The status field and every `writes` field become `writtenBy` the rule's
  Operation: generic create admits no value (the column defaults to
  `initial`), generic update refuses them with a message naming the Operation
  and its REST route, and the option set is a database `CHECK`.
- Availability follows [operation-availability.md](operation-availability.md):
  a rule is offered on a record only while its status is in `from` and its
  preconditions hold, and execution re-evaluates the same decision after
  locking the row. A refused rule answers `INVALID_STATE` naming the current
  state and the rule's `from` and `to`.
- The web manifest carries the rule table (`transitions` on the entity, with
  `from`/`to`/`label` per rule) so a renderer can show the offered rules as
  the record's transition buttons; the backend manifest carries the same
  table for the runtime.

Validation at compile time: `options.type` must be `static` (the states are
part of the contract, not a code table); `initial`, `from` and `to` must be
option values and `defaultValue` must equal `initial`; rule keys are unique
and do not collide with the entity's other operations; a `writes` field must
be a persisted single field that nothing else writes; and the status field
may be neither `writtenBy`, `immutable` nor placed in a create or update
form. `preconditions` is deliberately a small vocabulary — a field is
present or absent — and richer checks belong in an authored plugin Operation.

`AgreementMilestone.status` is the first core state machine: `trigger` moves
`pending` to `triggered` and is the only writer of `status`, `triggeredAt` and
`triggeredBy`.

