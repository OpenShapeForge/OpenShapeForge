// SPDX-License-Identifier: BUSL-1.1
import type { NextRequest } from "next/server";
import { auth, handlers } from "@/lib/auth";
import {
  authCookieNames,
  keycloakClientId,
  keycloakClientSecret,
  keycloakServerLogoutUrl,
} from "@/lib/auth/auth/keycloak";
import {
  handleLogoutRequest,
  resolveCanonicalAppOrigin,
  revokeKeycloakRefreshSession,
} from "@/lib/auth/auth/logout";
import { consumeSessionForLogout } from "@/lib/auth/redis";

const transientCookieNames = [
  authCookieNames.callbackUrl,
  authCookieNames.csrfToken,
  authCookieNames.pkceCodeVerifier,
  authCookieNames.state,
  authCookieNames.nonce,
] as const;

export async function POST(request: NextRequest): Promise<Response> {
  return handleLogoutRequest(request, {
    appOrigin: resolveCanonicalAppOrigin(
      process.env.AUTH_URL ?? process.env.NEXTAUTH_URL,
    ),
    authPost: handlers.POST,
    getAuthenticatedSession: auth,
    consumeSession: consumeSessionForLogout,
    revokeRefreshSession: (refreshToken) => revokeKeycloakRefreshSession({
      endpoint: keycloakServerLogoutUrl,
      clientId: keycloakClientId,
      clientSecret: keycloakClientSecret,
      refreshToken,
    }),
    transientCookieNames,
    secureCookies: process.env.AUTH_COOKIE_SECURE === "true",
    onLocalFailure: () => {
      console.error("[auth:logout] Local session revocation did not complete.");
    },
    onRevocationFailure: () => {
      console.warn("[auth:logout] Identity-provider revocation did not complete.");
    },
  });
}
