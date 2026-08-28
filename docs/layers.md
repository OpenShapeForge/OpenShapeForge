# Authoring layers

Layered authoring is Kustomize for entity YAML: a base layer plus any number
of overlays, resolved deterministically into a single authoring tree before
the compiler runs. Implementation:
`packages/compiler/src/authoring/layers.ts` (tests in `layers.test.ts`).

## `authoring.config.yaml`

Declared at the repo root; read by `loadAuthoringConfig(repoRoot)`:

```yaml
layers:
  - packages/compiler/config/authoring   # base (this repo's only configured layer)
  # - authoring/overlays/my-overlay      # overlay directory (repo-relative or absolute)
  # - "@openshapeforge/context-care"         # package whose root has an authoring/ dir
plugins:
  - ./examples/plugins/entity-docs.ts
  - ./examples/plugins/workflow/index.ts
```

- `layers` must be a non-empty string array. Each entry resolves to a
  directory: repo-relative/absolute path first, else a bare package specifier
  whose package root contains an `authoring/` directory.
- If the file is missing entirely, the default single layer
  `packages/compiler/config/authoring` is used — resolved against the host
  repo first, and otherwise against the copy packaged with the compiler, so
  a host repo without config mirroring still gets the base layer.
- `plugins` registers compiler plugins ([plugins.md](plugins.md)). A plugin
  that ships its own `authoring/` directory contributes it as an extra layer
  **appended after all configured layers**, in plugin registration order.
  (That is why this repo, with one configured layer, still materializes
  `.authoring-build/` — the workflow plugin's layer makes it two.)

## `authoring.config.local.yaml` — deployment-local extensions

Git-ignored, same shape, **append-only**. It exists so a deployment can mount
an authoring extension that this repository must not declare.

That distinction is the point. A sector data standard — VERA, say — belongs in
its own repository: it ships its own reference-data groups, its own
`entityPatch` files repointing core fields at them, and `enumMap` transforms
translating between its codes and core's. Adding it to the committed
`authoring.config.yaml` would put the extension back into core by reference,
which is exactly what keeping it out of the tree was meant to avoid. So it goes
here instead:

```yaml
# authoring.config.local.yaml — not committed
layers:
  - /opt/openshapeforge-vera/authoring     # or a bare package specifier
plugins:
  - /opt/openshapeforge-vera/index.ts
```

- Entries are **appended** after everything in `authoring.config.yaml`, which
  is also where an extension wants to be: a later layer is the one that gets to
  patch earlier ones.
- It cannot remove, reorder or replace a committed layer or plugin.
  Re-declaring one is an error rather than a silent reordering — moving a
  committed layer to the end would change which layer patches which.
- `layers` may be omitted (plugins only), but a malformed file is an error
  rather than an ignored file.
- While it is active, every compiler entry point warns. Generated artifacts are
  committed and gate-checked, so a build carrying extra layers must not look
  like an ordinary one — **do not commit artifacts generated with it in place.**
  CI never has this file, so committed artifacts stay canonical.

## Layer ordering and resolution

Layers are applied strictly in order; later layers see (and may patch) what
earlier layers produced. For each file in each layer:

1. **`kind: entityPatch`** (a `.yaml` whose parsed document has
   `kind: entityPatch`) — strategic-merged into the entity **with the same
   slug** from an earlier layer. The patch targets by slug (file stem), not
   by path, so an overlay may place the patch in any `entities/` subfolder.

Generated CRUD exposure is the deliberate exception to ordinary last-writer
wins merging: `crud.operations` is monotonic. A later `entityPatch` may disable
an operation but cannot re-enable one disabled by an earlier layer. This lets a
host set a maximum exposure policy that an installed package/plugin cannot
widen.
   Patching a slug no earlier layer defines is an error. Later layers may
   patch the same entity again — patches stack.
2. **`catalogs/*.yaml` with a path that already exists** — strategic-merged
   into the earlier catalog file (see below).
3. **Any other same-path collision** — hard error. Plain wholesale
   replacement across layers is rejected by design; patch instead.
4. **New files** — added as-is (entities in new folders, contexts, mappings,
   views, catalogs — anything).

Two different layers defining the same entity **slug** at *different* paths
is also an error ("Duplicate entity slug … Use kind: entityPatch").

## `kind: entityPatch` — strategic merge semantics

Exactly the `strategicMerge` function:

- **Objects deep-merge.** A patch property with value `null` **deletes** that
  property from the base.
- **Keyed arrays merge by item key.** If every item of the base (or patch)
  array is an object carrying a string `key`, `id`, or `value` property
  (checked in that priority order), items merge by that key: matching keys
  deep-merge, new keys append, and a patch item with `$delete: true` removes
  the base item. Patch items in a keyed array **must** carry the merge key,
  or the merge errors.
- **All other arrays are replaced wholesale** by the patch array.
- Scalars: patch wins.

Example overlay patch (targets the base `relation` slug):

```yaml
# overlay/entities/core/relation.yaml
kind: entityPatch
ui:
  presentations:
    list:
      defaultSort: { key: displayName, direction: desc }   # object deep-merge
fields:
  - key: notes
    $delete: true          # remove the notes field (keyed-array delete)
  - key: segment           # new key -> appended
    valueType: string
    persisted: { column: segment, storageClass: core }
```

The `kind: entityPatch` marker itself is stripped before merging; everything
else in the file is the patch body.

## Catalog merging

`catalogs/*.yaml` are the one place where same-path files across layers are
legal: the later file strategic-merges into the earlier one (same semantics
as above). This lets an overlay add referentiedata groups, semantic types, or
transforms — or extend existing groups item-by-item (`items` carry `value`,
so they merge as a keyed array) — without copying the base catalog.

Note the referentiedata snapshot generator reads the **resolved** catalog, so
overlay-added groups flow into `core-by-groep.json` automatically.

## `.authoring-build/` materialization

- **Single resolved layer, no patches** → the layer directory is used
  directly (fast path; byte-identical to pre-layer behavior). No build dir.
- **Multiple layers** → the merged tree is materialized under
  `.authoring-build/` at the repo root (deleted and rebuilt on every
  resolve, gitignored). This is your `kustomize build` output: inspect it to
  see exactly what the compiler saw. Generated provenance paths (e.g.
  `source.path` in the manifest, or the "authored in …" lines in
  `docs/entities.generated.md`) point into `.authoring-build/` when layering
  is active.
- Resolution is memoized per repo root (`resolveActiveAuthoringDir`), so the
  determinism double-run compiles the same resolved tree.

## Collision rules — summary

| Situation | Result |
| --- | --- |
| Same path, plain file, non-catalog | Error ("Layer collision") |
| Same path, `catalogs/*.yaml` | Strategic merge |
| Same slug via `kind: entityPatch` | Strategic merge (patch) |
| Same slug, plain entity file, different path | Error ("Duplicate entity slug") |
| `entityPatch` for unknown slug | Error |
| New path | Added |
