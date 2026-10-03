// SPDX-License-Identifier: BUSL-1.1
import Keycloak from "next-auth/providers/keycloak";

export type KeycloakDefaults = {
  /** Browser-facing issuer when AUTH_KEYCLOAK_ISSUER is unset: the app's realm. */
  issuer: string;
  /** Client id when AUTH_KEYCLOAK_ID is unset. */
  clientId: string;
  /** The realm's authored dev secret when AUTH_KEYCLOAK_SECRET is unset. */
  clientSecret: string;
  /** NextAuth session encryption secret when AUTH_SECRET / NEXTAUTH_SECRET are unset. */
  authSecret: string;
};

export type KeycloakSettings = {
  /** Browser-facing issuer: `iss` validation and browser redirects. */
  issuer: string;
  /** Server-facing issuer: OIDC discovery and token exchange from inside the network. */
  issuerInternal: string;
  clientId: string;
  clientSecret: string;
  authSecret: string;
  logoutUrl: string;
  providers: ReturnType<typeof Keycloak>[];
};

/**
 * Resolve the Keycloak client settings from the environment, falling back to
 * the app's own dev defaults. Which realm and client those defaults name is
 * the app's decision: pointing a control-plane app at the tenant realm would
 * let tenant users into the control plane, which is exactly what a second
 * realm exists to prevent.
 */
export function createKeycloakSettings(defaults: KeycloakDefaults): KeycloakSettings {
  const issuer = process.env.AUTH_KEYCLOAK_ISSUER ?? defaults.issuer;
  const issuerInternal = process.env.AUTH_KEYCLOAK_ISSUER_INTERNAL ?? issuer;
  const clientId = process.env.AUTH_KEYCLOAK_ID ?? defaults.clientId;
  const clientSecret = process.env.AUTH_KEYCLOAK_SECRET ?? defaults.clientSecret;
  const authSecret =
    process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? defaults.authSecret;
  return {
    issuer,
    issuerInternal,
    clientId,
    clientSecret,
    authSecret,
    logoutUrl: `${issuer}/protocol/openid-connect/logout`,
    providers: [
      Keycloak({
        clientId,
        clientSecret,
        issuer,
        authorization: {
          url: `${issuer}/protocol/openid-connect/auth`,
          params: { scope: "openid profile email" },
        },
        token: `${issuer}/protocol/openid-connect/token`,
        userinfo: `${issuer}/protocol/openid-connect/userinfo`,
      }),
    ],
  };
}
