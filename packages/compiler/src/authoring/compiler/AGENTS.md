# Entity sub-compilers

This directory compiles loaded authoring into the shared entity contract.
Read `index.ts` for current assembly order and `../types/compiled.ts` for the
output contract; do not maintain a second algorithm listing in these notes.

- Preserve dependency order: resolved model metadata feeds authorization, and
  canonical entity Operations depend on CRUD, authorization and relationships.
- Propagate explicit field/profile authorization and classification metadata.
  Do not synthesize undeclared roles from sensitivity labels. Runtime enforcement
  must be checked in the consuming read/write paths, not inferred from compiler
  output alone.
- Keep fields, semantic types, storage and validation consistent across interface
  projections. Profiles extend the common model rather than fork its semantics.
- REST/MCP/web reference canonical Operation identities; do not independently
  reconstruct operation policy in a transport generator.
- When extending the contract, update the owning sub-compiler, compiled types and
  affected generators/consumers together. Add focused tests for meaningful success
  and failure cases, then check generated freshness/determinism.
- Read current helpers and tests before changing field precedence, persisted
  column resolution or authorization defaults; these are behavior, not refactors.
