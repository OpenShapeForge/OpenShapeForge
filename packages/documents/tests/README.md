# PostgreSQL classification regression

Run this target alone, from the repository root, against a generated, migrated,
local database containing **synthetic** template data. It reuses
`ModulePlatformRuntime`, `runtimeStaticOperationRegistrations`, generated entity
Operations, the actual shared CRUD redactor, and the documents handlers. The
runtime binding follows the existing
`apps/api/src/db/__tests__/runtime-module-operation-session.test.ts` harness.

```sh
bun test packages/documents/tests/content-runtime-classification.postgres.test.ts
```

Provide these environment variables via the local test environment (do not
commit connection credentials or fixture IDs):

- `DOCUMENT_CONTENT_PG_DATABASE_URL`: the explicitly selected local PostgreSQL
  database connection, preferably its existing restricted application role.
- `DOCUMENT_CONTENT_PG_FIXTURE`: path to a JSON object with `tenantId`, `userId`,
  `templateVersionId`, `blockId`, `chipId`, `channel`, `locale`, and optional
  `parameters`.

The selected variant must contain the selected Block and resolve the selected
Chip through `{{chips.<key>}}`. Its synthetic Chip value must start with
`classification-fixture-`. The selected actor must have record access; generated
entity read roles must allow this path without granting classified-field read
rights. All referenced entities must already exist. The test does not seed,
migrate, edit records, stage artifacts, or invoke any write Operation.

The test temporarily marks the actual generated Chip.value and Block.values
column metadata confidential **in this test process**, then restores it. This
is the same technique used by the existing entity-classification e2e tests,
not a mock redactor. It proves unclassified control success, canonical Chip
redaction, materialization refusal without leakage, privileged-reader success,
and canonical Block.values redaction followed by materialization refusal.

Absent fixture configuration produces **one skipped test, not PostgreSQL
proof**. Missing generated artifacts, unavailable DB, invalid fixtures, denied
control reads, or incorrect redaction fail the enabled test. This is runtime/DB
integration proof; it does not test browser login or HTTP authentication.
