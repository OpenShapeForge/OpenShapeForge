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
- **`rules[]`** — each with a coarse `action`
  (`retain` / `archive` / `redact` / `delete`), the authored `disposition`
  verbatim (`keep` / `archive` / `delete` / `anonymize` / `mask` /
  `cryptoDelete` / `review`), an optional `review` gate
  (`{ required, queue }`), and — for `cryptoDelete` — `cryptoDelete.keyReference`
  identifying the key an executor must destroy.
- **`legalHold`** — `{ suspendDestruction: true }` when the policy declares a
  legal / litigation hold. An executor MUST NOT run any destructive
  disposition for the table while this is set, regardless of clock expiry.
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

## Runtime enforcement

`apps/api` ships a one-shot retention worker that consumes the generated DB
manifest. Run it after migrations from a scheduler or cron controller:

```sh
bun run --cwd apps/api retention:enforce
```

The worker takes a PostgreSQL advisory lock, processes each rule in bounded
batches, and exits with a JSON summary. Set `OPENSHAPEFORGE_RETENTION_BATCH_SIZE`
to an integer from 1 through 10000 (default 500). Schedule repeated invocations
until the eligible backlog is drained.

For each table, the worker resolves the first non-null clock column in manifest
order. `date` clocks expire at midnight UTC plus the calendar interval;
`timestamptz` clocks retain their instant semantics. The worker then:

1. skips destructive rules while `legalHold.suspendDestruction` is true;
2. inserts review-gated records into `platform.retention_review_queue` without
   changing the source row;
3. archives full rows in `platform.retention_archive` before deleting them;
4. queues referenced keys in `platform.retention_crypto_delete_queue` for the
   configured key-management integration rather than deleting source rows;
5. nulls classified sensitive columns for anonymize/mask/redact rules, using
   deterministic non-identifying placeholders only for required columns; and
6. records non-row-removing outcomes in `platform.retention_actions` so later
   runs are idempotent.

The worker runs through the audited system-session path because policies can
span tenants. Operators must monitor pending review and crypto-delete queues;
queue insertion is durable, but a key-management adapter remains responsible
for destroying queued keys and marking them complete.

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

## Shipped policies

The PII-bearing `Relation` and `ContactDetail` entities declare retention:

- relations enter the `privacy-review` queue seven years after their last
  update; approval tooling can then act on that review item;
- contact details are deleted two years after `validUntil`, falling back to
  `updatedAt` when no validity date is present.

These policies compile into `erp.relations` and `erp.contact_details` retention
blocks in the generated DB manifest. Changing a policy requires updating the
entity authoring YAML and regenerating artifacts.
