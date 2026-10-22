# Audit events and record timelines

`AuditEvent` is a headless, read-only entity authored in
`packages/compiler/config/authoring/entities/core/audit-event.yaml`. Its
canonical `AuditEvent.list` and `AuditEvent.get` Operations project to REST and
MCP. It deliberately has no Web interface or public write Operations.

Both reads require an authenticated organization session with `Audit.Logs.All`
or `Audit.Logs.ReadAll`. This is organization-wide audit authority; ordinary
record access alone does not grant it. Every query also enforces the session's
tenant in PostgreSQL.

## Reads and filters

`list` returns metadata, subjects, changed field names, a total count and an
opaque continuation cursor. `get`, by event ID, also returns recorded
`beforeValues`, `afterValues` and `rawData`. Secret and protected field values
are redacted at registration and again on reads. Exact decimal and bigint
snapshot values are strings to preserve precision. Audit data is append-only.
Historical events expose only facts actually recorded; absent actors, Operation
IDs or snapshots are null rather than inferred.

Filters support `and`/`or`, exact comparisons, `in`, null checks, ranges and text
matching on entity, record, event, timestamp, actor, actor kind, Operation and
correlation. Collection `contains` supports changed field names and complete
timeline subject tuples. Requests are bounded to 200 results per page, four
nested group levels and 20 clauses per group. Cursors bind to tenant, filter
and sorting; they cannot be reused for a different query.

For example, invoke `AuditEvent.list` with:

```json
{
  "first": 50,
  "filter": {
    "subjects": { "contains": { "entityType": "Budget", "recordId": "record-id" } },
    "occurredAt": { "gte": "2026-01-01T00:00:00Z" },
    "eventType": { "in": ["created", "updated", "deleted"] },
    "changedFields": { "contains": "amount" }
  },
  "sortField": "occurredAt",
  "sortDirection": "desc"
}
```

Entity types are authored names such as `Budget`, without a module prefix.

## Uniform registration and composed timelines

Every stored, tenant-scoped authored entity with a primary key gets a row
trigger. Inserts, updates and deletes journal in the same transaction as the
business write, including direct SQL from plugins. Audit persistence failure
rolls back the write. Existing semantic event writers use the same envelope.
Verified actor identity, current Operation and correlation propagate through
canonical invocation and database sessions. Service bearer principals are
identified as integrations; maintenance without a person is a system actor.
Source entities without their own rows must journal changes in their adapter;
the Account adapter does so for status and direct role changes.

Every business record is its own timeline subject. Owned children propagate
automatically. Additional relevant stored relationships are explicit YAML:

```yaml
audit:
  timeline:
    include: [lines]  # stored hasMany relationships
    parents: [caseId] # stored belongsTo relationships
```

These are execution metadata, not new database columns or altered relationship
ownership. The compiler rejects ambiguous or cross-tenant joins. An event's
subjects capture relevant ancestors at write time, including both roots on
reparenting and ancestry during cascaded removal. Traversal is cycle-safe and
fails rather than silently truncating ancestry beyond 64 records.

The core declares relevant children for relations, budgets, cases, case files,
documents, agreements and invoices. Plugins add their own relationships, such
as a budget line's monthly values, accounts, nested lines and assumptions.
Read a complete timeline through `AuditEvent.list` with `subjects.contains`;
there is no separate timeline store or competing Operation contract.

Generated `operations/audit.json` carries timeline policy. Bootstrap installs
its database invariants; API readiness rejects missing or disabled producers.
`platform.entity_events` remains the single event journal. Physical schema
changes are not needed for this capability.
