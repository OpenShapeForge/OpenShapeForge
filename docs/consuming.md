# Consuming the compiler from a host repo

The compiler is designed to run against another repository's authoring
config: outputs are written **relative to the host repo root**, and the
check-script ownership model travels with it.

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
`packages/compiler/config/referentiedata/core-by-groep.json`,
`keycloak/<realm>-realm.json` (when the resolved authoring tree has an
`authorization.yaml`), plus whatever registered plugins emit. The host repo
is expected to gitignore these and gate them with its own copies of the
check scripts (or by invoking `collectAllArtifacts(repoRoot)` — the same
in-memory entry point `scripts/check-generated-artifacts.mjs` uses here).

## Re-enabling web generation

Web UI artifact generation is keyed on one thing: an **`apps/web` directory
existing at the repo root** (`webPresent = existsSync(join(repoRoot,
"apps/web"))`). This repo does not ship an `apps/web` directory, so web
generation is inactive by default. Create one and rerun `generate`; the
compiler then additionally emits, with no compiler changes:

- CRUD pages, entity manifests, and server actions under
  `apps/web/src/app/(generated)`, `apps/web/src/compiler`,
  `apps/web/src/actions/generated`, plus the app-shell files
  (`apps/web/src/app/layout.tsx`, `page.tsx`) and the referentiedata copy
  `apps/web/src/lib/core-referentiedata-by-groep.json`.
- The `check:generated` web-shard coverage checks activate automatically
  (entity-manifest and action shard counts must equal
  `expectedGeneratedCrudEntityCount`).
- Plugins receive `webPresent: true` — the workflow example plugin then also
  emits its web-side artifacts (workflow contract, designer registries,
  renderer seeds) under the `apps/web/**` roots it already declares in
  `ownedPaths`.

**Workflow plugin web-side caveat (field-contract copies):** the extracted
generators still *produce* the web client's duplicate copies of the field
contract under their old `compiler/` and `generated/compiler/` path
prefixes, but the plugin's path mapper has **no mapping** for those prefixes
and silently drops them (`examples/plugins/workflow/index.ts`). A restored
web app that imports those duplicated contract modules will need mappings
added for the `compiler/` / `generated/compiler/` prefixes (or its imports
pointed at `apps/web/src/generated/workflow/contract/`) before those files
exist again.

## Current limitations

- **The base platform schema path is hard-coded.**
  `loadActivePlatformCompile` reads
  `<repoRoot>/packages/compiler/config/platform-schema.yaml` — the *host*
  root, not the package. A host repo must provide that file at that exact
  path (defining at least `platform.schema_migrations` and
  `platform.entity_events`, since the API runtime and migrator assume both).
- **Bun is required** — the CLI and plugin/package resolution use Bun APIs;
  there is no Node fallback.
- **The generated-CRUD denylist is compiled in.**
  `generatedCrudDeniedEntitySlugs` (`tenant-setting`, `case-step-action`)
  lives in `packages/compiler/src/active-manifest.ts` and is not
  configurable from the host config.
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
- The host repo owns everything downstream of the artifacts: the API
  runtime, migrations, compose stack, and test harnesses in this repo are
  reference implementations, not part of the compiler package.
