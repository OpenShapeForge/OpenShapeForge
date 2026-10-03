// SPDX-License-Identifier: BUSL-1.1
import NextAuth, { type Session } from "next-auth";
import { parseUserProfile, readJwtClaims } from "../claims.js";
import "./types.js";
import {
  decodeJwtExp,
  mergeUserProfileIntoStoredSession,
  resolveInitialRoles,
  type JwtClaims,
} from "./claims.js";
import type { KeycloakSettings } from "./keycloak.js";
import type { SessionStore, StoredSession } from "./store.js";
import {
  ACCESS_TOKEN_REFRESH_BUFFER_S,
  createTokenRefresh,
  type TokenRefresh,
  type TokenRefreshOptions,
} from "./token-refresh.js";

export type SignInClaims = {
  profile: JwtClaims | undefined;
  accessTokenClaims: JwtClaims | undefined;
  idTokenClaims: JwtClaims | undefined;
};

export type SessionAuthOptions<Extra extends object> = {
  /** Log tag: `auth` prefixes lines with `[auth]`. */
  logTag: string;
  /**
   * Cookie name prefix. Cookies are scoped by host, not by port, so two apps on
   * one developer machine share a cookie jar; distinct prefixes keep their
   * sessions side by side instead of each sign-in overwriting the other's.
   */
  cookiePrefix: string;
  keycloak: KeycloakSettings;
  store: SessionStore<Extra>;
  /**
   * Whether an authenticated identity may enter this app at all. Runs before
   * any session exists, so a refused identity never gets a session cookie;
   * NextAuth turns `false` into `/login?error=AccessDenied`.
   */
  admit(claims: SignInClaims): boolean;
  /** The app's own stored fields, derived once at sign-in. */
  initialFields(claims: SignInClaims): Extra;
  /** The app's own fields projected onto the NextAuth session on every read. */
  sessionFields(stored: StoredSession<Extra>): Record<string, unknown>;
} & Pick<TokenRefreshOptions<Extra>, "refreshInvariant" | "refreshedFields">;

export type SessionAuth<Extra extends object> = {
  handlers: ReturnType<typeof NextAuth>["handlers"];
  signIn: ReturnType<typeof NextAuth>["signIn"];
  signOut: ReturnType<typeof NextAuth>["signOut"];
  /** Like NextAuth's `auth()`, but an unreadable session cookie reads as signed out. */
  auth(): Promise<Session | null>;
  refresh: TokenRefresh<Extra>;
};

const strictSameSite = "strict" as const;
const oauthFlowSameSite = "lax" as const;

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

export function createSessionAuth<Extra extends object>(
  options: SessionAuthOptions<Extra>,
): SessionAuth<Extra> {
  const { store, keycloak } = options;
  const refresh = createTokenRefresh<Extra>({
    logTag: options.logTag,
    keycloak,
    store,
    refreshInvariant: options.refreshInvariant,
    refreshedFields: options.refreshedFields,
  });
  const cookieName = (suffix: string) => `${options.cookiePrefix}.${suffix}`;
  const secureCookies = process.env.AUTH_COOKIE_SECURE === "true";

  const { handlers, signIn, signOut, auth: nextAuth } = NextAuth({
    trustHost: true,
    secret: keycloak.authSecret,
    providers: keycloak.providers,
    callbacks: {
      async signIn({ account, profile }) {
        return options.admit({
          profile: profile as JwtClaims | undefined,
          accessTokenClaims: readJwtClaims(account?.access_token as string | undefined),
          idTokenClaims: readJwtClaims(account?.id_token as string | undefined),
        });
      },

      async jwt({ token, account, profile }) {
        if (account) {
          const prof = profile as JwtClaims | undefined;
          const accessTokenClaims = readJwtClaims(account.access_token as string | undefined);
          const idTokenClaims = readJwtClaims(account.id_token as string | undefined);
          const claims: SignInClaims = { profile: prof, accessTokenClaims, idTokenClaims };
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

          const stored: StoredSession<Extra> = {
            ...options.initialFields(claims),
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
            roles: resolveInitialRoles(accessTokenClaims, idTokenClaims, prof),
          };

          const sessionId = crypto.randomUUID();
          await store.setSession(sessionId, stored);

          return { sessionId };
        }

        if (token.error === "RefreshTokenError") {
          return token;
        }

        const { sessionId } = token;
        if (typeof sessionId !== "string" || !sessionId) {
          return { ...token, error: "RefreshTokenError" };
        }

        const stored = await store.getSession(sessionId);
        if (!stored || stored.error === "RefreshTokenError") {
          return { sessionId, error: "RefreshTokenError" };
        }

        if (stored.expiresAt) {
          const nowS = Math.floor(Date.now() / 1000);
          if (stored.expiresAt - nowS > ACCESS_TOKEN_REFRESH_BUFFER_S) {
            return token;
          }
        }

        if (!stored.refreshToken) {
          return { sessionId, error: "RefreshTokenError" };
        }

        const refreshed = await refresh.refreshSessionInRedis(sessionId, stored);
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

        const sessionId = token.sessionId;
        if (typeof sessionId !== "string") {
          session.error = "RefreshTokenError";
          return session;
        }

        let stored = await store.getSession(sessionId);
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
          await store.setSession(sessionId, hydratedStored);
          stored = hydratedStored;
        }

        Object.assign(session, options.sessionFields(stored));
        session.sessionId = sessionId;
        session.sub = stored.sub ?? "";
        session.accessToken = stored.accessToken ?? "";
        session.idToken = stored.idToken ?? "";
        session.roles = stored.roles ?? [];
        session.expiresAt = stored.expiresAt;
        session.refreshExpiresAt = stored.refreshExpiresAt;
        session.user = {
          ...session.user,
          id: stored.sub ?? "",
          name: stored.name ?? null,
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
        name: cookieName("session-token"),
        options: {
          httpOnly: true,
          sameSite: strictSameSite,
          path: "/",
          secure: secureCookies,
          ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
        },
      },
      callbackUrl: {
        name: cookieName("callback-url"),
        options: { httpOnly: true, sameSite: strictSameSite, path: "/", secure: secureCookies },
      },
      csrfToken: {
        name: cookieName("csrf-token"),
        options: { httpOnly: true, sameSite: strictSameSite, path: "/", secure: secureCookies },
      },
      pkceCodeVerifier: {
        name: cookieName("pkce.code_verifier"),
        options: { httpOnly: true, sameSite: oauthFlowSameSite, path: "/", secure: secureCookies },
      },
      state: {
        name: cookieName("state"),
        options: { httpOnly: true, sameSite: oauthFlowSameSite, path: "/", secure: secureCookies },
      },
      nonce: {
        name: cookieName("nonce"),
        options: { httpOnly: true, sameSite: oauthFlowSameSite, path: "/", secure: secureCookies },
      },
    },
    pages: {
      signIn: "/login",
      error: "/login",
    },
  });

  async function auth(): Promise<Session | null> {
    try {
      return await nextAuth();
    } catch (error) {
      if (shouldTreatAsMissingSession(error)) {
        console.warn(
          `[${options.logTag}] Discarding unreadable session cookie and treating request as signed out.`,
        );
        return null;
      }
      throw error;
    }
  }

  return { handlers, signIn, signOut, auth, refresh };
}
