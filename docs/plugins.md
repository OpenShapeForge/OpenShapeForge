# Compiler plugins

Plugins extend the compiler without living in it: extra generators, extra
platform tables, and optionally their own authoring layer. Contract and
loader: `packages/compiler/src/plugins.ts` (tests in `plugins.test.ts`).

## The contract

The real types (from `plugins.ts` / `schema.ts`):

```ts
export type CompilerPlugin = {
  name: string;
  /** Extra platform tables merged into the base manifest BEFORE authoring
   *  entities are promoted. Colliding with an existing schema.table errors. */
  contributePlatformTables?(context: PluginBaseContext): TableDefinition[];
  /** Emit artifacts; paths are repo-root-relative like all compiler output. */
  generate?(
    context: PluginGenerateContext,
  ): GeneratedArtifact[] | Promise<GeneratedArtifact[]>;
  /** Generated paths this plugin owns, so check:generated extends its
   *  stale/orphan gates to them. */
  ownedPaths?: { roots?: string[]; files?: string[] };
};

export type PluginBaseContext = {
  repoRoot: string;
  authoringDir: string;   // the RESOLVED authoring dir (post-layer-merge)
  webPresent: boolean;    // existsSync(<repoRoot>/apps/web)
};

export type PluginGenerateContext = PluginBaseContext & {
  manifest: PlatformSchemaManifest;   // full merged manifest
  entities: CompiledEntityInfo[];     // every compiled entity contract
};

export type CompiledEntityInfo = {
  slug: string;
  path: string;                        // repo-root-relative provenance path
  origin: "core" | "contextFull";
  contract: CompiledEntityContract;    // storage, model, graphql, views, …
};

export type GeneratedArtifact = { path: string; contents: string };
```

A plugin module **default-exports** a `CompilerPlugin` with a non-empty
string `name`; duplicate names across registered plugins are an error.

## Registration

In `authoring.config.yaml`:

```yaml
plugins:
  - ./examples/plugins/entity-docs.ts       # local module (relative/absolute path)
  - ./examples/plugins/workflow/index.ts    # local package-style plugin
  # - "@openshapeforge/plugin-workflow"         # or a workspace/npm package specifier
```

Path specifiers must exist; bare specifiers resolve via `Bun.resolveSync`.
Loading is memoized per repo root.

A plugin may also ship an **authoring layer**: an `authoring/` directory next
to the plugin module (for path specifiers) or at the package root (for
package specifiers) is appended to the configured layers automatically — see
[layers.md](layers.md).

## The compile-once context

`loadActivePlatformCompile(repoRoot)` (in `src/active-manifest.ts`) does the
expensive work exactly once per repo root and shares it:

1. Load plugins.
2. Load the base `config/platform-schema.yaml` manifest.
3. `mergePluginPlatformTables` — each plugin's `contributePlatformTables`
   result is appended to the base manifest; a `schema.table` that already
   exists is an error.
4. Compile every authoring entity **once** and promote the results into the
   manifest. The same `CompiledEntityInfo[]` array is what your `generate`
   hook receives — plugins never recompile entities.

Two shape details worth knowing when consuming the manifest in a plugin:

- **In-memory `TableDefinition`s carry `schema` and `name` separately**
  (`table.name` is the bare table name, e.g. `relations`). Only the
  *serialized* `manifest.json` uses a qualified `name` (`"erp.relations"`)
  with separate `schema`/`table` fields. Render qualified names yourself:
  `` `${table.schema}.${table.name}` ``.
- CRUD-eligible tables are those with `generatedCrud` and a
  `source.graphql` block; filter on that (as both shipped examples do).

## `ownedPaths` and the gates

Declaring `ownedPaths` opts your output into the same freshness/orphan gates
the core enjoys:

- **Stale**: `check:generated` compares every emitted artifact against disk.
- **Orphan**: every existing file under an owned `root` (or listed `file`)
  that a fresh generation would **not** emit fails the check — so deleted
  outputs cannot rot on disk.
- Declare roots that don't exist yet if you will emit into them later (the
  workflow plugin declares its `apps/web/**` roots up front); missing roots
  are simply skipped.

Artifact **path collisions** across core + all plugins are rejected globally
(`collectAllArtifacts` throws if two artifacts share a path).

## Determinism requirements

`check:generated` runs the whole pipeline **twice** and hashes each plugin's
artifact group independently — any byte of drift between the two runs fails
with "plugin <name> artifacts are nondeterministic". Practical rules:

- Sort everything you iterate (directory listings, `Map` entries built from
  scans, your returned artifact array).
- No timestamps, randomness, absolute paths, or environment-dependent
  content in artifact bodies.
- Hooks must be pure: same repo state in, same bytes out.

## Shipped example 1: `entity-docs`

`examples/plugins/entity-docs.ts` — the minimal single-file plugin
(~50 lines). It has no platform tables and no authoring layer:

- `ownedPaths: { files: ["docs/entities.generated.md"] }`
- `generate({ manifest })` filters `generatedCrud` tables with
  `source.graphql`, sorts them, and emits one markdown file per run: entity
  heading (`TypeName (\`schema.table\`)`), the authored English label +
  provenance path, the five GraphQL operation names, and a column table.

The output, `docs/entities.generated.md`, is the always-current entity
reference for this repo (gitignored; recreate with `bun run generate`).

## Shipped example 2: `workflow`

`examples/plugins/workflow/` — a package-style plugin that exercises every
extension point at once. It packages the workflow node-catalog machinery
**as a standalone plugin** rather than as a built-in compiler feature: the
generators live in the plugin and run behind the web-gated UI path, so the
compiler core stays focused on the data layer.

**Contributed platform tables** (`contributePlatformTables`) — three global,
tenant-agnostic catalog tables (`tenantScoped: false`, `domainInternal:
true`, so no RLS and no generated CRUD/GraphQL surface):

| Table | Contents |
| --- | --- |
| `platform.workflow_node_catalog_entries` | one row per workflow node type (standard + entity catalogs), keyed by `catalog_checksum` |
| `platform.entity_trigger_registry` | one row per workflow-triggerable entity + its designer filter fields |
| `platform.entity_field_suggestions` | per-entity `Field[]` suggestion arrays for condition/variable pickers |

**Restored authoring layer** — `examples/plugins/workflow/authoring/` is
picked up as a layer automatically and ships:

- `workflow-nodes/**` — the node-config YAMLs (ai/, flow/, messaging/,
  triggers/, …) the generators compile.
- `entities/core/relation.yaml` with `kind: entityPatch` — the **Relation
  entityPatch**: it strategically merges a `workflow.nodes.actions` block
  (create/getOne/list/update/delete: true) back onto the base Relation
  entity, opting it into entity workflow-node generation. This is the
  worked demonstration of plugin + authoring-layer + entityPatch
  composition.

**Generated artifacts** — `generate({ authoringDir, webPresent })` runs the
extracted generators against the *resolved* authoring dir and maps their
old repo paths to service paths:

- **api-side (always emitted)**, under `apps/api/src/generated/workflow/`:
  `node-catalog.ts` (types + the checksum that keys the runtime cache/seed —
  the catalog *data* lives in the Postgres tables above),
  `node-catalog.seed.json` (the seed source), and
  `entity-workflow-nodes.generated.json` (one entry per entity action node,
  e.g. `entity.core.relation.create`).
- **web-side (only when `apps/web` exists)**: the workflow contract, designer
  registries, and renderer seeds under `apps/web/src/generated/workflow/`,
  `apps/web/src/features/renderer/generated/`, and
  `apps/web/src/features/workflow/lib/nodes/generated/` — mirroring the
  core's web gating.
- The `compiler/` and `generated/compiler/` prefixes carry the web client's
  copies of the field contract. Despite the workflow-named generator these
  are the *renderer's* core type surface — `@/generated/compiler/field-contract`
  alone has ~87 importers across `features/renderer` and `components/entity` —
  so both are mapped into `apps/web/src/`, with byte-identical content.
- Any other unmapped prefix is dropped entirely, matching the core's
  greenfield-safe behaviour.

`ownedPaths.roots` declares the api root **and** all three web roots, so the
stale/orphan gates cover the web side; they deactivate along with generation
if a host repo removes `apps/web`.
