// SPDX-License-Identifier: BUSL-1.1
/**
 * NextAuth module augmentation for the control plane.
 *
 * Compare `apps/web/src/lib/auth/types.ts`. The shape is deliberately smaller,
 * and the omissions are the interesting part:
 *
 *   - NO `tenantId`. Control-realm tokens carry no `tid` claim, by design
 *     (`packages/compiler/config/authoring/authorization.control.yaml` says so
 *     in as many words). apps/web reads `stored.tenantId ?? ""`, so porting the
 *     field would give every operator session a tenant id of `""` — a value
 *     that type-checks, renders, and is wrong. Leaving the field out makes any
 *     code that reaches for a tenant here a COMPILE error instead.
 *   - NO `actorType`. It is derived from the tenant context; no tenant, no
 *     actor type.
 *   - NO `groups`. The control realm authors no groups; an operator's authority
 *     is one realm role and nothing else.
 *
 * What replaces them is `isPlatformOperator`: the single authorization fact
 * this app runs on, resolved once at session build so no call site has to
 * remember the role name.
 */
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
    /** Realm roles plus every client role, flattened. */
    roles: string[];
    /**
     * True when `roles` contains `platform-operator`. Authenticating against
     * the control realm is NOT authorization to use the control plane — this
     * is. See `src/lib/server/route-authz.ts` for the gate that enforces it.
     */
    isPlatformOperator: boolean;
    /** Unix timestamp (seconds) when the access token expires. */
    expiresAt?: number;
    /** Unix timestamp (seconds) when the refresh token expires. This is the true session lifetime. */
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
     * The full session payload lives in Redis under
     * `openshapeforge-admin:session:{sessionId}`.
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
    roles?: string[];
    error?: string;
  }
}
