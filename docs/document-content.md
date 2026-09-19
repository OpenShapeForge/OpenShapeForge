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

## Who reads and writes what

Roles come from the entity files; `apps/api/src/db/migrations/document-content.ts`
restates them at the database.

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
  The same setting admits the server-managed writes: `Document.templateVersionId`,
  `Document.followError` and, on a document block, `origin`, `templateBlockId`,
  `diverged` and `locked` (triggers `documents_content_guard`, `blocks_document_guard`).
- `DocumentVariant` carries the `Document` roles. `Document.linkTemplate`
  needs the document's update access and a *published* target version, nothing
  more: a document editor picks a published template without a template role;
  the command reads the version's frozen snapshot server-side.
- The generic `Document.publish` inserts the snapshot version as the runtime
  role under the transaction-local marker `app.publishing_entity = 'Document'`
  (set by `packages/versioning`); the `document_versions_write_guard` trigger
  in `core-invariants.ts` admits only such an insert — marker set and
  `versionNumber`, `snapshot` and `contentHash` all present — beside the
  SECURITY DEFINER document commands, and derives the label from the version
  number.
- Open point: `Document.rowAccess` is not yet propagated to variants or blocks.

## Lifecycle

The head is always editable. `lifecycleStatus` is `draft` after any change to
the head (a generic update, a follow) and `published` right after
`Document.publish`, exactly as for `Template`. Publishing is allowed in any
state and requires the head's `updatedAt` as `expectedVersion`. `Document.status`
(records management) is a separate, caller-owned field.

## Operations

| Operation | What it does |
|---|---|
| `Document.linkTemplate` `{ id, expectedVersion, templateVersionId, parameters?, replace? }` | Needs the document's update roles only. Seeds one `DocumentVariant` per variant of the published template version, blocks copied from the snapshot (`origin = template`, `templateBlockId`, `locked`), validates `parameters` against the template's local variables and stores them. Linking another version of the **same** template behaves like the follow rule (local edits survive). Linking a **different** template is refused with `INVALID_STATE` while local or diverged blocks exist, unless `replace: true`, which discards every variant first. REST `POST /api/document-content/:id/link-template`. |
| `DocumentVariant.insertBlock` `{ id, expectedVersion, values, beforeId? }` | Core collection machinery; inserted blocks are `origin = local`; `beforeId` places the block before another one. |
| `DocumentVariant.updateBlock` `{ id, expectedVersion, childId, values }` | Owner-scoped edit of one unlocked block's caller-writable fields. |
| `DocumentVariant.moveBlock` `{ id, expectedVersion, childId, beforeId }` | Reorder an unlocked block. |
| `DocumentVariant.removeBlock` `{ id, expectedVersion, childId }` | Owner-scoped removal of an unlocked block; positions are compacted. |
| `Document.publish` `{ id, expectedVersion }` | Generic snapshot publish (`packages/versioning`): freezes the document row with its variants and blocks into a new `DocumentVersion`, moves `latestVersion(Id)`/`publishedVersion(Id)`, sets `lifecycleStatus = published`. |
| `Template.publish` (existing) | Unchanged input; also runs the follow rule. |
| `TemplateVersion.createDocument` (existing) | Still materializes a frozen template straight into a `DocumentVersion` artifact; the CPQ plugin depends on it. |

The web manifest projects `insert`, `move`, `update` and `remove` on the
`DocumentVariant.blocks` relationship; the `Document` record view authors
`linkTemplate` as a record action and the compiler adds `publish`. Each
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
   `lifecycleStatus` becomes `draft`, positions are renumbered in one statement.

Each document runs under its own savepoint: a document that fails (or whose
tracked version is unavailable) keeps its blocks and old `templateVersionId`,
records the reason in `followError`, and the publication still succeeds.
Published `DocumentVersion`s are never touched. `Document.linkTemplate` runs
the same routine under the `link` command.

## Published snapshot

`DocumentVersion.snapshot` is the generic shape
`{ schemaVersion: 1, entity: "Document", head: { table, row, children: { document_variants: [ { row, children: { blocks: [...] } } ] } } }`,
children ordered by the owning key's position column
(`packages/versioning/src/snapshot.ts`). Materializing a published document
snapshot to rendered text is not in this slice.

A snapshot is content, and `contentHash` is the SHA-256 of its canonical JSON,
so publishing an unchanged head again yields a new version with the same hash.
Three things are therefore left out of every snapshot:

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
([plugins.md](plugins.md#shipped-example-3-notebook)).
