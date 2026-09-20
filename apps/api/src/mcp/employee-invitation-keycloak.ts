// SPDX-License-Identifier: BUSL-1.1
/**
 * The lazily built Keycloak client the employee invitation tools use.
 * Split out of generated-mcp-server.ts.
 */
// ---- employee invitations: lazy Keycloak client ----
// Built once, from the tenant control plane's own configuration
// (control/config.ts) — the SAME service account and realm `invite_employee`
// needs is already required for tenant provisioning, so this reads no new
// environment. `undefined` when that configuration is absent (an existing
// deployment that never set it up), in which case the tool answers
// CONTROL_PLANE_NOT_CONFIGURED rather than throwing at server-build time —
// consistent with how the control Operations stay bound and answer 503 by
// name instead of refusing to start.
import { readControlPlaneConfig } from "../control/config.js";
import { createServiceAccountTokenProvider } from "../control/keycloak-service-account.js";
import {
  createKeycloakOrganizationMembersClient,
  type KeycloakOrganizationMembersClient,
} from "../control/keycloak-organization-members.js";
import { KeycloakAdminError } from "../control/keycloak-organization-admin.js";
let cachedEmployeeInvitationKeycloak: KeycloakOrganizationMembersClient | undefined | null = null;
export function employeeInvitationKeycloakClient(): KeycloakOrganizationMembersClient | undefined {
  if (cachedEmployeeInvitationKeycloak !== null) return cachedEmployeeInvitationKeycloak;
  const configResult = readControlPlaneConfig();
  if (!configResult.ok) {
    cachedEmployeeInvitationKeycloak = undefined;
    return undefined;
  }
  const tokens = createServiceAccountTokenProvider(configResult.config.keycloak, {
    unauthorized: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
    unavailable: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
  });
  cachedEmployeeInvitationKeycloak = createKeycloakOrganizationMembersClient(
    configResult.config.keycloak,
    { tokens },
  );
  return cachedEmployeeInvitationKeycloak;
}
/** Test-only: force the next call to re-read configuration. */
export function __resetEmployeeInvitationKeycloakClientForTests(): void {
  cachedEmployeeInvitationKeycloak = null;
}
