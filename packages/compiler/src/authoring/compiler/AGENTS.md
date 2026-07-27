# Sub-Compilers

Sub-compilers that turn `LoadedArtifacts` into a `CompiledEntityContract`. The orchestrator (`index.ts` / `compile()`) calls them in a fixed order and assembles the result.

## Layout

| File | Role |
|------|------|
| `index.ts` | `compile(artifacts)` orchestrator |
| `model.ts` | `resolveModelFields()` — fields with render components, options, validation |
| `storage.ts` | `resolveStorageColumns()` — SQL columns from persisted core + profile fields |
| `relationships.ts` | `resolveRelationships()` — aggregate relationships from core + profiles |
| `graphql.ts` | `buildGraphQL()` — types, queries, mutations, filters |
| `rest.ts` | `buildRest()` — opt-in REST exposure (base path + per-operation flags) |
| `views.ts` | `buildViews()` — multi-context list/detail/form/summary presentations |
| `profiles.ts` | `buildProfiles()` — per-profile mappings, projections, field extensions |
| `authorization.ts` | `buildAuthorization()` — roles, composite roles, field-level policies |
| `canonical/` | `buildCanonicalCompilerKernel()` — workflow-engine canonical kernel |
| `helpers.ts` | `deriveTableName`, `pluralize`, `FIELD_TYPE_TO_SQL`, `FIELD_TYPE_TO_GQL` |

`canonical/` has its own files (`bridge.ts`, `normalization.ts`, `path.ts`, `types.ts`, `index.ts`). It is the largest sub-compiler — treat as a sub-area, not a single file.

## Order in `compile()`

1. `resolveStorageColumns(coreFields, profiles, relationships)`
2. `resolveModelFields(coreFields, componentCatalog, semanticTypes)`
3. `resolveRelationships(artifacts)`
4. `buildGraphQL(coreEntity, profiles, relationships, componentCatalog, semanticTypes)`
5. `buildRest(coreEntity)` — order-independent; returns undefined unless the entity opts in via `rest:`
6. `buildViews(coreEntity, profiles, componentCatalog, viewDefinition?)`
7. `buildProfiles(profiles, mappings)`
8. `buildAuthorization(coreEntity, profiles, modelFields)` — must run after model so it sees compiled classifications
9. `buildCanonicalCompilerKernel({ model, graphql, views })` — consumes earlier outputs, not raw artifacts

The result is assembled with table name, retention, hooks, permissions, and version metadata.

## Notable behaviour

### `model.ts`
Resolution priority for a field's render/validation: explicit field config → semantic type → field type default → fallback. Also resolves dropdown / referentiedata options.

### `storage.ts`
Only persisted fields produce columns. Core and profile fields share one storage pass — if a profile persists onto a core column name, compilation fails with a duplicate-column error. Promote duplicated profile fields into core and have the profile reuse the core field.

### `views.ts`
Most complex sub-compiler. Normalizes single- vs multi-context view shapes via `../view-normalization.js` and emits route info per presentation type.

### `authorization.ts`
- Returns `undefined` when the entity has no `authorization` block.
- Derives entity slug as kebab-case (`NaturalPerson` → `natural-person`).
- Defaults missing CRUD roles to `${slug}:create|update|delete`.
- Does NOT auto-derive field-level read roles from `classification.sensitivity`. That synthesized `${slug}:field:*` roles nobody could be granted (they were absent from `authorization.yaml`). Field-level authorizations are emitted only when a field/profile carries an explicit `authorization` block.
- Data classification (`pii`/`bsn`/`confidential`) is carried through to the runtime DB manifest (see `../backend-manifest.ts` — column `classification`, and `generate.ts`) and enforced field-level at runtime: the generated GraphQL resolvers redact classified columns for readers who lack a write grant on the entity. The compiler only propagates the classification; it does not turn it into a role.
- Composite roles (`${slug}:manage`/`${slug}:full`) are intentionally no longer emitted.

### `canonical/`
Transforms the compiler's own outputs (model, graphql, views) into a self-contained workflow-ready kernel: path-based field refs, condition expressions, form layouts. See `canonical/index.ts` for entry point.

## Adding a new sub-compiler

1. Add module here, export the build function.
2. Wire into `index.ts` `compile()` in dependency order.
3. Add its output field to `CompiledEntityContract` in `../types/compiled.ts`.
4. Add co-located `*.test.ts` tests next to the module (e.g. `timeline-validation.test.ts` in this directory).
5. If downstream generators consume it, update `../generators/`.

## Pitfalls

- Don't reorder `compile()` casually — `buildAuthorization` needs `modelFields`, and `buildCanonicalCompilerKernel` needs `model`/`graphql`/`views`.
- Profiles extend, don't fork. Generic provenance/lifecycle stays in core; sector taxonomy stays in profile fields.
- `canonical` is a directory now, not the single ~1000-line file older docs may describe.
