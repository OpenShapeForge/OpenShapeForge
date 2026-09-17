# Document revisions

A `Document` used to get content in exactly one way: `TemplateVersion.createDocument`
materialized a frozen template straight into an immutable `DocumentVersion`.
There was nothing to edit in between. Document revisions add that editable
middle: a draft that starts as a copy of a published template, can be changed
block by block, follows the template when it is republished, and is finally
published to the same immutable `DocumentVersion` a binary upload lands on.

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

- **`DocumentRevision`** (core entity, `packages/compiler/config/authoring/entities/core/document-revision.yaml`):
  `document` (owner FK), `templateVersion` (nullable reference; the version the
  draft currently tracks), `channel`, `locale`, `status`, `parameters` (the
  local-variable values the template needs), `blocks` (sortable owned
  collection of `Block`, `allowedDefinitions: [TextBlock, YouTubeEmbed, TemplateBlock]`).
- **`Block`** keeps its single table. It now has two nullable owner FKs,
  `variant` (TemplateVariant) and `revision` (DocumentRevision); the compiler
  already enforces `num_nonnulls(revision_id, variant_id) = 1`
  (`packages/compiler/src/authoring/entity-values.ts`, "owner" check). Three
  provenance fields are added: `origin` (`template` | `local`),
  `templateBlockId` (the id of the block inside the template snapshot this row
  was seeded from) and `diverged` (boolean).
- **`Document`** gets `revisions` (owned collection) and `currentRevisionId`
  (server-managed pointer to the last published revision). `Document.versions`
  is unchanged: binary uploads and published revisions are both `DocumentVersion`.
- **`Quote`** and **`Agreement`** get `document` (optional reference to `Document`).

### Plugin patches apply to both block collections

`allowedDefinitions` is a plain string array on the owning field, and an
`entityPatch` targets one base entity by file path (`docs/layers.md`,
"strategic merge": non-keyed arrays are replaced wholesale). One patch cannot
target two entities, so a plugin that adds a block definition must ship two
patch files: `entities/core/template-variant.yaml` and
`entities/core/document-revision.yaml`, each restating the full list. The
compiler does not require the two lists to agree: `Block.values` accepts the
union, and each collection gets its own check constraint. Keep them equal
anyway, otherwise a template block cannot be seeded into a revision.

## Lifecycle

`status`: `draft → submitted → approved | rejected → published`, and
`superseded` for a published revision that a later one replaced. Only `draft`
revisions are edited and only `draft` revisions follow the template.
`submitted`, `approved` and `rejected` are set through the ordinary
`DocumentRevision.update` in this slice (the review gate lives in a later
workflow); `published` and `superseded` are written only by
`DocumentRevision.publish`.

A published revision is frozen in the `DocumentVersion` artifact; the revision
row and its blocks stay for provenance and are no longer editable.

## Follow-template rule

When `Template.publish` creates a new `TemplateVersion`, every `draft`
revision of that template is re-seeded in the same transaction
(`packages/documents/src/revision-follow.ts`, registered as a publish follower
with `@openshapeforge/versioning`):

1. For each block with `origin = template`, compare its current `values` (and
   typed reference columns) with the block of the same `templateBlockId` in the
   **old** snapshot the revision tracks. Equal means "not locally edited".
2. Not locally edited and still present in the new snapshot: overwrite with the
   new snapshot's block. Not locally edited and gone from the new snapshot:
   delete. Locally edited: keep as is and set `diverged = true`. Gone from the
   new snapshot but locally edited: keep, `diverged = true`.
3. Template blocks new in the new snapshot are inserted. Order follows the new
   snapshot; local blocks (`origin = local`) and kept diverged blocks stay
   directly after the template block that preceded them before the follow.
4. `revision.templateVersion` moves to the new version.

Published `DocumentVersion`s are never touched; they pin their content in the
artifact. A revision whose `templateVersion` is null (started without a
template) has nothing to follow.

## Operations

| Operation | Handler | What it does |
|---|---|---|
| `Document.startRevision` | `documents.startRevision` | Creates a `draft` revision for `{ documentId, templateVersionId?, channel, locale, parameters? }`; seeds blocks from `template_versions.snapshot` for that channel/locale (`origin = template`, `templateBlockId` = snapshot block id). |
| `DocumentRevision.insertBlock` / `moveBlock` | core `collectionMutation` | The same collection machinery `TemplateVariant.blocks` uses (`apps/api/src/operations/entity/collection-mutations.ts`); inserted blocks get `origin = local`. |
| `Block.update` / `Block.delete` | generated CRUD | Edit or remove one block of a draft. |
| `DocumentRevision.publish` | `documents.publishRevision` | Materializes the revision's blocks with the pure engine (`packages/documents/src/content/materialize.ts`), stages the canonical JSON artifact, creates a `DocumentVersion` through the canonical `DocumentVersion.create`, sets `Document.currentRevisionId`, marks the previous published revision `superseded`. |
| `Template.publish` (existing) | `core-versioning` | Unchanged input; now also runs the follow rule above. |

Snapshot walking is a pure helper in `packages/versioning/src/snapshot.ts`
(`{ schemaVersion: 1, entity, head: { table, row, children } }`); it is the only
reader of snapshot shape outside the publisher.

## Published artifact

`DocumentRevision.publish` stores `application/json` with
`{ schemaVersion: 1, kind: "document-revision", revisionId, documentId,
templateVersionId, channel, locale, content }` where `content` is the
`MaterializedTemplateContent` the engine returns (blocks, compositions,
definitions, globals, `compositionHash`). The revision is the root "template"
of that materialization: the engine sees one variant containing the revision's
blocks; nested `TemplateBlock` inclusions still resolve real template versions
from their snapshots.

## Not in this slice

No UI. No review gate on the status transitions. No merge of a diverged block
back to the template (a user re-seeds by deleting the block). No follow for
`submitted` or later revisions.
