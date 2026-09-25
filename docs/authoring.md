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
    osf-types.yaml   reusable field semantics (email, phone, iban, …)
    core-referentiedata.yaml   code tables ("groepen") -> JSON snapshot
    transforms.yaml       mapping transforms (enumMap/cast/fallbackChain)
    retention-policies.yaml    named retention policies
    field-authoring-profiles.yaml  field-editor profiles (web authoring UI)
  authorization.yaml      Keycloak tenant realm: clients/roles/groups/dev users
  authorization.control.yaml  Keycloak control realm (platform operators)
  menu.yaml           web app shell + sidebar navigation
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
schemaVersion: 3             # the only authored shape; the loader refuses others
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
    osfType: string          # the ONE type axis: a base type, a osf-type
    required: true           # catalog key, or an entity name (see below)
    label: { en: Display name, nl: Weergavenaam }
    description: { en: ..., nl: ... }
    validation:
      minLength: { value: 1, message: { en: Name is required, nl: ... } }
      maxLength: 200         # plain number or {value, message} both work
    persisted:               # ONLY persisted fields become columns
      column: display_name
      storageClass: core
  - key: relationType
    osfType: referenceDataCode   # a catalog entry: its baseType is the base
    required: true
    persisted: { column: relation_type, storageClass: core }
    options: { type: referentiedata, referentieGroep: RELATIESOORT }
  - key: relationGroupId     # a single entity reference: the FK field itself
    osfType: RelationGroup   # PascalCase entity name; base type is string/uuid
    label: { en: Relation group, nl: Relatiegroep }
    persisted: { column: relation_group_id, storageClass: core }
    relationship:
      ownership: reference
      inverse:               # optional: shapes the collection the compiler
        key: relations       # derives on RelationGroup (default: lower-camel
        label: { en: Relations, nl: Relaties }   # plural of this entity)

operations:                  # EVERY behaviour of the entity, generated CRUD
  list:                      # included: an intent the entity does not
    name: { en: List relations, nl: Relaties tonen }   # implement does not exist
    description: { en: ..., nl: ... }
    implementation: { type: entity, action: list }     # or a plugin handler
    effects: { data: read, external: none }
    reliability: { idempotency: { mode: natural } }
    confirmation: { mode: none }
  get: { ... }               # get, create, update, delete, plus any
  create: { ... }            # entity-specific Operation (publish, archive, ...)

interfaces:                  # thin per-transport projections of `operations`;
  rest: {}                   # each may narrow the set, never widen it
  graphql: {}
  mcp:
    operations:
      create: { instructions: { en: ..., nl: ... } }
    resource: { uri: app://relations, name: Relations, description: ... }
  web:
    views:
      collection:            # the collection page: route, columns, sort
        route: { en: /relations, nl: /relaties }
        columns: [{ key: displayName, sortable: true }, ...]
      record:                # the record page: routes, title, tabbed layout
        routes: { read: { en: /relations/:id, nl: /relaties/:id } }
        title: "{{displayName}}"
        layout: { tabs: [...] }
```

### Target-owned Web views on relationships

A record tab may select a view by name on its relationship target. The target
entity owns that view; the referring entity only chooses it. `record` and
`collection` remain the standard names. Additional views live under
`interfaces.web.views.named` on the target:

```yaml
# On Document: a collection relationship placement
- id: content
  label: { en: Content, nl: Inhoud }
  relationship: { name: variants, view: tabbed }

# On DocumentVariant: the target-owned collection view
named:
  tabbed: { kind: collection, collectionLayout: tabs, itemView: record, tabLabel: locale }
```

`collectionLayout` is `table`, `tabs` (one tab per item), or `stack` (items in
order). A tabs/stack view selects an `itemView` owned by the same target
entity. That can be its standard `record` view or a named `record` view with
`fields`, for example `preview: { kind: record, fields: [values] }` on Block.
The compiler checks that the selected view exists and accepts the relation's
single-record or collection shape. No referring-entity renderer mapping is
needed.

Named record views also accept the same `layout` as the default `record`:

```yaml
named:
  card:
    kind: record
    title: "{{title}}"
    layout:
      tabs:
        - id: details
          label: { en: Details, nl: Details }
          groups:
            - id: summary
              title: { en: Summary, nl: Samenvatting }
              fields: [title, status]
        - id: children
          label: { en: Children, nl: Onderdelen }
          relationship: { name: children, view: tabbed }
```

The example assumes `title`, `status` and `children` are fields on this entity,
and the child entity owns `tabbed`. Either a single relationship selects `card`,
or a collection view on this entity selects `itemView: card`. The compiler uses
the default record layout compiler and manifest projection for both. Relationship
overrides stay local to the selected view. `fields: [...]` remains a shorthand
for one tab and is normalized to the same record layout; do not combine it with
`layout`. Named views are embedded read presentations, not additional routes or
write Operations. The optional `title` defaults to the standard record title.

### Action-specific record permissions

An entity can let one persisted JSON field further narrow its ordinary tenant
and role authorization. The shape is fixed: optional `view`, `edit`, and
`delete` objects, each containing optional `users`, `groups`, and `roles`
string arrays. A valid empty subject set follows the authored `empty` rule;
malformed JSON always denies access.

```yaml
authorization:
  roles:                    # still required: a record ACL never grants a role
    read: [Records.All.Read]
    create: [Records.All.Manage]
    update: [Records.All.Manage]
    delete: [Records.All.Delete]
  rowAccess:
    enabled: true
    empty: public
    recordPermissions:
      field: authorization
      empty: public
      createRequires: [view, edit]

fields:
  - key: authorization
    osfType: object
    required: true
    defaultValue: {}
    persisted: { column: authorization, storageClass: core }
```

Generated list/get require `view`, update requires `view` and `edit`, and
delete requires `view` and `delete`. Create checks the submitted/default ACL
against `createRequires`, preventing an author from creating a record they
cannot reopen. A record-scoped plugin Operation can add
`auth.recordPermission: view|edit|delete`; this is checked before challenges
or leases are issued and again inside the write transaction. This semantic
action is independent of its SQL verb, so an archive implemented with UPDATE
can truthfully require `delete`.

Notes on what the compiler does with this:

- **Only `persisted` fields produce columns.** A field without a `persisted`
  block is model/UI-only.
- **`readOnly` is presentation; write provenance is the contract.**
  `readOnly: true` makes the renderer pick a field's display component over
  its input one and is never an authorization or integrity rule by itself.
  `immutable: true` is the API contract: the value is settable when the record
  is created and refused on update by REST (`400`), GraphQL (absent from the
  update input) and MCP (absent from the update tool schema). It is the flag for
  a provenance link — `PaymentDetail.relationId` is authored with it, so a
  payment detail cannot be re-pointed at a different relation after the fact
  (#177). A persisted `readOnly` field that is intentionally supplied by a
  caller declares `writeSource: caller`; this makes that otherwise-surprising
  write path explicit without changing its create/update behavior. Computed,
  derived, and compiler-owned intrinsic fields use their existing source
  declarations instead. A server-managed persisted field names every
  legitimate canonical writer with `writtenBy: [Operation.id]`; generic create
  and update inputs
  then omit it, and the compiler verifies that every named writer exists and
  is reachable. `readOnly`, `immutable`, and `writtenBy` are independent
  declarations and must describe the field's real write lifecycle together.
- **A status field can be a state machine.** `transitions: { initial, rules }`
  on a field with static options compiles each rule into the Operation
  `<Entity>.<rule.key>` (REST, GraphQL, MCP and the web record actions), makes
  the field and the rule's `writes` fields `writtenBy` it, and offers the rule
  only while the record's status is in `from`. See
  [operations.md](operations.md#transitions).
- **Internal identifiers are derived, not entered.** A persisted required
  string field can declare
  `deriveOnCreate: { from: name, transform: slug, onConflict: suffix }`. The
  field is then absent from create and update inputs in Web, REST, GraphQL and
  MCP. The API stores the slug once, keeps it stable when the source is later
  edited, and allocates `name-2`, `name-3`, and so on under the database unique
  index. Tenant-scoped entities must declare that index as
  `fields: [tenantId, <derivedField>]`; global entities use only the derived
  field. The compiler rejects missing sources, non-persisted/non-string fields,
  and derivations without this race-safe index. Put only fields a person should
  actually enter in form groups; identifiers and IDs are implementation data.
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

### Generated CRUD is the set of implemented Operations

There is no separate CRUD policy. An entity exposes exactly the five
intents (`list`, `get`, `create`, `update`, `delete`) that its `operations`
implement, whether by the built-in entity implementation or a plugin
handler. A read-only entity simply has no `create`, `update` or `delete`
Operation; an internal entity has none at all. That set is the upper
bound for GraphQL, REST and MCP; each
`interfaces.*` block may exclude an Operation (`operations: { delete: false }`)
but cannot add one.

The stock generated entity pages are emitted only when all five intents are
implemented, because those pages assume the complete list/detail/edit
surface. Entities with a smaller set use a purpose-built UI, declared under
`interfaces.web`.

Per-Operation exposure is a prerequisite for immutable, versioned resources:
it removes generic mutation entry points, but remains defense in depth and
does not replace database-level immutability for published records.

### `interfaces.rest` — generated REST exposure

REST is **opt-in per entity** (fail closed, like the generated-CRUD
allowlist). Absent means no REST routes.

```yaml
interfaces:
  rest: {}                   # every implemented Operation, derived basePath
  # — or —
  rest:
    basePath: relations      # optional; default = table name with _ → -
                             # (RelationGroup → relation-groups); must match
                             # ^[a-z][a-z0-9-]*$ (emitted verbatim into routes)
    operations:              # each implemented Operation defaults to exposed
      delete: false          # `false` withholds one from this transport
```

What the compiler does with it:

- `buildRest()` (`authoring/compiler/rest.ts`) projects the block into the
  contract's `rest` section; the backend manifest bridges it to
  `source.rest` on the table, which drives the API's route registration
  (see [api.md](api.md#the-generated-rest-surface)) and the generated
  OpenAPI spec (`apps/api/src/generated/rest/openapi.json`).
- **Compile error** if a rest-enabled entity is not in the generated-CRUD
  allowlist or is `domainInternal` — REST delegates to the generated CRUD
  engine, so the combination is a misconfiguration.
- **Compile error** if two entities claim the same `basePath` (part of the
  collision audit).

`interfaces.mcp` works the same way (`buildMcp()`, `authoring/compiler/mcp.ts`)
with `tools`, per-Operation `instructions` and an optional `resource`.

### Relationships

Relationships are fields; there is no entity-level `relationships:` block
(one is refused by name).

- A **single reference** is a field whose `osfType` is an entity name. Its
  `persisted.column` (default `<key>_id`) is the foreign key. The target
  entity must be compiled in the same manifest — a reference to an absent
  entity fails the build. Between two tenant-scoped entities the constraint
  is `(tenant_id, <column>) -> target(tenant_id, id)`: a row can only ever
  point at a row of its own tenant, whatever its `schemaVersion`. A
  cross-module reference is registered in the manifest's
  `relationshipRegister` by the compiler; only references declared directly
  in `config/platform-schema.yaml` list theirs by hand.
- The **inverse collection is derived**, never authored. Every single
  reference gives its target entity a collection of the referencing records:
  key = lower-camel plural of the referencing entity (`AgreementParty` →
  `agreementParties`), label = that entity's `labels`. The API resolves it as
  an embedded list plus a `<name>Aggregate { count }` field. The referencing
  field shapes the collection with `relationship.inverse`:
  `{ key, label, ownership: owned, sortable, childAuthorization: owner,
  allowedDefinitions }` — all optional — or `false` for no collection.
- When several fields of one entity reference the same target, no default
  is derived: each of them declares `inverse` (`{ key }` or `false`), so a
  collection never silently follows the wrong foreign key.
- A read-only traversal through a local single reference (`cardinality:
  collection` + `relationship: { inverse: <field on target>, via: <local
  reference> }`) is the one collection that stays authored: it has no
  foreign key of its own to derive from.

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
- **`osf-types.yaml`** — reusable field semantics: validation pattern,
  render components, data classification (`pii`, `confidential`, …),
  retention, icon. Every entry declares the `baseType` it resolves to.
  A field opts in with `osfType: email`; the compiler derives the field's
  `baseType` from the entry. Keys are camelCase — PascalCase names are
  entities, and the seven base types are not catalog entries. Resolution
  priority for render/validation: explicit field config → semantic type →
  base-type default → fallback.
- **`components.yaml`** — the render-component catalog: default component per
  base type (string → `Input`, boolean → `Switch`, …), view defaults, and
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
kinds), optional realm roles, hand-authored client roles, audience-scoped
`clientRoleComposites`, groups, and users with a `tid` (tenant UUID) attribute.
Each is generated to `keycloak/<realm.name>-realm.json` and
mounted into the local Keycloak container, whose `--import-realm` imports every
file in its import directory.

Two realms are authored here:

- **`authorization.yaml`** — the tenant realm `openshapeforge`. Its
  `keycloak.entityRoleClient` (`erp-provider`) is the designated target for
  entity-derived roles. The reusable base contains no product personas, groups
  or users; hosts author those, while this repository adds neutral identities
  from `test/fixtures/authoring/development-identities` for local and e2e runs.
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

The tenant realm also declares `identity:` — who a login is, in entity terms:
the party a login acts as (`actingParty`: the Relation, its name, type,
status and profile fields, and which type values are a person and an
organization), the person record created beside it (`person`), where a
party's e-mail addresses live (`loginContact`), the role that administers an
organization (`administratorRole`) and the roles a just-in-time member holds
until an administrator assigns some (`memberRoles`). Exactly one
authorization file declares it; the compiler checks every named field's
shape against the compiled entities (single string or boolean scalars, the
relation fields as `belongsTo` references to the acting party), every role
against the realm's declared and entity-derived roles, and the platform
schema's own references to the acting party (`platform.tenants.relation_id`,
`platform.identity_relations.*`, authored in `platform-schema.yaml` because
that file is loaded before the entities compile) against the party's table.
It emits `apps/api/src/generated/compiler/identity.json`, which is the only
place the API's auth layer learns those names from.

### Overlaying a realm: `kind: authorizationPatch`

A host that consumes the compiler as a package inherits these realm files and
usually wants to change a few things in one of them — the audience client's
name, an extra client, or a product role composed on that audience — without forking
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
#    realmRoles.*.composites, clientRoles, clientRoleComposites (owner and
#    target ids), users[].clientRoles and serviceAccountClientRoles. Only the id moves; the client's own fields
#    are set below, under the NEW id.
renameClient: { from: erp-provider, to: application-api }

# 2. Everything else strategic-merges onto the (renamed) base.
keycloak:
  clients:
    - id: application-api                 # merges by id into the renamed client
      name: Application API
      devSecret: application-api-secret
      secret: ${env:KEYCLOAK_CLIENT_SECRET_APPLICATION_API}
    - id: application-reporting           # unknown id: appended
      kind: bearerOnly
    - id: openshapeforge-knowledge-base
      $delete: true                       # keyed-array delete
clientRoleComposites:
  application-api:
    Application.Editor:
      description: May edit application data
      composites:
        application-api: [Relations.All.ReadWrite]
realmRoles:                               # only when realm-global is intended
  support-operator:
    description: Support operator
    composites:
      application-api: [Relations.All.Read]
clientRoles:
  application-api: [Relations.All.ReadWrite, Relations.All.Read]
roleLabels:                               # what a role means to its holder
  Application.Editor:
    label: { en: Editor, nl: Redacteur }
    phrase: { en: editor, nl: redacteur }
  Relations.All.ReadWrite:
    phrase: { en: manage clients and other relations, nl: klanten en andere relaties beheren }
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
   `clientRoleComposites.<client>.<role>.composites.<client>`,
   `realmRoles.<role>.composites.<client>` and `realmRoles.<role>.includes`
   keep the base's grants in base order and append the patch's. A grant list
   is a set, and "add one composite" restating fifteen others is how a grant
   silently goes missing. To take a grant away, set the client key to `null`
   or change the owning layer.
4. The merged document is **validated as an `authorizationConfig`** and the
   error names the patch file, not the merged file nobody wrote.

A patch may carry `renameClient`, `realm`, `keycloak`, `realmRoles`,
`clientRoles`, `clientRoleComposites`, `groups`, `users` and `roleLabels`;
`schemaVersion` is the base's and cannot be patched.

**`roleLabels`** is what a role means to the person holding it, keyed by role
name and display only: `label` (title case) marks a persona — the composite a
membership row records, shown as `whoami.role` — and `phrase` (lower case) is
the wording inside a sentence: "is an organization administrator", "may manage
clients and other relations". Both are per-language maps and `en` is required:
English is what every reader falls back to, and a label without it fails the
build rather than dropping the persona at run time. The MCP session reads them from the compiled
`generated/compiler/role-labels.json`; the engine has no vocabulary of its own,
so a host labels its roles here or they are described from their shape
(`<Area>.All.ReadWrite` → "manage <area>") or left unsaid. Patching a realm no earlier layer defines is an error (a new
realm is an `authorizationConfig` under its own filename), as is a patch
filed anywhere but the layer root. Patches stack across layers in order.

## `menu.yaml`

Shell component + sidebar navigation (labels, icons, `entity:` references).
Consumed only by web UI generation, so it has no effect in a repo with no `apps/web`.

## Contexts and mappings (supported, unused here)

The loader also understands a per-context structure that this repo does not
use (no `contexts/` directory exists in the base layer):

- `contexts/<ctx>/partial/<entity>.yaml` — profile extensions of a core
  entity (`kind: entityProfile`, extra fields, own storage table). A profile
  field resolves its type like an entity field but may not reference an
  entity: profile tables carry no relationships, so add such a field to the
  entity itself with an `entityPatch`.
- `contexts/<ctx>/osf-types.yaml` — context-scoped osf-type catalogs,
  add-only over the core catalog: a context may add types, never redefine
  a key an earlier catalog declared.
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
4. `bun run db:reset` on a built database, `bun run db:migrate` on an empty
   one — the manifest checksum moved, and a built database is rebuilt, not
   altered ([migrations.md](migrations.md)).
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

To keep an authored entity **out of every generated CRUD surface**, give it
no entity-implemented Operations (`operations: {}` or only plugin-handled
ones). Secret-bearing and runtime-scheduler entities in the base catalog are
authored that way; no compiled slug denylist is involved.

## Published blueprint copies

A tenant-scoped v2 entity with built-in create and update Operations can opt in:

```yaml
blueprint:
  fields: [name, description]
```

The listed fields must be writable, unclassified scalar values. Identity,
source-identification, authorization, relationship, secret and computed fields
cannot be copied. The compiler generates blueprint list, status, publish and
reset Operations and their Web, REST, GraphQL and MCP projections. The regular
create Operation accepts an optional `blueprintId` (the published source record's
`externalId`); explicit create values override the selected snapshot.

Publication requires a `platform-operator` identity in a blueprint tenant.
Published versions are immutable snapshots. A platform administrator assigns
the customer's single library — any other active tenant of the host — with the
control-plane tool `assign_blueprint_library` (REST: `PUT
/api/control/v1/tenants/{slug}/blueprint-library` with `{ blueprintTenantSlug }`,
null to clear) and reads it with `get_blueprint_library`. Existing copies keep
their recorded source. A restricted database function can read only assigned
published snapshots whose reader roles match the session. Ordinary entity RLS
remains unchanged.

A local copy records its source and adopted version. New publication only changes
its update indicator. Reset requires explicit acknowledgement, the expected source
version and the entity's version/edit-lease controls. It replaces only the declared
fields, keeping the customer record's identity, relationships and other fields.
This initial contract supports scalar configuration records, not workflow graphs
or other aggregates. Existing plugin-backed mutations cannot silently opt in.
