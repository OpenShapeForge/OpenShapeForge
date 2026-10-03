// SPDX-License-Identifier: BUSL-1.1
/** Closed managed-process tenant command. No caller token or runtime factory escapes. */
import { sql } from "kysely";
import { createDatabaseRuntime, readMigrateDatabaseUrl, type OpenShapeForgeDatabase } from "../db/connection.js";
import { createServiceAccountTokenProvider, type KeycloakServiceAccountConfig } from "./keycloak-service-account.js";
import { createKeycloakSpiClient } from "./keycloak-spi-client.js";
import { createKeycloakOrganizationAdminClient } from "./keycloak-organization-admin.js";
import { createOrganizationScopeAdminClient } from "./organization-scopes.js";
import { rootOrganizationIdentifiers, assertDisplayName } from "./organization-naming.js";
import { provisionTenant } from "./provisioning.js";
import { getTenant } from "./tenant-registry.js";

type Request = { action: "get" | "provision"; tenant: string; name?: string; confirmed: boolean };
type Configuration = { keycloak: KeycloakServiceAccountConfig; mcpResource: { origins: string[]; clients: string[] }; database: string; role: string };
function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Managed maintenance requires HTTPS origins.");
  return url.origin;
}
export function readManagedMaintenanceConfiguration(env: NodeJS.ProcessEnv): Configuration {
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error("Managed maintenance configuration is incomplete."); return value; };
  const list = (key: string) => [...new Set((env[key] ?? "").split(",").map(v => v.trim()).filter(Boolean))];
  const origins = [origin(required("OPENSHAPEFORGE_PUBLIC_ORIGIN")), ...list("OPENSHAPEFORGE_MCP_RESOURCE_ORIGINS").map(origin)];
  const clients = list("OPENSHAPEFORGE_MCP_CLIENTS"); if (!clients.length) throw new Error("Managed maintenance resource clients are required.");
  const realm = required("OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM");
  const clientId = required("OPENSHAPEFORGE_CONTROL_KEYCLOAK_CLIENT_ID");
  if (realm.toLowerCase() === "master" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(realm) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(clientId)) throw new Error("Managed maintenance realm/client configuration is invalid.");
  return { keycloak: {
    baseUrl: origin(required("OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL")),
    ...(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_CONNECT_URL ? { connectUrl: origin(env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_CONNECT_URL) } : {}),
    tenantRealm: realm,
    clientId,
    clientSecret: required("KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API"),
  }, mcpResource: { origins: [...new Set(origins)], clients }, database: required("OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE"), role: required("OPENSHAPEFORGE_MAINTENANCE_EXPECTED_DATABASE_ROLE") };
}
/** Internal injectable owner harness; production only enters through the closed CLI. */
export async function runManagedTenantMaintenance(request: Request, config: Configuration, db: OpenShapeForgeDatabase, fetchImplementation?: typeof fetch): Promise<unknown> {
  if (!request.confirmed || !["get", "provision"].includes(request.action) || !/^[a-z][a-z0-9-]*$/.test(request.tenant)) throw new Error("Explicit managed maintenance confirmation and a valid request are required.");
  const identity = (await sql<{ database: string; role: string; session_role: string }>`select current_database() as database, current_user as role, session_user as session_role`.execute(db)).rows[0];
  if (!identity || identity.database !== config.database || identity.role !== config.role || identity.session_role !== config.role) throw new Error("Managed maintenance database boundary mismatch.");
  const tokens = createServiceAccountTokenProvider(config.keycloak, { ...(fetchImplementation ? { fetch: fetchImplementation } : {}), unauthorized: () => new Error("Managed service authentication refused."), unavailable: () => new Error("Managed service unavailable.") });
  // Trusted only because this was obtained by this owner from the pinned TLS endpoint.
  const token = await tokens.get();
  let claims: { azp?: unknown; sub?: unknown; iss?: unknown };
  try { claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()); } catch { throw new Error("Managed service identity is invalid."); }
  if (claims.azp !== config.keycloak.clientId || typeof claims.sub !== "string" || !claims.sub || claims.iss !== `${config.keycloak.baseUrl}/realms/${config.keycloak.tenantRealm}`) throw new Error("Managed service identity mismatch.");
  const options = { tokens, ...(fetchImplementation ? { fetch: fetchImplementation } : {}) };
  const deps = { db, tenantRealm: config.keycloak.tenantRealm, operator: { subject: claims.sub, issuer: claims.iss as string, username: undefined }, keycloak: createKeycloakSpiClient(config.keycloak, options), keycloakAdmin: createKeycloakOrganizationAdminClient(config.keycloak, options), organizationScopes: createOrganizationScopeAdminClient(config.keycloak, options), mcpResource: config.mcpResource };
  let existing;
  try { existing = await getTenant(deps, request.tenant); }
  catch (error) { if ((error as { code?: string }).code !== "CONTROL_TENANT_NOT_FOUND") throw error; }
  if (request.action === "get") return existing ?? null;
  const boundId = existing?.tenant.keycloakOrganizationId;
  const name = request.name ?? existing?.tenant.name ?? request.tenant;
  assertDisplayName(name, "name");
  const checkedCreate = async (input: Parameters<typeof deps.keycloak.createOrganization>[0]) => {
    const organization = await deps.keycloak.createOrganization(input);
    if (organization.alias !== request.tenant || (boundId && organization.id !== boundId)) throw new Error("Existing organization binding must not be replaced.");
    return organization;
  };
  // Already-bound managed tenants must refuse BEFORE registry/name/group writes.
  // The SPI upsert can have provider effects; this is not distributed atomicity.
  const identifiers = rootOrganizationIdentifiers(request.tenant);
  const checked = boundId ? await checkedCreate({ alias: identifiers.alias, name: identifiers.name, organizationLevel: "root", organizationPath: identifiers.organizationPath }) : undefined;
  return provisionTenant({ ...deps, keycloak: { createOrganization: async input => checked ?? checkedCreate(input) } }, { slug: request.tenant, name });
}

if (import.meta.main) {
  let runtime;
  try {
    const args = process.argv.slice(2); const values = new Map<string, string>(); let confirmed = false;
    while (args.length) { const key = args.shift()!; if (key === "--confirm-managed-maintenance" && !confirmed) { confirmed = true; continue; } if (!["--action", "--tenant", "--name"].includes(key) || values.has(key) || !args.length) throw new Error("Invalid managed maintenance arguments."); values.set(key, args.shift()!); }
    const config = readManagedMaintenanceConfiguration(process.env);
    const request = { action: values.get("--action") as Request["action"], tenant: values.get("--tenant") ?? "", ...(values.has("--name") ? { name: values.get("--name")! } : {}), confirmed };
    if (!confirmed) throw new Error("Managed maintenance confirmation is required.");
    runtime = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl(), maxConnections: 1 });
    const result = await runManagedTenantMaintenance(request, config, runtime.db);
    console.log(JSON.stringify(result));
  } catch { console.error("Managed tenant maintenance failed; provider responses and credentials are not logged."); process.exitCode = 1; }
  finally { await runtime?.close(); }
}
