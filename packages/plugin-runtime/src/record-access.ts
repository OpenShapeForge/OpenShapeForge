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

/** All identities must pass canonical access in the same session; no data is returned. */
export type RuntimeRecordAccessBatchRequest = Readonly<{
  entityName: string;
  ids: readonly string[];
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
  assertAccessMany(session: Session, request: RuntimeRecordAccessBatchRequest): Promise<void>;
  assertAccess(session: Session, request: RuntimeRecordAccessRequest): Promise<void>;
  projectStoredFields(
    session: Session,
    request: RuntimeStoredFieldProjectionRequest,
  ): Readonly<Record<string, unknown>>;
  /**
   * Refuse unless this session holds `action` on this record.
   *
   * The host evaluates its own compiled policy against the record ACL. The
   * module learns one thing — that it may proceed — and the record stays as
   * unreadable as it was: no row, no ACL, no other record.
   *
   * Called inside the module's active transaction (an Operation's, or one
   * opened through `platform.db.withSession`) the host holds the ACL row lock
   * there until that transaction commits, so the module's own writes happen
   * under the same lock the check took and a concurrent revocation cannot
   * interleave with them. Called outside one it is an early answer only.
   */
  assertAction(session: Session, request: RuntimeRecordActionRequest): Promise<void>;
  /**
   * The same question as {@link assertAction}, answered rather than raised.
   *
   * This is the predicate a module composes with a policy of its OWN: a
   * plugin-owned table whose rows belong to a host record can gate them on
   * "does this session hold `action` on that record" without copying the
   * host's ACL, reading it, or inventing a second permission model. The host
   * stays the only authority on the answer; the module decides what the answer
   * means for its own rows.
   *
   * It discloses no more than {@link assertAction} does — the caller already
   * names the record and the action, and the answer is about its own session.
   * Everything the host refuses outright (another tenant's record, an entity
   * or action the compiler did not authorize) answers `false`.
   */
  holdsAction(session: Session, request: RuntimeRecordActionRequest): Promise<boolean>;
  /**
   * The fields the action declared it needs, of exactly that record.
   *
   * An action authorizes an effect on a record its holder cannot see, which
   * would leave the effect with nothing to work from. The entity answers that
   * explicitly: the action declares its read projection and this returns those
   * fields and nothing else — never the ACL, never the tenant column, never an
   * undeclared field, never a second record. An action that declares no
   * projection discloses nothing and refuses here.
   */
  readForAction(
    session: Session,
    request: RuntimeRecordActionRequest,
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

/**
 * One named action on one record, as the entity declared it.
 *
 * `action` is a lowerCamel name the entity declared under its record ACL and
 * never a record permission: a named action is independent of `view` in both
 * directions, which is the whole reason the axis exists. A holder may be
 * authorized to act on a record it cannot read.
 */
export type RuntimeRecordActionRequest = Readonly<{
  /** Canonical authored Entity name, never a physical schema or table name. */
  entityName: string;
  /** Exact record identifier selected by the owning module. */
  id: string;
  /** A named action this entity declares; never view, edit or delete. */
  action: string;
}>;
