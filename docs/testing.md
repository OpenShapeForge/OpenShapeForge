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
bun run test:e2e                # manifest-driven GraphQL e2e suite (needs Postgres,
                                # shared across worktrees — see below)
bun run test:e2e:report         # same suite + HTML report
bun run --cwd apps/api test:migrations   # migrator vs throwaway scratch DBs
bun run test:perf               # k6 load suite (needs k6 + a running API)
bun run test:browser            # apps/web in a real browser (needs a running stack)
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
| `schema-drift.e2e.test.ts` | preflight: DB schema matches the bundled manifest, else fail fast with the remedy that fits the direction of the drift (see [One Postgres, many worktrees](#one-postgres-many-worktrees)) |
| `entity-crud.e2e.test.ts` | per entity: create, get, filtered list, sort, update, delete |
| `entity-relationships.e2e.test.ts` | belongsTo/hasMany traversal + aggregates |
| `entity-events.e2e.test.ts` | each mutation appends exactly one `created`/`updated`/`deleted` journal event; reads append none; sequences increase |
| `entity-security.e2e.test.ts` | unauthenticated rejection; cross-tenant RLS invisibility; cross-tenant deletes fail and journal nothing |
| `transport-auth.e2e.test.ts` | public health query; invalid bearer fails closed; real Keycloak password-grant token drives CRUD (skipped unless bearer verification is configured — see below) |
| `control-provisioning.e2e.test.ts` | tenant → root Organization, sub-organisation → child Organization, both through the real SPI, then RLS isolation of the provisioned tenant (skipped unless the control plane is configured — see below) |
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
- **The provisioning tests are opt-in the same way**, and for the same reason —
  they reach a real Keycloak through the identity-configuration SPI, so without
  one they would prove nothing. They skip unless the control plane is configured
  *and* an operator token can be obtained from the **control** realm:

  ```sh
  export OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL=http://localhost:8181
  export KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API=openshapeforge-auth-api-secret
  export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER=http://localhost:8181/realms/openshapeforge-control
  export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI=$OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER/protocol/openid-connect/certs
  export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID=openshapeforge-admin-gateway
  ```

  Control-realm knobs mirror the tenant ones: `E2E_CONTROL_CLIENT_ID`,
  `E2E_CONTROL_CLIENT_SECRET` (`admin-dev-secret`), `E2E_CONTROL_USERNAME`
  (`platform-operator`), `E2E_CONTROL_PASSWORD` (`test`). The suite creates a
  tenant with a run-random slug and deletes both the Organizations and the
  registry rows afterwards, so repeated runs do not accumulate tenants — the
  control surface has no delete of its own, by design.
- **Point `DATABASE_URL` at the restricted role** (`openshapeforge_app`) to
  exercise the RLS assertions for real. The privileged `openshapeforge` role in
  the compose stack is `SUPERUSER`, which bypasses row-level security outright,
  so a cross-tenant test that passes under it has only proven the application's
  own `WHERE` clause.

### One Postgres, many worktrees

`bun run test:e2e` connects to `DATABASE_URL`, which defaults to
`openshapeforge_dev` on the compose Postgres. **Every git worktree on the
machine shares that one database**, and `bun run db:migrate` stamps the
migrating branch's manifest checksum into it. So a checkout that declares one
entity more than yours leaves `openshapeforge_dev` holding a table your branch
does not declare, and `schema-drift.e2e.test.ts` then fails the whole suite on
your branch — which has changed nothing.

The preflight tells the two directions apart and prints only the remedy that
fits:

- **The database is behind your manifest.** Nothing in it is outside what your
  branch declares, so `bun run db:migrate` rolls it forward: new tables and new
  columns are additive and apply without touching data.
- **The database carries schema your branch does not declare.** The message
  names the offending tables and columns. `db:migrate` cannot fix this and will
  refuse — rolling forward has no way to drop a table — so rerunning it is
  wasted time. Point the suite at a scratch database instead, which leaves
  everyone else's `openshapeforge_dev` where it is:

  ```sh
  ADMIN="${OPENSHAPEFORGE_MIGRATE_DATABASE_URL:-$DATABASE_URL}"
  psql "${ADMIN%/*}/postgres" -c 'create database openshapeforge_e2e'
  OPENSHAPEFORGE_MIGRATE_DATABASE_URL="${ADMIN%/*}/openshapeforge_e2e" bun run db:migrate
  DATABASE_URL="${DATABASE_URL%/*}/openshapeforge_e2e" bun run test:e2e
  ```

  The two URLs stay separate on purpose: creating and migrating need the
  privileged role, while the suite keeps running as whatever `DATABASE_URL`
  names, so the RLS point above survives the move to a scratch database.

  Recreating `openshapeforge_dev` works too, at the cost of its data — and only
  until the next worktree migrates it.

Either way the failure is **not** a regression in the branch under test. Drop
the scratch database when you are done (`drop database … with (force)`) —
abandoned ones accumulate on the compose Postgres and are indistinguishable
from live ones to the next person.

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

## The browser suite for `apps/web`

`bun run test:browser` (Playwright, `apps/web/playwright.config.ts`) drives a
real Chromium against a **running** stack. It is the only suite here that needs
one, and the reason is the reason it exists: both defects it was written for are
invisible without a browser and a framework.

- **The editor settles** — loads a definition and asserts the page stops calling
  its own server. A server action whose effect depended on a prop rebuilt on
  every server render re-ran because it had run, at roughly seven requests a
  second, indefinitely. The detector needs no foresight: a page that never
  settles fails any assertion at all.
- **A palette drag reaches the canvas** — holds a drag open over the surface and
  asserts the preview card appears, then drops and asserts the node lands. The
  mid-drag half is the one that matters: the broken handler called
  `preventDefault()` before bailing, so the *drop* still worked and only
  everything during the drag was lost.
- **Smoke** — list, create, open, place a node, save, and come back through the
  list to a canvas rebuilt from the stored graph.

A simulated DOM cannot replace it. `dataTransfer.getData()` during `dragover`
returns the payload under happy-dom, does not exist under jsdom, and returns
`""` in every real browser — so a component test over the broken handler passes.
That measurement is recorded on issue #262.

**It does not move the line.** Decisions still live in
`examples/plugins/workflow/web/`, where `bun test examples` reaches them. This
suite drives the assembled screen through a browser; it cannot call a function,
so it is not an argument for putting logic in `apps/web`.

### Running it

```sh
docker compose -f docker-compose.local.yml up -d   # Postgres, Redis, Keycloak
bun run generate && bun run db:migrate
bun run dev:api                                    # or apps/api start, on :3001
bun run build:web && bun run --cwd apps/web start  # on :3000
bun run --cwd apps/web exec playwright install chromium   # once
bun run test:browser
```

The web app must be served from an origin the dev realm's gateway client accepts
— `http://localhost:3000` or `http://localhost:3001`, per
`packages/compiler/config/authoring/authorization.yaml`. Sign-in is the real
authorization-code flow through the Keycloak login page, because the web session
is written into Redis by the NextAuth callback and nothing outside that callback
can produce one. Credentials follow the same convention as the GraphQL e2e
harness: `E2E_USER_PASSWORD_<USERNAME>`, falling back to the committed dev-realm
literal. `E2E_WEB_URL` points the suite somewhere other than `:3000`.

CI runs it as its own workflow (`.github/workflows/web-e2e.yml`) rather than
inside `gates`, which has no Postgres.
