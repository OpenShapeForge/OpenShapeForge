// SPDX-License-Identifier: BUSL-1.1
import { ControlAuthorizationError } from "./authorization.js";
import type { ControlPlaneConfig } from "./config.js";

export type HostOperatorAuthority = "tenant-realm-admin" | "dedicated-control-realm";

function safeRealm(realm: string): boolean {
  return Boolean(realm) && realm.toLowerCase() !== "master" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(realm);
}

/**
 * Host administration may authenticate in the managed tenant realm itself or
 * in one dedicated control realm on the same Keycloak origin. The former must
 * prove Keycloak's built-in realm-admin role; the latter must prove OSF's
 * deliberately narrow platform-operator role. In both cases the API reaches
 * the tenant realm through its own SPI service account, never by forwarding
 * the interactive operator token.
 */
export function assertHostRealm(config: ControlPlaneConfig): HostOperatorAuthority {
  const tenantRealm = config.keycloak.tenantRealm;
  if (!safeRealm(tenantRealm)) {
    throw new ControlAuthorizationError("FORBIDDEN", "Host realm administration is not configured safely.");
  }

  let base: URL;
  let issuer: URL;
  try {
    base = new URL(config.keycloak.baseUrl);
    issuer = new URL(config.operator.issuer);
  } catch {
    throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer.");
  }
  if (base.pathname !== "/" || base.search || base.hash || issuer.origin !== base.origin ||
      issuer.search || issuer.hash) {
    throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer.");
  }

  const prefix = "/realms/";
  if (!issuer.pathname.startsWith(prefix) || issuer.pathname.slice(prefix.length).includes("/")) {
    throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer.");
  }
  let operatorRealm: string;
  try { operatorRealm = decodeURIComponent(issuer.pathname.slice(prefix.length)); }
  catch { throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer."); }
  if (!safeRealm(operatorRealm) || issuer.pathname !== `${prefix}${encodeURIComponent(operatorRealm)}`) {
    throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer.");
  }
  return operatorRealm === tenantRealm ? "tenant-realm-admin" : "dedicated-control-realm";
}

/** Only the built-in client role qualifies; similarly named realm roles do not. */
export function hasKeycloakRealmAdmin(claims: Record<string, unknown>): boolean {
  const access = claims.resource_access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return false;
  const management = (access as Record<string, unknown>)["realm-management"];
  if (!management || typeof management !== "object" || Array.isArray(management)) return false;
  const roles = (management as Record<string, unknown>).roles;
  return Array.isArray(roles) && roles.includes("realm-admin");
}
