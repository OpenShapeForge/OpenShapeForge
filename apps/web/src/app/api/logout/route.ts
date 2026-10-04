// SPDX-License-Identifier: BUSL-1.1
/**
 * Where the session-expiry guard and its "Log out" action send the browser:
 * ends the stored session, the cookie and the Keycloak SSO session
 * (packages/auth/src/session/logout.ts).
 */
import { logout } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return logout();
}
