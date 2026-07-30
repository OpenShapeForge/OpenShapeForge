// SPDX-License-Identifier: BUSL-1.1
import { executeGraphqlRequest } from "@/lib/server/graphql-client";
import type { Session } from "@/lib/auth";

type TenantShellQuery = {
  tenants?: {
    edges?: Array<{
      node?: {
        id?: string | null;
        slug?: string | null;
        name?: string | null;
      } | null;
    } | null> | null;
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
 * True when real DB-backed tenant resolution is on. When false,
 * `getActiveTenantShellOrganization` returns a hard-coded dev fallback name
 * — never use that result as a security boundary (e.g. as a signed
 * Metabase embed parameter). Callers that produce per-tenant authorization
 * should refuse or surface a banner when this is false.
 */
export function isTenantShellLookupEnabled(): boolean {
  return process.env.OPENSHAPEFORGE_ENABLE_TENANT_SHELL_LOOKUP === "true";
}

function isUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function readDevTenantId(): string {
  return process.env.OPENSHAPEFORGE_DEV_TENANT_ID ?? "11111111-1111-4111-8111-111111111111";
}

function resolveTenantShellTenantId(sessionTenantId: string | undefined): string | undefined {
  if (isUuid(sessionTenantId)) return sessionTenantId;

  const devTenantId = process.env.OPENSHAPEFORGE_DEV_TENANT_ID?.trim();
  if (devTenantId) return devTenantId;

  return sessionTenantId;
}

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

function tenantLookupVariables(sessionTenantId: string):
  | { id: string; slug?: never }
  | { slug: string; id?: never } {
  return isUuid(sessionTenantId) ? { id: sessionTenantId } : { slug: sessionTenantId };
}

function tenantLookupFilter(sessionTenantId: string): string {
  return isUuid(sessionTenantId) ? "id: $id" : "slug: $slug";
}

function tenantLookupVariableDefinition(sessionTenantId: string): string {
  return isUuid(sessionTenantId) ? "$id: ID!" : "$slug: String!";
}

export async function getActiveTenantShellOrganization(
  session: Session | null,
): Promise<TenantShellOrganization | undefined> {
  if (!isTenantShellLookupEnabled()) return activeTenantShellFallback(session);

  const tenantId = session?.tenantId;
  if (!tenantId) return undefined;

  try {
    const variableDefinition = tenantLookupVariableDefinition(tenantId);
    const filter = tenantLookupFilter(tenantId);
    const data = await executeGraphqlRequest<TenantShellQuery>({
      query: `
        query ActiveTenantShell(${variableDefinition}) {
          tenants(filter: { ${filter} }, first: 1) {
            edges {
              node {
                name
              }
            }
          }
        }
      `,
      variables: tenantLookupVariables(tenantId),
      cache: "no-store",
    });

    const node = data.tenants?.edges?.[0]?.node;
    if (!node?.name) return undefined;

    return {
      name: node.name,
    };
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
 *  - Never falls back to a dev/default organization. Tenant-shell lookup MUST
 *    be enabled and the GraphQL lookup MUST succeed.
 *  - Returns a STABLE identifier (tenant UUID `id` and `slug`), never the
 *    mutable display `name`.
 *  - Throws on lookup error rather than silently swallowing — a transient
 *    lookup failure must surface as a 5xx, not as wrong-tenant data.
 *
 * Callers should pass the returned `tenantId` (or `slug`) as the locked
 * scoping value; `name` from {@link getActiveTenantShellOrganization} stays
 * available for UI copy (titles, subtitles).
 */
export async function requireReportingTenantKey(
  session: Session | null,
): Promise<ReportingTenantKey> {
  if (!isTenantShellLookupEnabled()) {
    throw new Error(
      "requireReportingTenantKey: tenant-shell lookup is disabled " +
        "(OPENSHAPEFORGE_ENABLE_TENANT_SHELL_LOOKUP !== 'true'). " +
        "Reporting embeds require a real DB-backed tenant key — refusing " +
        "to sign a locked parameter with a dev fallback value.",
    );
  }

  const sessionTenantId = session?.tenantId;
  if (!sessionTenantId) {
    throw new Error(
      "requireReportingTenantKey: session has no tenantId — cannot resolve " +
        "a stable reporting tenant key.",
    );
  }

  const variableDefinition = tenantLookupVariableDefinition(sessionTenantId);
  const filter = tenantLookupFilter(sessionTenantId);
  const data = await executeGraphqlRequest<TenantShellQuery>({
    query: `
      query ReportingTenantKey(${variableDefinition}) {
        tenants(filter: { ${filter} }, first: 1) {
          edges {
            node {
              id
              slug
            }
          }
        }
      }
    `,
    variables: tenantLookupVariables(sessionTenantId),
    cache: "no-store",
  });

  const node = data.tenants?.edges?.[0]?.node;
  if (!node?.id || !node.slug) {
    throw new Error(
      `requireReportingTenantKey: no tenant row found for session tenant ${JSON.stringify(
        sessionTenantId,
      )}. Refusing to sign a reporting embed without a stable tenant key.`,
    );
  }

  return { tenantId: node.id, slug: node.slug };
}
