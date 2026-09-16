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

/**
 * Core-owned authorization oracle for reviewed runtime modules.
 *
 * It authorizes no mutation controls and returns no record data. The host
 * resolves and enforces its compiled Entity Operation against the exact live
 * session supplied to the module.
 */
export type RuntimeRecordAccessServices<Session> = Readonly<{
  assertAccess(session: Session, request: RuntimeRecordAccessRequest): Promise<void>;
}>;
