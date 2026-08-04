// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape a tenant form's `useActionState` reducer returns.
 *
 * Its own module, NOT part of `actions.ts`, because a `"use server"` file may
 * only export async functions — every export becomes a callable server endpoint,
 * so a plain object export is refused at module evaluation with
 * `A "use server" file can only export async functions, found object`. The type
 * would survive (types are erased) but `IDLE_TENANT_FORM_STATE` would not, and
 * a form needs an initial state.
 *
 * Splitting it out also means client components import the shape from a module
 * with no server code in it at all.
 */

export type TenantFormState = {
  status: "idle" | "error";
  /** Message written for an operator. Safe to display; the API redacts anything unclassified. */
  message?: string;
  /** The control surface's own code, so a caller can branch rather than string-match. */
  code?: string;
  /** Which input to attach the message to, when the refusal is about one. */
  field?: "slug" | "name";
  /** Echoed back so a refused submission does not clear the form. */
  values?: { slug?: string; name?: string };
};

export const IDLE_TENANT_FORM_STATE: TenantFormState = { status: "idle" };
