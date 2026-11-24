// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeOperationExecutionResult } from "./index.js";
/** Trusted installed maintenance code; SQL remains privileged, not sandboxed. */
export type MaintenanceQuery = {
  query<Row = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<Row[]>;
};
export type MaintenanceConnection = MaintenanceQuery & {
  transaction<T>(work: (query: MaintenanceQuery) => Promise<T>): Promise<T>;
};
export type MaintenanceStore = MaintenanceConnection & {
  pinned<T>(work: (connection: MaintenanceConnection) => Promise<T>): Promise<T>;
};
/** Exact seed-owned identities of one Document graph, from the host's plan. */
export type MaintenanceSeedDocumentRemoval = {
  /** The seed-owned Document to remove. */
  documentId: string;
  /** Every DocumentVersion identity expected to be removed with it. */
  versionIds: readonly string[];
  /**
   * Every owned member identity, by authoring entity name, including the
   * Document itself. The key set must cover the compiled owned graph exactly,
   * so an owned child the plan does not name refuses the removal.
   */
  ownedMembers: Readonly<Record<string, readonly string[]>>;
};

export type MaintenanceSeedDocumentRemovalResult = {
  documentId: string;
  /** Rows removed per authoring entity, with DocumentVersion counted apart. */
  removed: Readonly<Record<string, number>>;
};

export type MaintenanceContext = {
  readonly provenance: Readonly<{
    tenantId: string; tenantSlug: string; contribution: string; invocationId: string;
    operator?: Readonly<{ subject: string; issuer: string }>;
    job?: Readonly<{ name: string; appliedBy: string }>;
  }>;
  readonly store: MaintenanceStore;
  /** Managed file staging for an owned seed that declares Document.create. */
  readonly artifacts?: { stage(input: import("./artifacts.js").RuntimeArtifactStageInput): Promise<import("./artifacts.js").RuntimeArtifactDescriptor> };
  /**
   * Removal of a proven seed-owned Document graph, for a seed that declares
   * Document.deleteWithContents and an acting relation's source authority.
   * Bound to the caller's own transaction: pass the query the enclosing
   * `store.transaction` handed you, and a refusal rolls back with it.
   */
  readonly documents?: {
    removeSeedOwned(
      query: MaintenanceQuery,
      removal: MaintenanceSeedDocumentRemoval,
    ): Promise<MaintenanceSeedDocumentRemovalResult>;
  };
  readonly operations: {
    execute(operation: string, input: Record<string, unknown>, options?: { actingRelationId?: string }): Promise<RuntimeOperationExecutionResult>;
  };
};
export type MaintenanceRequest = { contribution: string; tenantSlug: string; reason: string };
export type RunMaintenanceSeed = {
  <T>(request: MaintenanceRequest, work: (context: MaintenanceContext) => Promise<T>): Promise<T>;
  /** Headless owners only: explicitly acknowledge an owned failed run after reconciliation. */
  acknowledgeFailure?(job: Promise<unknown>): void;
};
export type RuntimeMaintenanceContribution = {
  name: string;
  actorId: string;
  /** Trusted registered SQL owner; default is the migration connection. */
  storeConnection?: "application";
  /** Full stable direct/read/prepare allowlist, including all retry paths. */
  operations: readonly string[];
  actingRelation?: { sourceAuthority: string };
  /** Optional registered CLI entry; input is product-owned data, not authority. */
  run?(input: Record<string, unknown>, context: MaintenanceContext): Promise<unknown>;
};
