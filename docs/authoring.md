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

### Extending an Operation-backed entity from another catalog

A host or plugin can place its own Operation-backed child entity below an
Operation-backed entity owned by another catalog. The child stays in the
owning catalog; `entityExtensions` contributes only the related route to the
parent after all catalogs have been composed:

```yaml
interfaces:
  web:
    entities:
      TenantSeedInstallation:
        # normal Operation-backed entity definition
    entityExtensions:
      PlatformTenant:
        related:
          - entity: TenantSeedInstallation
            label: { en: Seed installations, nl: Seed-installaties }
            route: /tenants/:slug/seeds
```

Both the parent and child must resolve to Operation-backed entities in the
composed manifest. The compiler rejects an unknown parent, an unknown child,
and duplicate child or route contributions. This composes navigation only;
the child catalog still owns its Operations, authorization and input bindings.

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

### Named record actions

The three permissions answer "who may see, change and remove this record".
Some records also need "who may *do this particular thing* to it" — start it,
follow it, publish it — for a party that has no business reading or changing
it at all. That is a second, independent axis, declared per entity and per
action:

```yaml
    recordPermissions:
      field: authorization
      empty: public
      createRequires: [view, edit]
      actions:
        - name: start
          principals: [integration]
          reads: [definition, status]
        - name: follow
          principals: [integration, person]
          lock: shared
```

and granted per record, under the ACL's own `actions` member:

```json
{
  "view":   { "users": ["<person>"] },
  "edit":   { "users": ["<person>"] },
  "actions": {
    "start":  { "integrations": ["<integration id>"] },
    "follow": { "integrations": ["<integration id>"], "roles": ["Runs.All.Follow"] }
  }
}
```

What is true of this axis, and is the reason it is separate:

- **Independent in both directions.** Holding `view` grants no action, and
  holding an action grants no `view`, `edit` or `delete`. A holder of `start`
  cannot read the record through any generic API, because the row-scope policy
  that gates every read is unchanged and still asks for `view`.
- **Never public.** An absent `actions` member, an absent entry, an entry
  naming nobody and a malformed document are all denials, whatever the entity
  authored for `empty`. `empty: public` is about the three permissions only.
- **Matched against the verified principal class.** `users`, `groups` and
  `roles` are satisfiable only by a session the server classified as a person;
  `integrations` only by one carrying a resolved API-key integration. A service
  account holding the same role as a person therefore acquires nothing here,
  and a carrier the server could not classify holds no action at all. "Classified
  as a person" means the server positively verified a human login — the bearer
  path's verdict, or the class a trusted-context producer signed into its
  bundle. An identity ↔ Relation link is not that verdict, whatever party it
  names, so a session holding only a link holds no person action
  (docs/api.md).
- **Keyed on the integration, not the credential.** An `integrations` entry
  names `platform.api_key_integrations.id`, which survives key rotation and is
  independent of the integration's display name. A direct bearer token of the
  same integration's Keycloak service account is *not* an application
  principal and satisfies no action — see docs/api.md.
- **Opt-in.** An entity that declares no `actions` can carry none: a write
  naming an undeclared action, or a principal kind the action does not admit,
  is refused with `VALIDATION`. Assigning one is an ordinary ACL edit and so
  needs the record's `edit` permission; an editor may grant any action the
  entity declares, exactly as it may already rewrite view/edit/delete.
- **`reads` is the whole execution capability.** An action that must work with
  the record declares the fields it needs; core returns exactly those fields of
  exactly that record, through the same owner-scoped lookup that authorized the
  action. The ACL field, a classified, computed, localized or unpersisted
  field, a relationship and a field with its own authorization are refused at
  compile time. An action with no `reads` authorizes an effect and discloses
  nothing.

- **`lock` is the concurrency contract.** The check locks the record's ACL row
  and holds it for the rest of the transaction, and the effect then runs under
  that lock. `exclusive`, the default, takes a self-exclusive row lock: two
  holders of the same action on the same record serialize at the check, so an
  effect that goes on to lock that record more strongly — an ordinary
  `select … for update` on it, or an entity update of it — cannot deadlock on
  the upgrade. `shared` lets concurrent holders through together, which is the
  right trade for an action whose effect only reads: `follow` above polls a
  status and never writes the definition. Choosing `shared` for an effect that
  *does* upgrade is a deadlock under parallel calls, and the compiler cannot
  see an effect's SQL to warn you — which is why the default is the safe mode
  and a later authoring layer may tighten `lock` but never weaken it. Both
  modes fence a concurrent ACL change identically.

### Which principal classes the generic routes admit

A role list answers "what may this session do". It cannot answer "what sort of
session is this", because a service account and the person beside it can hold
the very same role. Once an application is a first-class principal that gap
matters: an entity may hand an application one named action on one record,
while the application's key holds the entity's ordinary read role on its
service account — and generated CRUD, the search derived from it and the
generic MCP tools ask only for the role. The collection would then return every
record of the entity and make the per-record grant decorative.

So an entity may declare which classes its **generated CRUD and derived
search** admit:

```yaml
authorization:
  roles: { read: [...], create: [...], update: [...], delete: [...] }
  principalClasses: [person, service, unknown]
```

The four classes are the server's own classification, never anything a caller
states: `person` a login the server positively verified to be a human,
`application` a resolved API-key integration, `service` a verified
client-credentials principal with no integration behind it (configured
organization automation included), and `unknown` a carrier the server could
not classify (docs/api.md). A linked Relation is not a classification, so a
trusted-context producer that has not been redeployed to sign the principal
class is `unknown` however its user is linked — which matters only if you
write `person` out of this list, since the derived default always admits
`unknown`.

- **Omitted admits every class**, which is what every entity did before this
  existed. One derived exception: an entity that declares a named action for
  `integration` principals compiles to every class *except* `application`.
  Such an entity has decided an application reaches it by grant, one record at
  a time; the default stops the collection from undoing that, without the
  entity having to remember to. Writing the list out re-admits applications
  deliberately — a decision with a reviewer rather than an omission.
- **It narrows only.** An admitted class still faces the entity's roles, the
  Operation's scopes and the record ACL. Nothing here admits a session those
  would refuse, and nothing here is a substitute for them.
- **It covers every generic route at once**, because they share one gate
  (`requireEntityOperation`): the REST routes, the GraphQL resolvers, the
  generic MCP tools, the change stream, and the entity `list` Operations the
  derived `application.search` executes. An excluded class is also absent from
  the Operation listing and the MCP tool listing, so it is not advertised and
  then refused.
- **It does not touch authored Operations.** A plugin Operation gated on
  `auth.recordAction` stays available to the application that was granted the
  action — which is the arrangement the policy exists to protect.
- **It is per entity, not per credential.** Excluding applications from one
  entity leaves the key's access to every other entity exactly as it was. A
  snapshot or version entity that stores the same content needs the same
  declaration; `NotebookVersion` in `examples/plugins/notebook` is that case
  authored explicitly.

A record-scoped plugin Operation requires one with
`auth.recordAction: <name>`; the entity must declare it, and the check is a
live read inside the Operation's transaction (docs/operations.md). The lock
above is the single ordering a concurrent policy change also follows, so a
grant and its removal cannot interleave with the effect in either direction.

The same check also re-reads the CREDENTIAL behind the session, because the
grant deliberately names the integration and therefore survives rotation. For
an application principal the check verifies and locks the presented
`platform.api_keys` row and its integration — unrevoked, unexpired, integration
`active` — in that same transaction, integration row first. So revoking the key
or disabling the integration either waits for an effect in flight or is read by
one that starts after it, and a withdrawn credential authorizes nothing even
while the record's grant is untouched. The reading is point-in-time: an
invocation already admitted commits even if the credential EXPIRES while its
effect runs, while every later check — the bounded read's included — refuses.
Nothing is authored for this: it applies wherever a named action does, and no
other principal class carries a credential it could affect. See
[api.md](api.md) for the carrier and semantics and
`db/migrations/record-actions.ts` for the lock order.

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
  field. The identifier stays unique across every row in that scope, including
  inactive rows. An authored partial unique index remains in the output; the
  compiler adds an unconditional unique index for suffix allocation when
  needed. Existing data must satisfy that unconditional rule before applying
  the generated schema. Generated index names over PostgreSQL's identifier
  limit use the existing deterministic hash suffix to keep them distinct.
  The compiler rejects missing sources, non-persisted/non-string fields,
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
- A field `authorization` block is fail-closed on each side. A missing or empty
  `roles.read` list permits nobody to read that field; a missing or empty
  `roles.write` list permits nobody to write it through caller input. Declare
  both lists when both kinds of access are needed. A field without an
  `authorization` block uses the entity's grants.
- Protecting existing object collections requires reseeding development data
  so every row has its runtime-generated `__osfItemId`. Missing stored identities
  fail closed; the greenfield compiler does not add a positional fallback or a
  migration for older development data.

### Generated CRUD is the set of implemented Operations

There is no separate CRUD policy. An entity exposes exactly the five
intents (`list`, `get`, `create`, `update`, `delete`) that its `operations`
implement, whether by the built-in entity implementation or a plugin
handler. A read-only entity simply has no `create`, `update` or `delete`
Operation; an internal entity has none at all. That set is the upper
bound for GraphQL, REST and MCP; each
`interfaces.*` block may exclude an Operation (`operations: { delete: false }`)
but cannot add one. That bound is per compiled entity, not per layer: a later
authoring layer's `entityPatch` may add an Operation the entity's own file left
out ([layers.md](layers.md)).

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

## Entity subtypes: `kind: entitySubtype`

A subtype is a scoped projection of one stored entity: the same table and the
same record identities, served under its own entity name, Operations, routes
and tools, for the rows whose discriminator holds one fixed value. It adds no
field, relationship or storage. `Team` in `entities/core/team.yaml` is the
shipped example, a `RelationGroup` whose `groupType` is `team`:

```yaml
schemaVersion: 3
kind: entitySubtype
entity: Team
extends: RelationGroup          # the base coreEntity, anywhere under entities/
scope:
  groupType: team               # base field -> the value every Team carries
title: Team
labels: { en: Team, nl: Team }
pluralLabels: { en: Teams, nl: Teams }
fields:
  - key: groupType
    hidden: true                # absent from every read, write and schema of Team
  - key: name
    label: { en: Team name, nl: Teamnaam }
    validation: { maxLength: 60 }   # may only tighten the base's constraint
operations:
  list:
    description: { en: Returns a page of teams; other group types never appear here. }
    guidance: { assistant: { en: Find a team by name before changing it. } }
interfaces:
  rest: { basePath: teams }
  mcp: { resource: { uri: app://teams, name: Teams } }
  web:
    views:
      collection: { route: { en: /teams, nl: /teams }, title: { en: Teams, nl: Teams } }
      record:
        routes: { read: { en: /teams/:id, nl: /teams/:id }, create: { en: /teams/new, nl: /teams/nieuw } }
```

What the loader does with it (`authoring/entity-subtype.ts`):

- **Composition happens after layering.** The base is resolved by its `entity`
  name from the resolved authoring tree, so every layer's `entityPatch` to the
  base is inherited; a later layer may also `entityPatch` the subtype file by
  its own slug. A subtype of a subtype is refused.
- **Everything is inherited unless restated:** fields, relationships and their
  derived collections, the canonical entity Operations and the native
  collection Operations (`implementation.type: collection`, for example a
  host plugin's `insertMembership`/`updateMembership` patched onto the base)
  with their concurrency, confirmation and stamps, authorization, retention,
  the web layout, the MCP instructions. A plugin-handled Operation on the
  base is refused: nothing would hold it to the subtype's scope. The
  composition runs over the base as it effectively is (meta fields merged,
  fields normalized), so a derived inverse collection such as `memberships`
  is a base field a subtype may hide like any other. The subtype may
  restate `title`, `description`, `labels`, `pluralLabels`, `displayTemplate`,
  `filterField`, `domains`, per-field `label`/`description`/`help`, per-Operation
  `name`/`description`/`guidance`, and its `interfaces` (a strategic-merge
  fragment over the base's, so a collection block without `columns` inherits
  the base's columns). Interfaces merge like `entityPatch`: keyed arrays by
  `key`/`id`/`title`, `$delete: true` removes an inherited item.
- **It may narrow, never widen.** `authorization.roles`, field `permissions`
  and `authorization`, Operation projections: the same monotonic rules a
  layered `entityPatch` is held to. `authorization.rowAccess` is refused on a
  subtype altogether: the row policy is the base table's row-level security,
  which no projection can tighten, so it is inherited exactly. `required` accepts only
  `true`; `validation` keeps every base constraint and may raise a minimum,
  lower a maximum or add a constraint. Anything else on a field or an
  Operation — type, storage, relationship, implementation, effects — is
  refused by the schema (`entity-subtype.schema.json`) or the composer.
- **`scope` is server-owned.** The discriminator must be a persisted, single
  string/number/boolean field of the base; the value must fit it: its base
  type and static options at load, and at manifest build the field's whole
  compiled value contract — validation and reference-data options included —
  so a subtype whose every create would be refused fails compilation instead.
  The runtime sets it on create and filters every
  list, get, update, delete, lease, confirmation challenge, record-permission
  check and relationship traversal by it; a caller that supplies it, by field
  or column name, is refused on every interface. The field is `readOnly` in
  the subtype's contract and absent from its inputs.
- **`hidden: true` is contract-level.** The field leaves the subtype's
  `model`, `storage`, GraphQL type, REST/MCP schemas, web fields, columns,
  groups, context and inherited placements; reads never return it and a write
  naming it is refused. The base keeps it. A hidden required column must have
  a server-owned value (the scope, a `defaultValue`, `defaultTemplate`,
  `writtenBy` or derivation), otherwise compilation fails. A hidden field the
  subtype's own configuration still names, or that an inherited
  `displayTemplate`, record `title`, `filterField`, confirmation challenge or
  row-access policy depends on, fails compilation and asks for a restatement.
  Hiding an inverse collection also removes the native collection Operations
  on that field from the subtype (the base keeps them), so no endpoint of the
  subtype reveals or changes what it hides; the runtime refuses a relationship
  traversal the projection does not declare.
- **One table, one identity.** The backend manifest emits no table, index,
  constraint or policy for a subtype; it binds a virtual table
  (`manifest.entitySubtypes`, registry name `<schema>.<table>@<Entity>`) to
  the base's, carrying the base's compiled retention so the delete guards
  (minimum period, legal hold) apply through the subtype exactly as through
  the base, hidden clock fields included. Leases, confirmation challenges and
  lease availability use the base entity id, so a record has one lease
  whichever projection took it — a native collection Operation on a subtype
  parent consumes that same lease; audit events are the base aggregate's;
  row-level security is the base's. The base's Operations still see and may
  retype the same rows: a `Team` whose `groupType` is changed through
  `RelationGroup.update` simply leaves the subtype.
- **Identities must be distinct.** Entity name, GraphQL names, REST base
  path, MCP tool prefix and resource URI, and web collection/record routes
  (per locale) are audited across every entity, subtypes included.
- A menu item `entity: team` (the file stem) resolves to the subtype's
  collection route like any entity's.

Not supported in this iteration, refused at load: subtype chains; bases that
are Operation-backed (`source`), value definitions, versioned, worker-accessed,
carry field `transitions`, plugin-implemented Operations, or partial profiles.
A subtype is not a relationship target (`osfType: Team` is unknown; reference
the base), inherits no `blueprint`, `indexes` or `audit` composition of its
own, and has no realtime change stream of its own.
The generic manifest-derived e2e lifecycle skips subtypes; the runtime proof
lives in `apps/api/src/operations/entity/entity-subtype-db.test.ts`.

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
| `sourceAdministration` | `source_administration` | sub-ledger within the source; the identifier source identity, deduplication and the watermark are keyed on |
| `sourceAdministrationName` | `source_administration_name` | the readable name of that administration, for display beside the identifier; renaming it does not change source identity |
| `sourceVersion` | `source_version` | the source's change marker, sortable as text; the highest per source and administration is the incremental-import watermark |

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
  An entry may also declare `children`, which is how a typed object value
  (`measurement`, `numericRange`, `dateRange`, `coordinates`, `recurrence`)
  carries its own shape instead of every field restating it. Add an entry when
  the *meaning* carries validation or an identity a base type does not — so
  that, for instance, an arbitrary `number` cannot fill a `percentage` and a
  bound value cannot lose the unit it was measured in.
  [field-acceptance-fixture.md](field-acceptance-fixture.md) walks the whole
  catalogue of field value contracts, one authored field per entry.
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

## Typed variables: a value typed at runtime, and a field bound to one

Two halves of one contract. A **typed value** is a stored value whose type is
not fixed by the catalog but by a FieldDefinition stored beside it; a **bound
field** is an ordinary persisted field whose value comes from a variable
instead of a literal. `Chip` is the authored example of the first (the tenant's
global variables) and any field with `variables:` is the second.

### `typedBy` — the value's contract is the definition stored beside it

```yaml
  - key: definition
    osfType: fieldDefinition
    required: true
    persisted: { column: definition, storageClass: core }
  - key: value
    osfType: typedValue
    required: true
    typedBy: { definitionField: definition }
    persisted: { column: value, storageClass: core }
```

The compiler checks that the named sibling is a **required, persisted, single
`fieldDefinition`** field and that both halves persist as `jsonb`, and stamps
the pair onto the manifest column. The shared entity write path then validates
the value against that stored definition on every create and update, through
the same field-schema service every stored definition goes through — a new
value against the stored definition, a new definition against the stored
value. `baseType: object` on `typedValue` is the storage and transport axis
only: `null`, `0`, `false` and `[]` are real values, and the definition decides
which of them are permitted. A NOT NULL column holds no `null` whatever the
definition says.

**The supported boundary.** A definition that arrives at runtime types a value
inside one json column, so the protections the runtime enforces on *columns*
cannot reach it: a classified column is redacted on read, an `immutable` one is
owned by the protected-field writer, a reference column is authorized against
the real target row. A typed value therefore **fails closed** on exactly what
the entity-value runtime fails closed on, through the same shared guard: no
`classification`, `authorization`, `permissions`, `secureInput`, `writtenBy` or
`immutable` at any depth — authored on the field or inherited from its
osf-type, which is why `email` and `phone` (pii in the catalog) are refused —
no relationship, entity-typed value or nested deferred `typedValue`/`typedBy`, and no osf-type the registry does not
know. On a write that is a `BAD_USER_INPUT` refusal naming the field; on a read
of an already-stored definition it is refused as well, so a value this runtime
cannot protect is never handed over. A variable that must carry a guarded or
referencing value needs a field of its own, with the column the runtime can
protect.

Two explicit compiled adapters extend that boundary for tenant configuration:

```yaml
- key: value
  osfType: typedValue
  typedBy:
    definitionField: definition
    documentField: documentValue
    encrypted: true
  persisted: { column: value, storageClass: core }
- key: documentValue
  osfType: Document
  readOnly: true
  persisted: { column: document_value_id, storageClass: core }
  relationship: { ownership: reference, inverse: false }
```

`definition` remains a required persisted `fieldDefinition`. `documentField`
names an optional, read-only, real Document FK. A root Document definition must
supply its normal `document` policy (`file` with MIME/size restrictions, or
`blocks`). The public value is the Document identifier; the server owns the
carrier and rejects callers writing it directly. Referenced content is checked
under the same tenant and canonical read permissions, and SQL invariants retain
the restrictions when the target changes. Embedded block drafts are applied
through canonical variant/block Operations inside the parent write transaction.

`encrypted: true` additionally admits a root `string` with an explicit
`classification.sensitivity: confidential`. It does not admit nested classified
fields or other unsupported policies. The existing platform AES-GCM keyring
(`OPENSHAPEFORGE_ELICITED_SECRET_KEYS`) seals values before SQL and event writes,
bound to the tenant, table, record and value column. Public reads return only
`__set__`; an unchanged marker preserves an existing secret and cannot create
one. Filtering/sorting the protected value is refused.

TenantSetting uses this pair for every value type. Blueprint publication copies
definitions and portable Document defaults, clones Documents into each target
tenant and refuses populated secret defaults. Reset restores the value while
preserving its immutable definition; a different immutable contract is refused
rather than silently reinterpreting existing data. No additional column is needed
for another scalar or structured setting type.

A single definition editor may use `authoring.lockedKeys: [key]` to preserve
the key from its carrier's `defaultValue`, while its type and other properties
remain editable. Chip uses the default `{key: value, osfType: string, required:
false}`; the API independently requires that paired definition key to be
`value`. An authoring profile does not change whether the carrier itself is
required.

### `variables:` — the field that accepts a variable

A persisted field that authors `variables: whole | template | both` is
*bindable*. An entity with at least one bindable field gets one
compiler-generated, server-owned `field_bindings` jsonb column: one map per
record, keyed by authored field name, with a database CHECK that admits only
that entity's bindable fields. It is not caller-writable — a body that carries
it is refused rather than dropped — and create and update gain two controls
beside `values`, on every interface:

```jsonc
"bindings": { "<bindableField>": "chips.<key>" | { "template": "… {{chips.<key>}} …" } },
"unbind":   ["<bindableField>"]
```

`whole` takes the reference (the variable's own typed value becomes the field's
value), `template` takes authored text whose `{{namespace.key}}` tokens are
filled with each variable's formatted value, and a Markdown destination escapes
every filled value as data. Two namespaces, always written out: `chips.<key>`
is the tenant's Chip catalogue, each Chip typed by the definition stored beside
its value, and `local.<key>` is another field of the same record, typed by that
record's own compiled definition. Nothing is ever evaluated: a `{{…}}` sequence
inside a *resolved value* stays text, and token-like text in a field that
authors no mode stays literal.

What the runtime guarantees:

- **The binding and the value are stored separately.** The map is the author's
  intent and survives; each value column holds what that binding resolved to at
  the last write.
- **Every live read resolves again**, under the reading actor and tenant,
  through the source entity's own read Operation. A source that is gone, not
  available to this reader, or no longer fitting the destination is a refusal
  (`DEPENDENCY_UNRESOLVED` / `DEPENDENCY_INVALID`) — never a stale or widened
  value.
- **A literal clears that field's binding**; `unbind` resolves the source once
  more and writes that value as a literal, so unbinding freezes what the source
  says *now* rather than the column's possibly stale content.
- **A bindable field is not a filter or a sort.** Its column holds the value of
  the last write, which a later source change makes stale, so a query naming it
  is refused instead of answered wrongly.
- **Bounded.** A chain of local bindings has a maximum depth and refuses a
  cycle; one template carries at most 64 variables; one request resolves at
  most 100 source records, each distinct variable read once per request.

### Creation defaults from field templates

A persisted string field may declare `defaultTemplate: "Budget {{fiscalYear.code}}"`. This creation-only default interpolates submitted scalar fields (`{{name}}`) or one belongs-to relationship (`{{fiscalYear.code}}`, where the reference field is `fiscalYearId`). Explicit caller values take precedence, including when copying a Blueprint. Missing or unreadable sources reject creation; references use the same tenant, read authorization and field projection as ordinary reads. No expressions, collections, chaining or executable code are accepted. Updates never recompute the value. Use `defaultValue` for literals; it cannot coexist with `defaultTemplate`.

Live variable values are held to the destination's complete value schema on
reads as well as writes. A later source update that exceeds its length or
numeric bounds refuses the dependent read. Template expansion is limited to
200,000 characters in addition to the token and source-read limits above.
A field cannot receive both a literal and a binding in the same request.
Required fields may arrive through a binding at transport input; after
resolution the canonical value is required again.

Local variable sources must be readable under the actor's column policy,
including nested protection. Elicited secrets and reference-valued sources
are refused. The runtime currently does not authorize referenced target
records as variable sources; references therefore need ordinary reference
fields instead. A hidden destination also withholds its authored binding,
so resolving a live value cannot undo the field's normal redaction.


### Document-valued properties

A single `osfType: Document` reference can declare `document: { content: file, mimeTypes: [image/png], maxBytes: 5242880, documentType: attachment }`, or `document: { content: blocks, documentType: note }`. `documentType` is the destination tenant's classification code. File policies accept explicit MIME types and a positive byte limit; file restrictions on blocks content fail compilation. The same policy reaches Web and the canonical write path. Generated database guards preserve it if a referenced Document subsequently changes its active file or gains a content variant.

Web reuses Document upload, storage and the variant block editor. Uploading creates an ordinary Document; saving the referring form assigns its identity. Cancelling the referring form leaves its previous reference intact; the newly uploaded Document remains in the document library. Blocks retain their own explicit save operations.

A blueprint may include policy-bearing Document properties. Publication captures portable metadata, file bytes and local block content, excluding source identity and permissions. Copy/reset creates destination-tenant Documents and stages/binds new artifacts through canonical Operations in the destination transaction. The source tenant's Document/artifact identifiers are never assigned to a receiving tenant. Classification codes and block definitions must be available in the destination. Existing scalar-only blueprints are unchanged.

## References between Operation-backed web entities

An Operation catalog's result property can declare a single reference to another
Operation-backed web entity using the existing `x-osf-type` and
`x-osf-reference` annotations together. `valueField` must be the target's
authored `idField`; this is the identifier carried in the source property.

```yaml
integrationId:
  type: string
  format: uuid
  x-osf-type: ApiKeyIntegration
  x-osf-reference: { entity: ApiKeyIntegration, valueField: integrationId }
```

The target must have a readable record route with one parameter, and its get
Operation must accept the target identity through that route and its declared
bindings. Source and target reads must use the same web authentication mode
(session, control or public), as for related links; this is the realm distinction
available in the authored Operation contract. The target's own read authorization
still applies. Collection-valued references and routes needing multiple parameters
are not supported by this projection.
This metadata supplies an identifier, not an embedded target record or a grant
to read it. List inputs bound from route context are not offered as user filters.

Operation-backed web entities can optionally set `recordLayout` using the same
record-layout vocabulary as entity views. This projection currently supports
`main-context` and `inbox-main-context`, one content tab, and named groups of
projected fields. Fields needed for identity and bindings can remain in `fields`
without being placed in the visible groups. Other layout properties and multiple
content tabs are rejected explicitly; related route tabs remain unchanged.
Omitting `recordLayout` preserves the existing default.
