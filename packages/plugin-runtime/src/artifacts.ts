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
export type RuntimeArtifactOwnerInput = Readonly<{ artifactId: string; documentVersionId: string }>;
export type RuntimeArtifactBindInput = RuntimeArtifactOwnerInput & Readonly<{ expectedArtifactVersion: number }>;
export type RuntimeArtifactContents = Readonly<{ descriptor: RuntimeArtifactDescriptor; bytes: Uint8Array }>;

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
  /** Requires the live Operation transaction that also creates the DocumentVersion. */
  bind(session: Session, input: RuntimeArtifactBindInput): Promise<RuntimeArtifactDescriptor>;
  read(session: Session, input: RuntimeArtifactOwnerInput): Promise<RuntimeArtifactContents>;
}>;
