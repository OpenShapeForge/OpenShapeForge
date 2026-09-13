# Artifact storage runtime boundary

OSF owns document policy and canonical Operations. A separately composed storage
module owns byte storage. Core does not import a provider implementation.

The module contributes `artifactStorage` with `stage`, `bind`, and `read` methods.
Core admits at most one contribution during startup, snapshots its methods, and
exposes a non-replaceable `platform.artifacts` service to runtime modules.

- Every call requires the exact live core-issued session, not copied claims.
- Staging runs through session-bound transactions and returns inspected facts:
  opaque artifact ID, storage version, filename, MIME type, checksum and size.
- Binding requires the active canonical Operation transaction. It receives the
  same transaction that creates the DocumentVersion and an expected artifact
  version for storage compare-and-swap. The expected version is not authority.
- Storage independently checks the document/version authorization through its
  trusted policy adapter. Calling the port does not grant access to a file.
- Reading names the artifact and its owning DocumentVersion. Core checks the
  returned identity and byte length, strips provider-specific metadata, and
  returns the verified descriptor with the bytes.
- There is deliberately no physical-delete method. Destructive storage work
  requires a durable OSF policy decision and a separate worker boundary.

A provider selected by compiled YAML must have exactly one matching runtime
contribution. A missing, disabled, mismatched or duplicate contribution fails
startup. With no selection and no contribution, file calls fail closed. No
provider path, credential or storage location is part of the
public descriptor. A retained session/transaction wrapper cannot be reused
after its request ends.

This port is not an upload transport or an enabled Document implementation.
The owning Operations, compiler settings, storage module initialization and
interface upload handling must still be composed and proven together. It does
not define new retention, legal-hold, file-size or expiry defaults.
