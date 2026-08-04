// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { PLATFORM_OPERATOR_ROLE } from "@/lib/auth";
import { requireOperatorSession } from "@/lib/server/route-authz";

/**
 * The control plane's landing page.
 *
 * Still a STATUS page rather than a dashboard. It says who is signed in and
 * against what, and points at the screens that do the work; it deliberately
 * does NOT summarise the registry, because a tenant count here would be a
 * second read of the same data that the tenant list already presents properly,
 * and one that quietly fails differently when the control API is down.
 *
 * It re-calls `requireOperatorSession` even though `(console)/layout.tsx`
 * already did. That is not an oversight — `getCachedSession` de-duplicates the
 * lookup within a render pass, so the second call costs nothing, and a page
 * that states its own precondition cannot be silently un-gated by someone
 * moving it out of the route group later.
 */
export default async function ControlPlaneOverviewPage() {
  const session = await requireOperatorSession("/");

  return (
    <div className="space-y-6" data-testid="console-overview">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p className="text-sm text-[var(--color-foreground-muted)]">
          Signed in against the control realm. Tenant management is under{" "}
          <Link
            href="/tenants"
            className="text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
          >
            Tenants
          </Link>
          ; whether Keycloak still matches the registry is under{" "}
          <Link
            href="/reconciliation"
            className="text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
          >
            Reconciliation
          </Link>
          .
        </p>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[var(--radius-medium)] border border-[var(--color-border-subtle)] p-4">
          <dt className="text-xs uppercase tracking-[0.18em] text-[var(--color-foreground-muted)]">
            Operator
          </dt>
          <dd className="mt-1 font-medium" data-testid="overview-operator">
            {session.user?.preferredUsername ?? session.user?.email ?? session.sub}
          </dd>
        </div>
        <div className="rounded-[var(--radius-medium)] border border-[var(--color-border-subtle)] p-4">
          <dt className="text-xs uppercase tracking-[0.18em] text-[var(--color-foreground-muted)]">
            Authorized by
          </dt>
          <dd className="mt-1 font-mono text-sm" data-testid="overview-role">
            {PLATFORM_OPERATOR_ROLE}
          </dd>
        </div>
      </dl>

      <ul className="space-y-2 text-sm text-[var(--color-foreground-muted)]">
        <li>Sub-organisation hierarchy — issue #292 (S6).</li>
        <li>Drift report and reconciliation — issue #293 (S7).</li>
      </ul>
    </div>
  );
}
