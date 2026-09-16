// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import type { ReactNode } from "react";
import { TenantStatusBadge } from "@/components/tenant-status-badge";
import { getTenant } from "@/lib/clients/control-api";
import { requireOperatorSession } from "@/lib/server/route-authz";
import { ControlApiError } from "../../control-api-error";
import { TenantLifecycleControls, TenantRenameForm } from "./tenant-controls";

/**
 * One tenant: the registry row, the Keycloak Organization it projects onto, and
 * the operations that move them together.
 *
 * ── Both sides, and the Keycloak side read back rather than assumed ──────────
 *
 * The registry is the system of record and the Organization is its projection,
 * which means the interesting failure is DRIFT — a suspended tenant whose
 * Organization is still enabled, or a link pointing at an Organization that no
 * longer exists. Rendering `keycloakOrganizationId` from the row would show
 * what the registry BELIEVES; the detail read asks Keycloak, so this page shows
 * what is actually true on both sides. When Keycloak cannot be reached the row
 * still renders and the reason is stated, because an operator must be able to
 * look at a tenant while an upstream is down.
 *
 * ── The URL key is the slug ─────────────────────────────────────────────────
 *
 * Not the uuid, because the slug is immutable and human-legible, and not the
 * name, because the name is mutable — the same distinction
 * `apps/web/src/lib/server/active-tenant-shell.ts` documents for embed
 * parameters. A bookmarked tenant URL stays correct across a rename.
 */

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs uppercase tracking-[0.14em] text-[var(--color-foreground-muted)]">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

const NOTICES: Record<string, string> = {
  created: "Tenant created. The registry row and its Keycloak Organization are linked.",
  // Provisioning is idempotent, so this is a success — but silently treating it
  // as "created" would tell an operator they made something that was already
  // there.
  existed:
    "That slug already belonged to a tenant, so nothing was created. Provisioning is idempotent; this is the existing tenant.",
};

export default async function TenantDetailPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  await requireOperatorSession(`/tenants/${slug}`);

  const result = await getTenant(slug);
  const notice = NOTICES[String((await searchParams).notice ?? "")];

  if (!result.ok) {
    return (
      <div className="space-y-6" data-testid="tenant-detail-page">
        <BackLink />
        <ControlApiError failure={result} />
      </div>
    );
  }

  const { tenant, organization, organizationError } = result;
  // The projection rule, stated once here so the page can say when it does not
  // hold rather than leaving an operator to compare two fields by eye.
  const expectedEnabled = tenant.status === "active";
  const drifted = organization !== null && organization.enabled !== expectedEnabled;

  return (
    <div className="space-y-6" data-testid="tenant-detail-page" data-slug={tenant.slug}>
      <BackLink />

      {notice ? (
        <p
          data-testid="tenant-notice"
          className="rounded-[var(--radius-medium)] border border-[var(--color-brand-aquamarine-60)] bg-[var(--color-brand-aquamarine-20)] p-3 text-sm"
        >
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{tenant.name}</h2>
        <TenantStatusBadge status={tenant.status} />
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Lifecycle</h3>
        <p className="text-sm text-[var(--color-foreground-muted)]">
          The registry status is authoritative; the Keycloak Organization is enabled if
          and only if the tenant is <code className="font-mono">active</code>. Disabling
          an Organization drops it from its members&rsquo;{" "}
          <code className="font-mono">organization</code> claim and stops its identity
          configuration from being used. It is not a session kill, and it does not by
          itself refuse a password login for a member whose realm account is enabled.
        </p>
        <TenantLifecycleControls tenant={tenant} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Registry</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Field label="Slug">
            <span className="font-mono text-[13px]" data-testid="tenant-slug">
              {tenant.slug}
            </span>
            <span className="ml-2 text-[12px] text-[var(--color-foreground-muted)]">
              permanent — the Organization alias and URL key
            </span>
          </Field>
          <Field label="Tenant id">
            <span className="font-mono text-[12px]" data-testid="tenant-id">
              {tenant.id}
            </span>
            <span className="ml-2 text-[12px] text-[var(--color-foreground-muted)]">
              the <code className="font-mono">tid</code> claim
            </span>
          </Field>
          <Field label="Created">
            <span className="font-mono text-[12px]">{tenant.createdAt}</span>
          </Field>
          <Field label="Updated">
            <span className="font-mono text-[12px]" data-testid="tenant-updated-at">
              {tenant.updatedAt}
            </span>
          </Field>
        </dl>
        <TenantRenameForm tenant={tenant} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Keycloak</h3>
        {organizationError ? (
          <p
            role="alert"
            data-testid="tenant-organization-error"
            className="rounded-[var(--radius-medium)] border border-[var(--color-functional-red-40)] bg-[var(--color-functional-red-5)] p-3 text-sm"
          >
            {organizationError}
          </p>
        ) : null}

        <dl className="grid gap-4 sm:grid-cols-2">
          <Field label="Realm">
            <span className="font-mono text-[13px]">{tenant.keycloakRealm ?? "—"}</span>
          </Field>
          <Field label="Organization id">
            <span className="font-mono text-[12px]" data-testid="tenant-organization-id">
              {tenant.keycloakOrganizationId ?? "not provisioned"}
            </span>
          </Field>
          <Field label="Organization alias">
            <span className="font-mono text-[13px]">{organization?.alias ?? "—"}</span>
          </Field>
          <Field label="Organization enabled">
            {organization ? (
              <span
                data-testid="organization-enabled"
                data-enabled={String(organization.enabled)}
                className="font-mono text-[13px]"
              >
                {String(organization.enabled)}
              </span>
            ) : (
              <span className="text-[var(--color-foreground-muted)]">—</span>
            )}
          </Field>
        </dl>

        {tenant.keycloakOrganizationId === null ? (
          <p className="text-sm text-[var(--color-functional-orange-100)]">
            This tenant has no Keycloak Organization. Provisioning is DB-first, so this is
            a recoverable half-applied state rather than a corruption: re-submitting the
            same slug and name on the create form finds the row, creates the Organization,
            and stamps the link.
          </p>
        ) : null}

        {drifted ? (
          <p
            data-testid="tenant-drift"
            className="text-sm text-[var(--color-functional-orange-100)]"
          >
            The Organization is {organization?.enabled ? "enabled" : "disabled"} while the
            tenant is <code className="font-mono">{tenant.status}</code>. Re-applying the
            status reconciles it.
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Sub-organisations</h3>
        <p className="max-w-3xl text-sm text-[var(--color-foreground-muted)]">
          The hierarchy beneath this tenant. Every unit is a child Keycloak Organization
          sharing this tenant&rsquo;s <code className="font-mono">tenant_id</code> and its
          root Organization at every depth. A separate screen, because the tree has its own
          per-node operations rather than the two this page offers.
        </p>
        <Link
          href={`/tenants/${encodeURIComponent(tenant.slug)}/organizations`}
          className="inline-block text-sm text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
          data-testid="tenant-organizations-link"
        >
          Manage sub-organisations →
        </Link>
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/tenants"
      className="text-sm text-[var(--color-brand-indigo-100)] underline-offset-2 hover:underline"
    >
      ← All tenants
    </Link>
  );
}
