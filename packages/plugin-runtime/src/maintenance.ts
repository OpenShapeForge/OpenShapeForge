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
export type MaintenanceContext = {
  readonly provenance: Readonly<{
    tenantId: string; tenantSlug: string; contribution: string; invocationId: string;
    operator?: Readonly<{ subject: string; issuer: string }>;
    job?: Readonly<{ name: string; appliedBy: string }>;
  }>;
  readonly store: MaintenanceStore;
  readonly operations: {
    execute(operation: string, input: Record<string, unknown>, options?: { actingRelationId?: string }): Promise<RuntimeOperationExecutionResult>;
  };
};
export type MaintenanceRequest = { contribution: string; tenantSlug: string; reason: string };
export type RunMaintenanceSeed = <T>(request: MaintenanceRequest, work: (context: MaintenanceContext) => Promise<T>) => Promise<T>;
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
