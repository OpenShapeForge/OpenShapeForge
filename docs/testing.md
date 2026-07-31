# Testing and proof gates

Everything test-shaped in this repo is derived from the generated manifest,
so coverage extends to new entities automatically.

## Proof gates

```sh
bun run check:authoring-local   # authoring catalog compiles deterministically
bun run check:generated         # artifacts fresh + deterministic, no orphans
bun run check:ts-nocheck        # compiler/workflow @ts-nocheck baseline does not grow
bun run typecheck:compiler && bun run typecheck:api
bun run test:compiler           # compiler unit tests (bun test packages/compiler)
bun run test:e2e                # manifest-driven GraphQL e2e suite (needs Postgres)
bun run test:e2e:report         # same suite + HTML report
bun run --cwd apps/api test:migrations   # migrator vs throwaway scratch DBs
bun run test:perf               # k6 load suite (needs k6 + a running API)
bun run scan:dependencies       # OSV-Scanner scan of the root bun.lock
```

**`check:ts-nocheck`** (`scripts/check-ts-nocheck-baseline.mjs`) is an
incremental safety gate for compiler and workflow-plugin typecheck coverage.
The checked-in `config/ts-nocheck-baseline.json` records the current 56
directives; adding a directive or leaving a cleaned-up entry in the baseline
fails the gate. This does not claim that the existing compiler type errors are
resolved. Each future cleanup should remove the directive and its baseline
entry in the same change, so the baseline only shrinks.

## Dependency vulnerability scan

`bun run scan:dependencies` runs the pinned OSV-Scanner `2.3.8` binary against
the repository's root `bun.lock`, including the complete Bun workspace graph.
The wrapper downloads the platform-specific release only after verifying its
SHA-256 checksum, then prints the package, version, advisory, CVSS, source, and
fixed-version fields when findings exist. It uses the OSV database over HTTPS
and does not require secrets.

The gate threshold is any known OSV vulnerability, including advisories without
a CVSS severity (`--all-vulns`). Exit codes are preserved from OSV-Scanner:

- `0`: packages were scanned and no vulnerabilities or findings matched.
- `1`: at least one vulnerability or finding matched the threshold.
- `127`: scanner error; `128`: no packages were found; `129`–`255`: other
  non-result errors. Wrapper/setup failures use `2`.

The scan must be run against the current lockfile before dependency changes are
merged. OSV-Scanner's `bun.lock` support is the reason this gate does not use
`bun pm scan`.

**`check:generated`** (`scripts/check-generated-artifacts.mjs`):

- **Double-run determinism** — generates everything twice in-process and
  hashes each artifact group separately (database, referentiedata, authoring
  UI, Keycloak, and each plugin individually); any byte of drift fails.
- **Stale** — every artifact on disk must equal a fresh in-memory
  generation ("Run `bun run generate` and include the generated changes").
- **Temp-write proof** — all artifacts written to a temp dir must land as
  exactly one file each (catches path collisions/normalization surprises).
- **Coverage** — when `apps/web` exists, the generated + on-disk web shards
  (entity manifests, server actions) must match
  `expectedGeneratedCrudEntityCount` (currently `4` — bump it when adding an
  entity) and agree name-for-name. Skipped in a repo with no `apps/web`.
- **Orphans** — files under compiler-owned or plugin-owned generated
  roots/files that a fresh generation would not produce fail the check.

**`check:authoring-local`** (`scripts/check-authoring-local.mjs`) — double
generation hash over all artifacts, every JSON schema in
`packages/compiler/config/schemas/` parses, and the active manifest has a
non-empty table set.

> [!WARNING]
> **The pipefail lesson.** `bun test`'s exit code disappears the moment you
> pipe its output — `bun test … 2>&1 | tail` exits with `tail`'s status, so a
> red suite can look green in a script or CI step. Always prefix piped test
> invocations with `set -o pipefail;` (the repo's own test headers spell it
> out, e.g. `apps/api/src/db/__tests__/migrations.test.ts`:
> `set -o pipefail; bun test src/db 2>&1`). The same applies to
> `check:generated`/`check:authoring-local` when piped.

## The manifest-derived e2e suite

Location: `apps/api/src/graphql/__tests__/` — one spec file per concern over
a shared harness:

| File | Concern |
| --- | --- |
| `schema-drift.e2e.test.ts` | preflight: DB schema matches the bundled manifest, else fail fast with `bun run db:migrate` guidance |
| `entity-crud.e2e.test.ts` | per entity: create, get, filtered list, sort, update, delete |
| `entity-relationships.e2e.test.ts` | belongsTo/hasMany traversal + aggregates |
| `entity-events.e2e.test.ts` | each mutation appends exactly one `created`/`updated`/`deleted` journal event; reads append none; sequences increase |
| `entity-security.e2e.test.ts` | unauthenticated rejection; cross-tenant RLS invisibility; cross-tenant deletes fail and journal nothing |
| `transport-auth.e2e.test.ts` | public health query; invalid bearer fails closed; real Keycloak password-grant token drives CRUD (skipped unless bearer verification is configured — see below) |
| `coverage.e2e.test.ts` | backstop: every `generatedCrud` entity is exercised |
| `e2e/harness.ts` | transport, auth helpers, request/event capture, describe/test wrappers, cleanup lifecycle |
| `e2e/entity-factory.ts` | manifest-driven row factory (recursively satisfies required FKs, mirrors the engine's column rules) |

Properties worth knowing:

- **Auto-coverage** — the suite loops over the manifest's `generatedCrud`
  tables at load time. A new entity is covered after `bun run generate`, with
  zero test-code changes.
- **Transport** — by default it runs the real graphql-yoga handler
  **in-process** against the compose Postgres; set
  `E2E_API_URL=http://127.0.0.1:3001` to drive a running API over HTTP
  instead. Entity-event assertions always read Postgres directly through the
  same RLS session layer the API uses.
- **Isolation** — two random tenants per run; created rows are tracked and
  drained (children before parents) in the last `afterAll`.
- **Request + event capture** — every GraphQL request/response and every
  journal read is captured per test and persisted to
  `.e2e-report/requests.json` for the HTML report.
- **The three bearer tests are opt-in.** They skip unless the API is configured
  to verify bearer tokens, because a suite that silently ran them against no
  verifier would prove nothing. Both variables are needed — the harness fetches
  its token from the issuer, the API verifies it against the JWKS:

  ```sh
  export OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER=http://localhost:8181/realms/openshapeforge
  export OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI=$OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER/protocol/openid-connect/certs
  ```

  With only the issuer set the API rejects every bearer as `UNAUTHENTICATED`
  and the three tests fail rather than skip. With the compose Keycloak up
  (`docker compose -f docker-compose.local.yml up -d keycloak`), the suite runs
  206 pass / 0 skip.
- Keycloak knobs: `E2E_KEYCLOAK_CLIENT_ID` (default `openshapeforge-gateway`),
  `E2E_KEYCLOAK_CLIENT_SECRET` (`dev-secret`), `E2E_KEYCLOAK_USERNAME`
  (`acme-directie`), `E2E_KEYCLOAK_PASSWORD` (`test`).

## HTML report

`bun run test:e2e:report` (`scripts/render-e2e-report.ts`) runs the suite
with bun's JUnit reporter and renders a self-contained
**`.e2e-report/index.html`**: summary counts, collapsible per-entity suites,
failure details, every GraphQL request/response and journal read attributed
to its test, plus raw runner output. Raw data sits alongside as
`requests.json` and `junit.xml`. The script **exits with the suite's exit
code**, so it can gate CI while always producing the report.

## k6 performance suite

`bun run test:perf` (`scripts/run-perf.ts` → `apps/api/perf/
generated-crud.perf.js`). Requirements: `brew install k6` and a running API
(`bun run dev:api`); the runner health-checks `API_URL` (default
`http://127.0.0.1:3001`) first.

- **Scenarios derived from the manifest** — every `generatedCrud` entity gets
  its own constant-VUs lifecycle scenario: create (required FK dependencies
  created recursively) → get → list → update → delete, dependencies deleted
  in reverse. **Self-cleaning per iteration** — only append-only
  `platform.entity_events` rows accumulate.
- **Thresholds derived too** — per entity **and** per op:
  `http_req_duration{entity:<slug>,op:<op>} p(95) < PERF_P95_MS` (default
  800 ms), plus `http_req_failed rate<0.01` and `checks rate>0.99`. A new
  entity is load-tested (and budgeted) automatically.
- **Signing inside k6** — the script HMAC-signs the v2 trusted-context
  payload with `k6/crypto` per request, mirroring
  `applyTrustedContextHeaders` (empty roles/groups).
- **Tenant isolation** — the runner mints a fresh `PERF_TENANT_ID` per run,
  so load-test rows are RLS-isolated from dev data.
- Tuning env: `PERF_VUS` (default 5/entity), `PERF_DURATION` (15s),
  `PERF_P95_MS` (800), `API_URL`, `PERF_TENANT_ID`/`PERF_USER_ID`,
  `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET`.
- Output: **`.perf-report/index.html`** (per entity/op avg/med/p95/p99/max +
  threshold verdicts + raw k6 output) and `summary.json`. Exits with k6's
  exit code, so threshold breaches fail CI while the report still renders.

## Migration tests

`bun run --cwd apps/api test:migrations` runs the real migration chain
against throwaway scratch databases created and dropped on the compose
Postgres (admin URL `SCRATCH_ADMIN_DATABASE_URL`, defaulting to the compose
superuser); the live `openshapeforge_dev` database is never touched. See
[migrations.md](migrations.md).
