// SPDX-License-Identifier: BUSL-1.1
// The orchestration is configuration-free and shared with apps/web. This app's
// route supplies its own realm, client, cookie names, and Redis consumer, so no
// credential or session namespace crosses the two independently deployed trust
// domains.
export {
  handleLogoutRequest,
  resolveCanonicalAppOrigin,
  revokeKeycloakRefreshSession,
} from "../../../../../web/src/lib/auth/auth/logout";
export type {
  LogoutDependencies,
  LogoutReason,
  RefreshSessionRevocation,
} from "../../../../../web/src/lib/auth/auth/logout";
