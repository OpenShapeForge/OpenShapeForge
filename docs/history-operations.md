# Audit log and record timeline

The core Operations `audit.list` and `timeline.list` expose the existing
organization event journal through canonical execution, REST and MCP. They do
not add Web views or a separate timeline store.

- `audit.list` requires `Audit.Logs.All` or `Audit.Logs.ReadAll`.
- `timeline.list` requires `Timeline.All` or `Timeline.Events.ReadAll`.

These are explicit organization-wide history privileges. Ordinary record-read,
own-history and restricted timeline roles do not confer them. They permit
reading metadata about deleted records too. Every query still runs under the
verified tenant's restricted database session and row-level security. The input
never selects a tenant.

Both return `events` and `nextCursor`. Events contain `id`, `aggregateType`,
`aggregateId`, `eventType`, `occurredAt`, and a nullable recorded actor UUID.
The Operations never return raw payloads, record values, visibility snapshots,
request bodies or provider errors. They do not reconstruct missing field diffs
or actors. Coverage is only as complete as the events appended by each writer.

Use `aggregateType` and `aggregateId` from the audit log to request a timeline.
Writer aggregate names are exact, case-sensitive journal identities: do not
merge two different aggregate types just because they share a record id.
The timeline remains readable after a record's deletion, and an unknown record
has an empty timeline. Related records require their own timeline calls.

Optional filters are `aggregateType`, `aggregateId`, `eventType`, `since`
(inclusive), and `until` (exclusive). A timeline requires both aggregate fields.
Pages use descending journal sequence, with 25 events by default and at most
100. Sequence is append order, not commit order: concurrent or subsequently
committed events may appear on a fresh first-page read. The cursor is bound to
the organization, Operation and filters. It is a pagination position, never an
authorization credential or a claim of a complete historical snapshot.

MCP clients use `osf_search_operations` to find `audit.list` / `timeline.list`
and `osf_execute_operation` with their published input contract. In direct-tool
mode the names are `audit_list` / `timeline_list`. REST uses
`POST /api/audit/list` and `POST /api/timeline/list` with the same contract.

For example, after finding an event with aggregate type `core.Relation` and
record id `11111111-1111-4111-8111-111111111111`, execute `timeline.list` with
`{"aggregateType":"core.Relation","aggregateId":"11111111-1111-4111-8111-111111111111"}`.
