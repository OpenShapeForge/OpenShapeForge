// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { getDriftReport, type DriftFinding } from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import { ControlApiError } from "../control-api-error";
import { ReapplyForm } from "./reapply-form";

/**
 * Drift between the registry and Keycloak, and the one action that closes it.
 *
 * ── Why the report is computed on every load ────────────────────────────────
 *
 * There is no stored report and no "last scan" timestamp to trust. Expected
 * state is recomputed from `platform.tenants` + `platform.org_unit` on each
 * request and compared against a live realm listing, because a cached verdict
 * about whether two systems agree is the third source of truth this whole
 * feature exists to avoid. The cost is one registry read plus one Keycloak
 * listing per page view, on a screen an operator opens deliberately.
 *
 * ── Two kinds of finding, rendered differently on purpose ───────────────────
 *
 * REPAIRABLE findings are closed by re-apply, which pushes registry state into
 * Keycloak. ADVISORY ones are not, and the distinction is not a severity
 * ranking — it is about who decides. An orphan Organization is the clearest
 * case: reconciliation never deletes one, because it may hold members, identity
 * providers and domains this system did not create, and the same observation is
 * produced by a half-finished create, a hand-made organization and a deleted
 * tenant row. Three situations, three right answers, only one of which is
 * deletion.
 */

export const dynamic = "force-dynamic";

const CODE_LABELS: Record<string, string> = {
  TENANT_ORGANIZATION_MISSING: "Tenant has no Organization",
  ORG_UNIT_ORGANIZATION_MISSING: "Sub-organisation has no Organization",
  ORGANIZATION_ORPHANED: "Organization claimed by nothing",
  ORGANIZATION_ALIAS_MISMATCH: "Alias mismatch",
  ORGANIZATION_LEVEL_MISMATCH: "Level mismatch",
  ORGANIZATION_PATH_MISMATCH: "organizationPath mismatch",
  ORGANIZATION_PARENT_MISMATCH: "Parent mismatch",
  ORGANIZATION_ROOT_MISMATCH: "Root mismatch",
  ORGANIZATION_ENABLED_MISMATCH: "Enabled mismatch",
  TARGET_NOT_PROJECTABLE: "Row cannot be projected",
};

function Subject({ finding }: { finding: DriftFinding }) {
  if (!finding.tenantSlug) {
    return <span className="text-[var(--color-foreground-muted)]">— (realm)</span>;
  }
  return (
    <span>
      <Link
        href={`/tenants/${encodeURIComponent(finding.tenantSlug)}`}
        className="font-mono text-[13px] text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
      >
        {finding.tenantSlug}
      </Link>
      {finding.orgUnitId ? (
        <span className="ml-2 font-mono text-[11px] text-[var(--color-foreground-muted)]">
          unit {finding.orgUnitId}
        </span>
      ) : null}
    </span>
  );
}

function FindingsTable({
  findings,
  testId,
}: {
  findings: readonly DriftFinding[];
  testId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-[var(--color-border-subtle)] text-xs uppercase tracking-[0.14em] text-[var(--color-foreground-muted)]">
            <th className="py-2 pr-4 font-medium">Finding</th>
            <th className="py-2 pr-4 font-medium">Subject</th>
            <th className="py-2 pr-4 font-medium">Expected</th>
            <th className="py-2 pr-4 font-medium">Actual</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding, index) => (
            <tr
              // A finding has no identity of its own — it is derived, not stored
              // — and the same (code, subject) pair can legitimately appear once
              // per property. The index is the honest key for a list that is
              // rebuilt whole on every render and never reordered in place.
              key={`${finding.code}:${finding.tenantId ?? ""}:${finding.orgUnitId ?? ""}:${index}`}
              className="border-b border-[var(--color-border-subtle)] align-top"
              data-testid="drift-finding"
              data-code={finding.code}
            >
              <td className="py-3 pr-4">
                <div className="font-medium">{CODE_LABELS[finding.code] ?? finding.code}</div>
                <div className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
                  {finding.code}
                </div>
                <p className="mt-1 max-w-xl text-[12px] text-[var(--color-foreground-subtle)]">
                  {finding.message}
                </p>
              </td>
              <td className="py-3 pr-4">
                <Subject finding={finding} />
              </td>
              <td className="py-3 pr-4 font-mono text-[12px]">{finding.expected ?? "—"}</td>
              <td className="py-3 pr-4 font-mono text-[12px]">{finding.actual ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ReconciliationPage() {
  await requireOperatorSession("/reconciliation");

  const result = await getDriftReport();
  if (!result.ok) {
    return (
      <div className="space-y-6" data-testid="reconciliation-page">
        <Heading />
        <ControlApiError failure={result} />
      </div>
    );
  }

  const repairable = result.findings.filter((finding) => finding.repairable);
  const advisory = result.findings.filter((finding) => !finding.repairable);
  // Only tenants that actually have repairable drift are offered as a scope: a
  // dropdown of every tenant would suggest re-apply does something for one that
  // is already converged, and it does not — it would touch nothing.
  const drifted = [
    ...new Set(
      repairable
        .map((finding) => finding.tenantSlug)
        .filter((slug): slug is string => slug !== null),
    ),
  ].sort();
  const truncated =
    result.truncated.tenants || result.truncated.orgUnits || result.truncated.organizations;

  return (
    <div
      className="space-y-6"
      data-testid="reconciliation-page"
      data-repairable={String(repairable.length)}
      data-advisory={String(advisory.length)}
    >
      <Heading />

      <p className="max-w-3xl text-sm text-[var(--color-foreground-muted)]">
        The application database is authoritative; the Keycloak Organization tree is its
        projection. This compares them and, where they disagree, replays the same
        provisioning calls that created the state in the first place. It never writes to
        the registry and never deletes an Organization.
      </p>

      <dl
        className="grid gap-4 sm:grid-cols-4"
        data-testid="reconciliation-counts"
      >
        <Counter label="Tenants" value={result.counts.tenants} />
        <Counter label="Sub-organisations" value={result.counts.orgUnits} />
        <Counter label="Organizations" value={result.counts.organizations} />
        <Counter label="Findings" value={result.findings.length} />
      </dl>

      {truncated ? (
        <p
          role="alert"
          data-testid="reconciliation-truncated"
          className="rounded-[var(--radius-medium)] border border-[var(--color-functional-orange-40)] bg-[var(--color-functional-orange-5)] p-3 text-sm"
        >
          This scan hit its cap, so it describes a prefix of the registry rather than all
          of it. Orphan detection is suppressed while that is true: &ldquo;no registry row
          claims this Organization&rdquo; cannot be answered from a partial registry
          without accusing every unscanned row&rsquo;s Organization of being orphaned.
        </p>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Re-apply</h3>
        <ReapplyForm tenantSlugs={drifted} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">
          Repairable drift ({repairable.length})
        </h3>
        {repairable.length === 0 ? (
          <p className="text-sm text-[var(--color-foreground-muted)]" data-testid="no-drift">
            Keycloak matches the registry. A re-apply now would make no call and write
            nothing.
          </p>
        ) : (
          <FindingsTable findings={repairable} testId="repairable-findings" />
        )}
      </section>

      {advisory.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Needs a decision ({advisory.length})</h3>
          <p className="max-w-3xl text-sm text-[var(--color-foreground-muted)]">
            Re-apply will not touch these. Pushing registry state outward cannot resolve
            them — an Organization the registry has no opinion about, or a row that cannot
            be projected at all.
          </p>
          <FindingsTable findings={advisory} testId="advisory-findings" />
        </section>
      ) : null}

      <p className="font-mono text-[11px] text-[var(--color-foreground-muted)]">
        scanned at {result.scannedAt}
        {result.orphansEvaluated ? "" : " · orphan detection suppressed"}
      </p>
    </div>
  );
}

function Heading() {
  return <h2 className="text-xl font-semibold tracking-tight">Reconciliation</h2>;
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs uppercase tracking-[0.14em] text-[var(--color-foreground-muted)]">
        {label}
      </dt>
      <dd className="font-mono text-lg">{value}</dd>
    </div>
  );
}
