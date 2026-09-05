# Authoring

All platform behavior starts in the authoring layer:
`packages/compiler/config/authoring/` (the base layer declared in
`authoring.config.yaml`; overlays and plugin layers can extend it — see
[layers.md](layers.md)).

```
authoring/
  entities/
    _base.yaml            shared meta fields (merged into every entity)
    core/                 organizational subfolder (any nesting allowed)
      relation.yaml
      relation-group.yaml
      contact-detail.yaml
  catalogs/
    components.yaml       render-component catalog + per-type defaults
    semantic-types.yaml   reusable field semantics (email, phone, iban, …)
    core-referentiedata.yaml   code tables ("groepen") -> JSON snapshot
    transforms.yaml       mapping transforms (enumMap/cast/fallbackChain)
    retention-policies.yaml    named retention policies
    field-authoring-profiles.yaml  field-editor profiles (web authoring UI)
  authorization.yaml      Keycloak tenant realm: clients/roles/groups/dev users
  authorization.control.yaml  Keycloak control realm (platform operators)
  appShell.yaml           web app shell + sidebar navigation
  views/                  optional standalone view YAML (empty here)
  contexts/, mappings/    supported by the loader, unused in this repo
```

## Entity files and slugs

- An entity is one YAML file under `entities/`. Subfolders (`entities/core/`,
  a future `entities/finance/`, …) are **organizational only** — the entity
  **slug is the file stem** (`relation-group.yaml` → `relation-group`) and
  must be unique across the entire tree; duplicates fail compilation.
- Files starting with `_` (like `_base.yaml`) are shared meta definitions,
  never entities.
- The slug drives table naming (`relation-group` → `erp.relation_groups`),
  GraphQL names, and patch targeting across layers.

## Entity YAML anatomy

Verified against `entities/core/relation.yaml` and the types in
`packages/compiler/src/authoring/types/authoring.ts`:

```yaml
schemaVersion: 1
kind: coreEntity
module: core                 # module -> DB schema (core maps to "erp")
entity: Relation             # PascalCase name (GraphQL type, targets)
title: Relation
description: { en: ..., nl: ... }
language: en
displayTemplate: "{{displayName}}"   # instance rendering template
filterField: displayName             # free-text typeahead filter field
labels: { en: Relation, nl: Relatie }
domains: [relations]

authorization:               # presence makes the entity TENANT-SCOPED:
  roles:                     # the compiler injects a tenant_id column and
    read: [Relaties.All.Read, Relaties.All.ReadWrite]   # an RLS policy
    create: [Relaties.All.ReadWrite]
    update: [Relaties.All.ReadWrite]
    delete: [Relaties.All.ReadWrite]
  rowAccess: { enabled: true, empty: public }

fields:
  - key: displayName         # camelCase field key
    valueType: string        # string|integer|number|boolean|date|datetime|object
    required: true
    label: { en: Display name, nl: Weergavenaam }
    description: { en: ..., nl: ... }
    validation:
      minLength: { value: 1, message: { en: Name is required, nl: ... } }
      maxLength: 200         # plain number or {value, message} both work
    persisted:               # ONLY persisted fields become columns
      column: display_name
      storageClass: core
  - key: relationType
    valueType: string
    required: true
    persisted: { column: relation_type, storageClass: core }
    render:                  # render component + props (see components.yaml)
      component: ReferenceSelect
      props: { referentieGroep: RELATIESOORT, clearable: false }

relationships:
  - key: relationGroup
    kind: belongsTo          # belongsTo | hasMany
    target: RelationGroup    # PascalCase entity name
    foreignKey: relation_group_id
    label: { en: Relation group, nl: Relatiegroep }

ui:
  routes:                    # localized route templates per action
    list:   { en: /relations,            nl: /relaties }
    detail: { en: /relations/:id,        nl: /relaties/:id }
    create: { en: /relations/create,     nl: /relaties/aanmaken }
    edit:   { en: /relations/:id/edit,   nl: /relaties/:id/bewerken }
    delete: { en: /relations/:id/delete, nl: /relaties/:id/verwijderen }
  presentations:
    list:                    # columns, sortability, defaultSort, rowLink
      columns: [{ key: displayName, sortable: true }, ...]
      defaultSort: { key: displayName, direction: asc }
    detail:                  # header (title/subtitle/badges), actions,
      groups: [...]          # grouped field sections; a group may render a
                             # relationship instead (relationship: members)
    form:
      variants:
        create: { title: ..., groups: [...] }
        edit:   { extends: create, title: ... }

workflow:                    # opt-in to entity workflow nodes (consumed by
  nodes:                     # the workflow plugin; see plugins.md)
    actions: { create: true, getOne: true, list: true, update: true, delete: true }

crud:                       # common upper bound for every generated surface
  operations:              # absent crud: keeps the historical all-true default
    list: true
    get: true
    create: false          # read-only example
    update: false
    delete: false

rest: true                   # opt-in generated REST exposure (see below)
```

Notes on what the compiler does with this:

- **Only `persisted` fields produce columns.** A field without a `persisted`
  block is model/UI-only.
- **`readOnly` is presentation; `immutable` is the contract.** `readOnly: true`
  makes the renderer pick a field's display component over its input one and
  says nothing about the API — every transport still accepts the field.
  `immutable: true` is the API contract: the value is settable when the record
  is created and refused on update by REST (`400`), GraphQL (absent from the
  update input) and MCP (absent from the update tool schema). It is the flag for
  a provenance link — `PaymentDetail.relationId` is authored with it, so a
  payment detail cannot be re-pointed at a different relation after the fact
  (#177). The two are independent: a field may be either, both, or neither.
- **`tenant_id` is injected automatically** when the entity has an
  `authorization` block (that is what makes it tenant-scoped and gives it an
  RLS policy). `created_at`/`updated_at` are appended automatically when not
  declared.
- **`ui.presentations.list.defaultSort`** is compiled into the manifest and
  applied by the API when resolving embedded `hasMany` lists.
- **`hooks:`** (before/after create/update/delete) is a valid block and is
  recorded on the compiled contract, but **the runtime does not execute
  hooks** today.
- **`indexes:`** (entity-level) compiles to `CREATE [UNIQUE] INDEX IF NOT
  EXISTS`; field keys are resolved to persisted column names.
- Entity-derived Keycloak role emission (`<slug>:read` etc. on the
  `entityRoleClient`) exists in the generator but currently emits nothing for
  this repo's entities — see the caveat in
  [api.md](api.md#authentication--authorization).
- The generic CRUD engine **enforces** the `authorization.roles` lists at
  request time, fail closed, for both GraphQL and REST: per operation the
  session's roles must intersect the entity's list or the request is
  `FORBIDDEN` (403) before any SQL runs. The compiler emits each list into
  the manifest as the union of the authored names and their
  Keycloak-normalized (Dutch → English) forms so bearer tokens and
  trusted-context callers both match. See
  [api.md](api.md#authentication--authorization).

### `crud:` — common generated-operation policy

This field is part of compiled entity contract version 2. Consumers that
validate compiled contracts must upgrade before accepting version 2. The
version bump makes this wire-contract change detectable; it is not by itself
a runtime barrier for plugin code that does not validate supported contract
versions. Generated manifests therefore also encode partial policies with
`generatedCrudEligible: true` and the legacy `generatedCrud: false`, so an old
runtime hides the entity instead of exposing full CRUD.

`crud` is the transport-independent upper bound for GraphQL, REST, MCP and
generated workflow nodes. Existing entities that
omit it keep all five operations enabled. `crud: false` disables every generic
operation; the object form can make an entity read-only or expose a smaller
set. `rest.operations`, `mcp.operations` and `workflow.nodes.actions` may
further narrow the common policy but cannot widen it.

Declare `crud` only on a core entity, a standalone `contexts/*/full` entity, or
an `entityPatch`. A `contexts/*/partial` profile extends fields on an existing
resource and is rejected if it declares its own CRUD policy.

The stock generated entity pages are emitted only when all five operations are
enabled, because those pages assume the complete list/detail/edit surface.
Entities with a partial policy use a purpose-built UI.

Per-operation exposure is a prerequisite for immutable, versioned resources:
it removes generic mutation entry points, but remains defense in depth and does
not replace database-level immutability for published records.

Because this is a security policy, authoring layers are monotonic: an
`entityPatch` may turn an operation from `true` to `false`, but a later layer
cannot restore an operation disabled by an earlier layer. Change the owning
layer when broader exposure is intended.

### `rest:` — generated REST exposure

REST is **opt-in per entity** (fail closed, like the generated-CRUD
allowlist). Absent or `false` means no REST routes. Two forms:

```yaml
rest: true                   # shorthand: all operations, derived basePath
# — or —
rest:
  enabled: true              # default true when the block is present
  basePath: relations        # optional; default = table name with _ → -
                             # (RelationGroup → relation-groups); must match
                             # ^[a-z][a-z0-9-]*$ (emitted verbatim into routes)
  operations:                # each defaults to true when REST is enabled
    list: true
    get: true
    create: true
    update: true
    delete: false
```

What the compiler does with it:

- `buildRest()` (`authoring/compiler/rest.ts`) normalizes the block into the
  contract's `rest` section; the backend manifest bridges it to
  `source.rest` on the table, which drives the API's route registration
  (see [api.md](api.md#the-generated-rest-surface)) and the generated
  OpenAPI spec (`apps/api/src/generated/rest/openapi.json`).
- **Compile error** if a rest-enabled entity is not in the generated-CRUD
  allowlist or is `domainInternal` — REST delegates to the generated CRUD
  engine, so the combination is a misconfiguration.
- **Compile error** if two entities claim the same `basePath` (part of the
  collision audit).

### Relationships

- `belongsTo` needs a `foreignKey` column (a persisted uuid column on this
  entity). If the **target entity is compiled in this repo**, the compiler
  emits a real foreign-key constraint; targets that are not present are
  recorded under `relationshipStatus.skippedReferences` in the manifest and
  no FK is emitted. Cross-module references additionally require an entry in
  the `relationshipRegister` (see `config/platform-schema.yaml`).
- `hasMany` is the inverse side: `foreignKey` names the column **on the
  target** that points back at this entity. The API resolves it as an
  embedded list plus a `<name>Aggregate { count }` field.

## `_base.yaml` — shared meta fields

`entities/_base.yaml` (`kind: baseEntity`) is merged into **every** core and
context-full entity at load time. It contributes:

| Field | Column | Notes |
| --- | --- | --- |
| `id` | `id` | uuid, required, readOnly; per-entity semantic type auto-derived |
| `createdAt` / `updatedAt` | `created_at` / `updated_at` | datetime, readOnly |
| `externalId` | `external_id` | id of the record in a connected source system |
| `sourceAuthority` | `source_authority` | responsible authority / data steward |
| `sourceOrganization` | `source_organization` | owning external organization |
| `sourceAdministration` | `source_administration` | sub-ledger within the source |

Redeclaring one of these fields in an entity is a compile error
(strict-replace semantics). `tenant_id` is deliberately **not** part of the
base — it is injected only for entities with an `authorization` block, so
non-tenant tables never grow one. The file is optional: without it, entities
simply get no base fields.

## Catalogs

Catalog files under `catalogs/` merge across authoring layers automatically
(same-path strategic merge — see [layers.md](layers.md#catalog-merging)):

- **`core-referentiedata.yaml`** — code tables (`groepen:` →
  `RELATIESOORT`, `COMMUNICATIEKANAAL`, …) with localized labels
  (nl/en/fr). Compiled into the snapshot
  `packages/compiler/config/referentiedata/core-by-groep.json` (and a copy
  under `apps/web/src/lib/` only when `apps/web` exists). Fields reference a
  group via `render.props.referentieGroep`.
- **`semantic-types.yaml`** — reusable field semantics: validation pattern,
  render components, data classification (`pii`, `confidential`, …),
  retention, icon. A field opts in with `semanticType: email`. Resolution
  priority for render/validation: explicit field config → semantic type →
  field-type default → fallback.
- **`components.yaml`** — the render-component catalog: default component per
  `valueType` (string → `Input`, boolean → `Switch`, …), view defaults, and
  component definitions with their allowed props.
- **`transforms.yaml`** — named mapping transforms (`enumMap`, `cast`,
  `fallbackChain`) used by entity mappings.
- **`retention-policies.yaml`** — named retention policies entities/fields
  can reference. What the compiler emits from these, and the (not-yet-built)
  runtime enforcement and data-subject erasure gaps, are documented in
  [retention.md](retention.md).
- **`field-authoring-profiles.yaml`** — presets for a (web) field-authoring
  editor; no effect on the data layer.

## `authorization.yaml` (and `authorization.<realm>.yaml`)

One file authors one whole Keycloak realm export: realm settings (token
lifespans, org feature), clients (`gateway` / `bearerOnly` / `serviceAccount`
kinds), realm roles with per-client composites, hand-authored client roles, a
demo group hierarchy, and dev users with plain passwords and a `tid` (tenant
UUID) attribute. Each is generated to `keycloak/<realm.name>-realm.json` and
mounted into the local Keycloak container, whose `--import-realm` imports every
file in its import directory.

Two realms are authored here:

- **`authorization.yaml`** — the tenant realm `openshapeforge`. Its
  `keycloak.entityRoleClient` (`erp-provider`) is the designated target for
  entity-derived roles. See [api.md](api.md#local-stack) for the dev logins.
- **`authorization.control.yaml`** — the control realm
  `openshapeforge-control`, the issuer `apps/admin` signs platform operators in
  against. Deliberately minimal: one gateway client, one `platform-operator`
  realm role, no tenant users, and no `entityRoleClient` — a realm that names
  none takes no entity-derived roles at all.

Keeping operators out of the tenant realm is the point of the split: an
identity that can create and suspend tenants has no business existing in the
realm those tenants log into.

Either realm may also author `keycloak.identityProviders` — external social or
corporate (OIDC/SAML) providers, emitted exactly as written. Neither shipped
realm does; see [identity-providers.md](identity-providers.md).

### Overlaying a realm: `kind: authorizationPatch`

A host that consumes the compiler as a package inherits these realm files and
usually wants to change a few things in one of them — the audience client's
name, an extra client, one more composite on a realm role — without forking
the whole file. Shipping a plain `authorization.yaml` in a later layer is a
layer collision, and a second `authorization.<x>.yaml` naming the same realm
is refused by the generator; the supported way is a **patch at the same
path** as the realm file it targets:

```yaml
# host-layer/authorization.yaml   (patches the base authorization.yaml;
#                                   authorization.control.yaml patches that realm)
kind: authorizationPatch

# 1. Optional. Moves one client id everywhere the base refers to it:
#    keycloak.entityRoleClient, keycloak.clients[].id, the client keys of
#    realmRoles.*.composites, clientRoles, users[].clientRoles and
#    serviceAccountClientRoles. Only the id moves; the client's own fields
#    are set below, under the NEW id.
renameClient: { from: erp-provider, to: acme-api }

# 2. Everything else strategic-merges onto the (renamed) base.
keycloak:
  clients:
    - id: acme-api                      # merges by id into the renamed client
      name: Acme API
      devSecret: acme-api-secret
      secret: ${env:KEYCLOAK_CLIENT_SECRET_ACME_API}
    - id: acme-reporting                # unknown id: appended
      kind: bearerOnly
    - id: openshapeforge-knowledge-base
      $delete: true                       # keyed-array delete
realmRoles:
  directie:
    composites:
      acme-api: [Pentest.All.ReadWrite] # role lists UNION: added, base kept
  pentester:                              # new realm role
    description: Pentester
    composites:
      acme-api: [Pentest.All.ReadWrite, Pentest.All.Read]
clientRoles:
  acme-api: [Pentest.All.ReadWrite, Pentest.All.Read]
```

Rules, in the order they apply:

1. **`renameClient: { from, to }`** rewrites references only. `from` must be
   a client of the realm being patched (or its `entityRoleClient`); `to` must
   not already exist. Nothing else in the client changes — so after a rename
   the base's `secret: ${env:KEYCLOAK_CLIENT_SECRET_ERP_PROVIDER}` is still
   there until the patch sets a new one. Anything else that named the old id
   outside authoring (runtime `aud` pins, setup scripts) is yours to move.
2. **Strategic merge** of the rest ([layers.md](layers.md#kind-entitypatch--strategic-merge-semantics)):
   objects deep-merge, `null` deletes a property, `keycloak.clients[]` merges
   by `id` with `$delete: true`, other arrays (`users`, `groups`,
   `redirectUris`, …) replace wholesale.
3. **Role-name lists union** instead of replacing: `clientRoles.<client>`,
   `realmRoles.<role>.composites.<client>` and `realmRoles.<role>.includes`
   keep the base's grants in base order and append the patch's. A grant list
   is a set, and "add one composite" restating fifteen others is how a grant
   silently goes missing. To take a grant away, set the client key to `null`
   or change the owning layer.
4. **Grants are monotonic across layers**, the same way generated CRUD
   exposure is ([layers.md](layers.md#kind-entitypatch--strategic-merge-semantics)):
   a later layer may union onto a grant list no earlier layer declared at
   that exact path, or narrow one it did, but it cannot add to a list an
   earlier layer already declared there — that append would union onto a
   base living in a different file, invisible to a review of the later patch
   alone. Widening one of those lists on purpose takes two steps: set the key
   to `null` in one layer (an explicit narrow), then declare the full desired
   list in a later one — a plain assignment, not a union, so the whole grant
   set is visible in that one file.
5. The merged document is **validated as an `authorizationConfig`** and the
   error names the patch file, not the merged file nobody wrote.

A patch may carry `renameClient`, `realm`, `keycloak`, `realmRoles`,
`clientRoles`, `groups` and `users`; `schemaVersion` is the base's and cannot
be patched. Patching a realm no earlier layer defines is an error (a new
realm is an `authorizationConfig` under its own filename), as is a patch
filed anywhere but the layer root. Patches stack across layers in order.

## `appShell.yaml`

Shell component + sidebar navigation (labels, icons, `entity:` references).
Consumed only by web UI generation, so it has no effect in a repo with no `apps/web`.

## Contexts and mappings (supported, unused here)

The loader also understands a per-context structure that this repo does not
use (no `contexts/` directory exists in the base layer):

- `contexts/<ctx>/partial/<entity>.yaml` — profile extensions of a core
  entity (`kind: entityProfile`, extra fields, own storage table).
- `contexts/<ctx>/full/<entity>.yaml` — standalone entities that exist only
  in one context; compiled into synthetic core entities (origin
  `contextFull`).
- `contexts/<ctx>/semantic-types.yaml` — context-scoped semantic-type
  catalogs merged over the core catalog.
- `mappings/<ctx>/<entity>.mapping.yaml` — field mappings between source and
  target entities using the transform catalog.
- `views/<entity>.view.yaml` — standalone view definitions.

An overlay layer can introduce all of these without compiler changes.

## Adding an entity end-to-end

1. Create `packages/compiler/config/authoring/entities/core/<slug>.yaml`
   (any subfolder works; the slug must be unique). Give it an
   `authorization` block if it holds tenant data. Relationships may only
   target entities present in this repo.
2. Bump `expectedGeneratedCrudEntityCount` in
   `scripts/check-generated-artifacts.mjs` (currently `3`).
3. `bun run generate` — regenerates schema.sql, types, manifest, realm,
   plugin artifacts.
4. `bun run db:migrate` — new tables/columns are additive and apply
   automatically ([migrations.md](migrations.md)).
5. Done. The GraphQL CRUD surface, entity-event journaling, the e2e suite,
   and the k6 load test all pick the entity up from the manifest — no test or
   API code changes ([testing.md](testing.md)).

A new **field** on an existing entity is steps 3–4 only.

## The schemas are enforced

`packages/compiler/config/schemas/*.json` describes the shape of every
authoring artifact, and — since #182 — is checked rather than merely published:

- `bun run check:authoring-schemas` validates every authoring YAML in this
  repository against the schema for its `kind`. It runs in CI. "In this
  repository" means every layer `authoring.config.yaml` resolves to — the
  configured `layers:` **and** the `authoring/` directory of each plugin it
  loads — taken from `authoringLayerDirs` in
  `packages/compiler/src/authoring/layers.ts`, the same resolver the compiler
  uses. A plugin that contributes authoring cannot contribute unvalidated
  authoring (#237).
- Artifacts that can arrive from **outside** this repository are validated at
  load instead, because no in-repo gate can see them all. Connector contracts
  are the case that exists today: `connector-loader.ts` validates a contract
  before anything else touches it, whether it came from here, from a package,
  or from a host repo's own layer.

Both paths share one validator, so they cannot disagree about what a schema
means. Adding an authoring `kind` requires listing it in `SCHEMA_BY_KIND` or in
`UNSCHEMAD_KINDS` (with the reason) in
`packages/compiler/src/authoring/schema-validation.ts` — a new kind cannot
become unvalidated by omission.

The gate also asserts, per schema, **how many** files it validated, against
`EXPECTED_SCHEMA_COVERAGE` in `scripts/check-authoring-schemas.mjs`. A mapped
schema matched against nothing used to print the same success line as one
matched against a full corpus, so adding or removing authoring means bumping
the count there — the same bookkeeping as `expectedGeneratedCrudEntityCount`
in `scripts/check-generated-artifacts.mjs`.

Schema validation does **not** replace the identifier allowlists in
`loader.ts` and `connector-loader.ts`. Those guard names that are spliced
verbatim into generated TypeScript, GraphQL, SQL, route strings and MCP tool
names; a shape schema documents a shape, and both layers must fail closed
independently.

To keep an authored entity **out of every generated CRUD surface**, set
`crud: false` on that entity. Secret-bearing and runtime-scheduler entities in
the base catalog use this declaration; no compiled slug denylist is involved.
