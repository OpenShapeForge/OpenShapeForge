// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape a sub-organisation form's `useActionState` reducer returns.
 *
 * Its own module for the same reason `../../form-state.ts` is one: a
 * `"use server"` file may only export async functions, so the idle constant a
 * form needs as its initial state cannot live beside the actions.
 *
 * Not shared with `TenantFormState` even though the two look alike. A
 * sub-organisation form has a `parentOrgUnitId` field a tenant form has no
 * concept of, and it reports a partially-applied reparent — the
 * `CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE` case — which is a success on the
 * registry side and a failure on the Keycloak side at once. Widening the tenant
 * shape to carry both would make every tenant form declare fields it can never
 * populate.
 */

export type OrgUnitFormState = {
  status: "idle" | "error";
  /** Message written for an operator. Safe to display; the API redacts anything unclassified. */
  message?: string;
  /** The control surface's own code, so a caller can branch rather than string-match. */
  code?: string;
  /** Which input to attach the message to, when the refusal is about one. */
  field?: "slug" | "name" | "parentOrgUnitId";
  /** Echoed back so a refused submission does not clear the form. */
  values?: { slug?: string; name?: string; parentOrgUnitId?: string };
  /**
   * Which unit the state belongs to. Every node renders its own forms against
   * ONE action per operation, so without this a refusal on one row would show
   * up under every row.
   */
  orgUnitId?: string;
};

export const IDLE_ORG_UNIT_FORM_STATE: OrgUnitFormState = { status: "idle" };
