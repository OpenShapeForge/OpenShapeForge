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
the event rolls back the business write, and rollback discards both. No-op SQL
updates append nothing. Semantic events use the same journal envelope. The
journal permits delivery-cursor updates only; payload mutation and deletion are
refused. API readiness refuses a schema without active audit triggers.

Every newly recorded event includes the verified actor (when one exists), actor
kind, canonical Operation and correlation context. Nested work shares its causal
correlation. Maintenance outside an Operation is explicitly system work; it does
not guess an Operation or a human actor. Account lifecycle adapters record their
source-owned state changes. Business row events record before/after snapshots,
changed field names and timeline subjects. Reads append no new audit events.

List results contain metadata only. `AuditEvent.get` returns the recorded
`beforeValues`, `afterValues` and `rawData` too. These are the retained, redacted
values: secrets, protected fields and elicited/hidden values are never copied
into row snapshots. Raw payload keys with credential/secret semantics are
redacted recursively. Visibility snapshots used for internal change delivery
are not returned as raw audit data. Value types are preserved. Missing historic
actors, Operation IDs and snapshots remain unknown; nothing reconstructs facts
that were never recorded. External-provider events only contain the facts the
provider adapter observed, not an invented snapshot of a remote system.

The API binds a correlation and Operation context at its shared dispatch and
database-session boundaries, so MCP, REST, workflow and module writes use the
same registration. The storage remains `platform.entity_events`; its delivery
sequence and existing change-stream consumers retain their own purpose.
