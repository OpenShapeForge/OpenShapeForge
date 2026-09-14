// SPDX-License-Identifier: BUSL-1.1
import { ControlAuthorizationError } from "./authorization.js";
import type { ControlPlaneConfig } from "./config.js";

/** Host administration never crosses the configured identity realm. */
export function assertHostRealm(config: ControlPlaneConfig): void {
  const realm = config.keycloak.tenantRealm;
  if (!realm || realm === "master" || realm === "." || realm === "..") {
    throw new ControlAuthorizationError("FORBIDDEN", "Host realm administration is not configured safely.");
  }
  const expectedIssuer = `${config.keycloak.baseUrl.replace(/\/$/, "")}/realms/${encodeURIComponent(realm)}`;
  if (config.operator.issuer !== expectedIssuer) {
    throw new ControlAuthorizationError("FORBIDDEN", "Host administration requires the host realm issuer.");
  }
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
