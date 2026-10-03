// SPDX-License-Identifier: BUSL-1.1
/** Provider-neutral facts derived from stored bytes, never supplied as authority by clients. */
export type RuntimeArtifactDescriptor = Readonly<{
  artifactId: string;
  version: number;
  fileName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
}>;

export type RuntimeArtifactStageInput = Readonly<{
  /** Selected by the owning Operation handler, not a permission grant. */
  purpose: string;
  fileName: string;
  source: AsyncIterable<Uint8Array>;
}>;
/**
 * The record that owns an artifact's bytes: any canonical Entity record, named
 * by entity and id. Core authorizes a read as `get` on this record through
 * `platform.records.assertAccess`, so a grant reaches a file exactly when it
 * reaches the record; a Document owns the files of its versions.
 */
export type RuntimeArtifactOwner = Readonly<{ entity: string; id: string }>;
export type RuntimeArtifactOwnerInput = Readonly<{ artifactId: string; owner: RuntimeArtifactOwner }>;
export type RuntimeArtifactBindInput = RuntimeArtifactOwnerInput & Readonly<{ expectedArtifactVersion: number }>;
/**
 * What a read returns. `owner` is the record the storage found the artifact
 * bound to — its own proof of the association, not an echo of the request.
 * Core refuses the read when it differs from the owner the caller named, so
 * a known artifact id never opens a file through some other record the
 * session happens to reach.
 */
export type RuntimeArtifactContents = Readonly<{ descriptor: RuntimeArtifactDescriptor; bytes: Uint8Array; owner: RuntimeArtifactOwner }>;

export type RuntimeArtifactSessionContext<Session, Transaction> = {
  session: Session;
  withTransaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
};

/** Private storage implements this contribution; public core never imports its implementation. */
export type RuntimeArtifactStorageContribution<Session, Transaction> = {
  readonly providerId: string;
  stage(context: RuntimeArtifactSessionContext<Session, Transaction>, input: RuntimeArtifactStageInput): Promise<RuntimeArtifactDescriptor>;
  bind(context: { session: Session; transaction: Transaction }, input: RuntimeArtifactBindInput): Promise<RuntimeArtifactDescriptor>;
  read(context: RuntimeArtifactSessionContext<Session, Transaction>, input: RuntimeArtifactOwnerInput): Promise<RuntimeArtifactContents>;
};

/** No physical-delete API: destructive work requires a durable OSF policy decision. */
export type RuntimeArtifactServices<Session> = Readonly<{
  stage(session: Session, input: RuntimeArtifactStageInput): Promise<RuntimeArtifactDescriptor>;
  /** Requires the live Operation transaction that also creates or updates the owning record. */
  bind(session: Session, input: RuntimeArtifactBindInput): Promise<RuntimeArtifactDescriptor>;
  /**
   * Core asserts `get` on the named owner before the provider is asked, and
   * refuses the result unless the provider confirms that owner as the record
   * the artifact is bound to.
   */
  read(session: Session, input: RuntimeArtifactOwnerInput): Promise<RuntimeArtifactContents>;
}>;
