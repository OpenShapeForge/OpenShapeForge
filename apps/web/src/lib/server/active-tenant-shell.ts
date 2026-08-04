// SPDX-License-Identifier: BUSL-1.1
/**
 * The signed-in tenant, for the app shell and for reporting embeds.
 *
 * ── WHAT CHANGED, AND WHY THE FEATURE FLAG IS GONE (#293) ───────────────────
 *
 * This module used to query a `tenants(filter: { … })` COLLECTION that the API
 * has never exposed — there was no `tenants` field on the schema at all — behind
 * `OPENSHAPEFORGE_ENABLE_TENANT_SHELL_LOOKUP`, whose "off" position substituted
 * the hard-coded name "Acme Corporation".
 *
 * The read is now `Query.currentTenant`: no arguments, no filter, no way to name
 * a tenant other than the session's own. `apps/api/src/graphql/current-tenant.ts`
 * carries the full argument for why that is a different thing from the registry
 * collection that was asked for — the short version is that a cross-tenant
 * registry on a per-tenant graph is a security defect, while a "viewer" field
 * fenced by `id = app.current_tenant()` in row-level security is not.
 *
 * The flag does not survive, and its removal is the point rather than a
 * side effect:
 *
 *   - it was never a rollout switch. Its two positions were "ask the backend"
 *     and "show a name that belongs to no one", so leaving it in place would
 *     mean every deployment had to opt IN to being correct, with the wrong
 *     answer as the default;
 *   - nothing configured it. It appears in no `.env.example`, no chart, no
 *     documentation — only in this file's own `=== "true"` test;
 *   - the one refusal it backed, {@link requireReportingTenantKey}'s, did not
 *     actually depend on it. That function refuses whenever it cannot resolve a
 *     real row, which is the invariant that matters and which now holds
 *     unconditionally instead of only when an env var says so.
 *
 * ── THE DEV FALLBACK, AND WHAT IT IS STILL FOR ──────────────────────────────
 *
 * The hard-coded name survives in exactly one place: an outage of the API or the
 * database, outside production, for the dev tenant. It is reached only from the
 * catch block, never as a routine answer, and in production the error is
 * rethrown — a transient lookup failure must surface as a 5xx rather than
 * silently render a dev organisation name to a real tenant's users. That posture
 * predates this change and is deliberately preserved.
 */
import { executeGraphqlRequest } from "@/lib/server/graphql-client";
import type { Session } from "@/lib/auth";

type CurrentTenantQuery = {
  currentTenant?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
  } | null;
};

export type TenantShellOrganization = {
  name: string;
  avatarStorageLocation?: string | null;
};

/**
 * Stable, immutable tenant identifier safe to sign into authorization-relevant
 * embed parameters (e.g. Metabase locked params). Prefer the tenant UUID `id`
 * — it's the primary key and never changes. `slug` is a stable secondary key.
 * Display `name` is mutable and MUST NOT be used here.
 */
export type ReportingTenantKey = {
  /** Tenant UUID (primary key, immutable). Use this for Metabase scoping. */
  tenantId: string;
  /** URL slug — immutable identifier safe for cross-system references. */
  slug: string;
};

/**
 * The one query, shared by both resolvers so they cannot ask for different
 * things and disagree about what "the current tenant" is.
 */
const CURRENT_TENANT_QUERY = /* GraphQL */ `
  query ActiveTenantShell {
    currentTenant {
      id
      slug
      name
    }
  }
`;

function readDevTenantId(): string {
  return process.env.OPENSHAPEFORGE_DEV_TENANT_ID ?? "11111111-1111-4111-8111-111111111111";
}

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function resolveTenantShellTenantId(sessionTenantId: string | undefined): string | undefined {
  if (isUuid(sessionTenantId)) return sessionTenantId;

  const devTenantId = process.env.OPENSHAPEFORGE_DEV_TENANT_ID?.trim();
  if (devTenantId) return devTenantId;

  return sessionTenantId;
}

/**
 * The local-demo name, for when the backend cannot answer at all.
 *
 * Deliberately still keyed on the dev tenant id: a fallback that answered for
 * ANY tenant would be a wrong name rendered confidently, which is worse than no
 * name. Outside the dev tenant this returns undefined and the shell renders
 * without an organisation label.
 */
function activeTenantShellFallback(
  session: Session | null,
): TenantShellOrganization | undefined {
  const tenantId = resolveTenantShellTenantId(session?.tenantId);
  if (!tenantId) return undefined;

  const devTenantId = readDevTenantId();
  if (tenantId !== devTenantId) return undefined;

  return {
    name: process.env.OPENSHAPEFORGE_TENANT_SHELL_NAME ?? "Acme Corporation",
  };
}

export async function getActiveTenantShellOrganization(
  session: Session | null,
): Promise<TenantShellOrganization | undefined> {
  // No tenant on the session means there is nothing to resolve and no query
  // worth issuing — the API would refuse it as unauthenticated anyway.
  if (!session?.tenantId) return undefined;

  try {
    const data = await executeGraphqlRequest<CurrentTenantQuery>({
      query: CURRENT_TENANT_QUERY,
      cache: "no-store",
    });

    const name = data.currentTenant?.name;
    if (!name) return undefined;

    return { name };
  } catch (error) {
    console.warn("Failed to resolve active tenant shell data", error);
    // Don't mask a backend outage with a default tenant in production — a
    // transient lookup failure must surface, not silently render a dev org
    // name. The dev fallback exists only to keep the local demo flow usable.
    if (process.env.NODE_ENV === "production") throw error;
    return activeTenantShellFallback(session);
  }
}

/**
 * Strict tenant-key resolver for authorization-relevant flows (e.g. signing
 * locked Metabase embed parameters).
 *
 * Unlike {@link getActiveTenantShellOrganization}, this resolver:
 *  - Never falls back to a dev/default organization. The lookup MUST succeed
 *    and MUST return a real row.
 *  - Returns a STABLE identifier (tenant UUID `id` and `slug`), never the
 *    mutable display `name`.
 *  - Throws on lookup error rather than silently swallowing — a transient
 *    lookup failure must surface as a 5xx, not as wrong-tenant data. There is
 *    no `try` here on purpose: an error from the request propagates.
 *
 * Callers should pass the returned `tenantId` (or `slug`) as the locked
 * scoping value; `name` from {@link getActiveTenantShellOrganization} stays
 * available for UI copy (titles, subtitles).
 */
export async function requireReportingTenantKey(
  session: Session | null,
): Promise<ReportingTenantKey> {
  const sessionTenantId = session?.tenantId;
  if (!sessionTenantId) {
    throw new Error(
      "requireReportingTenantKey: session has no tenantId — cannot resolve " +
        "a stable reporting tenant key.",
    );
  }

  const data = await executeGraphqlRequest<CurrentTenantQuery>({
    query: CURRENT_TENANT_QUERY,
    cache: "no-store",
  });

  const tenant = data.currentTenant;
  if (!tenant?.id || !tenant.slug) {
    throw new Error(
      `requireReportingTenantKey: no tenant row found for session tenant ${JSON.stringify(
        sessionTenantId,
      )}. Refusing to sign a reporting embed without a stable tenant key.`,
    );
  }

  return { tenantId: tenant.id, slug: tenant.slug };
}
