# Document content

A `Document` links **directly** to a published `TemplateVersion`, inherits that
template's variants (channel × locale), lets an editor change, insert, move and
remove blocks per variant where the template allows it, and publishes through
the same generic snapshot versioning a `Template` uses. There is one editable
head, N immutable snapshots and one `publishedVersionId` pointer; the model is
the same for `Template` and `Document`.

## Model

```
Template (head = draft) ──publish──▶ TemplateVersion (snapshot: variants + blocks, immutable)
   └─ TemplateVariant (channel × locale)
        └─ Block (variant_id; locked authored here)

Document (head = draft)
   ├─ templateVersionId → TemplateVersion   (pinned; moves through linkTemplate and the follow rule)
   ├─ parameters (values for the template's local variables), followError
   └─ DocumentVariant (channel × locale, seeded from the template's variants)
        └─ Block (document_variant_id; origin: template | local, templateBlockId, diverged, locked)
Document ──publish──▶ DocumentVersion (generic publishedSnapshot; an uploaded file is the other kind of version)
```

## Document theme

A tenant owns many `DocumentTheme` records and exactly one default when it has themes
(`entities/core/document-theme.yaml`). A `Template` may name one theme;
variants, documents and blocks do not. New templates without a choice receive
the tenant default at insert. Published template snapshots freeze that theme
**id** with the head row; they do not freeze token values. Live preview and
`DocumentTheme.resolve` read the current theme row. Bytes already stored on a
`DocumentVersion` artifact stay those bytes.
The first theme becomes the default. `DocumentTheme.setDefault` changes that
choice atomically for future templates; the current default cannot be deleted
until another theme has been selected.

Resolution, for a template, published version or document, uses the stored
theme id (draft template column, or the id on the frozen template-version
head). An older record with no theme id stays unthemed. A stored id whose row
is missing is an error; live reads never silently adopt a different default.

Semantic tokens are surface/text/accent colors, a closed font-family token
(hosts map the token to a file they actually have; this repository does not
ship font binaries), and body / H1–H3 / quote / list styles. Logo and icon
are not theme fields: the reusable file field is one file per row, bound to
the fixed companions `fileName`, `mimeType` and `checksum`, and `Attachment`
belongs to a support issue. Two marks would need a second pointer model, so
they stay out. There is no free CSS and no per-block override.

- **`Document`** (`entities/core/document.yaml`) declares
  `versioning: { strategy: publishedSnapshot, versionEntity: DocumentVersion, versionsField: versions }`
  exactly like `template.yaml`; the compiler supplies `lifecycleStatus`,
  `latestVersion(Id)`, `publishedVersion(Id)` and `Document.publish`. The
  records-management `status` (draft/registered/final/…) is untouched and
  coexists with `lifecycleStatus`. New fields: `templateVersionId` (pinned
  reference, `writtenBy: [Document.linkTemplate, Template.publish]`),
  `parameters` (jsonb), `followError`, and the owned collection `variants`.
- **`DocumentVariant`** (`entities/core/document-variant.yaml`): `document`,
  `channel`, `locale`, unique per document. Its owned sortable `blocks`
  collection is derived from `Block.documentVariant`, whose
  `relationship.inverse` declares `childAuthorization: owner`,
  `childLock: locked` and the same `allowedDefinitions` as the template
  variant's collection (one type axis, `docs/authoring.md`).
- **`Block`** keeps one table with two nullable owner FKs, `variant` and
  `documentVariant` (compiler check `num_nonnulls(document_variant_id, variant_id) = 1`),
  provenance `origin` (`template` | `local`), `templateBlockId` (id inside
  the seeding snapshot), `diverged`, and `locked`.
- **`DocumentVersion`** keeps its artifact fields (`artifactId`, `fileName`,
  `mimeType`, …) nullable and gains the snapshot fields (`versionNumber`,
  `snapshot`, `contentHash`, `publishedBy`, `publishedAt`, also nullable), so
  an uploaded file and a published snapshot share the entity and
  `Document.versions`. A snapshot version's `versionLabel` is
  `snapshot-<number>`, a prefix an upload may never use (the write guard
  refuses it), so the per-document label uniqueness cannot collide; its
  `status` is `published` (added to `DOCUMENTVERSIONSTATUS`).

### Reference version: pinned or current

An entity reference relationship may declare `version: pinned | current`
(`relationship: { ownership: reference, version: pinned }`; schema
`field-definition.schema.json`, default `current`). `current` means the
reference is to the target's editable head; `pinned` means it names one
immutable version and moves only through an authored command. It is metadata:
documented, validated (single references only), and emitted in the backend and
web manifests so a client can show it. The foreign key itself already pins;
nothing resolves differently at runtime. `Document.templateVersionId` is
`pinned`.

### Locked blocks

`Block.locked` is authored on a template block (`TemplateVariant.updateBlock`,
generic `Block.update`) and copied to the document block it seeds. A
collection authored with `childLock: <booleanField>` makes the owner's
`update`, `move` and `remove` collection Operations refuse a child whose flag
is set with `INVALID_STATE` (`apps/api/src/operations/entity/collection-mutations.ts`);
`insert` is unaffected. `Block.documentVariant` declares it on its inverse
collection, `Block.variant` does not. The compiler also drops the lock field and every owning foreign key of
the child from the owner-scoped `insertBlock`/`updateBlock` values contracts
(`packages/compiler/src/authoring/collection-operations.ts`), so the schema
promises no more than the storage guards admit. The database keeps `locked` server-managed on a document block (an
editor cannot unlock one), and the follow rule always overwrites a locked
block from the new snapshot, whatever happened to it locally.

### Plugin patches apply to both block collections

An `entityPatch` targets one base entity and `allowedDefinitions` replaces
wholesale (`docs/layers.md`). Both block collections are declared on `Block`
(`variant.relationship.inverse` and `documentVariant.relationship.inverse`),
so a plugin adding a block definition patches `block.yaml`, restating the full
list on both references. The compiler unions them for `Block.values`; keep them equal or
the follow rule skips the block (see below).

### Which variant a locale gets

Materialization asks for a channel and a locale. The channel is exact; the
locale is served by language: the variant with the exact locale, else one of
the same language subtag (`nl-NL` is served by `nl`; the bare language wins,
then the authored default among them, then the lowest locale), else the variant the template authors as the channel's
default (`TemplateVariant.isDefault`, at most one per channel: a partial unique
index, authored as `indexes[].where: { field: isDefault, equals: true }`). A channel with
none of those refuses with `UNSUPPORTED_LOCALE`; another channel is never
substituted (`packages/documents/src/content/validation.ts`,
`selectContentTemplateVariant`). The result keeps the requested `locale`; the
served variant is `templates[].variantId` with its own `locale`. A document
materializes with the default its pinned template version froze, carried
over by channel and locale, so its variants need no flag of their own.

## Who reads and writes what

Roles come from the entity files. Which blocks a session may read is authored
on `Block` as `authorization.ownerAxis` (`entities/core/block.yaml`): each
owning reference lends its owner entity's `authorization.roles.read` to the
rows it carries, and the compiler renders the restrictive policy
`blocks_owner_read` into `schema.sql` from those role lists, so a host
renaming a role renames the policy and no migration restates a role name.

| Subject | Template-owned blocks | Document-owned blocks |
|---|---|---|
| `Templates.Read`, `General.All.Read/ReadWrite` | read | no access |
| `Organization.All.ReadWrite` | read, generic `Block.create/update`, `TemplateVariant.*Block` | no access |
| `CaseFile.All.Read` | no access | read (`DocumentVariant.get/list`, `Block.get/list`; the policy hides template-owned rows) |
| `CaseFile.All.ReadWrite` | no access (may link a published version through `Document.linkTemplate`) | read, and write only through `DocumentVariant.insertBlock/updateBlock/moveBlock/removeBlock` |

- `Block` **read** roles include `CaseFile.All.Read/ReadWrite` so the web can
  list a variant's blocks through the generic `Block.list`; the restrictive
  policy `blocks_owner_read` decides which rows such a session sees. `Block`
  **write** roles are unchanged (template roles), so generic `Block.create/update`
  refuse a document editor. `DocumentVariant.blocks` is authored with
  `childAuthorization: owner`: only then do the owner's collection Operations
  lend the owner's `update` roles to its owned children
  (`apps/api/src/operations/entity/collection-mutations.ts`, `safeOperation`
  with `via`). `TemplateVariant.blocks` does not set it. There is no generic
  `Block.delete`.
- A documents command (`app.document_command` = `link` | `follow`) passes the
  read policy regardless of roles, so a template publisher holding only
  `Organization.All.ReadWrite` still re-seeds the documents tracking the
  template; the setting is transaction-local and never set by generated CRUD.
  It is the `ownerAxis.command` the entity authors; the provenance triggers in
  `apps/api/src/db/migrations/document-content.ts` honour the same marker.
  The same setting admits the server-managed writes: `Document.templateVersionId`,
  `Document.followError` and, on a document block, `origin`, `templateBlockId`,
  `diverged` and `locked` (triggers `documents_content_guard`, `blocks_document_guard`).
- `DocumentVariant` carries the `Document` roles. `Document.linkTemplate`
  needs the document's update access and a *published* target version, nothing
  more: a document editor picks a published template without a template role;
  the command reads the version's frozen snapshot server-side.
  `Document.materialize` resolves the pinned version the same way, under the
  document's read access; a template version another block *includes* still
  needs `TemplateVersion` and `Template` read.
- The generic `Document.publish` inserts the snapshot version as the runtime
  role under the transaction-local marker `app.publishing_entity = 'Document'`
  (set by `packages/versioning`); the `document_versions_write_guard` trigger
  in `core-invariants.ts` admits only such an insert — marker set and
  `versionNumber`, `snapshot` and `contentHash` all present — beside the
  SECURITY DEFINER document commands, and derives the label from the version
  number.
- Open point: `Document.rowAccess` is not yet propagated to variants or blocks.

## Lifecycle

The head is always editable. `lifecycleStatus` is `draft` after a content
change to the head and `published` right after `Document.publish`, exactly as
for `Template`. What counts as a content change is the **draft rule** the
compiler emits beside the managed lifecycle fields
(`source.versioning.onEdit: { field: lifecycleStatus, value: draft }`) and the
runtime reads from the manifest (`apps/api/src/operations/entity/versioned-head.ts`):

- a generic update that changes at least one content column, compared in the
  database against the stored row; `PATCH {}` or a value supplied as stored
  writes nothing at all, neither the version token, the lifecycle nor an
  event;
- an owned-collection Operation (`insert`, `update`, `move`, `remove`) on the
  head or on anything the head owns, walking the bound ownership tree up to
  the head (`DocumentVariant.insertBlock` drafts the `Document`,
  `TemplateVariant.insertBlock` drafts the `Template`), as does a generic
  update of an owned child; a child update with its stored values or a move
  to the child's own place is the same no-op (no owner touch, no draft, no
  event). Every real change below the head advances the head's `updatedAt`,
  draft or not, so a publisher's `expectedVersion` never covers content it
  has not seen; a row whose owner columns resolve to more than one head or
  path is refused;
- a follow that actually re-seeds, diverges, inserts, removes or moves a block;
  a follow that only moves the pin (a head-only template change) leaves a
  published document published.

Publishing is allowed in any state and requires the head's `updatedAt` as
`expectedVersion`. Publishing a head whose content hashes like its latest
version is a no-op: the current version comes back, no row is added, no
follower runs, and the head is `published` again (a change edited back is no
change). `Document.status` (records management) is a separate, caller-owned
field.

## Operations

| Operation | What it does |
|---|---|
| `Document.linkTemplate` `{ id, expectedVersion, templateVersionId, parameters?, replace? }` | Needs the document's update roles only. Seeds one `DocumentVariant` per variant of the published template version, blocks copied from the snapshot (`origin = template`, `templateBlockId`, `locked`), validates `parameters` against the template's local variables and stores them. Linking another version of the **same** template behaves like the follow rule (local edits survive). Linking a **different** template is refused with `INVALID_STATE` while local or diverged blocks exist, unless `replace: true`, which discards every variant first. REST `POST /api/document-content/:id/link-template`. |
| `DocumentVariant.insertBlock` `{ id, expectedVersion, values, beforeId? }` | Core collection machinery; inserted blocks are `origin = local`; `beforeId` places the block before another one. |
| `DocumentVariant.updateBlock` `{ id, expectedVersion, childId, values }` | Owner-scoped edit of one unlocked block's caller-writable fields. |
| `DocumentVariant.moveBlock` `{ id, expectedVersion, childId, beforeId }` | Reorder an unlocked block. |
| `DocumentVariant.removeBlock` `{ id, expectedVersion, childId }` | Owner-scoped removal of an unlocked block; positions are compacted. |
| `Document.materialize` `{ id, channel, locale }` | Read-only; needs the document's read roles only (the pinned version is read under that authority; an included template still needs its own read roles). Resolves the editable head for one channel and locale (served by language, see above) through the same content engine as `TemplateVersion.materialize`: the root is the pinned version's identity and parameter definitions with the document's **live** variants and blocks, the document's stored `parameters` are the values, and any template version a `TemplateBlock` includes resolves from its frozen snapshot. Returns the same `MaterializedTemplateContent` shape; `compositionHash` covers the live content, so an unchanged head hashes the same and an edit changes it. Theme tokens are **not** part of that snapshot; resolve them with `DocumentTheme.resolve`. `INVALID_STATE` without a linked template version. REST `POST /api/document-content/:id/materialize`. |
| `DocumentTheme.resolve` `{ documentId }` / `{ templateId }` / `{ templateVersionId }` | Read-only live theme tokens for one source. REST `POST /api/document-themes/resolve`. |
| `Document.publish` `{ id, expectedVersion }` | Generic snapshot publish (`packages/versioning`): freezes the document row with its variants and blocks into a new `DocumentVersion`, moves `latestVersion(Id)`/`publishedVersion(Id)`, sets `lifecycleStatus = published`. |
| `Template.publish` (existing) | Unchanged input; also runs the follow rule. |
| `TemplateVersion.createDocument` (existing) | Still materializes a frozen template straight into a `DocumentVersion` artifact; plugins that render a frozen template to a file build on it. |

The web manifest projects `insert`, `move`, `update` and `remove` on the
`DocumentVariant.blocks` relationship; the `Document` record view authors
`linkTemplate` and `materialize` as record actions and the compiler adds `publish`. Each
command appends the same `updated` entity events the generated CRUD appends
(`document`).

## Follow-template rule

When `Template.publish` creates a new `TemplateVersion`, every document
tracking that template is re-seeded in the same transaction
(`packages/documents/src/document-follow.ts`, registered as a publish follower
with `@openshapeforge/versioning` in the module's `init`). Per template
variant of the new snapshot, matched to the document variant of the same
channel and locale (created when missing):

1. For each block with `origin = template`, compare its content (only the
   columns the tracked snapshot row has, so a column added later is not an
   edit) with the block of the same `templateBlockId` in the tracked snapshot.
2. Untouched and still present: overwrite from the new snapshot (skipped when
   the content is already identical, so `updatedAt` is not bumped). Untouched
   and gone: delete. Edited: keep, `diverged = true`, whether or not the
   template still has it. Locked in the new snapshot: overwrite, whatever
   happened locally. A second row claiming the same `templateBlockId` counts
   as a local block.
3. New template blocks are inserted at their snapshot position; blocks whose
   definition is not allowed on a document are skipped and named in
   `followError`. Local and kept diverged blocks trail the template block that
   preceded them.
4. Document variants the template no longer has are left in place and named
   in `followError`. `templateVersionId` moves to the new version,
   `lifecycleStatus` becomes `draft` only when a block changed (the draft
   rule above), positions are renumbered in one statement.

Each document runs under its own savepoint: a document that fails (or whose
tracked version is unavailable) keeps its blocks and old `templateVersionId`,
records the reason in `followError`, and the publication still succeeds.
Published `DocumentVersion`s are never touched. `Document.linkTemplate` runs
the same routine under the `link` command.

## Published snapshot

`DocumentVersion.snapshot` is the generic shape
`{ schemaVersion: 1, entity: "Document", head: { table, row, children: { document_variants: [ { row, children: { blocks: [...] } } ] } } }`,
children ordered by the owning key's position column
(`packages/versioning/src/snapshot.ts`). The head is materialized through
`Document.materialize` (`packages/documents/src/document-materialize.ts`):
live variants and blocks, the stored `parameters`, the pinned version's
parameter definitions, inclusions frozen. A `DocumentVersion` snapshot is
still not rendered.

A snapshot is content, and `contentHash` is the SHA-256 of its canonical JSON,
which is how `publish` recognises an unchanged head and returns the current
version instead of a new row. Three things are therefore left out of every
snapshot:

- the version table itself, even where the version entity's head reference is
  owned (`template_versions.template_id` cascades): the walk excludes the
  table the compiler bound as the version storage, so version N never embeds
  versions 1..N-1;
- the head's own publication pointers (`latestVersion(Id)`,
  `publishedVersion(Id)`, `lifecycleStatus`), which `publish` writes after
  taking the snapshot and which describe the previous publication;
- `createdAt` and `updatedAt` on every row; the version row carries its own
  `publishedAt`.

Which tables `publish` reads and writes is bound by the compiler into the head
table's manifest source (`source.versioning.storage`) and served to the
runtime as `platform.schemas.versioning`; nothing is derived from the entity
name, so a plugin entity in its own schema publishes the same way
([plugins.md](plugins.md#shipped-example-3-notebook)). The walk itself follows
`storage.owned`, the tree of authored `ownership: owned` collections under the
head (`snapshot.ownedRelationships: recursive`), version table excluded at
every level; it never consults the catalog, so a cascading foreign key from a
bookkeeping table is not content and never enters a snapshot.
