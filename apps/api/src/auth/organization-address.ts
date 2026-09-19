// SPDX-License-Identifier: BUSL-1.1
/**
 * The short-address check: `/<alias>/api/...` and `/<alias>/graphql` name an
 * organization, and a credential of another tenant is refused there the way
 * the per-organization MCP resource refuses it. The routing layer records the
 * alias in a server-owned request header (ORGANIZATION_ADDRESS_HEADER,
 * mcp/organization-resource.ts); this module compares it with the
 * credential's tenant by registry slug — the Keycloak Organization alias and
 * the URL segment. The MCP resource pins its tenant through its own binding
 * and needs no second check.
 */
import { ORGANIZATION_TENANT_CACHE_TTL_MS } from "@openshapeforge/auth";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { ORGANIZATION_ADDRESS_HEADER } from "../mcp/organization-resource.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "./trusted-context.js";

export class OrganizationAddressError extends HttpError {
  constructor(alias: string) {
    super(
      403,
      "ORGANIZATION_RESOURCE_FORBIDDEN",
      `This credential is not for the organization at /${alias}.`,
    );
    this.name = "OrganizationAddressError";
  }
}

type TenantSession = TrustedSessionContext & { tenantId: string; userId: string };

const tenantSlugCache = new Map<string, { slug: string; expiresAtMs: number }>();
let tenantSlugOverride: ((tenantId: string) => string | null) | null = null;

/** Test-only: stand in for the `platform.tenants.slug` read. */
export function __setTenantSlugForTests(lookup: ((tenantId: string) => string | null) | null): void {
  tenantSlugOverride = lookup;
}

/** Test-only. */
export function __resetOrganizationAddressForTests(): void {
  tenantSlugCache.clear();
  tenantSlugOverride = null;
}

/** The tenant's own slug, read as the tenant (its registry row is visible to it). */
async function tenantSlug(db: OpenShapeForgeDatabase, session: TenantSession): Promise<string | null> {
  if (tenantSlugOverride) return tenantSlugOverride(session.tenantId);
  const cached = tenantSlugCache.get(session.tenantId);
  if (cached && cached.expiresAtMs > Date.now()) return cached.slug;
  const slug = await withDbSession(
    db,
    {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: session.roles,
      groups: session.groups,
      scope: session.scope,
    },
    async (trx) => {
      const result = await sql<{ slug: string }>`
        select slug from platform.tenants where id = ${session.tenantId}::uuid
      `.execute(trx);
      return result.rows[0]?.slug ?? null;
    },
  );
  if (slug) {
    // Slugs are immutable after creation (platform-schema.yaml), so a cached
    // answer never goes stale in the direction that matters.
    tenantSlugCache.set(session.tenantId, { slug, expiresAtMs: Date.now() + ORGANIZATION_TENANT_CACHE_TTL_MS });
  }
  return slug;
}

/**
 * The session, or the empty one when the organization cannot be verified;
 * throws {@link OrganizationAddressError} when it is another organization's.
 */
export async function assertSessionAddressesOrganization(
  headers: Headers,
  session: TrustedSessionContext,
  options: { db?: OpenShapeForgeDatabase | undefined; bound?: boolean },
  empty: TrustedSessionContext,
): Promise<TrustedSessionContext> {
  const alias = headers.get(ORGANIZATION_ADDRESS_HEADER)?.trim().toLowerCase();
  if (!alias || options.bound || !session.tenantId || !session.userId) return session;
  if (!options.db) {
    console.warn(
      `[auth] A credential was presented at /${alias} on a surface that resolves sessions ` +
        "without a database; the organization cannot be verified. Rejecting.",
    );
    return empty;
  }
  const slug = await tenantSlug(options.db, session as TenantSession);
  if (slug?.toLowerCase() !== alias) {
    console.warn(
      `[auth] Credential for tenant ${session.tenantId} (${slug ?? "no slug"}) refused at /${alias}.`,
    );
    throw new OrganizationAddressError(alias);
  }
  return session;
}
