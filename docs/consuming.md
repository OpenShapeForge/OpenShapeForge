# Consuming the compiler from a host repo

The compiler is designed to run against another repository's authoring
config: outputs are written **relative to the host repo root**, and the
check-script ownership model travels with it.

## Getting the package

`@openshapeforge/compiler` is published to the **GitHub Packages npm
registry** (not npmjs.com) by the **Package compiler** workflow
(`.github/workflows/package-compiler.yml`) on pushes to `main`, whenever the
version in `packages/compiler/package.json` is not there yet — releasing is
"bump the version and merge".

GitHub's npm registry requires authentication even for public packages, so
consumers need a token with `read:packages` (a classic PAT, or
`GITHUB_TOKEN` in Actions). Point the `@openshapeforge` scope at the registry
in the host repo's `.npmrc`:

```ini
@openshapeforge:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

then install by name (Bun and npm both read `.npmrc`):

```sh
bun add @openshapeforge/compiler
```

Alternatively, every workflow run — including pull requests touching
`packages/compiler` — also uploads the tarball as a run artifact named
`openshapeforge-compiler-npm-<sha>` (90-day retention). Download it from the
run's Artifacts section (or `gh run download`) and install from the file:

```sh
bun add ./openshapeforge-compiler-0.1.0.tgz
```

Either way the content is proven before it ships: CI installs the tarball into
a scratch project and regenerates this repository's committed artifacts from
the packaged bin, byte-for-byte.

## Setup

1. Depend on `@openshapeforge/compiler` (workspace or package dependency). The
   package exposes a `bin`: `openshapeforge-compiler` → `src/index.ts`. It runs
   under **Bun** (the loader uses `Bun.resolveSync`; the bin is a TypeScript
   entry point).
2. Put an `authoring.config.yaml` at the host repo root declaring the host's
   layers and plugins ([layers.md](layers.md)):

   ```yaml
   layers:
     - authoring                 # the host's own authoring tree
   plugins: []
   ```

3. Run the compiler with the host root:

   ```sh
   openshapeforge-compiler --repo-root .
   # or
   OPENSHAPEFORGE_REPO_ROOT=. openshapeforge-compiler
   ```

   or programmatically:

   ```ts
   import { runCompiler } from "@openshapeforge/compiler";
   await runCompiler({ repoRoot: "/path/to/host" });
   ```

   Without `--repo-root`/`OPENSHAPEFORGE_REPO_ROOT`, the compiler assumes it
   lives at `<repoRoot>/packages/compiler` inside its own monorepo.

## What lands where

All artifact paths are repo-root-relative and fixed:
`apps/api/src/generated/db/{schema.sql,types.ts,manifest.json}`,
the optional `apps/api/src/generated/plugin-migrations/registry.json` when a
plugin contributes constraints or invariant DDL,
`packages/compiler/config/referentiedata/core-by-groep.json`,
`keycloak/<realm>-realm.json` (one per `authorization.yaml` /
`authorization.<realm>.yaml` in the resolved authoring tree), plus whatever
registered plugins emit. The host repo
is expected to gitignore these and gate them with its own copies of the
check scripts (or by invoking `collectAllArtifacts(repoRoot)` — the same
in-memory entry point `scripts/check-generated-artifacts.mjs` uses here).

## The web app

Web UI artifact generation is keyed on one thing: an **`apps/web` directory
existing at the repo root** (`webPresent = existsSync(join(repoRoot,
"apps/web"))`). This repo ships one, so `generate` emits, on top of the data
layer:

- CRUD pages, entity manifests, and server actions under
  `apps/web/src/app/(generated)`, `apps/web/src/compiler`,
  `apps/web/src/actions/generated`, plus the app-shell files
  (`apps/web/src/app/layout.tsx`, `page.tsx`) and the referentiedata copy
  `apps/web/src/lib/core-referentiedata-by-groep.json`.
- The page-config catalog seed
  `apps/api/src/generated/page-configs/entity-page-configs.seed.json`. It
  lands API-side because `apps/api` owns `platform.entity_page_configs` and
  loads it during `db:migrate`; the pages read it back over GraphQL. **Run
  `db:migrate` after `generate`** whenever page configs change, or the
  renderer serves the previous layout.
- The `check:generated` web-shard coverage checks (entity-manifest and action
  shard counts must equal `expectedGeneratedCrudEntityCount`).
- Plugins receive `webPresent: true` — the workflow example plugin then also
  emits its web-side artifacts (field contract, designer registries, renderer
  seeds) under the `apps/web/**` roots it declares in `ownedPaths`.

A host repo that wants the data layer and API only can **delete `apps/web`**;
the compiler stops emitting UI artifacts with no compiler changes, and the
web-shard gates deactivate with it.

Run it with `bun run dev:web` (`build:web` to build). Both first build
`packages/auth` — see the note below.

**`@openshapeforge/auth` resolves to `dist/` under a bundler.** Its relative
imports carry NodeNext `.js` specifiers, which TypeScript and Bun map back
onto the `.ts` sources but Turbopack resolves literally and fails on. The
package's `exports` therefore serve `src/` to Bun and TypeScript — apps/api
and the scripts are unaffected and need no build — and `dist/` to everything
else. `apps/web`'s `dev` and `build` scripts run that build first; a host
repo bundling this package needs to do the same.

## Current limitations

- **The base platform schema follows the packaged default.**
  `loadActivePlatformCompile` reads
  `<repoRoot>/packages/compiler/config/platform-schema.yaml` when the host
  provides it, and otherwise falls back to the copy packaged with the
  compiler — the same fallback applies to the implicit base authoring layer.
  Both overrides are all-or-nothing: a host copy of the base authoring
  directory REPLACES the packaged tree entirely rather than merging into it
  (extend the base through an extra layer instead — see
  [layers.md](layers.md)). A host that overrides the platform schema must
  keep defining at least `platform.schema_migrations` and
  `platform.entity_events`, since the API runtime and migrator assume both.
- **Bun is required** — the CLI and plugin/package resolution use Bun APIs;
  there is no Node fallback.
- **Generated CRUD policy is entity-authored.** The common `crud.operations`
  block is the upper bound for GraphQL, REST, MCP and workflow. Stock generated
  entity pages require the full five-operation policy; partial policies use a
  purpose-built UI.
  External layers/packages can narrow that policy with `entityPatch`; the
  layer resolver rejects attempts to re-enable an operation disabled earlier.
- **The `core` module maps to the `erp` schema** via a default
  (`schemaByModule: { core: "erp" }`) that host repos cannot override
  through configuration; other module names fall back to their snake_cased
  module name as the schema.
- **The example plugins are not portable.** Both live under
  `examples/plugins/` and the workflow plugin deep-imports compiler
  internals by relative path (`../../../../packages/compiler/src/…`); they
  demonstrate the contract but would need packaging work before a host repo
  could register them from node_modules.
- **Relationships only resolve inside the compile.** Entity relationships
  may only target entities present in the host's resolved authoring tree;
  anything else is skipped (recorded in
  `relationshipStatus.skippedReferences`), and cross-module FKs additionally
  require `relationshipRegister` entries in the platform schema.
- **Retention is advisory metadata; there is no enforcement runtime.** The
  compiler emits a `retention` block (clock, rules, legal hold, review gates,
  crypto-delete key, erasure cascades) into the DB manifest, but nothing reads
  it: no scheduler deletes/anonymizes data past its window, no legal hold is
  honored, and there is no cross-entity data-subject erasure primitive. See
  [retention.md](retention.md); building the enforcement job and the erasure
  primitive are tracked as follow-up issues.
- **A host that does not use the reference API migrator must consume the
  plugin migration registry itself.** Apply its ordered SQL after generated
  tables exist, transactionally record the exact checksums under the emitted
  plugin/version identities, fail on changed applied entries, and report but
  tolerate ledger entries absent from an older registry so image rollback
  remains possible.
  The reference implementation is
  `apps/api/src/db/migrations/generated-plugin-migrations.ts`.
- The host repo owns everything downstream of the artifacts: the API
  runtime, migrations, compose stack, and test harnesses in this repo are
  reference implementations, not part of the compiler package.
