# @openshapeforge/plugin-runtime

## Unreleased

### Added

- **`childRelations` on the extension registry.** The single relations of a
  collection's child that is not extensible itself, by child entity, for
  `rollup.of` to follow: `RuntimeExtensionRegistryManifest.childRelations` and
  `RuntimeExtensionRegistry.childRelations(entity)`. Metadata only.
- **`RuntimeOperationDefinition.nativeMcpTool`**, for a provider Operation that
  is one tool of an external MCP server. It carries the exact tool name, the
  owning Connection and the upstream title, output schema, annotations and
  metadata; a successful Operation answers an MCP `CallToolResult` as `data`.
  Core binds execution to that Connection and refuses a definition that claims
  more than `RUNTIME_NATIVE_MCP_EFFECTS` or any idempotency. `list` and `get`
  must not reach the upstream server. Exports `RuntimeNativeMcpTool`,
  `RuntimeNativeMcpToolResult`, `RUNTIME_NATIVE_MCP_EFFECTS`,
  `RUNTIME_NATIVE_MCP_OUTPUT`, `nativeMcpToolProblem` and
  `parseNativeMcpToolResult`.
- **Extension registry types.** `RuntimeExtensibleEntity`,
  `RuntimeExtensionRegistryManifest`, `RuntimeExtensionRegistry` and
  `RuntimeExtensionIndexColumn` describe the manifest's `extensionRegistry`
  (tenant-defined fields on `extensible` entities): storage, manage roles,
  limits, allowed osfTypes and reference targets. Metadata only.
- **Extension snapshot service.** `schemas.extensions.snapshot` (optional,
  `RuntimeExtensionSnapshotService`) returns what a published snapshot of an
  extensible head freezes of its tenant fields; the versioning runtime fails
  closed without it.
- **`declarativeServiceCapabilities`**, the capability signal for the
  declarative Service controls, with
  `RuntimeDeclarativeServiceCapabilities = { expectedConnection: readonly
  RuntimeDeclarativeServiceConnectionExpectationScope[] }`. It is on
  `RuntimeOperationExecutionContext` (the context a record-derived Operation
  provider is handed) and on `PluginPlatformServices` (for a canonical
  Operation handler, which holds `platform`). Published only by a runtime whose
  registered declarative engine enforces `expectedConnection` at every
  credential boundary of every provider call; the whole property is absent on a
  host that predates the control and reads `undefined` on a runtime with no
  declarative engine. Check it BEFORE invoking a Service with
  `expectedConnection` — a host that ignored the control would answer an
  ordinary success from whichever Connection the live session is authorized for
  — read it as a list, and fail closed. It advertises capability only: it says
  nothing about what the caller may reach.
- **`expectedConnection` may name the Connection by its own id**, for the one
  call a core-minted reference cannot cover: the FIRST. A sync reads the
  Connection it means to synchronize from, holds its id, and only then invokes
  the Service — and an administrator may replace that Connection in between, so
  the first page can execute against the replacement and store its records
  under the id of the Connection the sync believed it read.
  `RuntimeDeclarativeServiceConnectionExpectation` is now a union of
  `RuntimeDeclarativeServiceConnectionExpectationByReference` (`sourceReference`,
  unchanged) and `RuntimeDeclarativeServiceConnectionExpectationById`
  (`connectionId`), each with the same `appliesTo: "every-provider-call"`. The
  id is scoped to the tenant of the session presenting it and resolved against
  the stored row at every credential boundary, nested ones included; it
  authorizes and selects nothing, and a malformed id, an id of another tenant
  or an id of a Connection this session may not use all answer
  `EXPECTED_CONNECTION_UNAVAILABLE` exactly as a replaced Connection does. The
  two are mutually exclusive by shape and a host refuses an expectation
  carrying both; where both end up in force across a nesting, the invocation is
  held to both and only the row each of them names passes. `connectionUse`
  still answers with the reference form, whichever way the invocation named its
  own expectation, so a run carries the stronger identity from its second page
  onwards; its `one-connection` outcome is typed as that form specifically
  rather than as the new union.
- **`every-provider-call` covers nested invocations.** A binding on the
  platform-owned native transport runs a canonical Operation in-process, and
  that Operation may open a Connection's credentials
  (`platform.secrets.resolveConnectionValues`) or invoke a further declarative
  Service. Those are credential boundaries of the same invocation: each is held
  to the invocation's `expectedConnection` and recorded into the same
  `connectionUse`. A nested invocation may confirm the inherited expectation —
  by presenting the same value, or by naming the same Connection the other way
  — and may not replace it with another Connection. A Service that reaches two accounts
  through an Operation it composes therefore answers `no-single-connection`
  instead of naming one of them. Work a nested Operation *defers* — a durable
  job, a queued outbox entry — runs later under its own invocation and carries
  no expectation from this one.
- **The refusal fails the invocation whatever the Service declares, and says
  the same thing in every case.** A binding a Service declares `optional` does
  not absorb `EXPECTED_CONNECTION_UNAVAILABLE`: `optional` covers an
  unavailable source, not a wrong account, so a Service cannot answer success
  — with `connectionUse` naming the account its other bindings used — after a
  step was refused for leaving that account. This holds for a Service's own
  bindings and for those of any Service nested inside it, and every other
  optional failure is still reported as an unavailable source. And with an
  expectation in force, a Connection that is simply gone answers that same
  refusal rather than the connection-setup failure a caller without an
  expectation gets (`CONNECTION_MISSING`, `CONNECTION_REQUIRED`), in the
  organization and personal scopes alike — so "replaced" and "gone, with
  nothing in its place" stay indistinguishable.

### Package compatibility

- The reviewed compiler field-value policy release publishes operations,
  interface-web, compiler and documents at 0.2.2, plugin-runtime at 0.1.3,
  and versioning at 0.1.2. Dependent packages receive new immutable versions
  because their published workspace dependency ranges change.

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
