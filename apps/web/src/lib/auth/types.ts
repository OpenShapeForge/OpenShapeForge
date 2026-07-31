// SPDX-License-Identifier: BUSL-1.1
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    id?: string;
    givenName?: string;
    familyName?: string;
    preferredUsername?: string;
  }

  interface Session extends DefaultSession {
    sub: string;
    accessToken: string;
    idToken: string;
    tenantId: string;
    actorType: string;
    roles: string[];
    /**
     * Keycloak group paths the user belongs to. Forwarded to the API in
     * the trusted-context bundle and used by app-level group gates.
     */
    groups: string[];
    /** Unix timestamp (seconds) when the access token expires. */
    expiresAt?: number;
    /** Unix timestamp (seconds) when the refresh token expires. This is the true session lifetime — used by SessionExpiryGuard. */
    refreshExpiresAt?: number;
    /** Set when token refresh failed (e.g. 400); client should logout and redirect to login */
    error?: "RefreshTokenError";
    /**
     * Opaque Redis session ID. Used server-side only to invalidate the session
     * on logout. Not a secret — it is only useful in combination with the
     * encrypted session cookie that references it.
     */
    sessionId?: string;
  }

  interface JWT {
    /**
     * Opaque session ID. The only field stored in the encrypted session cookie.
     * The full session payload lives in Redis under `openshapeforge:session:{sessionId}`.
     */
    sessionId?: string;
    // The fields below are kept for type completeness but are stored in Redis,
    // not in the JWT cookie payload.
    accessToken?: string;
    idToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Unix timestamp (seconds) when the refresh token expires. */
    refreshExpiresAt?: number;
    tenantId?: string;
    actorType?: string;
    roles?: string[];
    groups?: string[];
    error?: string;
  }
}
