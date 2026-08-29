// SPDX-License-Identifier: BUSL-1.1
import { parseUserProfile, readJwtClaims } from "@openshapeforge/auth";
import NextAuth from "next-auth";
import "../types";
import { getSession, setSession } from "../redis";
import type { StoredSession } from "../redis";
import {
  decodeJwtExp,
  hasPlatformOperatorRole,
  resolveInitialRoles,
} from "./claims";
import {
  authCookieNames,
  authSecret,
  oauthFlowSameSite,
  providers,
  strictSameSite,
} from "./keycloak";
import {
  ACCESS_TOKEN_REFRESH_BUFFER_S,
  refreshSessionInRedis,
} from "./token-refresh";
import { hydrateStoredSessionProfile } from "./session-hydration";

const secureCookies = process.env.AUTH_COOKIE_SECURE === "true";

const { handlers, signIn, auth: nextAuth } = NextAuth({
  trustHost: true,
  secret: authSecret,
  providers,
  callbacks: {
    /**
     * FIRST of the two authorization gates, and the one that matters most: it
     * runs before any session exists, so a user without `platform-operator`
     * never gets a session cookie at all. NextAuth turns the `false` into
     * `/login?error=AccessDenied`.
     *
     * This is why the control realm ships a `platform-noaccess` user: without
     * an authenticated-but-unauthorized identity there is no way to tell "the
     * control plane checks the role" from "the control plane lets in anyone who
     * can reach the login page".
     *
     * The second gate is `requireOperatorSession` in
     * `src/lib/server/route-authz.ts`. It is not redundant — this callback runs
     * once, at sign-in, and a role revoked afterwards would otherwise ride an
     * existing cookie until it expired.
     */
    async signIn({ account }) {
      const accessTokenClaims = readJwtClaims(account?.access_token as string | undefined);
      const idTokenClaims = readJwtClaims(account?.id_token as string | undefined);
      const roles = resolveInitialRoles(accessTokenClaims, idTokenClaims, undefined);

      return hasPlatformOperatorRole(roles);
    },

    async jwt({ token, account, profile }) {
      if (account) {
        const prof = profile as Record<string, unknown> | undefined;
        const accessTokenClaims = readJwtClaims(account.access_token as string | undefined);
        const idTokenClaims = readJwtClaims(account.id_token as string | undefined);
        const roles = resolveInitialRoles(accessTokenClaims, idTokenClaims, prof);
        const storedUserProfile = parseUserProfile({
          sub: token.sub,
          profile: prof,
          idTokenClaims,
          accessTokenClaims,
        });

        const nowS = Math.floor(Date.now() / 1000);
        const expiresAt = account.expires_at;

        // Prefer the refresh token's own exp claim when available.
        const refreshTokenExpiresAt = decodeJwtExp(account.refresh_token as string | undefined);
        const refreshExpiresAt = refreshTokenExpiresAt
          ?? (expiresAt
            ? nowS + Math.max((expiresAt - nowS) * 6, 1800)
            : nowS + 1800);

        // No tenantId / actorType / groups: see the header of ../types.ts.
        const stored: StoredSession = {
          sub: token.sub,
          name: storedUserProfile.name,
          givenName: storedUserProfile.givenName,
          familyName: storedUserProfile.familyName,
          preferredUsername: storedUserProfile.preferredUsername,
          email: storedUserProfile.email,
          accessToken: account.access_token as string,
          idToken: account.id_token as string | undefined,
          refreshToken: account.refresh_token as string | undefined,
          expiresAt,
          refreshExpiresAt,
          roles,
        };

        const sessionId = crypto.randomUUID();
        await setSession(sessionId, stored);

        return { sessionId };
      }

      if (token.error === "RefreshTokenError") {
        return token;
      }

      const { sessionId } = token;
      if (!sessionId) {
        return { ...token, error: "RefreshTokenError" };
      }

      if (typeof sessionId !== "string") {
        return { ...token, error: "RefreshTokenError" };
      }

      const stored = await getSession(sessionId);
      if (!stored) {
        return { sessionId, error: "RefreshTokenError" };
      }

      if (stored.error === "RefreshTokenError") {
        return { sessionId, error: "RefreshTokenError" };
      }

      if (stored.expiresAt) {
        const nowS = Math.floor(Date.now() / 1000);
        const secondsUntilExpiry = stored.expiresAt - nowS;
        if (secondsUntilExpiry > ACCESS_TOKEN_REFRESH_BUFFER_S) {
          return token;
        }
      }

      if (!stored.refreshToken) {
        return { sessionId, error: "RefreshTokenError" };
      }

      const refreshed = await refreshSessionInRedis(sessionId, stored);
      if (refreshed.error === "RefreshTokenError") {
        return { sessionId, error: "RefreshTokenError" };
      }

      return token;
    },

    async session({ session, token }) {
      if (token.error === "RefreshTokenError") {
        if (typeof token.sessionId === "string") {
          session.sessionId = token.sessionId;
        }
        session.error = "RefreshTokenError";
        return session;
      }

      const rawSessionId = token.sessionId;
      if (typeof rawSessionId !== "string") {
        session.error = "RefreshTokenError";
        return session;
      }
      const sessionId = rawSessionId;

      let stored = await getSession(sessionId);
      if (!stored || stored.error === "RefreshTokenError") {
        session.error = "RefreshTokenError";
        return session;
      }

      stored = await hydrateStoredSessionProfile(sessionId, stored);
      if (!stored || stored.error === "RefreshTokenError") {
        session.error = "RefreshTokenError";
        return session;
      }

      const roles = stored.roles ?? [];

      session.sessionId = sessionId;
      session.sub = stored.sub ?? "";
      session.accessToken = stored.accessToken ?? "";
      session.idToken = stored.idToken ?? "";
      session.roles = roles;
      // Resolved once, here, so no page has to remember the role name — and so
      // that "is this operator authorized" is answered from the CURRENT stored
      // roles, which token-refresh rewrites on every refresh.
      session.isPlatformOperator = hasPlatformOperatorRole(roles);
      session.expiresAt = stored.expiresAt;
      session.refreshExpiresAt = stored.refreshExpiresAt;
      session.user = {
        ...session.user,
        id: stored.sub ?? "",
        name: stored.name,
        email: stored.email ?? session.user?.email ?? "",
        givenName: stored.givenName,
        familyName: stored.familyName,
        preferredUsername: stored.preferredUsername,
      };
      return session;
    },
  },
  // Cookie names are prefixed per-app — see cookieName() in ./keycloak.ts for
  // why sharing apps/web's names on localhost would break both apps.
  cookies: {
    sessionToken: {
      name: authCookieNames.sessionToken,
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: secureCookies,
        domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
      },
    },
    callbackUrl: {
      name: authCookieNames.callbackUrl,
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: secureCookies,
      },
    },
    csrfToken: {
      name: authCookieNames.csrfToken,
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: secureCookies,
      },
    },
    pkceCodeVerifier: {
      name: authCookieNames.pkceCodeVerifier,
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: secureCookies,
      },
    },
    state: {
      name: authCookieNames.state,
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: secureCookies,
      },
    },
    nonce: {
      name: authCookieNames.nonce,
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: secureCookies,
      },
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});

function shouldTreatAsMissingSession(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const authCause = (error as Error & { cause?: { name?: string; message?: string } }).cause;
  const errorMessage = error.message ?? "";
  const causeMessage = authCause?.message ?? "";
  return (
    error.name === "JWTSessionError"
    || errorMessage.includes("JWTSessionError")
    || errorMessage.includes("no matching decryption secret")
    || authCause?.name === "JWEDecryptionFailed"
    || causeMessage.includes("no matching decryption secret")
  );
}

export async function auth() {
  try {
    return await nextAuth();
  } catch (error) {
    if (shouldTreatAsMissingSession(error)) {
      console.warn(
        "[admin-auth] Discarding unreadable session cookie and treating request as signed out.",
      );
      return null;
    }
    throw error;
  }
}

export { handlers, signIn };
