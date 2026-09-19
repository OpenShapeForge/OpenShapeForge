# Artifact storage runtime boundary

OSF owns document policy and canonical Operations. A separately composed storage
module owns byte storage. Core does not import a provider implementation.

The module contributes `artifactStorage` with `stage`, `bind`, and `read` methods.
Core admits at most one contribution during startup, snapshots its methods, and
exposes a non-replaceable `platform.artifacts` service to runtime modules.

- Every call requires the exact live core-issued session, not copied claims.
- Staging runs through session-bound transactions and returns inspected facts:
  opaque artifact ID, storage version, filename, MIME type, checksum and size.
- **Any canonical record may own an artifact.** The owner is
  `{ entity, id }` (`RuntimeArtifactOwner`): the authored Entity name and the
  record id. A document file is owned by its **Document** — the version row
  is the association that names the artifact, and a version is the
  document's content.
- Binding requires the active canonical Operation transaction: the one that
  creates or updates the owning record, whose own authorization it inherits.
  It receives that transaction, the owner and an expected artifact version
  for storage compare-and-swap. The expected version is not authority, and
  core asserts no record permission for a bind — a first-create authority
  may be narrower than `update`, and the Operation already held it.
- Reading names the artifact and its owner. Core first asserts `get` on the
  owner through `platform.records.assertAccess` — the same oracle every
  module uses, so a capability grant reaches a file exactly when it reaches
  the record — inside the transaction the provider then reads in. Storage
  independently checks the association through its trusted policy adapter
  (`@openshapeforge/documents/artifact-authorization` for a Document owner:
  the artifact must be one of the Document's stored versions, and the
  Document's `get` is asked again). Calling the port does not grant access
  to a file. Core checks the returned identity and byte length, strips
  provider-specific metadata, and returns the verified descriptor with the
  bytes.
- Over REST the owner is two query parameters:
  `GET /api/artifacts/:artifactId/contents?ownerEntity=Document&ownerId=<uuid>`.
- There is deliberately no physical-delete method. Destructive storage work
  requires a durable OSF policy decision and a separate worker boundary.

A provider selected by compiled YAML must have exactly one matching runtime
contribution. A missing, disabled, mismatched or duplicate contribution fails
startup. With no selection and no contribution, file calls fail closed. No
provider path, credential or storage location is part of the
public descriptor. A retained session/transaction wrapper cannot be reused
after its request ends.

## Document Operations

`Document.create` and `DocumentVersion.create` accept an optional top-level
`artifact: { artifactId, expectedArtifactVersion }` alongside their logical
input. They create a provisional version inside the canonical transaction,
bind the storage-issued handle to the Document as owner, and persist only the
inspected descriptor.
The database refuses to commit an incomplete association. A failed binding
rolls back the new version and current-version pointer together. Omitting
`artifact` keeps metadata-only creation usable without a storage provider.

Descriptor fields on a version are read-only. A caller cannot replace them
with a filename, MIME type, checksum, byte size or provider path. Reads do not
require an edit lease.

This port is not an upload transport. Compiler settings, storage module
initialization and interface upload handling must still be composed and proven
together. It defines no new retention, legal-hold, file-size or expiry defaults.
