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
  authorization.yaml      Keycloak realm/clients/roles/groups/dev users
  appShell.yaml           web app shell + sidebar navigation (dormant)
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
```

Notes on what the compiler does with this:

- **Only `persisted` fields produce columns.** A field without a `persisted`
  block is model/UI-only.
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
- The generic CRUD engine does **not** enforce the `authorization.roles`
  lists at request time; see [api.md](api.md).

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

## `authorization.yaml`

One file authors the whole Keycloak realm export
(`keycloak/openshapeforge-dev-realm.json`, generated and mounted into the local
Keycloak container): realm settings (token lifespans, org feature), clients
(`gateway` / `bearerOnly` / `serviceAccount` kinds), realm roles with
per-client composites, hand-authored client roles, a demo group hierarchy,
and dev users with plain passwords and a `tid` (tenant UUID) attribute. The
`keycloak.entityRoleClient` (`erp-provider`) is the designated target for
entity-derived roles. See [api.md](api.md#local-stack) for the dev logins.

## `appShell.yaml`

Shell component + sidebar navigation (labels, icons, `entity:` references).
Consumed only by web UI generation, which is dormant without `apps/web`.

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

To keep a generated table **out of the CRUD surface**, its slug must be in
`generatedCrudDeniedEntitySlugs` (`packages/compiler/src/active-manifest.ts`);
such tables are marked `domainInternal` and get no GraphQL surface (used for
secret-bearing or runtime-scheduler tables).
