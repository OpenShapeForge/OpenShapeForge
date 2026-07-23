# Referentiedata (configuration)

This folder holds the **generated** lookup file `core-by-groep.json`
(groep → codes and labels) used when entity YAML declares
`options.type: referentiedata`.

- **Source:** the core catalog at
  `packages/compiler/config/authoring/catalogs/core-referentiedata.yaml`.
- **Regenerate:** `bun run generate` at the repo root rewrites the snapshot
  from the catalog.
- **Why here:** reference lists are platform configuration, not compiler
  implementation code; the compiler only reads this file when expanding
  `referentieGroep` for emitted apps.
