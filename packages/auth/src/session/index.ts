// SPDX-License-Identifier: BUSL-1.1
/**
 * The Keycloak-backed NextAuth session on Redis that the Next apps share.
 *
 * An app composes one: its Keycloak defaults, its Redis key and cookie
 * prefixes, the gate an identity must pass to enter, the fields it stores
 * beside the common ones, and the invariant a refreshed token must keep.
 * Everything else — the store, the refresh mutex and retry budget, the
 * cookie set, the callbacks — is here once.
 */
import "./types.js";

export { createSessionStore, REFRESH_LOCK_TTL_MS } from "./store.js";
export type { SessionStore, SessionStoreOptions, StoredSession, StoredSessionBase } from "./store.js";

export {
  claimsIncludeRoleState,
  decodeJwtExp,
  mergeUserProfileIntoStoredSession,
  parseAuthorizationRoles,
  resolveInitialRoles,
} from "./claims.js";
export type { JwtClaims, StoredUserProfile } from "./claims.js";

export { createKeycloakSettings } from "./keycloak.js";
export type { KeycloakDefaults, KeycloakSettings } from "./keycloak.js";

export { validateProductionEnv } from "./validate-env.js";
export type { ProductionEnvRules } from "./validate-env.js";

export { ACCESS_TOKEN_REFRESH_BUFFER_S, createTokenRefresh } from "./token-refresh.js";
export type { RefreshedClaims, TokenRefresh, TokenRefreshOptions } from "./token-refresh.js";

export { createSessionAuth } from "./next-auth.js";
export type { SessionAuth, SessionAuthOptions, SignInClaims } from "./next-auth.js";
