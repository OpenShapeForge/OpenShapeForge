// SPDX-License-Identifier: BUSL-1.1
/**
 * Control-plane refusals that are the caller's to fix, distinct from an input
 * that is malformed (`ControlInputError`) and from an upstream that failed
 * (`KeycloakSpiError` / `KeycloakAdminError`).
 *
 * Its own module for one reason: the route layer decides how to present an
 * error with a single `instanceof` per class, so there must be exactly ONE
 * `ControlServiceError` in the process. Declaring it in `provisioning.ts` and
 * again in `tenant-registry.ts` would type-check, pass every unit test, and
 * quietly turn half the control plane's 404s into redacted 500s — a failure
 * that only shows up in production. Both modules import it from here, and
 * neither imports the other's copy, so there is no cycle either.
 */

export type ControlServiceErrorCode =
  | "CONTROL_TENANT_NOT_FOUND"
  | "CONTROL_TENANT_NOT_PROVISIONED"
  | "CONTROL_PARENT_NOT_FOUND"
  | "CONTROL_PARENT_NOT_PROVISIONED"
  | "CONTROL_ORG_UNIT_DEPTH_EXCEEDED"
  | "CONTROL_ORG_UNIT_NOT_FOUND"
  /** The requested parent is the unit itself or one of its own descendants. */
  | "CONTROL_ORG_UNIT_CYCLE"
  /** A sibling under the target parent already holds this unit's slug. */
  | "CONTROL_ORG_UNIT_SLUG_TAKEN"
  /**
   * The registry move COMMITTED and the Keycloak reprojection did not finish.
   * Its own code because it is a state, not a rejection: see
   * `org-unit-registry.ts` for the full argument and what heals it.
   */
  | "CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE"
  /**
   * A re-apply ran and some of its steps failed. Distinct from
   * CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE, which is about ONE committed move:
   * this one says a reconciliation pass over the whole registry left work
   * undone, and it names each step. Re-running is safe — see `reconciliation.ts`.
   */
  | "CONTROL_RECONCILIATION_INCOMPLETE";

export class ControlServiceError extends Error {
  readonly code: ControlServiceErrorCode;
  constructor(code: ControlServiceErrorCode, message: string) {
    super(message);
    this.name = "ControlServiceError";
    this.code = code;
  }
}

/** "No tenant with that slug", phrased identically wherever it is answered. */
export function tenantNotFound(slug: string): ControlServiceError {
  return new ControlServiceError(
    "CONTROL_TENANT_NOT_FOUND",
    `No tenant with slug "${slug}".`,
  );
}
