// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@openshapeforge/ui";
import { reapplyProjectionAction } from "./actions";
import { IDLE_REAPPLY_FORM_STATE, type ReapplyFormState } from "./form-state";

/**
 * The one write on this screen.
 *
 * An optional tenant slug, not a checklist of findings. A finding is not
 * independently repairable — they cascade, and the API's repair unit is a whole
 * tenant for exactly that reason (see `reconciliation.ts`). Offering per-finding
 * checkboxes would suggest a granularity the operation does not have.
 *
 * Deliberately NOT a destructive-styled control, and deliberately without a
 * confirmation dialog: re-apply writes only what the registry already says, it
 * never deletes an Organization, and it is a no-op when there is nothing to fix.
 * Dressing an idempotent convergence step as dangerous would train an operator
 * to click through the warnings that matter.
 */

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="M" disabled={pending}>
      {pending ? "Re-applying…" : "Re-apply"}
    </Button>
  );
}

export function ReapplyForm({ tenantSlugs }: { tenantSlugs: readonly string[] }) {
  const [state, formAction] = useActionState<ReapplyFormState, FormData>(
    reapplyProjectionAction,
    IDLE_REAPPLY_FORM_STATE,
  );

  return (
    <form action={formAction} className="space-y-3" data-testid="reapply-form">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="reapply-tenant" className="block text-sm font-medium">
            Scope
          </label>
          <select
            id="reapply-tenant"
            name="tenantSlug"
            defaultValue=""
            className="rounded-[var(--radius-small)] border border-[var(--color-input-border)] bg-[var(--color-input)] px-3 py-2 font-sans text-[13px] text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-indigo-60)]"
          >
            <option value="">Every drifted tenant</option>
            {tenantSlugs.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </div>
        <SubmitButton />
      </div>

      {state.status === "error" ? (
        <p
          role="alert"
          data-testid="reapply-error"
          data-code={state.code}
          className="text-[12px] text-[var(--color-functional-red-100)]"
        >
          {state.message} <span className="font-mono">({state.code})</span>
        </p>
      ) : null}

      {state.status === "done" && state.summary ? (
        <p
          data-testid="reapply-summary"
          data-converged={String(state.summary.converged)}
          className="text-[12px] text-[var(--color-foreground-muted)]"
        >
          {state.summary.attempted === 0
            ? "Nothing to re-apply — the projection already matched the registry, so no Keycloak call and no database write was made."
            : `Re-applied ${state.summary.applied} of ${state.summary.attempted} steps. ` +
              `Repairable drift went from ${state.summary.repairableBefore} to ` +
              `${state.summary.repairableAfter}.`}
          {state.summary.advisoryAfter > 0
            ? ` ${state.summary.advisoryAfter} finding(s) remain that a re-apply will not touch — they need a decision.`
            : ""}
        </p>
      ) : null}
    </form>
  );
}
