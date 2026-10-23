# AuditEvent and record timelines

`AuditEvent` is an Operation-backed, read-only YAML entity. Its authored fields,
read roles and canonical `AuditEvent.list` / `AuditEvent.get` Operations are the
single public contract. REST and MCP project it. There is no Web route, public
write Operation, separate timeline database or parallel legacy audit catalog.

Both reads require `Audit.Logs.All` or `Audit.Logs.ReadAll` in the current
organization. Ordinary record-read permissions do not confer organization-wide
audit access. Queries use the verified session and the restricted database role;
the caller cannot select a tenant. A missing or foreign event is not found.

## List, filter and timeline

The list returns `items`, `totalCount` and `nextCursor`. Pass the cursor as
`after`; it is bound to the tenant, filters and sorting, and carries no authority.
`first` defaults to 50 with a maximum of 200. Default sorting is descending
`occurredAt` with event ID as its stable tie-breaker. This is a paged history,
not a promise to freeze concurrently committing transactions.

`filter` supports conjunction between fields, explicit `and` / `or` groups,
`eq`, `ne`, `in`, `isNull`, `gt`, `gte`, `lt`, `lte`, and literal case-insensitive
`contains` / `startsWith` on text. Date filters use typed timestamps. Collection
fields support `contains`. The contract limits grouping to four nested levels,
20 children per group, and at most 200 filter nodes at execution. Only authored
query fields may be filtered or sorted; arbitrary payload queries are refused.

For example:

```json
{"filter":{"entityType":{"in":["Budget","BudgetLine"]},"occurredAt":{"gte":"2026-01-01T00:00:00Z","lt":"2027-01-01T00:00:00Z"},"changedFields":{"contains":"name"}},"first":50}
```

Every stored business entity has a timeline. It is the same `AuditEvent.list`,
filtered by the complete subject tuple, not another kind of event:

```json
{"filter":{"subjects":{"contains":{"entityType":"Budget","recordId":"11111111-1111-4111-8111-111111111111"}}}}
```

Subject containment can be combined with every other filter, including actor,
Operation, correlation, event type and changed fields. Entity types are the
compiler's authored entity names. Historical events retain the identity actually
recorded by their writer; no fictitious normalization or backfill is performed.

Owned children are included automatically. Explicit relevant references are
selected with the entity-level YAML `audit.timeline.include` array, naming
existing stored child relationships. The compiler rejects unknown or unsupported
joins. The base includes, among others, budget lines, document versions,
relation contact details, case documents/tasks, agreement components and invoice
lines/payments. Plugins author their own additional relationships.

Subjects are captured in the writer transaction, including the prior and new
parents on reparenting. Cascaded deletions can use the parent's last recorded
ancestry when its row has already disappeared. Subjects are cycle-safe and
bounded to 64 distinct ancestors per traversal; exceeding that bound refuses the
write rather than silently dropping history. Related records remain in their
former parent's timeline even after moving or removal.

## Registration and detail

Current-model invariant DDL installs a transactional row trigger on every
stored, tenant-scoped authored entity, including plugin-backed writes. Generic
CRUD does not append a duplicate event in application code. Failure to persist
the event rolls back the business write, and rollback discards both. Byte-identical SQL
updates append nothing; a CRUD write that changes updatedAt still records that field. Semantic events use the same journal envelope. The
journal permits delivery-cursor updates only; payload mutation and deletion are
refused. API readiness refuses a schema without active audit triggers.

Every newly recorded event includes the verified actor (when one exists), actor
kind, canonical Operation and correlation context. Verified service principals and API keys are integrations; an unrecorded principal kind remains unknown. Nested work shares its causal
correlation. Maintenance outside an Operation is explicitly system work; it does
not guess an Operation or a human actor. Account lifecycle adapters record their
source-owned state changes. Business row events record before/after snapshots,
changed field names and timeline subjects. Reads append no new audit events.

List results contain metadata only. `AuditEvent.get` returns the recorded
`beforeValues`, `afterValues` and `rawData` too. These are the retained, redacted
values: secrets, protected fields, retention-governed values and elicited/hidden values are never copied
into row snapshots. Raw payload keys with credential/secret semantics are
redacted recursively. Visibility snapshots used for internal change delivery
are not returned as raw audit data. Exact decimal/bigint snapshots use strings to preserve precision. Missing historic
actors, Operation IDs and snapshots remain unknown; nothing reconstructs facts
that were never recorded. External-provider events only contain the facts the
provider adapter observed, not an invented snapshot of a remote system.

The API binds a correlation and Operation context at its shared dispatch and
database-session boundaries, so MCP, REST, workflow and module writes use the
same registration. The storage remains `platform.entity_events`; its delivery
sequence and existing change-stream consumers retain their own purpose.

Timeline policy is emitted separately in `operations/audit.json`. Invariant installation is atomic and readiness checks the exact producer configuration.

For entities with declared retention, audit retains event metadata and changed field names, but masks row values rather than creating an indefinitely retained second copy. The live record remains governed by its existing retention and legal-hold policy.

## Writer visibility and verification

Ancestor lookup uses the writer's existing row permissions. If a parent is
removed or invisible under its record ACL, the immediate parent is still a
subject; deeper ancestry uses that parent's last recorded subjects when those
exist. Missing deeper history stays unknown. Auditing never expands the writer's
record access to discover an ancestor.

The signed trusted-context carrier currently carries no verified principal kind.
Its actor ID is recorded, but `actorKind` remains `unknown`, including browser
requests forwarded by that carrier. A verified bearer principal kind or API key
can distinguish person and integration; no client-supplied guess fills the gap.

The release gate runs the canonical CRUD performance suite against an isolated
API/database, retaining `.perf-report/index.html` and `summary.json` outside Git.
The history integration test also measures one 1,000-row child insert through a
three-level timeline and verifies all 1,002 events and their root subjects.
Nested transaction tests cover correlation restoration, explicit savepoint
recovery and the unchanged abort behavior without an explicit savepoint.

## Retention and complete tenant removal

Audit history has no automatic expiry. The change-delivery replay window does
not remove history. Unclassified business values remain recorded until an
explicitly authorized retention or complete tenant-removal procedure removes
them; deleting a business record does not delete its history. Journal and index
storage grow with committed row changes and semantic events, so deployments
must monitor capacity. Retention-governed entity values remain masked as above.
No new retention duration or end-user erasure Operation is introduced here.

The database owner can remove the journal portion of an approved, complete
tenant offboarding. This is an operator maintenance procedure, never available
to the application role or through AuditEvent's read Operations. Stop the
removed tenant's writers and complete its business-data removal first. Run the
following final journal step in one owner transaction, replacing the UUID with
the approved tenant. The exclusive lock prevents any concurrent writer from
using the temporary trigger window; any error must roll back the transaction.
The same transaction restores the guard before committing.

```sql
BEGIN;
LOCK TABLE platform.entity_events IN ACCESS EXCLUSIVE MODE;
ALTER TABLE platform.entity_events DISABLE TRIGGER audit_event_envelope;
DELETE FROM platform.entity_events
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111'::uuid;
ALTER TABLE platform.entity_events ENABLE TRIGGER audit_event_envelope;
COMMIT;
```

Record the approval and removal result in the deployment operator's maintenance
record, outside the tenant being removed. Verify that the target tenant has no
remaining events and `/api/ready` succeeds with the audit guard enabled. The
integration suite rehearses this procedure on its disposable tenant and checks
that another tenant's history and the append-only guard survive.
