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
          writes:                                       # input fields only this rule may set
            - comment                                   # optional input
            - { field: reviewerId, required: true, agreesOn: [teamId] }  # required, and the Relation it names must share this record's teamId
          stamps:                                       # server-derived, never input
            - { field: submittedAt, value: now }
            - { field: submittedBy, value: actor }      # linked Relation, or the user id for a string
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
- The status field and every `writes` and `stamps` field become `writtenBy`
  the rule's Operation: generic create admits no value (the column defaults to
  `initial`), generic update refuses them with a message naming the Operation
  and its REST route, and the option set is a database `CHECK`. A write in
  its object form can be `required` (the rule refuses to run without it, and
  the input schema says so) and, on a single entity reference, can carry
  `agreesOn`: field keys on which the referenced record must equal this one.
  The generic handler compares in SQL, column against column with `IS
  DISTINCT FROM` in the query that share-locks the referenced record inside
  the transition's transaction — typed and null-aware, a null agrees with a
  null and with nothing else — and refuses with `VALIDATION` when the record
  is absent from the tenant or disagrees. The constraint is declared once in
  the YAML and enforced for every interface. A `stamps`
  field is filled by the server at execution — `now` is the transaction time
  on a datetime field, `actor` the session's linked Relation on a Relation
  reference or the user id on a string field — and is refused as input.
- On an entity with `authorization.rowAccess.recordPermissions` every rule
  requires the record's `edit` permission — a transition is a write, so
  `auth.recordPermission` may only restate `edit` — checked before the offer
  and again inside the write; an entity without record-level permissions
  refuses the key.
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
and do not collide with the entity's other operations; a `writes` or `stamps`
field must be a persisted single field that nothing else writes and, when
required, must carry a `defaultValue` (it leaves the create input, so without
one no record could ever be created); an `agreesOn` write must be a single
entity reference and name persisted single comparable (non-object) fields
that the referenced entity carries with the same base type and column type
— checked across the whole corpus when the catalogue is built, and again
against the manifest's columns when the runtime binds the rule at boot; and
neither the status field nor a
`writes`/`stamps` target may be placed in a create or update form, nor may the
status field be `writtenBy` or `immutable`. `preconditions` is deliberately a small vocabulary — a field is
present (not null) or absent (null); an empty string is a present value — and
richer checks belong in an authored plugin Operation.

`AgreementMilestone.status` is the first core state machine: `trigger` moves
`pending` to `triggered` and stamps `triggeredAt` with the transaction time
and `triggeredBy` with the actor; `cancel` moves `pending` or `triggered` to
`cancelled`; `invoice` moves `triggered` to `invoiced` under the finance role
and requires `producedInvoiceId`, an Invoice that agrees with the milestone
on `agreementId` — no milestone is invoiced against nothing or against
another agreement's invoice. Nothing leaves `invoiced`, so a milestone is
invoiced at most once by construction.

## Billing

The milestone billing run is the first core behaviour that is neither a
CRUD intent nor a transition: `BillingRun.execute`, authored on the
BillingRun entity and implemented by the core `osf-billing` runtime
(`apps/api/src/operations/billing`), which binds in every process like the
transition, jobs and grants handlers. The YAML is the whole contract:

```yaml
operations:
  execute:
    name: { en: Run milestone billing, nl: Mijlpaalfacturatie draaien }
    implementation: { type: plugin, plugin: osf-billing, handler: executeBillingRun }
    target: { scope: collection }
    input:
      schema:
        type: object
        additionalProperties: false
        required: [idempotencyKey]
        properties:
          idempotencyKey: { type: string, minLength: 1, maxLength: 200 }
          agreementId: { type: string, format: uuid, x-osf-reference: { entity: Agreement } }
          dryRun: { type: boolean, default: false }
    auth: { mode: session, roles: [Finance.All.ReadWrite] }
    tenancy: { mode: required }
    effects: { data: write, external: none }
    reliability: { idempotency: { mode: keyed, inputField: idempotencyKey } }
    errors:
      - { status: 404, code: REFERENCE_NOT_FOUND, description: The agreement does not exist in this tenant. }
      - { status: 409, code: ALREADY_EXISTS, description: Another caller already ran billing under this idempotency key. }
interfaces:
  rest:
    operations:
      execute: { method: POST, path: /api/rest/v1/billing-runs/execute }
```

What one call does, in one transaction: create the BillingRun (the record
of the run), lock every AgreementMilestone at `triggered` — of the tenant,
or of the one agreement named — and for each of them allocate a number from
the tenant's sales InvoiceSequence for the fiscal year, create one Invoice
with one InvoiceLine, create a BillingRunItem recording the decision, and
move the milestone through `AgreementMilestone.invoice`. The rows go
through the generic entity create, so declared validation, the tenant
column and the `created` journal events are the ones a hand-made record
gets; the milestone goes through the transition handler, so the status
column has no other writer.

The number is identity, frozen at issue: `Invoice.invoiceNumber` and
`Invoice.fiscalYearCode` are `immutable` and `writtenBy: [BillingRun.execute]`,
so no generic create or update on any interface sets or changes them (a
draft made by hand has no number until a run issues it), and the unique
index over Invoice `(tenantId, invoiceKind, fiscalYearCode, invoiceNumber)`
is the guarantee that no two invoices of a tenant share a number within a
kind and fiscal year. The fiscal year is stored on the invoice rather than
derived from its issue date, because the counter is scoped by it: a later
change of the issue date must not move an invoice out of the sequence that
numbered it. InvoiceSequence has no create, update or delete on any
interface; its counter columns are `writtenBy` the run and only the run
touches the row. Should an invoice nonetheless hold the number the counter
would issue next — a counter reset by hand, a row planted past the run —
the run allocates past it (a gap is cheaper than a run that cannot finish)
and gives up after a thousand taken numbers rather than scan.

Idempotency is the core receipt, keyed on the caller's `Idempotency-Key`:
a replay by the same actor returns the first result without running again,
a different input under the same key is `IDEMPOTENCY_KEY_REUSED`, and a
different actor reusing the key is refused as `ALREADY_EXISTS` by name
rather than as a database error. Numbering relies on the unique index over
InvoiceSequence `(tenantId, kind, fiscalYearCode)`: one `insert ... on
conflict ... do update` seeds a fiscal year at 1 or increments it, so two
runs racing on the first number of a year serialise on the row instead of
both taking 1. `dryRun` plans and counts, records the run, and invoices
nothing.

`AgreementMilestone.create` is authored the same way (`implementation:
{ type: plugin, plugin: osf-billing, handler: createAgreementMilestone,
action: create }`): the one create rule the generic path does not know —
with `percentOfBasis` the amount is computed from `basisAmount` once and
frozen, otherwise a positive `amount` is required — lives in the module,
and the Operation is projected as the entity's ordinary create on REST,
MCP and GraphQL.
