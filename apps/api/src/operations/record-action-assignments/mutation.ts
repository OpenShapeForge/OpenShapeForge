// SPDX-License-Identifier: BUSL-1.1
/**
 * Change ONE integration's hold on ONE declared action of ONE record.
 *
 * This module writes nothing. It resolves a locator, re-decides every part of
 * it, and then applies the ONE canonical delta
 * (operations/record-action-operations.ts) that every change to the
 * named-action axis goes through. There is no second write path, no second set
 * of authority checks to keep in step and no trusted bypass: the generic write
 * guard in entity/record-permissions.ts refuses the axis to every ordinary
 * update, this surface included, and the canonical Operation is how the axis
 * moves for a management surface exactly as it is for a direct caller.
 *
 * WHAT THIS MODULE DECIDES
 * ------------------------
 * The reach of the locator, before the delta is asked for:
 *
 *   authority     {@link assertAssignmentManagerAuthority} — the same
 *                 integration-management authority the listing takes, so a
 *                 session cannot change what it may not see;
 *   context       the parent `integrationId` of the route the caller came in
 *                 on must be the one the locator names. A detail route under
 *                 integration B carrying a locator for integration A is
 *                 refused rather than silently acting on A;
 *   manageability the entity must be one the compiled registry admits and the
 *                 action one it declared for an application principal.
 *
 * WHAT THE CANONICAL DELTA DECIDES
 * --------------------------------
 * Everything that touches the record: the entity's own update roles, the
 * record's `edit` permission under the ACL-row lock, that the integration
 * being GRANTED is an `active` integration of this tenant — rechecked inside
 * that lock, so a concurrent disable either loses the race or waits for it —
 * the carrier gate, `Platform.ApiKeys.Manage` for an application subject, the
 * preservation of every other subject and action, the audit row, and
 * `expectedVersion` when the caller supplies one.
 *
 * Revoking stays available for a disabled integration, because that is exactly
 * when a leftover grant most needs removing. Granting does not: a subject that
 * authenticates nothing would be a grant to a row rather than to a party.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { applyRecordActionDelegation } from "../record-action-operations.js";
import { assertAssignmentManagerAuthority } from "./authority.js";
import { parseAssignmentLocator, formatAssignmentLocator } from "./locator.js";
import { recordActionAssignmentEntity } from "./registry.js";

export type AssignmentChange = {
  id: string;
  entity: string;
  recordId: string;
  action: string;
  integrationId: string;
  assigned: boolean;
  /** True when the stored document actually changed; false when it already said so. */
  changed: boolean;
  version: string | null;
};

/** The transports derive the status from the code (connectors/provider-outcome.ts). */
function refuse(code: string, message: string): Error {
  return operationFailure({ code, message, retryable: false });
}

export type SetAssignmentInput = {
  /** The locator a listing returned, or one built from its parts. */
  assignment: string;
  /**
   * The integration the caller's route is scoped to. The route is UNTRUSTED
   * input like any other, so it is not an authority — but the locator must
   * agree with it, or one of the two is not the request the caller made.
   */
  integrationId: string;
  assigned: boolean;
  /** The record version the caller acted on; refused when it has moved. */
  expectedVersion?: string | undefined;
};

export async function setRecordActionAssignment(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext & DbSessionInput,
  input: SetAssignmentInput,
): Promise<AssignmentChange> {
  assertAssignmentManagerAuthority(session);
  const locator = parseAssignmentLocator(input.assignment);
  if (!locator) throw refuse("VALIDATION", "The assignment identifier is not valid.");
  if (typeof input.assigned !== "boolean") {
    throw refuse("VALIDATION", "assigned must be true or false.");
  }
  // The path and the locator are two statements of the same subject by two
  // routes, and a disagreement between them is not something to resolve in
  // the caller's favour. Refused, so a route under one integration can never
  // reach another even when the session is allowed to manage both.
  if (input.integrationId !== locator.integrationId) {
    throw refuse(
      "VALIDATION",
      "The assignment does not belong to the integration in the request path.",
    );
  }
  const entity = recordActionAssignmentEntity(locator.entity);
  if (!entity) {
    throw refuse("NOT_FOUND", "No such manageable record action.");
  }
  if (!entity.actions.some((candidate) => candidate.name === locator.action)) {
    throw refuse(
      "NOT_FOUND",
      `${locator.entity} does not declare an action "${locator.action}" an application may hold.`,
    );
  }

  const subject = { integrations: [locator.integrationId] };
  const result = await applyRecordActionDelegation(db, session, {
    entity: locator.entity,
    recordId: locator.recordId,
    action: locator.action,
    ...(input.assigned ? { grant: subject } : { revoke: subject }),
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });

  return {
    id: formatAssignmentLocator(locator),
    entity: locator.entity,
    recordId: locator.recordId,
    action: locator.action,
    integrationId: locator.integrationId,
    // What the record ends up with, not what was asked for: the delta is
    // applied to the document under the lock, so this is the stored truth.
    assigned: result.subjects.integrations.includes(locator.integrationId),
    changed: result.changed,
    version: result.version,
  };
}
