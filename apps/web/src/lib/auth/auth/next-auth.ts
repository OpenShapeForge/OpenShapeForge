// SPDX-License-Identifier: BUSL-1.1
import { parseUserProfile, readJwtClaims } from "@openshapeforge/auth";
import NextAuth from "next-auth";
import "../types";
import { getSession, setSession } from "../redis";
import type { StoredSession } from "../redis";
import {
  decodeJwtExp,
  hasApplicationRealmRole,
  mergeUserProfileIntoStoredSession,
  resolveInitialActorType,
  resolveInitialGroups,
  resolveInitialRoles,
  resolveInitialTenantId,
} from "./claims";
import {
  authSecret,
  oauthFlowSameSite,
  providers,
  strictSameSite,
} from "./keycloak";
import {
  ACCESS_TOKEN_REFRESH_BUFFER_S,
  refreshSessionInRedis,
} from "./token-refresh";

const { handlers, signIn, signOut, auth: nextAuth } = NextAuth({
  trustHost: true,
  secret: authSecret,
  providers,
  callbacks: {
    async signIn({ account }) {
      const accessTokenClaims = readJwtClaims(account?.access_token as string | undefined);
      const idTokenClaims = readJwtClaims(account?.id_token as string | undefined);
      const roles = resolveInitialRoles(accessTokenClaims, idTokenClaims, undefined);

      return hasApplicationRealmRole(roles);
    },

    async jwt({ token, account, profile }) {
      if (account) {
        const prof = profile as Record<string, unknown> | undefined;
        const accessTokenClaims = readJwtClaims(account.access_token as string | undefined);
        const idTokenClaims = readJwtClaims(account.id_token as string | undefined);
        const roles = resolveInitialRoles(accessTokenClaims, idTokenClaims, prof);
        const tenantId = resolveInitialTenantId(prof, accessTokenClaims, idTokenClaims);
        const groups = resolveInitialGroups(accessTokenClaims, idTokenClaims, prof, tenantId, roles);
        const actorType = resolveInitialActorType(tenantId, prof, accessTokenClaims, idTokenClaims);
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
          tenantId,
          actorType,
          roles,
          groups,
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

      const hydratedUserProfile = parseUserProfile({
        sub: stored.sub,
        stored,
        idTokenClaims: readJwtClaims(stored.idToken),
        accessTokenClaims: readJwtClaims(stored.accessToken),
      });
      const hydratedStored = mergeUserProfileIntoStoredSession(stored, hydratedUserProfile);
      if (
        hydratedStored.name !== stored.name ||
        hydratedStored.givenName !== stored.givenName ||
        hydratedStored.familyName !== stored.familyName ||
        hydratedStored.preferredUsername !== stored.preferredUsername ||
        hydratedStored.email !== stored.email
      ) {
        await setSession(sessionId, hydratedStored);
        stored = hydratedStored;
      }

      session.sessionId = sessionId;
      session.sub = stored.sub ?? "";
      session.accessToken = stored.accessToken ?? "";
      session.idToken = stored.idToken ?? "";
      session.tenantId = stored.tenantId ?? "";
      session.actorType = stored.actorType ?? "";
      session.roles = stored.roles ?? [];
      session.groups = stored.groups ?? [];
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
  cookies: {
    sessionToken: {
      name: "openshapeforge.session-token",
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
        domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
      },
    },
    callbackUrl: {
      name: "openshapeforge.callback-url",
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
      },
    },
    csrfToken: {
      name: "openshapeforge.csrf-token",
      options: {
        httpOnly: true,
        sameSite: strictSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
      },
    },
    pkceCodeVerifier: {
      name: "openshapeforge.pkce.code_verifier",
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
      },
    },
    state: {
      name: "openshapeforge.state",
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
      },
    },
    nonce: {
      name: "openshapeforge.nonce",
      options: {
        httpOnly: true,
        sameSite: oauthFlowSameSite,
        path: "/",
        secure: process.env.AUTH_COOKIE_SECURE === "true",
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
        "[auth] Discarding unreadable session cookie and treating request as signed out.",
      );
      return null;
    }
    throw error;
  }
}

export { handlers, signIn, signOut };
