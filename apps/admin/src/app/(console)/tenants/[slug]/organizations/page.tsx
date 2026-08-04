// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { listOrgUnits } from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import { ControlApiError } from "../../../control-api-error";
import { OrgUnitTreeView } from "./org-unit-tree";

/**
 * One tenant's sub-organisation hierarchy.
 *
 * ── Its own route, beneath the tenant ───────────────────────────────────────
 *
 * Not a section of the detail page, because the two answer different questions:
 * the detail page is about one row and its projection, and this is about a
 * structure with its own create/rename/move controls per node. Nesting the
 * route under `/tenants/[slug]/` keeps the tenant in the URL, which is what the
 * whole surface is scoped by — every unit here shares that tenant's
 * `tenant_id` and hangs off its root Organization.
 *
 * ── One read, one query ─────────────────────────────────────────────────────
 *
 * The whole tree arrives in a single control-plane call, which is a single
 * database query joining `platform.org_unit` to the trigger-maintained
 * `platform.org_unit_closure`. No per-node fetch, and no recursive walk: the
 * closure already holds every ancestor edge with its depth.
 *
 * What is NOT read here is Keycloak. The paths shown are the ones the registry
 * says each unit should carry, recomputed from the rows; comparing them against
 * what Keycloak actually holds is a per-node admin-API read and belongs in
 * #293's drift report, not in a tree render.
 */

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function TenantOrganizationsPage({ params }: PageProps) {
  const { slug } = await params;
  await requireOperatorSession(`/tenants/${slug}/organizations`);

  const result = await listOrgUnits(slug);

  return (
    <div className="space-y-6" data-testid="org-units-page" data-slug={slug}>
      <Link
        href={`/tenants/${encodeURIComponent(slug)}`}
        className="text-sm text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
      >
        ← {slug}
      </Link>

      {!result.ok ? (
        <ControlApiError failure={result} />
      ) : (
        <>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">
              Sub-organisations of {result.tenant.name}
            </h2>
            <p className="max-w-3xl text-sm text-[var(--color-foreground-muted)]">
              Every unit below is one <code className="font-mono">platform.org_unit</code>{" "}
              row and one child Keycloak Organization. They all share this tenant&rsquo;s{" "}
              <code className="font-mono">tenant_id</code> and its root Organization at
              every depth — the tree is one identity boundary, not several. Paths are
              capped at {result.maxDepth} levels below the tenant.
            </p>
          </div>

          <OrgUnitTreeView tree={result} />
        </>
      )}
    </div>
  );
}
