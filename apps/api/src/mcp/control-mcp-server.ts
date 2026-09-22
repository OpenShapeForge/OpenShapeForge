// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator MCP — `/api/control/mcp`.
 *
 * A second, small MCP server beside the generated one, and deliberately not
 * a mode of it. The generated server is per-tenant by construction: every
 * session it admits names a tenant, every tool it lists is scoped by that
 * tenant's rows and roles, and `whoami` says which organization the person
 * acts for. A platform administrator has no tenant. Threading "no tenant"
 * through a server whose invariants all assume one would be the same defect
 * the control plane refuses to be on the GraphQL schema, so this server
 * shares the transport plumbing — Streamable HTTP, stateful sessions keyed
 * by `mcp-session-id`, the JSON body parser, RFC 9728 discovery — and
 * nothing else.
 *
 * WHAT IT SERVES
 * --------------
 * The `osf-control` Operations (control/operations.ts), bound by the same
 * `bindOperationHandlers` REST uses and dispatched through `invokeOperation`
 * with `transport: "mcp"`. The tool list is the Operations whose `auth.roles`
 * admit the session's control-realm roles, under their `transports.mcp`
 * names, with the compiled input schema — the `confirmed` acknowledgement
 * field included where the Operation declares one. Beside them, the one
 * `osf://platform-session` resource.
 *
 * WHO GETS IN
 * -----------
 * Control-realm bearer only (`control/control-session.ts`): a token verified
 * against the control realm's issuer and JWKS, minted for an admitted client
 * (`azp` allow-list: the admin gateway and the platform's public PKCE
 * client) or bound to this resource by `aud`, holding a control-realm
 * platform role. Which tools that role reaches is the Operations' decision.
 * Trusted-context headers and API keys name a tenant and are refused before
 * any of that; a tenant-realm token fails signature verification and is
 * refused with the same 401 as no token at all. A refused caller learns
 * nothing about which tenants, realms or clients exist.
 *
 * DISCOVERY
 * ---------
 * The 401 challenge names this resource's own metadata document,
 * `/.well-known/oauth-protected-resource/api/control/mcp`, whose
 * `authorization_servers` is the CONTROL realm — not the tenant realm the
 * root document names. A client that follows the pointer therefore signs the
 * person in against the right realm without being told. The RFC 8414
 * path-inserted spelling of the control issuer's metadata is mirrored as
 * well, for the same reason protected-resource-metadata.ts mirrors the
 * tenant issuer's.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientInfoFromInitializeBody, type McpClientInfo } from "./session-client.js";
import {
  controlSessionHttpError,
  resolveControlSession,
  type ControlSessionContext,
} from "../control/control-session.js";
import {
  buildPlatformSessionInfo,
  PLATFORM_SERVER_INFO,
  PLATFORM_SERVER_INSTRUCTIONS,
  PLATFORM_SESSION_RESOURCE,
  PLATFORM_SESSION_RESOURCE_URI,
  listPlatformTenantsCount,
} from "../control/platform-tools.js";
import type { ControlPresentation } from "../control/runtime.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import type {
  ModuleOperationSuccessResult,
  ModuleRuntimeContext,
  RuntimeModule,
} from "../modules/contract.js";
import {
  bindOperationHandlers,
  type BoundOperation,
  DeclaredOperationError,
  invokeOperation,
  listOperationContracts,
  type OperationContract,
  requireOperationAuthorization,
} from "../operations/runtime.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import { withConfirmationHint } from "./confirmation-hint.js";
import {
  AUTHORIZATION_SERVER_METADATA_PREFIXES,
  PROTECTED_RESOURCE_METADATA_PATH,
  requestOrigin,
} from "./protected-resource-metadata.js";

/** The route this server mounts the control MCP on. */
export const CONTROL_MCP_ROUTE_PATH = "/api/control/mcp";

/**
 * The PUBLISHED name of the platform administrator resource: `/admin/mcp`,
 * beside `/admin` itself, in the same short address space as
 * `/<organization>/mcp`. `/api/control/mcp` is rewritten to it on the way in
 * (roles/api.ts) and stays reachable; this constant is what appears in the
 * metadata document, in the `WWW-Authenticate` challenge and in `aud`, so it is
 * the one that has to be short.
 */
export const CONTROL_MCP_PATH = "/admin/mcp";

/** The control resource's own metadata document (RFC 9728 path-suffixed form). */
export const CONTROL_MCP_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}${CONTROL_MCP_PATH}`;

export function controlResourceUri(request: FastifyRequest): string {
  return `${requestOrigin(request)}${CONTROL_MCP_PATH}`;
}

/**
 * The client scope whose audience mapper puts this resource's URL into `aud`.
 *
 * The same device the per-organization resources use (organization-resource.ts),
 * for the same reason and one more. A client that registers ITSELF gets a
 * client id Keycloak mints on the spot, so the `azp` allow-list below cannot
 * name it in advance — an allow-list of client ids and RFC 7591 are mutually
 * exclusive by construction. This scope replaces it with a stronger claim:
 * the token was minted FOR `/api/control/mcp` (RFC 8707), which no other
 * client of the control realm can obtain without being granted this scope.
 */
export const CONTROL_RESOURCE_SCOPE = "mcp-resource:control";

/**
 * Client scopes of the CONTROL realm a client must ask for by name.
 *
 * Comma-separated, default `roles,profile,email`. `roles` is not decoration
 * here: it is the scope carrying the realm-role mapper, so
 * `realm_access.roles` — and with it `platform_admin`, the only authority this
 * surface recognises — is absent without it. `profile` and `email` carry
 * `preferred_username`, `name` and `email`, which become the audit actor on
 * every `Platform.SystemBypass` elevation this surface makes. It has to be ADVERTISED because Keycloak 26 applies a realm's
 * default client scopes to a newly registered client only when the RFC 7591
 * request names no `scope`; naming one makes the request exhaustive. See
 * organization-resource.ts, where the tenant realm hits the same wall.
 */
export const CONTROL_MCP_CLIENT_SCOPES_ENV = "OPENSHAPEFORGE_CONTROL_MCP_CLIENT_SCOPES";

export function controlMcpScopes(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  const raw = env[CONTROL_MCP_CLIENT_SCOPES_ENV];
  const configured = (raw === undefined ? "roles,profile,email" : raw)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set([...configured, CONTROL_RESOURCE_SCOPE])];
}

/**
 * `Bearer resource_metadata="…/api/control/mcp", scope="…"`.
 *
 * The scope used to be omitted, on the grounds that this realm authorizes by
 * ROLE rather than by scope. That is still true of the authority, but a
 * client that has to register itself first has no other way to learn which
 * scopes to ask for, and a registration that names none is refused the role
 * mapper it needs. The challenge and the metadata document take the list from
 * one place so they cannot disagree.
 */
export function buildControlAuthenticateChallenge(request: FastifyRequest): string {
  return (
    `Bearer resource_metadata="${requestOrigin(request)}${CONTROL_MCP_METADATA_PATH}", ` +
    `scope="${controlMcpScopes().join(" ")}"`
  );
}

export function buildControlResourceMetadata(
  request: FastifyRequest,
  controlIssuer: string | undefined,
): {
  resource: string;
  authorization_servers?: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_documentation?: string;
} {
  return {
    resource: controlResourceUri(request),
    ...(controlIssuer ? { authorization_servers: [controlIssuer] } : {}),
    bearer_methods_supported: ["header"],
    scopes_supported: controlMcpScopes(),
  };
}

export type ControlMcpOptions = {
  /**
   * The module runtime context: the database, the platform, and the control
   * runtime (control/runtime.ts) the Operations need. Without a control
   * runtime, or with an incomplete configuration, every request answers 503
   * naming what is missing.
   */
  context: ModuleRuntimeContext;
  /** Loaded runtime modules whose control Operations join the core control plane. */
  modules: readonly RuntimeModule[];
  /** Injected by tests; defaults to the generated catalog. */
  operations?: readonly OperationContract[] | undefined;
};

/** One tool as this session sees it, with the Operation it dispatches to. */
type SessionTool = { tool: Tool; entry: BoundOperation };

/**
 * The control Operations bound for this process. Core control Operations are
 * always present; loaded runtime modules may add their own control Operations.
 * Filtering by the declared authorization mode keeps tenant Operations off
 * this platform-only surface.
 */
function bindControlOperations(
  modules: readonly RuntimeModule[],
  operations: readonly OperationContract[],
): readonly BoundOperation[] {
  const controlPlugins = new Set(
    operations
      .filter((operation) => operation.auth.mode === "control")
      .map((operation) => operation.plugin),
  );
  const relevantOperations = operations.filter(
    (operation) => operation.auth.mode === "control" || controlPlugins.has(operation.plugin),
  );
  const relevantModules = modules.filter((module) => controlPlugins.has(module.name));
  return [...bindOperationHandlers(relevantModules, relevantOperations).values()]
    .filter(({ operation }) => operation.auth.mode === "control");
}

/**
 * The tools a session may list and call: the MCP-projected control Operations
 * whose `auth.roles` admit the session. Decided by the same
 * `requireOperationAuthorization` REST applies, so the two transports cannot
 * disagree about who may do what. Annotations follow the compiler's rule for
 * the tenant surface.
 */
function toolsForControlSession(
  bound: readonly BoundOperation[],
  session: ControlSessionContext,
): readonly SessionTool[] {
  return bound
    .filter(({ operation }) => {
      if (!operation.transports.mcp.enabled || !operation.transports.mcp.name) return false;
      try {
        requireOperationAuthorization(operation, session);
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      entry,
      tool: {
        name: entry.operation.transports.mcp.name!,
        title: entry.operation.title,
        description: entry.operation.description,
        inputSchema: entry.operation.inputSchema as Tool["inputSchema"],
        outputSchema: entry.operation.outputSchema as Tool["outputSchema"],
        annotations: {
          title: entry.operation.title,
          readOnlyHint: entry.operation.effects.data === "read",
          destructiveHint: entry.operation.effects.data === "delete",
          idempotentHint: entry.operation.idempotency.mode !== "none",
          openWorldHint: entry.operation.effects.external !== "none",
        },
      },
    }));
}

function toolResult(result: ModuleOperationSuccessResult): CallToolResult {
  if (result.mcp) {
    return {
      content: result.mcp.content,
      ...(result.mcp.structuredContent ? { structuredContent: result.mcp.structuredContent } : {}),
    };
  }
  const value = result.value;
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}

/**
 * A refusal as a tool result rather than a protocol error, so the assistant
 * reads the code and message and can act (fix the definition, name a real
 * tenant). A declared Operation error carries the body the handler stated;
 * anything else is the runtime's redacted projection, logged here because a
 * driver error can carry SQL text.
 */
function failedToolResult(error: unknown, log: (error: unknown) => void): CallToolResult {
  if (error instanceof DeclaredOperationError) {
    const body = error.body;
    const message = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined;
    return {
      content: [
        { type: "text", text: `${error.code}: ${typeof message === "string" ? message : error.message}` },
        { type: "text", text: JSON.stringify(body, null, 2) },
      ],
      ...(body && typeof body === "object" && !Array.isArray(body)
        ? { structuredContent: body as Record<string, unknown> }
        : {}),
      isError: true,
    };
  }
  const { status, body: mapped } = toHttpError(error);
  if (status >= 500) log(error);
  const body = withConfirmationHint(mapped);
  const hint = (body.error as { hint?: unknown }).hint;
  return {
    content: [
      { type: "text", text: `${body.error.code}: ${body.error.message}` },
      ...(typeof hint === "string" ? [{ type: "text" as const, text: hint }] : []),
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    structuredContent: body,
    isError: true,
  };
}

function buildPlatformServer(input: {
  context: ModuleRuntimeContext;
  db: OpenShapeForgeDatabase;
  session: ControlSessionContext;
  bound: readonly BoundOperation[];
  /** What the client said at `initialize` (mcp/session-client.ts); null on a single shot. */
  client: McpClientInfo | null;
  log: (error: unknown) => void;
}): Server {
  const server = new Server(PLATFORM_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: PLATFORM_SERVER_INSTRUCTIONS,
  });
  // Roles are pinned for the life of the session, so its tool list is too.
  const tools = toolsForControlSession(input.bound, input.session);
  const access = () => ({ tools: tools.length, resources: 1 });
  const presentation: ControlPresentation = { client: input.client, access };
  const { administrator } = input.session;
  const catalog = {
    db: input.db,
    administrator,
    provider: input.context.control?.provider,
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ tool }) => tool),
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [PLATFORM_SESSION_RESOURCE],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== PLATFORM_SESSION_RESOURCE_URI) {
      throw new HttpError(404, "NOT_FOUND", `Unknown resource "${request.params.uri}".`);
    }
    const info = buildPlatformSessionInfo({
      administrator,
      roles: input.session.roles,
      tenants: await listPlatformTenantsCount(catalog),
      client: input.client,
      access: access(),
    });
    return {
      contents: [
        {
          uri: PLATFORM_SESSION_RESOURCE_URI,
          mimeType: "application/json",
          text: JSON.stringify(info, null, 2),
        },
      ],
    };
  });
  // Unknown names and Operations this session may not use get the same
  // refusal: NOT_FOUND, no hint of what exists.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const match = tools.find(({ tool }) => tool.name === request.params.name);
    if (!match) {
      return failedToolResult(
        new HttpError(404, "NOT_FOUND", `Unknown tool "${request.params.name}".`),
        input.log,
      );
    }
    try {
      const result = await invokeOperation(match.entry, request.params.arguments ?? {}, {
        ...input.context,
        db: input.db,
        control: { ...input.context.control!, presentation, log: input.log },
        session: input.session,
        transport: "mcp",
      });
      return toolResult(result);
    } catch (error) {
      return failedToolResult(error, input.log);
    }
  });
  return server;
}

/** Test seam: the server one session sees, without the HTTP transport. */
export function __buildPlatformServerForTests(input: {
  context: ModuleRuntimeContext;
  session: ControlSessionContext;
  operations: readonly OperationContract[];
  modules?: readonly RuntimeModule[];
  client?: McpClientInfo | null;
  log?: (error: unknown) => void;
}): Server {
  if (!input.context.db) throw new Error("The control MCP test seam needs a database.");
  return buildPlatformServer({
    context: input.context,
    db: input.context.db,
    session: input.session,
    bound: bindControlOperations(input.modules ?? [], input.operations),
    client: input.client ?? null,
    log: input.log ?? (() => undefined),
  });
}

export function registerControlMcpServer(app: FastifyInstance, options: ControlMcpOptions): void {
  const { context } = options;
  const configResult = context.control?.config ?? { ok: false as const, missing: ["the control runtime"] };
  const controlIssuer = configResult.ok ? configResult.config.operator.issuer : undefined;
  const bound = bindControlOperations(options.modules, options.operations ?? listOperationContracts());

  if (!configResult.ok) {
    app.log.warn(
      { missing: configResult.missing },
      `Platform administrator MCP is not configured; ${CONTROL_MCP_ROUTE_PATH} will refuse every request.`,
    );
  }

  // Discovery is public and unauthenticated, like the tenant documents: it
  // is what a client reads because it cannot yet authenticate. It discloses
  // the control realm's URL, which every control token already carries.
  app.get(CONTROL_MCP_METADATA_PATH, async (request, reply) =>
    reply
      .header("cache-control", "public, max-age=3600")
      .send(buildControlResourceMetadata(request, controlIssuer)),
  );
  if (controlIssuer) {
    const issuerPath = new URL(controlIssuer).pathname;
    for (const prefix of AUTHORIZATION_SERVER_METADATA_PREFIXES) {
      // A static route beside protected-resource-metadata.ts's wildcard for
      // the tenant issuer; the router prefers the static match. Mirrors one
      // known document, fetched over the JWKS base the verifier already uses.
      app.get(`${prefix}${issuerPath}`, async (_request, reply) => {
        const jwks = configResult.ok ? configResult.config.operator.jwksUri : "";
        const suffix = "/protocol/openid-connect/certs";
        const base = jwks.endsWith(suffix) ? jwks.slice(0, -suffix.length) : controlIssuer;
        const upstream = await fetch(`${base}/.well-known/openid-configuration`).catch(() => null);
        if (!upstream?.ok) {
          return reply
            .code(502)
            .send({ error: `authorization server metadata unavailable from ${controlIssuer}` });
        }
        return reply
          .header("cache-control", "public, max-age=3600")
          .header("content-type", "application/json")
          .send(await upstream.text());
      });
    }
  }

  async function requirePlatformSession(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: ControlSessionContext;
  }> {
    if (!configResult.ok) {
      throw new HttpError(
        503,
        "CONTROL_PLANE_NOT_CONFIGURED",
        "The platform administrator MCP is not configured. Missing environment: " +
          `${configResult.missing.join(", ")}.`,
      );
    }
    let session: ControlSessionContext;
    try {
      session = await resolveControlSession(
        headersFromFastify(request.headers),
        configResult.config,
        { resource: controlResourceUri(request) },
      );
    } catch (error) {
      throw controlSessionHttpError(error);
    }
    if (!context.db) {
      throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured for MCP access.");
    }
    return { db: context.db, session };
  }

  void app.register(async (instance) => {
    instance.removeContentTypeParser("application/json");
    instance.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      if (body === "" || body === undefined) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON."), undefined);
      }
    });

    // A hosted client's discovery probe is a bare POST — no body, and a
    // content-type Fastify has no parser for (aiohttp sends
    // application/octet-stream). Answer it with the 401 challenge before any
    // parsing, exactly as the organization resource does: nothing is
    // authenticated here, the credential is verified by requirePlatformSession.
    instance.addHook("onRequest", async (request) => {
      if (request.method !== "POST") return;
      const authorization = request.headers["authorization"];
      const value = Array.isArray(authorization) ? authorization[0] : authorization;
      if (typeof value === "string" && /^bearer\s+\S/i.test(value.trim())) return;
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "The control plane requires an Authorization: Bearer token from the control realm.",
      );
    });

    instance.setErrorHandler((error, request, reply) => {
      // A credentialed request under a media type without a parser is the
      // client's mistake, not a server failure.
      const fastifyCode = (error as { code?: unknown }).code;
      if (fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        void reply.status(415).send({
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "JSON-RPC bodies are accepted only as application/json.", retryable: false },
        });
        return;
      }
      const { status, body } = toHttpError(error);
      if (status >= 500) instance.log.error({ err: error }, "Platform MCP request failed.");
      if (status === 401) {
        void reply.header("www-authenticate", buildControlAuthenticateChallenge(request));
      }
      void reply.status(status).send(body);
    });

    type SessionEntry = {
      transport: StreamableHTTPServerTransport;
      server: Server;
      subject: string;
      issuer: string;
      lastSeenMs: number;
    };
    const sessions = new Map<string, SessionEntry>();
    const SESSION_IDLE_LIMIT_MS = 30 * 60 * 1000;
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of sessions) {
        if (now - entry.lastSeenMs > SESSION_IDLE_LIMIT_MS) {
          sessions.delete(id);
          void entry.transport.close();
          void entry.server.close();
        }
      }
    }, 60 * 1000);
    sweep.unref();

    const isInitializeBody = (body: unknown): boolean =>
      (Array.isArray(body) ? body : [body]).some(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as { method?: unknown }).method === "initialize",
      );

    const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const { db, session } = await requirePlatformSession(request);
      const { administrator } = session;
      const log = (error: unknown) => request.log.error({ err: error }, "Platform tool failed.");
      const sessionHeader = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          throw new HttpError(404, "SESSION_NOT_FOUND", "Unknown MCP session; reinitialize.");
        }
        // A session is a credential: initialized by one administrator, it
        // stays bound to that identity.
        if (existing.subject !== administrator.subject || existing.issuer !== administrator.issuer) {
          throw new HttpError(403, "FORBIDDEN", "MCP session belongs to another identity.");
        }
        existing.lastSeenMs = Date.now();
        reply.hijack();
        await existing.transport.handleRequest(request.raw, reply.raw, request.body);
        return;
      }

      if (request.method === "POST" && isInitializeBody(request.body)) {
        const client = clientInfoFromInitializeBody(request.body);
        const server = buildPlatformServer({ context, db, session, bound, client, log });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, {
              transport,
              server,
              subject: administrator.subject,
              issuer: administrator.issuer,
              lastSeenMs: Date.now(),
            });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        reply.hijack();
        await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
        await transport.handleRequest(request.raw, reply.raw, request.body);
        return;
      }

      // Sessionless single shot, for probes and scripted proofs.
      const server = buildPlatformServer({ context, db, session, bound, client: null, log });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      reply.hijack();
      await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    };

    instance.route({ url: CONTROL_MCP_ROUTE_PATH, method: ["GET", "POST", "DELETE"], handler: handle });
  });
}
