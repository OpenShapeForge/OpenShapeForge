# Retention and data-subject erasure

This document describes what the compiler emits for data retention and
GDPR-style erasure, and — importantly — what it does **not** yet do at
runtime. Read it before relying on any retention or erasure guarantee.

## What the compiler emits

An entity may declare a `retention:` block (or reference a named policy from
`retention-policies.yaml`). The backend manifest compiler
(`packages/compiler/src/authoring/backend-manifest.ts`, `compileRetention`)
resolves that into a `RetentionDefinition` on the table
(`packages/compiler/src/schema.ts`) and writes it into the DB manifest
(`apps/api/src/generated/db/manifest.json`). Nothing is written into
`schema.sql` — retention is metadata, not DDL.

A compiled `RetentionDefinition` carries:

- **`clock`** — the anchor column the retention window is measured from, plus
  its `type` (`timestamptz` or `date`) and optional `fallbackColumns`. A
  business-`date` anchor (e.g. `contractEndDate`) is a first-class clock; it is
  no longer silently dropped in favour of a system timestamp.
- **`rules[]`** — each with distinct `duration.minimum`, `duration.default`
  and `duration.maximum` values (when authored), plus a coarse `action`
  (`retain` / `archive` / `redact` / `delete`), the authored `disposition`
  verbatim (`keep` / `archive` / `delete` / `anonymize` / `mask` /
  `cryptoDelete` / `review`), an optional `review` gate
  (`{ required, queue }`), and — for `cryptoDelete` — `cryptoDelete.keyReference`
  identifying the key an executor must destroy.
- **`legalHold`** — `{ suspendDestruction: true, activeColumn? }` when the
  policy supports legal / litigation holds. The static flag is capability
  metadata, not an active hold on every record. When `activeColumn` is present,
  a true value on that record represents an actual active hold.
- **`erasure`** — advisory subject-erasure cascade metadata: `subjectScoped`,
  the `subjectColumns` that identify a data subject, and `cascades[]` naming
  dependent tables (`{ schema, table, via }`) that must also be erased.

### Deterministic clock resolution

`compileRetention` now **fails the build** (rather than silently emitting no
rule) when a declared retention policy cannot resolve a usable clock:

- a `startsFrom` field that does not exist on the entity → error;
- a `startsFrom` field whose column is neither `timestamptz` nor `date` →
  error;
- a `startsFrom.strategy` of `field` / `firstNonNull` with no field declared,
  or any policy that resolves to no anchor at all → error.

This prevents an entity from advertising a statutory retention window that
compiles to nothing.

## What is swept today: finished jobs and inbound payloads

Two runtime sweeps exist, both deliberately narrow, both on the `job-worker`'s
hourly tick, and neither one the executor described below.

### Finished jobs

The `job-worker`
role ([jobs.md](jobs.md#retention)) deletes rows of `platform.jobs` in status
`done` whose `completed_at` is older than
`OPENSHAPEFORGE_JOBS_DONE_RETENTION_DAYS` (default 30; `0` disables it), once
an hour, under the worker session. It touches no other status: a `failed`,
`dead` or `outcome_unknown` job is an operator decision still to be taken, and
a queue that forgot those would forget the very rows retention exists to
account for. It reads no entity retention metadata — the queue is platform
bookkeeping, not a business record.

### Retained inbound delivery payloads

The same role removes the encrypted provider payload held on **settled**
deliveries in `platform.inbound_deliveries`
([inbound-deliveries.md](inbound-deliveries.md#bounded-removal)): the row stays
as the receipt, and `body_ciphertext` is nulled with `body_purged_at` recorded.
Two bounds apply — `OPENSHAPEFORGE_INBOUND_BODY_RETENTION_DAYS` (default 7)
after a delivery settles, and `OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS`
(default 30, maximum 365) after it arrived, as the outer bound on that same
removal. Unlike the job sweep, the second bound cannot be disabled: this is
third-party content, often personal, and a settled receipt must not keep it
indefinitely. Each sweep is row-bounded.

A delivery that has **not** settled keeps its payload however old it is. The
2xx the provider received was a durable acceptance and the sealed payload is
the only remaining copy of the work; discarding it on a timer would make
accepted work unrecoverable without saying so. Such a delivery is instead
counted as *overdue* past the same age and reported for operator action —
today only as a worker log line. An alert on that count and admission
backpressure are **not implemented** and are needed before this is
operationally complete.

This too reads no entity retention metadata; the payload is a transport
artefact, not an authored business record.

## Runtime enforcement

User-initiated hard deletion reads the compiled retention metadata. It refuses
deletion while the record's configured clock is inside a `minimum` period or
while its explicit active-hold column is true. If every configured clock value
is null, retention has not started and does not prevent deletion. A
`maximum`-only policy likewise permits earlier authorized deletion. Normal
authorization, explicit acknowledgement, current-version comparison and
foreign-key constraints still apply.

There is not yet a scheduled retention executor. No scheduler, cron, or job
automatically deletes, archives, anonymizes, masks, reviews, or crypto-erases
records at the default or maximum date. The distinct bounds and disposition
are preserved so that executor can apply the authored outcome rather than
treating every expired policy as row deletion.

Any executor built against this metadata MUST:

1. Resolve actual per-record hold state; `suspendDestruction` by itself only
   says the policy supports suspension.
2. Honor each rule's `review` gate — route to the named queue instead of
   destroying unattended.
3. For `cryptoDelete`, destroy the referenced key rather than deleting rows.

Building that job is tracked as a follow-up issue.

What does exist are per-table purge functions a deployment can call from
its own scheduler: `purgeExpiredAuthorizationStates` for
`platform.connector_oauth_states`, and `purgeCapabilityGrants` for
`platform.capability_grants`, which removes grants whose expiry or
revocation is older than a retention window (default thirty days) while the
`capability_grant_*` audit rows stay in `platform.entity_events`
([capability-grants.md](capability-grants.md#housekeeping)). Neither is
scheduled by the API itself.

## Data-subject erasure: metadata only (follow-up)

There is likewise **no cross-entity erasure primitive**. The generated CRUD
delete (`generated-crud.ts`) operates one table at a time and there is no
soft-delete / `deletedAt` mechanism. Honoring a GDPR Art. 17 erasure request
today requires ordered, manual, multi-table deletion by an operator, and some
PII foreign keys (e.g. `contact_details.relation_id`) omit an `ON DELETE`
clause, so a naive parent delete fails with an opaque FK violation.

The `erasure` cascade metadata above is emitted so downstream tooling and a
future erasure runtime can drive or verify an ordered, subject-scoped cascade.
It is **not** enforced yet. Building the erasure primitive (and deciding
`ON DELETE` semantics deliberately per PII relationship) is tracked as a
follow-up issue.

## Authored policy is not enforcement

`Document` and `CaseFile` currently reference `records-archive-7y`, so their
compiled tables contain retention metadata. The generic hard-delete guard
enforces a configured minimum and explicit active hold, but the authored policy
still does not prove automated disposition at the default or maximum date.
