# Document revisions

`TemplateVersion.createDocument` materialized a frozen template straight into an
immutable `DocumentVersion`; nothing was editable in between. A revision is that
editable middle: a draft copied from a published template, changed block by
block, following the template when it is republished, and finally published to
the same immutable `DocumentVersion` a binary upload lands on.

## Model

```
Template ──publish──▶ TemplateVersion (immutable snapshot)
                             │ seeds / follows
Document ──startRevision──▶ DocumentRevision (draft) ──publish──▶ DocumentVersion
   │                               │ owns                              ▲
   └── versions ◀──────────────────┼──── shares Document.versions ─────┘
                                   ▼
                                Block (revision_id set, variant_id null)
```

- **`DocumentRevision`** (`entities/core/document-revision.yaml`): `document`
  (owner FK), `templateVersion` (tracked version), `channel`, `locale`, `status`,
  `parameters`, `publishedVersionId`, `followError`, `blocks` (sortable owned
  `Block` collection, `allowedDefinitions: [TextBlock, YouTubeEmbed, TemplateBlock]`).
- **`Block`** keeps one table with two nullable owner FKs, `variant` and
  `revision` (compiler check `num_nonnulls(revision_id, variant_id) = 1`), plus
  provenance `origin` (`template` | `local`), `templateBlockId` (id inside the
  seeding snapshot) and `diverged`.
- **`Document`** gets `revisions` (owned) and `currentRevisionId`;
  `Document.versions` is unchanged. **`Quote`** and **`Agreement`** get `document`.

### Plugin patches apply to both block collections

An `entityPatch` targets one base entity and `allowedDefinitions` replaces
wholesale (`docs/layers.md`), so a plugin adding a block definition ships two
patch files, `template-variant.yaml` and `document-revision.yaml`, restating
the full list. The compiler unions them for `Block.values`; keep them equal or
the follow rule skips the block (see below).

## Who reads and writes what

Roles come from the entity files; `apps/api/src/db/migrations/document-revisions.ts`
restates them at the database.

| Subject | Template-owned blocks | Revision-owned blocks |
|---|---|---|
| `Templates.Read`, `General.All.Read/ReadWrite` | read | no access |
| `Organization.All.ReadWrite` | read, generic `Block.create/update`, `TemplateVariant.*Block` | no access |
| `CaseFile.All.Read` | no access | read (`DocumentRevision.get/list`, `Block.get/list`; the policy hides template-owned rows) |
| `CaseFile.All.ReadWrite` | no access | read, and write only through `DocumentRevision.insertBlock/updateBlock/moveBlock/removeBlock` |

- `Block` **read** roles include `CaseFile.All.Read/ReadWrite` so the web can
  list a revision's blocks through the generic `Block.list`; the restrictive
  policy decides which rows such a session sees. `Block` **write** roles are
  unchanged (template roles), so generic `Block.create/update` refuse a
  document editor. `DocumentRevision.blocks`
  is authored with `childAuthorization: owner`: only then do the owner's
  collection Operations lend the owner's `update` roles to its owned children
  (`apps/api/src/operations/entity/collection-mutations.ts`, `safeOperation`
  with `via`). `TemplateVariant.blocks` does not set it, so template blocks keep
  strict child roles. There is no generic `Block.delete`.
- Reads are closed at the database: the restrictive policy `blocks_owner_read`
  shows a revision-owned block only to a session holding a `CaseFile` role and a
  template-owned block only to a session holding a template role. A documents
  command (`app.document_revision_command` = `start` | `follow` | `publish`)
  passes the policy regardless of roles, so a template publisher holding only
  `Organization.All.ReadWrite` still re-seeds the drafts tracking the template;
  the command setting is transaction-local and never set by generated CRUD.
- `DocumentRevision` carries the `Document` roles. Starting a revision *from a
  template* also needs `Templates.Read` (record access on the TemplateVersion).
- Open point: `Document.rowAccess` is not yet propagated to revisions or blocks.

## Lifecycle

`draft → submitted → approved | rejected → published`, and `superseded` for a
published revision replaced by a later one of the same channel and locale.
Server-side enforcement is a trigger on `document_revisions` and one on
`blocks`; the documents module marks its own commands with the transaction-local
setting `app.document_revision_command` (`start` | `follow` | `publish`),
which the generated CRUD never sets.

- Allowed through `DocumentRevision.update`: `draft→submitted`,
  `submitted→approved|rejected|draft`, `approved|rejected→draft`. Everything
  else, including `published` and `superseded`, refuses `INVALID_STATE`.
- The transitions to `published` and `superseded` are not in the database
  transition table: `DocumentRevision.publish` makes them in the application
  under the `publish` command setting, which the trigger lets through. The DB
  guards what the generic CRUD may do; the command owns its own rules
  (publishable from `draft` or `approved` only).
- `parameters`, `channel`, `locale` and the blocks change only in `draft`.
- `publish` accepts `draft` and `approved`; `submitted` and `rejected` refuse.
- `templateVersion`, `publishedVersionId`, `followError`, `Block.origin`,
  `Block.templateBlockId` and `Block.diverged` are `readOnly`/`writtenBy` in
  authoring and refused by the trigger outside a command.
- Deleting a `published`/`superseded` revision, or the document's current
  revision, refuses `INVALID_STATE` (an operation error, not a raw FK error).

## Follow-template rule

When `Template.publish` creates a new `TemplateVersion`, every `draft`
revision tracking that template is re-seeded in the same transaction
(`packages/documents/src/revision-follow.ts`, registered as a publish
follower with `@openshapeforge/versioning` in the module's `init`):

1. For each block with `origin = template`, compare its content (only the
   columns the tracked snapshot row has, so a column added later is not an
   edit) with the block of the same `templateBlockId` in the tracked snapshot.
2. Untouched and still present: overwrite from the new snapshot (skipped when
   the content is already identical, so `updatedAt` is not bumped). Untouched
   and gone: delete. Edited: keep, `diverged = true`, whether or not the
   template still has it. A second row claiming the same `templateBlockId`
   counts as a local block.
3. New template blocks are inserted; blocks whose definition is not allowed on
   a revision are skipped and named in `followError`. Order follows the new
   snapshot; local and kept diverged blocks trail the template block that
   preceded them.
4. `templateVersion` moves to the new version; positions are renumbered in
   one statement.

Each draft runs under its own savepoint: a draft that fails (or whose tracked
version is unavailable) keeps its blocks and old `templateVersion`, records the
reason in `followError`, and the publication still succeeds. Published
`DocumentVersion`s are never touched.

## Operations

| Operation | What it does |
|---|---|
| `Document.startRevision` `{ documentId, templateVersionId?, channel, locale, parameters? }` | Creates a `draft`, seeds blocks from `template_versions.snapshot` (`origin = template`). REST `POST /api/document-content/:documentId/revisions`. |
| `DocumentRevision.insertBlock` `{ id, expectedVersion, values, beforeId? }` | Core collection machinery; inserted blocks are `origin = local`. |
| `DocumentRevision.updateBlock` `{ id, expectedVersion, childId, values }` | Owner-scoped edit of one block's caller-writable fields. |
| `DocumentRevision.moveBlock` `{ id, expectedVersion, childId, beforeId }` | Reorder. |
| `DocumentRevision.removeBlock` `{ id, expectedVersion, childId }` | Owner-scoped removal; positions are compacted. |
| `DocumentRevision.update` | Status transitions above, `parameters` while draft. |
| `Document.removeRevision` `{ id, expectedVersion, childId }` | Owner-scoped deletion of an unpublished revision and its blocks (generic delete of a collection owner is refused by core policy). `Document.update` therefore now carries `updatedAt` version concurrency (`expectedVersion`), like `Template.update`. |
| `DocumentRevision.publish` `{ id, version, idempotencyKey }` | Locks the Document row, materializes with the pure engine, stages the canonical JSON artifact, creates the `DocumentVersion` through its canonical command, supersedes the previously published revision of the same channel and locale, sets `Document.currentRevisionId`. REST `POST /api/document-content/revisions/:id/publish`. |
| `Template.publish` (existing) | Unchanged input; also runs the follow rule. |

`TemplateVariant` has the same `updateBlock`/`removeBlock` (template roles). The
web manifest projects `insert`, `move`, `update` and `remove` on the relationship;
the `Document` and `DocumentRevision` record views author `startRevision` and
`publish` as record actions. Each
command appends the same `created`/`updated` entity events the generated CRUD
appends (`documentRevision`, `document`).

## Published artifact

`application/json`: `{ schemaVersion: 1, kind: "document-revision", revisionId,
documentId, templateVersionId, channel, locale, content }`, `content` being the
engine's `MaterializedTemplateContent` with the revision as root "template";
nested `TemplateBlock` inclusions resolve real template versions from snapshots.

Not in this slice: UI, a review gate beyond the transition table, merging a
diverged block back to the template, following `submitted` or later revisions.
