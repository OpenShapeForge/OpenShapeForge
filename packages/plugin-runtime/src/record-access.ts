// SPDX-License-Identifier: BUSL-1.1

export type RuntimeRecordAccessIntent = "get" | "update" | "delete";

export type RuntimeRecordAccessRequest = Readonly<{
  /** Canonical authored Entity name, never a physical schema or table name. */
  entityName: string;
  /** Exact related record identifier selected by the owning module. */
  id: string;
  /** Existing canonical Entity Operation whose authorization must hold. */
  intent: RuntimeRecordAccessIntent;
}>;

export type RuntimeStoredFieldProjectionRequest = Readonly<{
  /** Canonical authored Entity name, never a physical schema or table name. */
  entityName: string;
  /**
   * Canonical authored field keys and values already held by the module.
   * Projection authorizes no read and fetches no data: it can only replace a
   * value with `null` under the host's current disclosure policy.
   */
  fields: Readonly<Record<string, unknown>>;
}>;

/**
 * Core-owned authorization oracle for reviewed runtime modules.
 *
 * It authorizes no mutation controls and fetches no record data. The host
 * resolves and enforces its compiled Entity Operation against the exact live
 * session supplied to the module; stored-field projection only attenuates
 * values the module already holds.
 */
export type RuntimeRecordAccessServices<Session> = Readonly<{
  assertAccess(session: Session, request: RuntimeRecordAccessRequest): Promise<void>;
  projectStoredFields(
    session: Session,
    request: RuntimeStoredFieldProjectionRequest,
  ): Readonly<Record<string, unknown>>;
}>;
