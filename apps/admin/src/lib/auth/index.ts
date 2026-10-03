// SPDX-License-Identifier: BUSL-1.1
import {
  createKeycloakSettings,
  createSessionAuth,
  createSessionStore,
  resolveInitialRoles,
  validateProductionEnv,
} from "@openshapeforge/auth/session";
import "./types";
import { hasPlatformOperatorRole, operatorRefreshInvariant } from "./claims";

/**
 * The CONTROL realm, not the tenant realm: every default here names
 * `openshapeforge-control` and the `openshapeforge-admin-gateway` client
 * authored in `packages/compiler/config/authoring/authorization.control.yaml`.
 * Pointing this app at `/realms/openshapeforge` would let tenant users sign in
 * to the control plane, which is the exact thing the second realm exists to
 * prevent.
 */
const DEFAULT_ISSUER = "http://localhost:8181/realms/openshapeforge-control";

validateProductionEnv({
  defaultIssuer: DEFAULT_ISSUER,
  devDefaults: {
    AUTH_SECRET: [
      "dev-admin-auth-secret-change-in-production",
      "openshapeforge-local-dev-admin-auth-secret",
    ],
    NEXTAUTH_SECRET: [
      "dev-admin-auth-secret-change-in-production",
      "openshapeforge-local-dev-admin-auth-secret",
    ],
    // The `devSecret` the control realm authors for openshapeforge-admin-gateway.
    // Reaching production with this value means the realm was imported in its
    // dev shape, so refusing it here is refusing a realm, not just a string.
    AUTH_KEYCLOAK_SECRET: ["admin-dev-secret"],
  },
});

const keycloak = createKeycloakSettings({
  issuer: DEFAULT_ISSUER,
  clientId: "openshapeforge-admin-gateway",
  clientSecret: "admin-dev-secret",
  authSecret: "dev-admin-auth-secret-change-in-production",
});

// Own key and cookie prefixes: apps/web and apps/admin share one Redis and,
// on a developer machine, one `localhost` cookie jar.
const store = createSessionStore({ keyPrefix: "openshapeforge-admin", logTag: "admin-auth" });

const session = createSessionAuth({
  logTag: "admin-auth",
  cookiePrefix: "openshapeforge-admin",
  keycloak,
  store,
  /**
   * FIRST of the two authorization gates, and the one that matters most: a
   * user without `platform-operator` never gets a session cookie at all. The
   * second is `requireOperatorSession` in `src/lib/server/route-authz.ts`,
   * because a role revoked afterwards would otherwise ride an existing cookie
   * until it expired.
   */
  admit: ({ accessTokenClaims, idTokenClaims }) =>
    hasPlatformOperatorRole(resolveInitialRoles(accessTokenClaims, idTokenClaims, undefined)),
  initialFields: () => ({}),
  refreshInvariant: operatorRefreshInvariant,
  refreshedFields: () => ({}),
  // Resolved once, here, from the CURRENT stored roles, which token refresh
  // rewrites on every refresh — so no page has to remember the role name.
  sessionFields: (stored) => ({ isPlatformOperator: hasPlatformOperatorRole(stored.roles ?? []) }),
});

export const { auth, handlers, signIn, signOut } = session;
export const { deleteSession } = store;
export const keycloakLogoutUrl = keycloak.logoutUrl;
export { PLATFORM_OPERATOR_ROLE, hasPlatformOperatorRole } from "./claims";
export type { Session } from "next-auth";
