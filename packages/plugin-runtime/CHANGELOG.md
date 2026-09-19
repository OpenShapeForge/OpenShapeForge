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
- A document file is owned by its **Document**, not its DocumentVersion:
  `Document.create` and `DocumentVersion.create` bind with
  `owner: { entity: "Document", id: documentId }`. A storage contribution that
  keys its association on the owner stores the Document id from now on. The
  policy adapter `@openshapeforge/documents/artifact-authorization` takes
  `owner: { entity: "Document", id }` and resolves the version row that names
  the artifact (`documentVersionId` on the result); its old
  `{ entity: "DocumentVersion", recordId }` input is refused.
- Over REST the download names the owner as `ownerEntity` and `ownerId` query
  parameters instead of `documentVersionId`.

### Jobs

- `RuntimeJobHandlerContextContract.db` is a tenant session that replays the
  enqueuing person's roles, groups, RelationGroup memberships and scope;
  `job-worker` is set only as `app.worker_role`, never as a role.
- A handler's transaction and its outcome commit together; a malformed
  outcome settles the job `failed` with `INVALID_OUTCOME`.
