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

## Runtime enforcement: NOT IMPLEMENTED (follow-up)

**There is no retention-enforcement runtime.** Nothing in `apps/api` reads the
compiled `retention` block: no scheduler, cron, or job deletes, anonymizes, or
redacts records past their retention window, and nothing checks `legalHold`
before acting. The compiled metadata exists so a future job can consume it, but
until that job ships, retention is **advisory metadata only**.

Any executor built against this metadata MUST:

1. Check `legalHold.suspendDestruction` first and skip all destructive
   dispositions while a hold is active.
2. Honor each rule's `review` gate — route to the named queue instead of
   destroying unattended.
3. For `cryptoDelete`, destroy the referenced key rather than deleting rows.

Building that job is tracked as a follow-up issue.

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

## No shipped entity declares retention

At present **no entity YAML** under `packages/compiler/config/authoring/entities`
declares a `retention:` block, so the shipped `manifest.json` contains no
`retention` metadata. `retention-policies.yaml` is authored but not yet
referenced by any table. Wiring policies onto the PII-bearing entities
(relations, contact details) is the authoring step that makes the metadata
above actually appear in the manifest — do it alongside, or ahead of, the
runtime-enforcement follow-up.
