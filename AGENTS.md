# OpenShapeForge agent instructions

## Scope and ownership

OpenShapeForge owns the generic compiled application contract, canonical
Operations and shared execution/interface boundaries. Keep host-specific domain
rules and presentation in plugins or hosts; do not import a host into the core.
Inspect the current source and package exports before assuming a capability is
missing. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/README.md](docs/README.md).

When this tree is embedded in a containing workspace, that workspace owns local
branches, task tracking and runtime assembly. Do not create a second issue or
publish a package for every local edit. Standalone publication follows this
repository's contribution and release policy. Keep the public tree portable.

## Public distribution and licensing

- Treat source, history, issues and review text as public. Never include real
  credentials, personal data, private project references or internal URLs.
  Synthetic local credentials must remain local-only. Report suspected leaks
  without repeating the value; a removal commit does not revoke a secret.
- Follow [LICENSE](LICENSE) and record origin/license of introduced third-party
  code. Do not add incompatible copyleft dependencies or describe this
  source-available distribution as unrestricted open source.
- Keep commits focused and imperative, with no AI-attribution trailers. Preserve
  other agents' changes. Use the PR template and report actual verification;
  tick only checks actually satisfied. Public work and plans use the existing
  issue tracker; do not duplicate a containing workspace's local task.

## Compiler and runtime invariants

- Edit the owning source, authoring configuration or generator, then regenerate.
  Determine generated ownership from `packages/compiler/src/generated-artifact-paths.ts`
  and `.gitignore`, not a `generated-` filename prefix: some consumers are handwritten.
- Compiler/plugin output must be reproducible for the same inputs. Use the
  current `check:generated` command to prove freshness/determinism where affected.
- Keep authorization, validation and effects in canonical Operations. Interfaces
  project that contract; they must not invent independent permission or input rules.
- Preserve tenant isolation and verified identity. For changes at those boundaries,
  include denied/cross-tenant cases as well as successful behavior.
- Prefer supported `entityPatch` and plugin extensions to copied core models.
  Check the current authoring schemas and coverage checks when adding YAML.
  Add targeted behavioral tests when manifest-derived coverage is insufficient.
- OSF is greenfield. Development data is disposable and may be rebuilt from
  updated seeds in the task's isolated database. Do not add data migrations,
  compatibility shims, fallback paths or duplicate contracts merely to preserve
  old development data. Remove existing layers that serve only those obsolete
  contracts/data too; do not merely stop adding new ones. Retain bootstrap and
  invariant DDL that the current model still needs. Complete code migration, update all affected consumers,
  remove superseded code/config/tests and reseed in the same change. Do not defer
  this cleanup as technical debt. Coordinate before resetting a shared runtime;
  this development policy does not authorize destruction of external/customer data.
- Reusable presentation belongs in its owning shared package; apps assemble it.
  Check current package scripts rather than assuming a web test runner is absent.
- UI copy defaults to English; preserve explicit language selection and intentional
  sample data languages. Read scoped AGENTS.md for compiler/auth internals.

## Iteration and promotion

For a local design iteration, run focused checks that establish the changed
behavior and preserve the above invariants. Documentation-only edits need
instruction/link/diff checks, not database or browser setup.

Before promotion, inspect current package scripts, CI and branch requirements.
Run all applicable required checks; typical areas are generated/authoring
freshness, compiler/API typechecks, compiler tests and database tests. Dependency
changes require license/notices checks; hot-path changes may need performance
proof; changed web journeys need real browser proof. Use isolated services.
Report pass/fail and skipped checks accurately; preserve failing exit codes.

Normal feature contributions target `develop`; promotion to `main` is a separate
reviewed release. Agents have standing user authorization to complete this
release path, merge to `main`, publish packages and deploy after local review
and the applicable required checks, without separate approval from Hans.
Coordinate package and host dependencies with their owners. This permission
applies within the agreed task scope; local-only work stays local and product
acceptance remains with Hans. Follow protected branches and environment boundaries.
