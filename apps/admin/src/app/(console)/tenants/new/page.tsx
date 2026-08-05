// SPDX-License-Identifier: BUSL-1.1
import { requireOperatorSession } from "@/lib/server/route-authz";
import { CreateTenantForm } from "./create-tenant-form";

/**
 * Create a tenant.
 *
 * A server component wrapping a client form, because the form needs
 * `useActionState` to show a server-side refusal against the field that caused
 * it, and the page around it needs the operator gate. The gate is re-asserted
 * here even though `(console)/layout.tsx` applies it — the same reasoning the
 * overview page states: `getCachedSession` de-duplicates within a render pass,
 * so it costs nothing, and a page that states its own precondition cannot be
 * silently un-gated by being moved.
 */
export default async function NewTenantPage() {
  await requireOperatorSession("/tenants/new");

  return (
    <div className="space-y-6" data-testid="new-tenant-page">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">New tenant</h2>
        <p className="text-sm text-[var(--color-foreground-muted)]">
          Writes the registry row and provisions the root Keycloak Organization in one
          operation. The call is idempotent, so submitting a slug that already exists
          reports the existing tenant instead of failing.
        </p>
      </div>

      <CreateTenantForm />
    </div>
  );
}
