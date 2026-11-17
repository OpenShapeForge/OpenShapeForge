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
   ├─ templateVersionId → TemplateVersion   (pinned; moves through linkTemplate only)
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
editor cannot unlock one), and a link always overwrites a locked block with
the new capture.

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
| `Templates.Manage` (held by `org_admin`) | read, generic `Block.create/update`, `TemplateVariant.*Block` | no access on its own (see below for combined roles) |
| `CaseFile.All.Read` | no access | read (`DocumentVariant.get/list`, `Block.get/list`; the policy hides template-owned rows) |
| `CaseFile.All.ReadWrite` | no access (may link a published version through `Document.linkTemplate`) | read, and write only through `DocumentVariant.insertBlock/updateBlock/moveBlock/removeBlock` |

- `Block` **read** roles include `CaseFile.All.Read/ReadWrite` so the web can
  list a variant's blocks through the generic `Block.list`; the restrictive
  policy `blocks_owner_read` decides which rows such a session sees. `Block`
  **write** roles are unchanged (template roles), so generic `Block.create/update`
  refuse a session that holds only document roles. The table describes each
  role on its own; a session holding both `Templates.Manage` and a document
  read role sees document-owned blocks too, and generic `Block.update` is not
  limited to template-owned rows. It checks `Block`'s own roles only: the owning
  `DocumentVariant`'s `update` role, its version and a block's `locked` flag
  are checked by the `DocumentVariant.*Block` Operations, not by the generic
  update. `DocumentVariant.blocks` is authored with
  `childAuthorization: owner`: only then do the owner's collection Operations
  lend the owner's `update` roles to its owned children
  (`apps/api/src/operations/entity/collection-mutations.ts`, `safeOperation`
  with `via`). `TemplateVariant.blocks` does not set it. There is no generic
  `Block.delete`.
- A documents command (`app.document_command` = `link`, the only value the
  entity admits) passes the read
  policy regardless of roles, so `Document.linkTemplate` can rewrite the blocks
  of the document it links; the setting is transaction-local and never set by
  generated CRUD.
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
- a link that actually re-seeds, diverges, inserts, removes or moves a block;
  a link that only moves the pin (a head-only template change) leaves a
  published document published. Publishing a template drafts no document.

Publishing is allowed in any state and requires the head's `updatedAt` as
`expectedVersion`. Publishing a head whose content hashes like its latest
version is a no-op: the current version comes back, no row is added, no
follower runs, and the head is `published` again (a change edited back is no
change). `Document.status` (records management) is a separate, caller-owned
field.

## Operations

| Operation | What it does |
|---|---|
| `Document.linkTemplate` `{ id, expectedVersion, templateVersionId, parameters?, replace? }` | Needs the document's update roles only. Seeds one `DocumentVariant` per variant of the published template version, blocks captured from the snapshot (`origin = template`, `templateBlockId`, `locked`) with every variable resolved once from the document's values, validates `parameters` against the template's local variables and stores them. It is the only way a document moves to another version. Linking a version of the **same** template — also the one already linked — follows the follow rule (local edits survive, untouched content is captured again with the current record values). A value the linking session may not read, a missing input or a merge conflict refuses the link and leaves the document as it was. Linking a **different** template requires `replace: true`, retains local and diverged blocks, and refuses protection conflicts instead of discarding content. REST `POST /api/document-content/:id/link-template`. |
| `DocumentVariant.insertBlock` `{ id, expectedVersion, values, beforeId? }` | Core collection machinery; inserted blocks are `origin = local`; `beforeId` places the block before another one. |
| `DocumentVariant.updateBlock` `{ id, expectedVersion, childId, values }` | Owner-scoped edit of one unlocked block's caller-writable fields. |
| `DocumentVariant.moveBlock` `{ id, expectedVersion, childId, beforeId }` | Reorder an unlocked block. |
| `DocumentVariant.removeBlock` `{ id, expectedVersion, childId }` | Owner-scoped removal of an unlocked block; positions are compacted. |
| `Document.materialize` `{ id, channel, locale }` | Read-only; needs the document's read roles only (the pinned version is read under that authority; an inclusion is read from the copy its block stores, so its source template is not read at all). Resolves the editable head for one channel and locale (served by language, see above) through the same content engine as `TemplateVersion.materialize`: the root is the pinned version's identity and parameter definitions with the document's **live** variants and blocks. Content the server captured — a block the template seeded, a block of an inclusion's copy — is data and is not bound again; a block the document authored itself binds its variables against the document's stored `parameters`; a typed block is executed under the reader, through its concrete references. Returns the same `MaterializedTemplateContent` shape; `compositionHash` covers the live content, so an unchanged head hashes the same and an edit changes it. Theme tokens are **not** part of that snapshot; resolve them with `DocumentTheme.resolve`. `INVALID_STATE` without a linked template version. REST `POST /api/document-content/:id/materialize`. |
| `DocumentTheme.resolve` `{ documentId }` / `{ templateId }` / `{ templateVersionId }` | Read-only live theme tokens for one source. REST `POST /api/document-themes/resolve`. |
| `Document.publish` `{ id, expectedVersion }` | Generic snapshot publish (`packages/versioning`): freezes the document row with its variants and blocks into a new `DocumentVersion`, moves `latestVersion(Id)`/`publishedVersion(Id)`, sets `lifecycleStatus = published`. |
| `Template.publish` (existing) | Unchanged input. Freezes the images the new version uses (see below); changes no document. |
| `TemplateVersion.createDocument` (existing) | Still materializes a frozen template straight into a `DocumentVersion` artifact; plugins that render a frozen template to a file build on it. |

The web manifest projects `insert`, `move`, `update` and `remove` on the
`DocumentVariant.blocks` relationship; the `Document` record view authors
`linkTemplate` and `materialize` as record actions and the compiler adds `publish`. Each
command appends the same `updated` entity events the generated CRUD appends
(`document`).

## Follow-template rule

A document moves to a template version only through `Document.linkTemplate`
(`packages/documents/src/document-follow.ts`). Publishing a template changes
no document: nothing is re-seeded for the publisher, under the publisher's
account. What a link gives the document is captured content — the template's
blocks with every variable resolved once, as the linking session, from the
document's values (`captureTemplateBlocks`). Per template variant of the
linked snapshot, matched to the document variant of the same channel and
locale (created when missing):

1. A block with `origin = template` counts as edited when the server marked
   it: any canonical write that changes a seeded block's content sets
   `diverged = true` in the same transaction. Its stored text is resolved
   text, so it is never compared with what the template authored.
2. Untouched and still present: overwrite with the new capture (skipped when
   the content is already identical, so `updatedAt` is not bumped). Untouched
   and gone: delete. Edited: keep, `diverged = true`, whether or not the
   template still has it. Newly locked content that conflicts with a local edit or deletion: refuse the
   link and retain the existing document and pin. A second row claiming the same `templateBlockId` counts
   as a local block. An inclusion the document already holds is updated from
   its own source record instead (the three-way update below), so changes
   inside it survive and a real conflict refuses the link.
3. New template blocks are inserted at their snapshot position; blocks whose
   definition is not allowed on a document are skipped and named in
   `followError`. Local and kept diverged blocks trail the template block that
   preceded them.
4. Document variants the template no longer has are left in place and named
   in `followError`. `templateVersionId` moves to the new version,
   `lifecycleStatus` becomes `draft` only when a block changed (the draft
   rule above), positions are renumbered in one statement.

The link is one transaction under the `link` command: a refusal or a fault
leaves the blocks, the pin and the stored parameters as they were. Published
`DocumentVersion`s are never touched.

## Inclusions are host-owned copies

A `TemplateBlock` stores the complete content of the template version it
includes, in its `content` value. The copy is what is read, edited, laid out
and printed; the source template is read only when the copy is captured and
when it is explicitly updated.

```
content
 ├─ blocks[]   complete blocks: id, definitionKey, schemaVersion, values, references?, region?, layoutKey?, locked?
 ├─ source[]   the server's record, one entry per captured block in source order: id, hash, locked?, deferred?
 └─ page?      the source variant's page settings
```

`source` and `page` are written by the server only. `hash` is the hash of the
block as it was captured (`blockHash`: its content, without its lock and
without the source record of an inclusion nested in it), so a block that still
hashes to it has no local change. An inclusion nested in a copy is itself a
`TemplateBlock` entry of `blocks`, with its own `content` and source record.

**Capture** (`packages/documents/src/content/capture.ts`) resolves ordinary
text exactly once, as the session that writes. The rule is the same for every
typed variable and every host:

- an input with a concrete value resolves everything that depends on it —
  `{{local.deal.customer.name}}` becomes the name, read through the canonical
  Operations of the records on that path;
- an input bound to a variable the host has not supplied
  (`deal: "{{local.opportunity}}"` in a host template) leaves what depends on
  it pending: the text is rewritten into the host's scope
  (`{{local.opportunity.customer.name}}`), a typed reference becomes a
  binding to the host's parameter, and the block's source entry is marked
  `deferred`. Nothing of the unnamed record is read;
- a document is a concrete host. Whatever a document cannot supply refuses
  the capture: an inclusion in a document holds no pending binding.

Captured text is data. A value that reads like `{{local.title}}` stays that
text; how the host reads a block of a copy follows from what the host is
(`copyBinding`):

- **In a document nothing in a copy is bound.** A document is concrete: text
  typed into it later — into a captured block or as a new paragraph — is text,
  braces included.
- **In a template, Markdown fields of a captured block are bound** in the
  template's scope. A value captured into Markdown is escaped (`\{\{`), which
  prints the same text and is never a variable, so a variable the author
  writes into copied text works and the captured values around it stay data.
- **In a template, the other fields of a captured block are data**, unless
  the capture left a binding pending there (`deferred`), in which case the
  whole block is bound. A plain field has no spelling for a brace that is
  data, so two things follow, and only there: a variable typed later into a
  captured plain field is text, and a block cannot hold, outside Markdown, a
  pending variable together with a resolved value containing `{{` or `}}`
  (refused at capture).
- A block the template's author added to a copy is the template's own content
  and is bound like any other block of it.

`{{page.…}}` stays as written everywhere and is filled by the page renderer.
A typed block keeps its definition and its concrete `{entity, id}` references
and is executed on every read, under the reader's authorization.

**Writing** goes through the generic Block Operations; there is no separate
action. Every insert and update of a Block row passes
`prepareBlockInclusionWrite` in the transaction that stores it, and every
removal or move `assertBlockInclusionRemoval`
(`packages/documents/src/inclusion-write.ts`):

| Write | What the server does |
|---|---|
| Insert `{ definitionKey: "TemplateBlock", values: { version, parameters } }` | Captures the source and stores `parameters` (resolved where concrete) and the complete `content`. Leave `content` out. If one is sent, its blocks are local content over the baseline captured in this write; its `source` and `page` are ignored and protected blocks come from the capture. |
| Update with the same `version` and `parameters`, `content` carrying the stored `source` (or none) | An ordinary edit. `content.blocks` is the new local content; `source` and `page` may be sent back as read or left out. Leaving `content` out keeps the stored copy. No template is read and no role or record access on the source is needed (below). |
| Update with another `version` or changed `parameters`, `content` carrying the stored `source` (or left out) | The explicit update: captures the new source with the given inputs and merges three ways (below). `content`, when sent, is the current local draft and is checked against the stored baseline first; left out, the stored blocks are the draft. |
| Update whose `content.source` differs from the stored one | A prepared copy (next section). The source is captured again as the writing session and `source` and `page` must equal that capture exactly; no hash or lock is adopted from the caller. The blocks are then checked against the new record and against what the stored copy protects. With the same `version` and `parameters` this is the deliberate refresh. |
| Remove or move the row | Refused while the copy, at any depth, holds content its source protects. |

Refused on every write: a `source` or `page` that is neither the stored one
nor what a capture yields now, a lock that is lowered or invented, a locked
block that is changed, removed or reordered against other locked blocks, and
removing an inclusion that holds protected content, replacing it, or turning
it into another kind of block under the same identity — as a row or nested in
a copy. A nested inclusion that is new, or whose `version` or `parameters`
changed, is captured or merged by the same rules inside the same write. The
host cannot leave an inclusion's version to a variable: a copy is captured
from one version. A template's author still edits the locks of the template's
own blocks; protection applies to the copies hosts hold.

**Access to the source.** A stored inclusion keeps its `version` and
`parameters` as the provenance of its copy. Whether a write depends on the
source is decided from the stored row alone
(`retainedInclusionProvenance`, the same test `settle` applies):

- An ordinary edit — the row already stores a complete copy, and the write
  repeats the stored `version`, the stored `parameters` and the stored
  `source` record (or sends no `content`). The source is not a dependency of
  this write: `TemplateVersion.get` is not required, the version row is not
  read or locked and its parameter definitions are not read again. Whoever
  may update the host may edit the unprotected content of the copy. The stored
  record and its locks are still enforced.
- Every other write — an insertion, another `version`, changed `parameters`,
  a prepared copy or refresh (`content.source` differs from the stored one),
  and a row that stores no copy yet — reads the source as the writing
  session: the role check of `TemplateVersion.get`, the tenant-scoped row and
  its record permissions, the parameter definitions of that version, and then
  the capture through the canonical Operations. Without that access the write
  is refused (`FORBIDDEN`) and nothing is stored.

Nothing the caller sends can turn the second case into the first: repeating
the stored values is the only way to be an ordinary edit, and a `source` that
is not the stored one is captured again and must equal that capture. Only the
inclusion's own source reference is treated this way; every other typed
reference of an entity-value row is authorized on every write, changed or not.

### Preparing an inclusion before Save

`TemplateBlock.materialize` (REST `POST /api/content-blocks/template/materialize`)
is the read behind an insertion or update dialog: it returns the complete
content the inclusion would hold if it were saved with the given version,
inputs and draft. It reuses the settlement a write runs and performs no write:
no row, no `diverged` mark, no staged or bound file. Cancel therefore needs
no server call, and a refusal leaves the caller's draft as it was.

Input: `definitionKey`, `referenceField`, `parametersField` (the constants of
the definition), `references.<referenceField>` (the template version to
capture), `values` (the inputs, and `content` when a saved inclusion has a
local draft), and

- `host` `{ entity: "TemplateVariant" | "DocumentVariant", id }` — required;
  the collection the inclusion is or will be a block of. Update access to it
  is checked first, through the record access of that entity.
- `blockId` — the saved root block. It must be a block of `host`; anything
  else is `NOT_FOUND`. Left out for an inclusion that is not stored yet.
- `path` — at most eight block ids from that root down to an inclusion nested
  in its copy. A step that is stored must be an inclusion; a step that is not
  stored names an inclusion the draft adds, and so does everything below it.
- `baseline` — only when `values.content` is a draft of an earlier
  preparation; see "Preparing again" below.

Without `baseline`, `values.content` must be the draft of the *saved* copy
(its `source` as read, or none). Result:
`{ kind: "template", referenceField, version: { entity, id }, parameters, content, baseline }`
with `parameters` as resolved, `content` the complete prepared copy and
`baseline` `{ version, parameters, content }`: the same version and inputs as
captured, without the local content merged into `content`. The caller
replaces its draft with `content`, keeps `baseline` beside it and, on Save,
writes the Block with exactly these `version`, `parameters` and `content`
(edited further if the user did). `baseline` is never saved.

A prepare with unchanged version and inputs captures again and merges: that
is how a copy is refreshed with the current record values. Ordinary reads and
edits never do.

**Preparing again.** Between a preparation and Save the user may keep
editing and then choose yet another version or other inputs. The draft is by
then a draft of the earlier preparation, not of the saved copy, so the caller
sends that preparation's `baseline` back unchanged, with `values.content` the
current draft and `references`/`values.parameters` the next choice. This holds
for a saved inclusion, for a new one that is not stored yet (no `blockId`) and
for an inclusion nested in either.

Nothing of `baseline` is trusted. Its version is captured again with its
inputs as the caller — which takes the same read access to that source as the
first preparation did — and `baseline` must equal that capture exactly:
blocks, source record, locks and page settings. The capture, not what was
sent, is then the baseline: the draft is checked against it (a block it locks
is present, unchanged and in order) and merged three ways into the next
source, with the source's blocks as authored at the baseline version and the
next one. What the saved copy protects must be held by that baseline and by
the result, so a true baseline of an unrelated source releases nothing. The
result again carries the `baseline` of the next source.

A `baseline` the server would not capture now is refused with `INVALID_STATE`
("The earlier preparation no longer matches its source or the records it
names…"), whether it was altered or a record it names changed after it was
prepared; nothing is written and the saved inclusion is as it was. A draft
whose `source` differs from the stored one and arrives without `baseline` is
refused as well: it is never silently read as a draft of the saved copy. No
preparation is stored on the server: there is no token, table or lock, and
Save is the same generic write, which captures once more and decides from the
stored record alone.

Roles. The prepare read needs update access to `host` and read access to the
source. Its Operation roles (`Templates.Read`, `Templates.Manage`,
`General.All.Read`, `General.All.ReadWrite`) are exactly the read roles of
`TemplateVersion`, whose `get` the capture executes as the caller, so the
Operation adds no role beyond the canonical read of the source; a compiler
test keeps the two sets equal. The same roles gate the capturing writes above.
The consequence is a product limitation, not an oversight of the prepare
read: a document editor who holds only document roles (`CaseFile.All.*`,
`Organization.All.*`) can edit the unprotected content of an inclusion a
document already holds, but cannot insert an inclusion, choose another
version, change its inputs or refresh it. `Document.linkTemplate` is
different by design: it admits a published version on the document's update
access alone. Letting document editors capture published templates the same
way would be a change of the `TemplateVersion` read policy (or a dedicated
published-version read), not of this Operation.

**The three-way update** (`mergeInclusionCopy`) compares the stored source
record with the current blocks to find local changes, the source's own blocks
as authored then and now to find source changes, and adopts the new capture:

- no local change: the block adopts the new capture, record values included;
- a local change, and the source did not change what it authored there: the
  local content stays — a refreshed record value never overwrites an edit;
- local additions stay behind the block they followed, local removals stay
  removed, new source blocks arrive at their source position, and a block the
  source dropped goes unless it was changed here;
- content the stored copy protects, at any depth, must still be offered by
  the new source. A version (or another template) that no longer holds it
  cannot replace the stored one: the update is refused, the block is never
  dropped and never kept as unprotected local text. The same holds when
  `Document.linkTemplate` would remove an inclusion that holds such content;
- a nested inclusion both sides changed is merged by the same rule from its
  own source record;
- a block both sides changed, a new lock on content that was changed or
  removed here, and a new block with the identity of a local one are
  conflicts. The write is refused with `INVALID_STATE` ("… The existing
  inclusion has been kept.") and nothing is stored.

When the earlier source version can no longer be read by the writing session
there is no authored comparison, and a local change is kept rather than
weighed against the source.

A template version published before copies existed may hold an inclusion in
the earlier reference-only form (no `source`). It is not expanded: reading or
capturing it is refused with `DEPENDENCY_INVALID` and the instruction to insert
the template again or republish the template that contains it. A version
without inclusions is captured like any other.

**Images.** `Template.publish` freezes every image its version uses into that
version (`TemplateVersionImage`). An image that came with an inclusion is
copied from the frozen images of the inclusion's exact source version, under
the hash the content names; it is never read as a file of the host template
and the source's file is never bound to it. A document reads images from the
version it is linked to and from the exact source version of each inclusion
it holds — the server's own record of provenance, not a lookup across the
tenant — which needs no access to any template.

Those frozen rows are durable by the schema itself, so no second copy of the
bytes is staged: a `TemplateVersionImage` is immutable, has no delete
Operation, and its foreign key to `TemplateVersion` does not cascade, so a
version that holds images cannot be deleted (nor its template, whose delete
cascades to its versions and stops there). A linked document and a root
inclusion row hold their version by foreign key as well. Publishing a newer
version or archiving the template changes none of these rows.

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
([plugins.md](plugins.md#shipped-example-2-notebook)). The walk itself follows
`storage.owned`, the tree of authored `ownership: owned` collections under the
head (`snapshot.ownedRelationships: recursive`), version table excluded at
every level; it never consults the catalog, so a cascading foreign key from a
bookkeeping table is not content and never enters a snapshot.
