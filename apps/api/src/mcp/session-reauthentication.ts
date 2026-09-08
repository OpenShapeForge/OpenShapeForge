// SPDX-License-Identifier: BUSL-1.1
/**
 * Tool-level OAuth reauthorization for an already authenticated MCP session.
 *
 * Transport-level 401 responses remain the answer for missing or invalid
 * bearer tokens. An authenticated tool call is already inside MCP JSON-RPC,
 * so ChatGPT's documented reauthorization signal is instead an error result
 * carrying `_meta["mcp/www_authenticate"]`, backed by an OAuth security scheme
 * on the tool. The current Keycloak session is removed before that signal is
 * returned; the session id comes only from the verified bearer token and is
 * never accepted as tool input or returned to the caller.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { readControlPlaneConfig } from "../control/config.js";
import { createMemberRoleAdminClient } from "../control/member-role-admin.js";
import { HttpError } from "../rest/http-error.js";

export const REAUTHENTICATE_TOOL_NAME = "reauthenticate";

const OAUTH_SECURITY_SCHEMES = [{ type: "oauth2", scopes: [] }] as const;

type OAuthTool = Tool & {
  securitySchemes: typeof OAUTH_SECURITY_SCHEMES;
};

export const REAUTHENTICATE_TOOL: OAuthTool = {
  name: REAUTHENTICATE_TOOL_NAME,
  title: "Sign in again",
  description:
    "Ends only this MCP connection's current sign-in and asks the client to run OAuth again. " +
    "Use when the person explicitly asks to reconnect, switch identity, or refresh their authorization.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  securitySchemes: OAUTH_SECURITY_SCHEMES,
  // Compatibility mirror for clients that adopted tool security metadata
  // before the top-level field became the documented form.
  _meta: { securitySchemes: OAUTH_SECURITY_SCHEMES },
  annotations: {
    title: "Sign in again",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

type AuthenticationSession = {
  id: string;
  offlineAccess: boolean;
};

const authenticationSessions = new WeakMap<TrustedSessionContext, AuthenticationSession>();
const BEARER_AUTHORIZATION = /^Bearer\s+(.+)$/i;

function bearerClaims(headers: Headers): Record<string, unknown> | null {
  const token = BEARER_AUTHORIZATION.exec(headers.get("authorization") ?? "")?.[1];
  const encoded = token?.split(".")[1];
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Attach the verified bearer token's non-public session handle to its session. */
export function rememberAuthenticationSession(
  session: TrustedSessionContext,
  headers: Headers,
): void {
  if (session.credential !== "bearer") return;
  const claims = bearerClaims(headers);
  const candidate = claims?.sid ?? claims?.session_state;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return;
  authenticationSessions.set(session, {
    id: candidate.trim(),
    offlineAccess: (session.oauthScopes ?? []).includes("offline_access"),
  });
}

/** Carry the current request's refreshed bearer session onto a stateful MCP server. */
export function carryAuthenticationSession(
  captured: TrustedSessionContext,
  current: TrustedSessionContext,
): void {
  if (captured === current) return;
  const authentication = authenticationSessions.get(current);
  if (authentication) authenticationSessions.set(captured, authentication);
}

export function canReauthenticate(session: TrustedSessionContext): boolean {
  return session.credential === "bearer" && authenticationSessions.has(session);
}

export type ReauthenticationDependencies = {
  revoke(sessionId: string, offline: boolean): Promise<boolean>;
};

function defaultDependencies(): ReauthenticationDependencies {
  const controlPlane = readControlPlaneConfig();
  if (!controlPlane.ok) {
    throw new HttpError(
      503,
      "REAUTHENTICATION_UNAVAILABLE",
      "This deployment cannot end the current sign-in.",
    );
  }
  const admin = createMemberRoleAdminClient(controlPlane.config.keycloak);
  return {
    revoke: (sessionId, offline) => admin.revokeSession(sessionId, offline),
  };
}

/** Revoke exactly the caller's verified session and emit ChatGPT's OAuth signal. */
export async function reauthenticate(
  session: TrustedSessionContext,
  challenge: string,
  onRequested: () => void = () => {},
  dependencies: ReauthenticationDependencies = defaultDependencies(),
): Promise<CallToolResult> {
  const authentication = authenticationSessions.get(session);
  if (session.credential !== "bearer" || !authentication) {
    throw new HttpError(
      403,
      "REAUTHENTICATION_UNAVAILABLE",
      "This connection has no revocable OAuth session.",
    );
  }

  try {
    // A grant with offline_access can exist in both Keycloak stores under the
    // same verified sid. Touch only that sid; never enumerate or revoke the
    // user's other sessions.
    if (authentication.offlineAccess) {
      await dependencies.revoke(authentication.id, true);
    }
    await dependencies.revoke(authentication.id, false);
  } catch {
    throw new HttpError(
      502,
      "REAUTHENTICATION_FAILED",
      "The identity provider could not end this sign-in. No other session was changed.",
    );
  }

  onRequested();
  const authenticate = `${challenge}, error="invalid_token", ` +
    'error_description="The current sign-in was ended. Sign in again to continue."';
  return {
    content: [
      {
        type: "text",
        text: "This connection's sign-in was ended. Sign in again to continue.",
      },
    ],
    isError: true,
    _meta: { "mcp/www_authenticate": [authenticate] },
  };
}

/** Test-only inspection without exposing the handle through the MCP surface. */
export function __authenticationSessionForTests(
  session: TrustedSessionContext,
): AuthenticationSession | undefined {
  return authenticationSessions.get(session);
}
