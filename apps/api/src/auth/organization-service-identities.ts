// SPDX-License-Identifier: BUSL-1.1
/** Host-owned deployment configuration, projected from authorization YAML. */
export type OrganizationServiceIdentity = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalTenantId(value: unknown): string | undefined {
  return typeof value === "string" && TENANT_UUID.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function organizationServiceIdentities(
  env: NodeJS.ProcessEnv = process.env,
): readonly OrganizationServiceIdentity[] {
  const raw = env.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES;
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid organization service identity configuration."); }
  if (!Array.isArray(parsed)) throw new Error("Organization service identities must be an array.");
  const tenants = new Set<string>();
  const clients = new Set<string>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid organization service identity configuration.");
    }
    const entry = value as Record<string, unknown>;
    const tenantId = canonicalTenantId(entry.tenantId);
    if (Object.keys(entry).some((key) => !["tenantId", "clientId", "clientSecret"].includes(key)) ||
      !tenantId ||
      typeof entry.clientId !== "string" || !entry.clientId.trim() ||
      typeof entry.clientSecret !== "string" || !entry.clientSecret) {
      throw new Error("Invalid organization service identity configuration.");
    }
    if (tenants.has(tenantId) || clients.has(entry.clientId)) {
      throw new Error("Each organization and service identity must have one unambiguous binding.");
    }
    tenants.add(tenantId); clients.add(entry.clientId);
    return Object.freeze({ tenantId, clientId: entry.clientId, clientSecret: entry.clientSecret });
  });
}

/** Call ONLY after ordinary signature/issuer/audience/azp verification. */
export function configuredOrganizationServiceAccount(
  claims: Record<string, unknown>,
  tenantId: string | null,
  identities = organizationServiceIdentities(),
): OrganizationServiceIdentity | undefined {
  const canonicalClaimTenantId = canonicalTenantId(tenantId);
  if (!canonicalClaimTenantId || typeof claims.sub !== "string" || !claims.sub) return undefined;
  return identities.find((entry) => canonicalTenantId(entry.tenantId) === canonicalClaimTenantId &&
    entry.clientId === claims.azp && claims.preferred_username === `service-account-${entry.clientId}`);
}

/** Credentials must never follow redirects or leave TLS except over loopback. */
export function serviceIdentityEndpoint(value: string | undefined, description: string): URL {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error(`${description} is not configured.`); }
  if (url.username || url.password || url.hash || url.search ||
    !(url.protocol === "https:" || (url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error(`${description} must use HTTPS, or HTTP on loopback only.`);
  }
  return url;
}
