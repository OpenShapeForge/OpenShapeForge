// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape the re-apply `useActionState` reducer returns.
 *
 * Its own module, NOT part of `actions.ts`, for the same reason
 * `tenants/form-state.ts` is: a `"use server"` file may only export async
 * functions — every export becomes a callable server endpoint — so the idle
 * value could not live there.
 */

export type ReapplySummary = {
  /** Steps that landed, and steps that were attempted. */
  applied: number;
  attempted: number;
  /** Repairable findings before and after the run. */
  repairableBefore: number;
  repairableAfter: number;
  /** Findings a re-apply will never touch — orphans, unprojectable rows. */
  advisoryAfter: number;
  converged: boolean;
};

export type ReapplyFormState = {
  status: "idle" | "done" | "error";
  /** Message written for an operator. Safe to display; the API redacts anything unclassified. */
  message?: string;
  /** The control surface's own code, so a caller can branch rather than string-match. */
  code?: string;
  /** Present on success, so the page can say what actually happened. */
  summary?: ReapplySummary;
};

export const IDLE_REAPPLY_FORM_STATE: ReapplyFormState = { status: "idle" };
