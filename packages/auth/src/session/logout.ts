// SPDX-License-Identifier: BUSL-1.1
/**
 * The app's logout route. Signing out has three parts, and the cookie alone is
 * the least of them: the Redis record still holds the refresh token, and the
 * Keycloak SSO session would sign the person straight back in. So the route
 * deletes the stored session, clears the cookie, then sends the browser to
 * Keycloak's end-session endpoint for the same client.
 */
import type { Session } from "next-auth";
import type { KeycloakSettings } from "./keycloak.js";

export type LogoutHandlerOptions = {
  logTag: string;
  auth(): Promise<Session | null>;
  signOut(options: { redirect: false }): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
  keycloak: Pick<KeycloakSettings, "logoutUrl" | "clientId">;
};

export function createLogoutHandler(options: LogoutHandlerOptions): () => Promise<Response> {
  return async function logout(): Promise<Response> {
    let session: Session | null = null;
    try {
      session = await options.auth();
    } catch (error) {
      console.error(`[${options.logTag}] Reading the session during logout failed; clearing the cookie anyway.`, error);
    }
    if (session?.sessionId) {
      try {
        await options.deleteSession(session.sessionId);
      } catch (error) {
        console.error(`[${options.logTag}] Deleting the stored session during logout failed.`, error);
      }
    }
    await options.signOut({ redirect: false });
    const endSession = new URL(options.keycloak.logoutUrl);
    endSession.searchParams.set("client_id", options.keycloak.clientId);
    if (session?.idToken) endSession.searchParams.set("id_token_hint", session.idToken);
    return new Response(null, {
      status: 303,
      headers: { location: endSession.toString(), "cache-control": "no-store" },
    });
  };
}
