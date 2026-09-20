// SPDX-License-Identifier: BUSL-1.1
/**
 * The stateful MCP transport sessions and their request handler. Split out
 * of generated-mcp-server.ts, verbatim.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SHORT_ADDRESS_VARY } from "./address.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  createStatefulMcpSessionContext,
  sameStatefulMcpAuthorization,
  withFreshRelationGroupMemberships,
} from "./stateful-session-authorization.js";
import { carrySessionIdentity } from "./session-info.js";
import { clientInfoFromInitializeBody, rememberSessionClient } from "./session-client.js";
import { sessionOpeningSentence } from "./session-opening.js";
import { catalogDerivedTools } from "./catalog.js";
import type { McpRegistrationOptions, McpRouteContext } from "./route-context.js";
import type { BuildServer } from "./generated-mcp-server.js";
/**
 * The stateful transport sessions of the MCP plugin scope, keyed by the
 * SDK-issued session id and bound to the identity that initialized them,
 * and the one request handler every MCP route shares. `buildServer` is the
 * session server builder of generated-mcp-server.ts, passed in so this
 * module does not import the file that registers it.
 */
export function createTransportSessions(input: {
  options: McpRegistrationOptions;
  requireMcpSession: McpRouteContext["requireMcpSession"];
  buildServer: BuildServer;
}) {
  const { options, requireMcpSession, buildServer } = input;
  // Stateful sessions, keyed by the SDK-issued mcp-session-id and bound to
  // the authenticated identity that initialized them. Statefulness is what
  // makes server-initiated exchanges possible at all: elicitation sends a
  // request on the SSE stream of one POST and receives the person's answer
  // as the NEXT POST, which must reach the same transport. Sessions are
  // per-process; a multi-replica deployment needs session affinity on this
  // path.
  type McpSessionEntry = {
    transport: StreamableHTTPServerTransport;
    server: Server;
    /** Resource path the session was initialized on; it is not portable. */
    resource: string;
    /**
     * The session context `buildServer` captured at `initialize`. Held so a
     * later request can refresh the display facts hanging off it — see
     * carrySessionIdentity — rather than leaving `whoami` answering with the
     * expiry of the very first access token forever.
     */
    session: TrustedSessionContext;
    tenantId: string;
    userId: string;
    roles: string[];
    oauthScopes: string[];
    groups: string[];
    scope: TrustedSessionContext["scope"];
    credential: TrustedSessionContext["credential"];
    loginSessionBinding?: string;
    lastSeenMs: number;
  };
  const mcpSessions = new Map<string, McpSessionEntry>();
  const SESSION_IDLE_LIMIT_MS = 30 * 60 * 1000;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of mcpSessions) {
      if (now - entry.lastSeenMs > SESSION_IDLE_LIMIT_MS) {
        mcpSessions.delete(id);
        options.modulePlatform?.unregisterServer(entry.server);
        void entry.transport.close();
        void entry.server.close();
      }
    }
  }, 60 * 1000);
  sweep.unref();

  /**
   * Fan a tools/list_changed out to every live session of the SAME tenant
   * whose roles could see tools derived from `table` — audience roles or
   * any role with an operation on the defining entity. A session without an
   * open notification stream simply misses the nudge; delivery is
   * best-effort by design.
   */
  const notifyDerivedDefinitionChanged = (
    table: string,
    tenantId: string | null,
  ): void => {
    const audiences = catalogDerivedTools
      .filter((entry) => entry.table === table)
      .flatMap((entry) => entry.roles);
    if (audiences.length === 0) return;
    const audience = new Set(audiences);
    for (const entry of mcpSessions.values()) {
      if (tenantId && entry.tenantId !== tenantId) continue;
      if (!entry.roles.some((role) => audience.has(role))) continue;
      void entry.server.sendToolListChanged().catch(() => {
        // No open stream on this session; it will see the change on its
        // next tools/list.
      });
    }
  };

  const isInitializeBody = (body: unknown): boolean => {
    const messages = Array.isArray(body) ? body : [body];
    return messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        (message as { method?: unknown }).method === "initialize",
    );
  };

  const handleMcpRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    void reply.header("vary", SHORT_ADDRESS_VARY);
    const { db, session, resource } = await requireMcpSession(request);

    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;

    if (sessionId) {
      const existing = mcpSessions.get(sessionId);
      if (!existing) {
        // Per spec: an unknown session id answers 404 so the client
        // reinitializes, rather than being silently handled statelessly.
        throw new HttpError(
          404,
          "SESSION_NOT_FOUND",
          "Unknown MCP session; reinitialize.",
        );
      }
      // The session is a credential: it was initialized by one identity
      // on one resource and stays bound to both. A session id minted on
      // one organization's resource is not a ticket to another's, nor to
      // the legacy mount.
      if (existing.resource !== resource) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "MCP session was initialized on another MCP resource.",
        );
      }
      if (
        existing.tenantId !== session.tenantId ||
        existing.userId !== session.userId
      ) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "MCP session belongs to another identity.",
        );
      }
      if (!sameStatefulMcpAuthorization(existing, session)) {
        mcpSessions.delete(sessionId);
        options.modulePlatform?.unregisterServer(existing.server);
        void existing.transport.close();
        void existing.server.close();
        throw new HttpError(
          404,
          "SESSION_NOT_FOUND",
          "Authorization changed; reinitialize the MCP session.",
        );
      }
      existing.lastSeenMs = Date.now();
      // The credential this request carried is newer than the one the
      // session was initialized with — the client refreshes silently — so
      // the display facts move over to the captured context before the
      // server answers from it.
      carrySessionIdentity(existing.session, session);
      reply.hijack();
      await withFreshRelationGroupMemberships(
        session,
        () => existing.transport.handleRequest(
          request.raw,
          reply.raw,
          request.body,
        ),
      );
      return;
    }

    if (request.method === "POST" && isInitializeBody(request.body)) {
      const statefulSession = createStatefulMcpSessionContext(session);
      // What the client says about itself is said once, here; the server
      // built next reads it for its instructions, and `whoami` for the
      // life of the session (mcp/session-client.ts).
      rememberSessionClient(statefulSession, clientInfoFromInitializeBody(request.body));
      const server = buildServer(
        db,
        statefulSession,
        options.modules,
        options.modulePlatform,
        options.egressOwner,
        notifyDerivedDefinitionChanged,
        true,
        undefined,
        await sessionOpeningSentence({ db, session: statefulSession }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, {
            transport,
            server,
            resource,
            session: statefulSession,
            tenantId: session.tenantId as string,
            userId: session.userId as string,
            roles: [...(session.roles ?? [])],
            oauthScopes: [...(session.oauthScopes ?? [])],
            groups: [...(session.groups ?? [])],
            scope: session.scope,
            credential: session.credential,
            ...(session.loginSessionBinding !== undefined
              ? { loginSessionBinding: session.loginSessionBinding }
              : {}),
            lastSeenMs: Date.now(),
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
        options.modulePlatform?.unregisterServer(server);
      };
      reply.hijack();
      // The SDK declares Transport's optional callbacks as required-when-present,
      // which collides with this repo's exactOptionalPropertyTypes. The cast is
      // to the SDK's own Transport shape and changes no behaviour.
      await server.connect(
        transport as unknown as Parameters<Server["connect"]>[0],
      );
      await withFreshRelationGroupMemberships(
        session,
        () => transport.handleRequest(request.raw, reply.raw, request.body),
      );
      return;
    }

    // Sessionless non-initialize request: the pre-session stateless
    // single-shot behaviour, kept for probes and legacy callers. No
    // server-initiated exchange is possible on this path, but a mutation
    // made through it still nudges the live sessions.
    const server = buildServer(
      db,
      session,
      options.modules,
      options.modulePlatform,
      options.egressOwner,
      notifyDerivedDefinitionChanged,
    );
    // `sessionIdGenerator` is omitted rather than set to undefined: the SDK
    // reads it as `=== undefined` to mean stateless, and omitting keeps
    // exactOptionalPropertyTypes happy.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    reply.raw.on("close", () => {
      options.modulePlatform?.unregisterServer(server);
      void transport.close();
      void server.close();
    });
    reply.hijack();
    await server.connect(
      transport as unknown as Parameters<Server["connect"]>[0],
    );
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  return { handleMcpRequest, notifyDerivedDefinitionChanged };
}
