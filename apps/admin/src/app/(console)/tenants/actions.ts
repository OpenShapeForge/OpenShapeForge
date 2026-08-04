// SPDX-License-Identifier: BUSL-1.1
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createTenant,
  updateTenant,
  TENANT_STATUSES,
  type ControlApiFailure,
  type TenantStatus,
} from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import type { TenantFormState } from "./form-state";

/**
 * The mutations behind the tenant screens.
 *
 * ── Every action re-checks authorization ────────────────────────────────────
 *
 * `(console)/layout.tsx` gates the PAGES, and a server action is not a page: it
 * is a POST endpoint Next publishes under a generated id, reachable without
 * ever rendering the layout that gated the form. So each action calls
 * `requireOperatorSession` itself. The control surface would refuse an
 * unauthorized caller anyway — it verifies the bearer and the
 * `platform-operator` role on every request — but relying on that would make
 * this app's gate depend on the remote one, and "the far side checks" is how a
 * surface ends up unguarded the day it is put behind something that does not.
 *
 * ── Errors come back as state, not as thrown exceptions ─────────────────────
 *
 * These are `useActionState` reducers. The control surface distinguishes a
 * malformed slug (400) from an unknown tenant (404) from an unconfigured
 * deployment (503), and a form has to present those differently — the first
 * belongs under the field that caused it. Throwing would collapse all of them
 * into one error boundary and lose what the operator typed.
 *
 * `TenantFormState` and its idle value live in `./form-state`, not here: every
 * export of a `"use server"` module becomes a callable server endpoint, so a
 * non-function export is refused outright at module evaluation.
 */

function fieldFor(failure: ControlApiFailure, submitted: { slug: string; name: string }) {
  // The control surface answers one CONTROL_INVALID_INPUT code for every field,
  // with the offending field named in the message (`slug must be lowercase…`).
  // Reading which field it was from that message is the only signal there is,
  // and it beats showing a slug error above the name box.
  if (failure.code !== "CONTROL_INVALID_INPUT") return undefined;
  if (/\bslug\b/i.test(failure.message)) return "slug" as const;
  if (/\bname\b/i.test(failure.message)) return "name" as const;
  return submitted.slug ? undefined : ("slug" as const);
}

export async function createTenantAction(
  _previous: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  await requireOperatorSession("/tenants/new");

  const slug = String(formData.get("slug") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const values = { slug, name };

  const result = await createTenant({ slug, name });
  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      code: result.code,
      ...(fieldFor(result, values) ? { field: fieldFor(result, values)! } : {}),
      values,
    };
  }

  // The list and the new tenant's own page are both stale now.
  revalidatePath("/tenants");
  revalidatePath(`/tenants/${result.tenant.slug}`);

  // A REPLAY is a success, not an error: provisioning is idempotent, so posting
  // an existing slug answers 200 with `created: false` rather than a conflict.
  // Saying so on the destination page is the difference between "your tenant
  // was created" and the truth, which an operator who did not expect the tenant
  // to exist needs to know.
  redirect(
    `/tenants/${encodeURIComponent(result.tenant.slug)}?notice=${
      result.created ? "created" : "existed"
    }`,
  );
}

/**
 * Suspend or reactivate — the whole lifecycle, driven from the detail page.
 *
 * The status arrives in the form data rather than being bound per-button,
 * and it is validated here against the same list the API validates against.
 * A server action's arguments are whatever the client sent, so treating a
 * hidden field as trustworthy is exactly the mistake the extra four lines
 * prevent.
 */
export async function setTenantStatusAction(
  _previous: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  const slug = String(formData.get("slug") ?? "").trim();
  await requireOperatorSession(`/tenants/${slug}`);

  const requested = String(formData.get("status") ?? "");
  if (!(TENANT_STATUSES as readonly string[]).includes(requested)) {
    return {
      status: "error",
      code: "CONTROL_INVALID_INPUT",
      message: `"${requested}" is not a tenant lifecycle state.`,
    };
  }

  const result = await updateTenant(slug, { status: requested as TenantStatus });
  if (!result.ok) {
    return { status: "error", message: result.message, code: result.code };
  }

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${slug}`);
  return { status: "idle" };
}

/**
 * Rename a tenant.
 *
 * There is no slug field here and there is no action that changes one. The slug
 * is the Keycloak Organization alias, the segment every sub-organisation path
 * is built from, and the URL key; `apps/web/src/lib/server/active-tenant-shell.ts`
 * documents that `id` and `slug` are the only tenant identifiers stable enough
 * to sign into authorization-relevant embed parameters, precisely because
 * `name` is not. The control surface refuses a body carrying `slug` outright —
 * this is the near half of the same rule, not the whole of it.
 */
export async function renameTenantAction(
  _previous: TenantFormState,
  formData: FormData,
): Promise<TenantFormState> {
  const slug = String(formData.get("slug") ?? "").trim();
  await requireOperatorSession(`/tenants/${slug}`);

  const name = String(formData.get("name") ?? "").trim();
  const result = await updateTenant(slug, { name });
  if (!result.ok) {
    return {
      status: "error",
      message: result.message,
      code: result.code,
      field: "name",
      values: { name },
    };
  }

  revalidatePath("/tenants");
  revalidatePath(`/tenants/${slug}`);
  return { status: "idle" };
}
