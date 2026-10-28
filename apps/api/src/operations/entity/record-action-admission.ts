// SPDX-License-Identifier: BUSL-1.1
/**
 * WHICH record a module may read through a named action, and for WHICH action.
 *
 * Holding an action is not the question this answers. `app.record_action_read`
 * already refuses a record whose ACL does not name this session's verified
 * principal, in this session's own tenant, under the lock the check takes —
 * and that part is enforced by the database. What the database cannot know is
 * which record the CALL was authorized on: a session granted `deliver` on
 * fifty notebooks holds the action on all fifty, so the lookup answers for
 * all fifty, while the Operation that is running was authorized on exactly
 * one of them (`auth.recordAction` on `target.inputField`).
 *
 * So the dispatcher states its own target here, after it has authorized it
 * inside the Operation's transaction and before the handler runs, and
 * `platform.records.readForAction` serves that pair and refuses every other.
 * A handler therefore reads the record its caller named, and not the rest of
 * the application's grant.
 *
 * Three properties make it a bound rather than a hint:
 *
 *   - the session is matched by OBJECT IDENTITY, the same rule the platform
 *     services use. A module cannot admit itself by passing a session-shaped
 *     object, because the only object that matches is the capability core
 *     handed this invocation;
 *   - the admission is async-local, so two concurrent invocations never see
 *     each other's target, and a continuation retained past the Operation
 *     sees the enclosing scope's admission rather than a stale one;
 *   - every custom Operation handler runs inside a scope of its own. A
 *     handler that dispatches a second Operation does not lend its target to
 *     that Operation's handler: `withAdmittedRecordAction(null, …)` clears
 *     an inherited admission before the inner dispatch authorizes its own.
 *
 * This is a HOST bound, not a database one. See the trust boundary recorded
 * on `RecordAccessRuntime.readForAction` (modules/record-access.ts) for what
 * a module that writes its own SQL can still reach, and why closing that
 * needs a database role of its own rather than another check here.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type AdmittedRecordAction = {
  /** The exact capability the dispatcher authorized; identity, never shape. */
  readonly session: object;
  /** The authored entity name of the Operation's target. */
  readonly entityName: string;
  /** The record key the Operation's target input field named. */
  readonly id: string;
  /** The actions `auth.recordAction` required and the dispatcher checked. */
  readonly actions: ReadonlySet<string>;
};

const admissions = new AsyncLocalStorage<AdmittedRecordAction | null>();

/**
 * Run `work` with exactly this admission, or with none at all (`null`).
 *
 * Always called with an explicit value, including `null`: an Operation whose
 * contract names no record action must be able to STATE that, so that an
 * enclosing Operation's target cannot leak into it.
 */
export function withAdmittedRecordAction<T>(
  admitted: AdmittedRecordAction | null,
  work: () => Promise<T>,
): Promise<T> {
  return admissions.run(admitted, work);
}

/** Is this exact session admitted to this exact record and action? */
export function admitsRecordAction(
  session: object,
  input: { entityName: string; id: string; action: string },
): boolean {
  const admitted = admissions.getStore();
  if (!admitted) return false;
  return (
    admitted.session === session &&
    admitted.entityName === input.entityName &&
    admitted.id === input.id &&
    admitted.actions.has(input.action)
  );
}
