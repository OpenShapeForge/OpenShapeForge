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

## Designing entity Web presentations in YAML

Before creating or changing `interfaces.web` views, analyse the entity and
design its presentation from the user's tasks. YAML syntax is the final
translation of that design, not the starting point. Read
[docs/authoring.md](docs/authoring.md) for the supported authoring contract.

1. **Understand the entity.** Inspect its current fields, semantic types,
   relationships, authorization, lifecycle, canonical Operations and workflow
   capabilities. Establish what users need to identify, understand, compare,
   create and edit, and which information matters in each state and role.
2. **Design the information hierarchy.** Select useful collection columns,
   labels, sorting and filters. For a record, choose the identifying title,
   essential summary and logical field groups with meaningful names and order.
   Use tabs only for distinct tasks or substantial related information. Do not
   dump fields in schema order or expose technical metadata without a user need.
   Consider read, create and edit separately, including empty states, required
   values, validation and conditional visibility or editability.
3. **Inspect the relevant Battery Figma patterns and actual components.**
   Understand the information hierarchy and interaction purpose of the available
   examples, including the Relation presentation. Its placement of important
   relationships in a first right-side panel and Operations or workflow actions
   in a right-side action area can guide a suitable entity; determine why each
   item belongs there rather than copying the arrangement indiscriminately.
   A small example set is not an exhaustive catalogue of entity designs. Use
   supported Battery components and APIs for every visual element. New visual
   design goes through the designer; a missing component capability requires a
   concrete gap and explicit product-owner approval before a visual deviation.
   Record approved deviations in the host's designer review register.
4. **Prefer editable properties and ordinary CRUD.** Most CRUD screens do not
   need additional user-facing Operations. A publication flag, for example,
   may be edited with a supported checkbox or switch and conditional validation
   when publishing is simply a permitted state change. Enforce authorization,
   validation and state-transition constraints on the backend as well as in the
   presentation. Introduce a separate Operation only for demonstrated behaviour
   that ordinary entity editing does not adequately express, such as approval,
   starting a workflow or external publication. Existing canonical CRUD
   Operations remain the underlying contract; avoiding an extra action does not
   remove that contract. A button in a Figma example alone does not justify a
   new Operation. Discuss the gap and obtain product-owner approval before
   introducing a new user-facing action.
5. **Place relationships and justified actions deliberately.** Decide which
   relationships are essential context, which are editable properties and which
   deserve a collection, tab or side panel. Reuse target-owned relationship
   views where appropriate. Place existing Operations and workflow actions
   according to task, importance, role and lifecycle state; do not invent actions
   to fill a panel.
6. **Translate the design into supported YAML.** Inspect the current schemas,
   compiler, component catalog and existing authored examples before choosing
   syntax. Explain the proposed groups, relationships and interaction choices
   in product terms and show the concrete YAML diff before implementation.
   Clearly distinguish supported configuration from a proposed foundation
   extension. If the intended design cannot be expressed, document the concrete
   gap and smallest sufficient alternative rather than inventing YAML keys or
   hiding procedural behaviour in configuration.
7. **Verify the rendered experience.** Compile and inspect the affected real
   browser journeys for collection, read, create, edit, relationships and any
   justified actions. Check role and state conditions, persistence and failure
   feedback. Retain meaningful screenshots, video and Playwright reports outside
   Git by default. Compilation and functional checks do not establish visual
   acceptance or product-owner acceptance; report these separately.

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
