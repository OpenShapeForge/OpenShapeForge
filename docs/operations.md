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
- `/api/ready` checks the database, generated-schema checksum, every immutable
  versioned-migration ledger checksum, absence of database-ahead migrations,
  and runtime module initialization. A
  one-second cache and single-flight execution bound probe bursts. It returns
  503 until every dependency is ready and exposes only fixed names/statuses.
- `/api/metrics` is Prometheus text using one registry per process. GraphQL
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
