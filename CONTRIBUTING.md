# Contributing to OpenShapeForge

OpenShapeForge is a compiler-driven data platform: entities are authored as YAML, and a
compiler generates the database schema (with RLS), a generic GraphQL CRUD API surface,
and the Keycloak realm. Contributions almost always mean editing authoring YAML or the
hand-written engines — never the generated output.

## Prerequisites

- **bun >= 1.3** (the repo pins `bun@1.3.4` as package manager)
- **Docker** with Compose, for the local stack: Postgres on `5434`, Keycloak on `8181`
- **k6** (`brew install k6`) — optional, only for `bun run test:perf`

## Setup

```sh
bun install
cp apps/api/.env.example apps/api/.env   # required before db:migrate/dev:api; defaults match the compose stack
docker compose -f docker-compose.local.yml up -d --build
bun run generate       # compile authoring YAML into generated artifacts
bun run db:migrate     # create/roll-forward the schema
bun run dev:api        # http://127.0.0.1:3001/api/graphql (GraphiQL in dev)
```

`bun scripts/e2e-crud-proof.ts` is a live smoke test of the running API.

## The golden rule: never edit generated artifacts

Everything the compiler emits is gitignored, reproducible, and named or located to make
its origin obvious (`apps/api/src/generated/`, `generated-*`, `*.generated.*`).
Hand-written engines consume generated manifests; they never contain per-entity code.
If a generated file looks wrong, fix the authoring YAML, a template, or a generator —
then rerun `bun run generate` and let the gates verify. Hand-edits are overwritten and
flagged as drift by `check:generated`.

## Proof gates (all green before any PR)

```sh
bun run check:generated         # artifacts fresh + deterministic (double-run), no orphans
bun run check:authoring-local   # authoring catalog compiles deterministically
bun run check:ts-nocheck        # compiler/workflow @ts-nocheck baseline does not grow
bun run check:notices:linux     # THIRD-PARTY-NOTICES matches the deps, as CI runs it
bun run typecheck:compiler
bun run typecheck:api
bun run typecheck:examples  # the shipped example plugins/connectors
bun run test:compiler
bun run test:e2e                # manifest-driven GraphQL e2e suite (needs Postgres up)
bun run --cwd apps/api test:migrations   # migrator + drift tests (bun test src/db)
```

Run `bun run test:perf` as well when touching the API hot path (resolvers, the CRUD
engine, RLS/session plumbing); it needs k6 and a running API.

Run `bun run test:browser` when touching `apps/web`. It drives the assembled screen
in a real Chromium and needs a running stack — the compose services plus both app
processes — because it signs in through the Keycloak login page. Setup is in
[docs/testing.md](docs/testing.md#the-browser-suite-for-appsweb).

If you add, remove, or bump a dependency, run `bun run notices:linux` and commit the
updated `THIRD-PARTY-NOTICES.md` — the notices gate fails the PR otherwise.

**Use the `:linux` variants unless you are on linux-x64.** The committed notices are the
linux-x64 artifact, because the tree carries platform-native optional packages
(`@next/swc-*`, `@img/sharp-*`, …) and bun installs only the current platform's. Plain
`check:notices` compares against *your* install, so on a Mac it reports the darwin
natives as drift and can never pass — that failure is the platform, not a stale file.
Both `:linux` scripts run in a container and restore your local install afterwards.

**Pipefail warning:** never pipe test output through `tail`/`head` in a way that hides
the ` N pass / N fail` summary lines. Always `set -o pipefail` and read the actual
counts — a truncated pipe can make a failing suite look green.

## Contributing an entity

1. Add `packages/compiler/config/authoring/entities/core/<slug>.yaml` (the file stem is
   the slug and must be unique across all `entities/` subfolders; relationships may only
   target entities present in this repo).
2. Bump `expectedGeneratedCrudEntityCount` in `scripts/check-generated-artifacts.mjs`.
3. `bun run generate && bun run db:migrate` — additive changes roll forward
   automatically, no migration code needed.

That's it: e2e specs, perf scenarios, and report coverage are derived from the generated
manifest, so a new entity is tested automatically. A new field on an existing entity is
just step 3 after editing its YAML.

## Contributing an overlay / layer

`authoring.config.yaml` at the repo root lists authoring layers, applied in order like
Kustomize bases and overlays. An overlay directory (or a package with an `authoring/`
dir) can add entities, contexts, partials, and mappings; `catalogs/*.yaml` with the same
path merge across layers. To modify an entity from an earlier layer, ship a file with
the same slug and `kind: entityPatch` — objects deep-merge, `null` deletes a property,
keyed arrays merge by `key`/`id`/`value` (`$delete: true` removes an item). Plain
same-path replacement across layers is rejected; patch instead. With multiple layers,
inspect the resolved tree under `.authoring-build/`.

## Contributing a plugin

A compiler plugin default-exports `{ name, generate?, contributePlatformTables?,
ownedPaths? }` (see `packages/compiler/src/plugins.ts`) and is registered under
`plugins:` in `authoring.config.yaml`:

- `generate` receives the resolved authoring dir, the platform manifest, and every
  compiled entity contract, and returns artifacts.
- `contributePlatformTables` merges extra platform tables into the manifest.
- `ownedPaths` extends the stale/orphan gates to the plugin's output — declare
  everything you emit.
- A plugin may ship its own `authoring/` directory next to its module; it is appended
  as an authoring layer automatically.

Plugins must be **deterministic**: `check:generated` runs the whole pipeline twice,
plugins included, and fails on any byte drift. Study the two examples under
`examples/plugins/`: `entity-docs.ts` (minimal single-file plugin) and `workflow/`
(platform tables + own authoring layer + api-side artifacts).

## Schema-migration rules

- **Additive is automatic.** New entities/fields: `bun run generate && bun run
  db:migrate`. The migrator diffs the manifest against the live schema and rolls
  forward.
- **Non-additive needs a versioned migration.** Drops, renames, type changes, or
  required no-default columns fail `db:migrate` with an exact drift listing. Scaffold
  with `bun run db:migration:new <name>` and write its `up()`.
- **Applied migrations are immutable.** Each is recorded with a checksum verified on
  every run; editing an applied migration fails loudly — write a new one instead.

## Code style

- Match the surrounding code; no new formatters, lint rules, or conventions in passing.
- Comments only for constraints the code cannot express — not narration.
- Nothing a generator or plugin emits may contain timestamps, randomness, or
  environment-dependent values: the double-run determinism gate will catch it.

## Licensing of contributions

This project is source-available under the Business Source License 1.1 (see
`LICENSE`); any production use requires a separate commercial license from
BatterAI B.V., and each version converts to the GNU AGPLv3 four years after
its publication.

By submitting a contribution you accept the following contributor terms:

- **Copyright.** Your contribution is licensed under the project's license
  (inbound = outbound). In addition, you grant BatterAI B.V. a perpetual,
  worldwide, non-exclusive, irrevocable, royalty-free copyright license to
  use, reproduce, modify, distribute, and sublicense your contribution as
  part of the project, including under the Change License and under separate
  commercial licenses. You retain ownership of your contribution.
- **Patents.** You grant BatterAI B.V. and all recipients of the project a
  perpetual, worldwide, non-exclusive, irrevocable, royalty-free patent
  license for patent claims licensable by you that are necessarily infringed
  by your contribution alone or by its combination with the project.
- **Authority.** You represent that your contribution is your original work
  and that you are entitled to grant these rights — in particular that, where
  applicable, your employer has authorized the contribution or waived its
  rights in it.
