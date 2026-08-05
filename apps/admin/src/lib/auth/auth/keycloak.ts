// SPDX-License-Identifier: BUSL-1.1
import Keycloak from "next-auth/providers/keycloak";
import { validateProductionEnv } from "../validate-env";

validateProductionEnv();

/**
 * Browser-facing issuer: used for `iss` validation and browser redirects.
 *
 * The CONTROL realm, not the tenant realm. Every default in this file points at
 * `openshapeforge-control` and at the `openshapeforge-admin-gateway` client
 * authored in `packages/compiler/config/authoring/authorization.control.yaml`.
 * Pointing this app at `/realms/openshapeforge` would let tenant users sign in
 * to the control plane, which is the exact thing the second realm exists to
 * prevent.
 */
export const issuer =
  process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:8181/realms/openshapeforge-control";

// Server-facing issuer: used for OIDC discovery and token exchange from Docker.
export const issuerInternal = process.env.AUTH_KEYCLOAK_ISSUER_INTERNAL ?? issuer;

/** Matches the control realm's dev `devSecret`; production must set AUTH_KEYCLOAK_SECRET. */
export const keycloakClientSecret =
  process.env.AUTH_KEYCLOAK_SECRET ?? "admin-dev-secret";

export const keycloakClientId =
  process.env.AUTH_KEYCLOAK_ID ?? "openshapeforge-admin-gateway";

/** NextAuth session encryption; production requires env via validateProductionEnv. */
export const authSecret =
  process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? "dev-admin-auth-secret-change-in-production";

export const keycloakLogoutUrl = `${issuer}/protocol/openid-connect/logout`;

export const strictSameSite = "strict" as const;
export const oauthFlowSameSite = "lax" as const;

/**
 * Cookie name prefix. NOT cosmetic, and NOT the same as apps/web's.
 *
 * Cookies are scoped by host, NOT by port: on a developer machine apps/web
 * (:3000) and apps/admin (:3002) are both `localhost` and share one cookie jar.
 * Reusing apps/web's `openshapeforge.*` names would mean each app's sign-in
 * silently overwrites the other's session cookie, and each app would then try
 * to decrypt a cookie minted for a different realm with a different AUTH_SECRET.
 * Distinct names keep the two sessions side by side.
 */
const COOKIE_PREFIX = "openshapeforge-admin";

export const cookieName = (suffix: string) => `${COOKIE_PREFIX}.${suffix}`;

export const providers = [
  Keycloak({
    clientId: keycloakClientId,
    clientSecret: keycloakClientSecret,
    issuer,
    authorization: {
      url: `${issuer}/protocol/openid-connect/auth`,
      params: { scope: "openid profile email" },
    },
    token: `${issuer}/protocol/openid-connect/token`,
    userinfo: `${issuer}/protocol/openid-connect/userinfo`,
  }),
];
