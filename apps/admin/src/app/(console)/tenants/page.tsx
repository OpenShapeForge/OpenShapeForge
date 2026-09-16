// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { Button } from "@openshapeforge/ui";
import { TenantStatusBadge } from "@/components/tenant-status-badge";
import { listTenants } from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import { ControlApiError } from "../control-api-error";

/**
 * The tenant registry.
 *
 * A server component that reads through the control API, which is the only way
 * this app is allowed to see the registry: `platform.tenants` carries an RLS
 * policy that shows an ordinary session exactly its own row, so the whole list
 * exists only behind the API's audited `withSystemSession` bypass. There is no
 * direct database access from here and there must not be one.
 *
 * The failure path is a first-class state rather than a thrown error. The most
 * common one in development is "the API is not running", and a red Next error
 * overlay does not say which process to start; the control surface's own 503
 * names every missing environment variable, and that message is worth showing
 * verbatim.
 */
export default async function TenantsPage() {
  await requireOperatorSession("/tenants");
  const result = await listTenants();

  return (
    <div className="space-y-6" data-testid="tenants-page">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">Tenants</h2>
          <p className="text-sm text-[var(--color-foreground-muted)]">
            The platform tenant registry. Each tenant is one row here and one root
            Organization in the <code className="font-mono">openshapeforge</code> realm.
          </p>
        </div>
        <Button asChild variant="primary" size="M">
          <Link href="/tenants/new">New tenant</Link>
        </Button>
      </div>

      {!result.ok ? (
        <ControlApiError failure={result} />
      ) : result.tenants.length === 0 ? (
        <p
          className="rounded-[var(--radius-medium)] border border-dashed border-[var(--color-border-subtle)] p-6 text-sm text-[var(--color-foreground-muted)]"
          data-testid="tenants-empty"
        >
          No tenants yet. Creating one writes the registry row and provisions its
          Keycloak Organization in the same operation.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="tenants-table">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] text-left text-xs uppercase tracking-[0.14em] text-[var(--color-foreground-muted)]">
                  <th className="px-3 py-2 font-medium">Slug</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Keycloak organization</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {result.tenants.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className="border-b border-[var(--color-border-subtle)]"
                    data-testid="tenant-row"
                    data-slug={tenant.slug}
                  >
                    <td className="px-3 py-2">
                      {/* The slug is the URL key precisely because it is immutable. */}
                      <Link
                        href={`/tenants/${encodeURIComponent(tenant.slug)}`}
                        className="font-mono text-[13px] text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
                      >
                        {tenant.slug}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{tenant.name}</td>
                    <td className="px-3 py-2">
                      <TenantStatusBadge status={tenant.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-[var(--color-foreground-muted)]">
                      {tenant.keycloakOrganizationId ?? (
                        // Not an error: provisioning is DB-first, so a row with no
                        // link is a real, replay-healable state rather than a bug.
                        <span className="text-[var(--color-functional-orange-100)]">
                          not provisioned
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-foreground-muted)]">
                      {new Date(tenant.createdAt).toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.truncated ? (
            <p className="text-sm text-[var(--color-functional-orange-100)]">
              Showing the first page of the registry only — there are more tenants than
              this list returns. Paging arrives when a deployment needs it.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
