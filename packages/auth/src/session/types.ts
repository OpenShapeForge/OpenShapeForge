// SPDX-License-Identifier: BUSL-1.1
/**
 * NextAuth module augmentation shared by every app: the fields the session
 * callback in `./next-auth.ts` always sets. An app augments the same
 * interfaces again with the fields its own `sessionFields` adds.
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    id?: string | undefined;
    givenName?: string | undefined;
    familyName?: string | undefined;
    preferredUsername?: string | undefined;
  }

  interface Session extends DefaultSession {
    sub: string;
    accessToken: string;
    idToken: string;
    /** Realm roles plus every client role, flattened. */
    roles: string[];
    /** Unix timestamp (seconds) when the access token expires. */
    expiresAt?: number | undefined;
    /** Unix timestamp (seconds) when the refresh token expires: the true session lifetime. */
    refreshExpiresAt?: number | undefined;
    /** Earliest retry after a temporary refresh failure (Unix milliseconds). */
    refreshRetryAt?: number | undefined;
    /** Only RefreshTokenError requires a new login; Unavailable can recover. */
    error?: "RefreshTokenError" | "RefreshTokenUnavailable" | undefined;
    /**
     * Opaque Redis session id. Used server-side only to invalidate the session
     * on logout. Not a secret — it is only useful in combination with the
     * encrypted session cookie that references it.
     */
    sessionId?: string | undefined;
  }

  interface JWT {
    /**
     * Opaque session id: the only field stored in the encrypted session cookie.
     * The full session payload lives in Redis under the app's key prefix.
     */
    sessionId?: string | undefined;
    error?: string | undefined;
  }
}
