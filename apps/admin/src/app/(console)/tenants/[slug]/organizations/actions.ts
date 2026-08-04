// SPDX-License-Identifier: BUSL-1.1
"use server";

import { revalidatePath } from "next/cache";
import {
  createOrgUnit,
  updateOrgUnit,
  type ControlApiFailure,
} from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import type { OrgUnitFormState } from "./form-state";

/**
 * The mutations behind the sub-organisation tree.
 *
 * ── Every action re-checks authorization ────────────────────────────────────
 *
 * Same reasoning as `../../actions.ts`: `(console)/layout.tsx` gates the PAGES,
 * and a server action is not a page — it is a POST endpoint Next publishes
 * under a generated id, reachable without ever rendering the layout that gated
 * the form. The control surface would refuse an unauthorized caller anyway, but
 * "the far side checks" is how a surface ends up unguarded the day it is put
 * behind something that does not.
 *
 * ── The tree is re-read after every mutation ────────────────────────────────
 *
 * `revalidatePath` on the tree route rather than optimistic client state. A
 * reparent moves the `organizationPath` of the moved node AND of every
 * descendant, so the set of rows that changed is not derivable from what the
 * operator clicked — and a stale tree after a move is exactly the screen an
 * operator would act on next.
 *
 * ── A half-projected reparent is reported, not swallowed ────────────────────
 *
 * `CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE` means the registry move COMMITTED and
 * one or more Keycloak Organizations did not follow. It arrives here as a
 * failure, and it is presented as one — but the path is still revalidated
 * first, because the tree really did change and showing the old one would be a
 * lie on top of a drift.
 */

function fieldFor(
  failure: ControlApiFailure,
  submitted: { slug?: string; name?: string },
): OrgUnitFormState["field"] {
  // The control surface answers one CONTROL_INVALID_INPUT code for every field,
  // with the offending field named in the message. Reading which field it was
  // from that message is the only signal there is.
  if (failure.code === "CONTROL_ORG_UNIT_SLUG_TAKEN") return "slug";
  if (failure.code === "CONTROL_PARENT_NOT_FOUND") return "parentOrgUnitId";
  if (failure.code === "CONTROL_ORG_UNIT_CYCLE") return "parentOrgUnitId";
  if (failure.code === "CONTROL_ORG_UNIT_DEPTH_EXCEEDED") return "parentOrgUnitId";
  if (failure.code !== "CONTROL_INVALID_INPUT") return undefined;
  if (/\bparentOrgUnitId\b/i.test(failure.message)) return "parentOrgUnitId";
  if (/\bslug\b/i.test(failure.message)) return "slug";
  if (/\bname\b/i.test(failure.message)) return "name";
  return submitted.slug ? undefined : "slug";
}

/**
 * Add a sub-organisation beneath the tenant root or beneath another unit.
 *
 * The parent arrives in the form data and is NOT trusted: a server action's
 * arguments are whatever the client sent, so an empty string (the "top level"
 * option) is normalised to "no parent" here rather than forwarded as a uuid the
 * API would then have to refuse.
 */
export async function createOrgUnitAction(
  _previous: OrgUnitFormState,
  formData: FormData,
): Promise<OrgUnitFormState> {
  const tenantSlug = String(formData.get("tenantSlug") ?? "").trim();
  await requireOperatorSession(`/tenants/${tenantSlug}/organizations`);

  const slug = String(formData.get("slug") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const parentOrgUnitId = String(formData.get("parentOrgUnitId") ?? "").trim();
  const values = { slug, name, parentOrgUnitId };

  const result = await createOrgUnit(tenantSlug, {
    slug,
    name,
    ...(parentOrgUnitId ? { parentOrgUnitId } : {}),
  });
  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      code: result.code,
      ...(fieldFor(result, values) ? { field: fieldFor(result, values)! } : {}),
      values,
    };
  }

  revalidatePath(`/tenants/${tenantSlug}/organizations`);
  return { status: "idle" };
}

/**
 * Rename one unit's display name.
 *
 * There is no slug field here and no action that changes one. A sub-org slug is
 * its `organizationPath` segment, so editing it would move the path of this
 * unit and of every descendant exactly as a reparent does — and the control
 * surface refuses a body carrying `slug` outright. This is the near half of the
 * same rule.
 */
export async function renameOrgUnitAction(
  _previous: OrgUnitFormState,
  formData: FormData,
): Promise<OrgUnitFormState> {
  const tenantSlug = String(formData.get("tenantSlug") ?? "").trim();
  await requireOperatorSession(`/tenants/${tenantSlug}/organizations`);

  const orgUnitId = String(formData.get("orgUnitId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  const result = await updateOrgUnit(tenantSlug, orgUnitId, { name });
  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      code: result.code,
      field: "name",
      values: { name },
      orgUnitId,
    };
  }

  revalidatePath(`/tenants/${tenantSlug}/organizations`);
  return { status: "idle" };
}

/**
 * Move a unit — and everything beneath it — under a different parent.
 *
 * The empty option means the top level, and it is sent as an explicit `null`
 * rather than omitted: omitting the field would mean "do not reparent", and the
 * two must not collapse or a nested unit could never be un-nested.
 */
export async function reparentOrgUnitAction(
  _previous: OrgUnitFormState,
  formData: FormData,
): Promise<OrgUnitFormState> {
  const tenantSlug = String(formData.get("tenantSlug") ?? "").trim();
  await requireOperatorSession(`/tenants/${tenantSlug}/organizations`);

  const orgUnitId = String(formData.get("orgUnitId") ?? "").trim();
  const parentOrgUnitId = String(formData.get("parentOrgUnitId") ?? "").trim();

  const result = await updateOrgUnit(tenantSlug, orgUnitId, {
    parentOrgUnitId: parentOrgUnitId === "" ? null : parentOrgUnitId,
  });

  // Revalidate BEFORE branching on the result. A failed reparent is not
  // necessarily a reparent that did not happen — see
  // CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE, where the registry moved and only
  // the mirror is behind — so the tree has to be re-read either way.
  revalidatePath(`/tenants/${tenantSlug}/organizations`);

  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      code: result.code,
      ...(fieldFor(result, {}) ? { field: fieldFor(result, {})! } : {}),
      values: { parentOrgUnitId },
      orgUnitId,
    };
  }
  return { status: "idle" };
}
