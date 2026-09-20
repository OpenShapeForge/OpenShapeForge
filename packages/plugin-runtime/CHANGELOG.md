# @openshapeforge/plugin-runtime

## Unreleased

### Changed

- **Artifact owner is generic.** `RuntimeArtifactOwnerInput` is now
  `{ artifactId, owner: RuntimeArtifactOwner }` with
  `RuntimeArtifactOwner = { entity, id }`; the `documentVersionId` field is
  gone. `RuntimeArtifactBindInput`, `RuntimeArtifactServices` and
  `RuntimeArtifactStorageContribution` keep their names and carry the new
  shape. Core authorizes `read` as `get` on the owner through
  `platform.records.assertAccess` before the storage contribution is asked,
  inside the transaction the contribution reads in; `bind` still requires the
  active Operation transaction and asserts no record permission of its own.
- **`read` must confirm the owner.** `RuntimeArtifactContents` gains
  `owner: RuntimeArtifactOwner`: the record the contribution found the
  artifact bound to, from its own association check — never an echo of the
  request. Core refuses the read (`FORBIDDEN`) when it is absent or differs
  from the owner the caller named. A contribution that does not check the
  association therefore serves nothing.
- A document file is owned by its **Document**, not its DocumentVersion:
  `Document.create` and `DocumentVersion.create` bind with
  `owner: { entity: "Document", id: documentId }`. A storage contribution that
  keys its association on the owner stores the Document id from now on.
- **No Document-specific policy adapter.** `@openshapeforge/documents/artifact-authorization`
  is gone: a storage contribution authorizes a read through
  `platform.records.assertAccess` on whatever record the artifact is bound
  to, and a bind through the Operation transaction it runs in, the same for
  every owner.
- **`platform.jobs.enqueue` joins the artifact transaction.** Inside a
  contribution's `stage` or `read` (`context.withTransaction`), an enqueue
  runs in that transaction, so a staged row and the job that collects it at
  expiry commit together, as they already did inside an Operation transaction.
- Over REST the download names the owner as `ownerEntity` and `ownerId` query
  parameters instead of `documentVersionId`.

### Jobs

- `RuntimeJobHandlerContextContract.db` is a tenant session that replays the
  enqueuing person's roles, groups, RelationGroup memberships and scope; it
  carries no worker role and no worker GUC.
- A handler's transaction and its outcome commit together; a malformed
  outcome settles the job `failed` with `INVALID_OUTCOME`.
