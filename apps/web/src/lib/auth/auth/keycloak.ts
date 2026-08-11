// SPDX-License-Identifier: BUSL-1.1
import Keycloak from "next-auth/providers/keycloak";
import { validateProductionEnv } from "../validate-env";

validateProductionEnv();

// Browser-facing issuer: used for `iss` validation and browser redirects.
export const issuer =
  process.env.AUTH_KEYCLOAK_ISSUER ?? "http://localhost:8181/realms/openshapeforge";

// Server-facing issuer: used for OIDC discovery and token exchange from Docker.
export const issuerInternal = process.env.AUTH_KEYCLOAK_ISSUER_INTERNAL ?? issuer;

/** Matches local Keycloak dev realm; production must set AUTH_KEYCLOAK_SECRET. */
export const keycloakClientSecret =
  process.env.AUTH_KEYCLOAK_SECRET ?? "dev-secret";

export const keycloakClientId =
  process.env.AUTH_KEYCLOAK_ID ?? "openshapeforge-gateway";

/** NextAuth session encryption; production requires env via validateProductionEnv. */
export const authSecret =
  process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? "dev-auth-secret-change-in-production";

export const keycloakLogoutUrl = `${issuer}/protocol/openid-connect/logout`;
export const keycloakServerLogoutUrl = `${issuerInternal}/protocol/openid-connect/logout`;

export const authCookieNames = {
  sessionToken: "openshapeforge.session-token",
  callbackUrl: "openshapeforge.callback-url",
  csrfToken: "openshapeforge.csrf-token",
  pkceCodeVerifier: "openshapeforge.pkce.code_verifier",
  state: "openshapeforge.state",
  nonce: "openshapeforge.nonce",
} as const;

export const strictSameSite = "strict" as const;
export const oauthFlowSameSite = "lax" as const;

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
