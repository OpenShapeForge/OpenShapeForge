// SPDX-License-Identifier: BUSL-1.1
"use server";

import { revalidatePath } from "next/cache";
import { reapplyProjection } from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import type { ReapplyFormState } from "./form-state";

/**
 * Re-apply: push the registry back into Keycloak.
 *
 * ── This action re-checks authorization, like every other one ───────────────
 *
 * `(console)/layout.tsx` gates the PAGES, and a server action is not a page: it
 * is a POST endpoint Next publishes under a generated id, reachable without ever
 * rendering the layout that gated the form. The control surface would refuse an
 * unauthorized caller anyway, but relying on that would make this app's gate
 * depend on the remote one.
 *
 * ── Why the whole result is collapsed to counts ─────────────────────────────
 *
 * The API answers with the report before, every step it took, and a fresh report
 * after. Rendering all three would be a second, worse version of the page that
 * is already below the form — and the page re-reads the report on revalidation
 * anyway, so the "after" state is about to be shown properly. What the action
 * contributes is the part the page cannot see by looking: how many steps ran and
 * whether the run converged.
 */
export async function reapplyProjectionAction(
  _previous: ReapplyFormState,
  formData: FormData,
): Promise<ReapplyFormState> {
  await requireOperatorSession("/reconciliation");

  // Empty means "every tenant with a repairable finding". A server action's
  // arguments are whatever the client sent, so the field is normalised here
  // rather than trusted.
  const tenantSlug = String(formData.get("tenantSlug") ?? "").trim();

  const result = await reapplyProjection(tenantSlug ? { tenantSlug } : {});
  if (!result.ok) {
    return { status: "error", message: result.message, code: result.code };
  }

  revalidatePath("/reconciliation");
  revalidatePath("/tenants");

  const repairable = (findings: { repairable: boolean }[]) =>
    findings.filter((finding) => finding.repairable).length;

  return {
    status: "done",
    summary: {
      applied: result.actions.filter((action) => action.applied).length,
      attempted: result.actions.length,
      repairableBefore: repairable(result.before.findings),
      repairableAfter: repairable(result.after.findings),
      advisoryAfter: result.after.findings.length - repairable(result.after.findings),
      converged: result.converged,
    },
  };
}
