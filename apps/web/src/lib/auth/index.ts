// SPDX-License-Identifier: BUSL-1.1
import {
  createKeycloakSettings,
  createSessionAuth,
  createSessionStore,
  validateProductionEnv,
} from "@openshapeforge/auth/session";
import "./types";
import {
  hasApplicationTenantContext,
  initialTenantFields,
  refreshedTenantFields,
  tenantRefreshInvariant,
  type TenantSessionFields,
} from "./claims";

const DEFAULT_ISSUER = "http://localhost:8181/realms/openshapeforge";

validateProductionEnv({
  defaultIssuer: DEFAULT_ISSUER,
  devDefaults: {
    AUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
    NEXTAUTH_SECRET: ["dev-auth-secret-change-in-production", "dev-auth-secret-change-me"],
    AUTH_KEYCLOAK_SECRET: ["dev-secret"],
  },
  // These map a dev user's tenant alias onto a real tenant uuid; production
  // has no such alias.
  forbiddenEnvVars: [
    "OPENSHAPEFORGE_DEV_TENANT_ID",
    "OPENSHAPEFORGE_DEV_USER_ID",
    "OPENSHAPEFORGE_DEV_USER_ROLES",
  ],
});

const keycloak = createKeycloakSettings({
  issuer: DEFAULT_ISSUER,
  clientId: "openshapeforge-gateway",
  clientSecret: "dev-secret",
  authSecret: "dev-auth-secret-change-in-production",
});

const store = createSessionStore<TenantSessionFields>({
  keyPrefix: "openshapeforge",
  logTag: "auth",
});

const session = createSessionAuth<TenantSessionFields>({
  logTag: "auth",
  cookiePrefix: "openshapeforge",
  keycloak,
  store,
  admit: ({ profile, accessTokenClaims, idTokenClaims }) =>
    hasApplicationTenantContext(profile, accessTokenClaims, idTokenClaims),
  initialFields: initialTenantFields,
  refreshInvariant: tenantRefreshInvariant,
  refreshedFields: refreshedTenantFields,
  sessionFields: (stored) => ({
    tenantId: stored.tenantId ?? "",
    actorType: stored.actorType ?? "",
    groups: stored.groups ?? [],
  }),
});

export const { auth, handlers, signIn, signOut } = session;
export const { deleteSession } = store;
export const keycloakLogoutUrl = keycloak.logoutUrl;
export type { Session } from "next-auth";
