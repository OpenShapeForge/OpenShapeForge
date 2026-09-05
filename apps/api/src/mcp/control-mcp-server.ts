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
 * the control REST surface refuses to be on the GraphQL schema
 * (control/rest-routes.ts), so this server shares the transport plumbing —
 * Streamable HTTP, stateful sessions keyed by `mcp-session-id`, the JSON
 * body parser, RFC 9728 discovery — and nothing else.
 *
 * WHO GETS IN
 * -----------
 * Control-realm bearer only (`control/platform-admin.ts`): a token verified
 * against the control realm's issuer and JWKS, minted for an admitted client
 * (`azp` allow-list: the admin gateway and the platform's public PKCE
 * client), holding the `platform_admin` realm role. Trusted-context headers
 * and API keys name a tenant and are refused before any of that; a
 * tenant-realm token fails signature verification and is refused with the
 * same 401 as no token at all. A refused caller learns nothing about which
 * tenants, realms or clients exist.
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ControlAuthorizationError } from "../control/authorization.js";
import { readControlPlaneConfig, type ControlPlaneConfigResult } from "../control/config.js";
import {
  resolvePlatformAdministrator,
  type PlatformAdministrator,
} from "../control/platform-admin.js";
import type { PlatformCatalogProvider } from "../control/platform-catalog.js";
import {
  buildPlatformSessionInfo,
  callPlatformTool,
  PLATFORM_SERVER_INFO,
  PLATFORM_SERVER_INSTRUCTIONS,
  PLATFORM_SESSION_RESOURCE,
  PLATFORM_SESSION_RESOURCE_URI,
  PLATFORM_TOOLS,
  listPlatformTenantsCount,
} from "../control/platform-tools.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import type { RuntimeModule } from "../modules/contract.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
import {
  AUTHORIZATION_SERVER_METADATA_PREFIXES,
  PROTECTED_RESOURCE_METADATA_PATH,
  requestOrigin,
} from "./protected-resource-metadata.js";

export const CONTROL_MCP_PATH = "/api/control/mcp";

/** The control resource's own metadata document (RFC 9728 path-suffixed form). */
export const CONTROL_MCP_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}${CONTROL_MCP_PATH}`;

export function controlResourceUri(request: FastifyRequest): string {
  return `${requestOrigin(request)}${CONTROL_MCP_PATH}`;
}

/** `Bearer resource_metadata="…/api/control/mcp"`; no scope, the realm authorizes by role. */
export function buildControlAuthenticateChallenge(request: FastifyRequest): string {
  return `Bearer resource_metadata="${requestOrigin(request)}${CONTROL_MCP_METADATA_PATH}"`;
}

export function buildControlResourceMetadata(
  request: FastifyRequest,
  controlIssuer: string | undefined,
): {
  resource: string;
  authorization_servers?: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
} {
  return {
    resource: controlResourceUri(request),
    ...(controlIssuer ? { authorization_servers: [controlIssuer] } : {}),
    bearer_methods_supported: ["header"],
  };
}

/** The first loaded module that administers a catalog, if any. */
export function platformCatalogProviderOf(
  modules: readonly RuntimeModule[] | undefined,
): PlatformCatalogProvider | undefined {
  return modules?.find((module) => module.platformCatalog !== undefined)?.platformCatalog;
}

export type ControlMcpOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  modules?: readonly RuntimeModule[] | undefined;
  /** Injected by tests; defaults to reading the process environment. */
  config?: ControlPlaneConfigResult;
};

function buildPlatformServer(input: {
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  provider: PlatformCatalogProvider | undefined;
  log: (error: unknown) => void;
}): Server {
  const server = new Server(PLATFORM_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: PLATFORM_SERVER_INSTRUCTIONS,
  });
  const access = () => ({ tools: PLATFORM_TOOLS.length, resources: 1 });
  const context = { db: input.db, administrator: input.administrator, provider: input.provider, access, log: input.log };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...PLATFORM_TOOLS] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [PLATFORM_SESSION_RESOURCE],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== PLATFORM_SESSION_RESOURCE_URI) {
      throw new HttpError(404, "NOT_FOUND", `Unknown resource "${request.params.uri}".`);
    }
    const info = buildPlatformSessionInfo({
      administrator: input.administrator,
      tenants: await listPlatformTenantsCount(context),
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
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callPlatformTool(request.params.name, request.params.arguments ?? {}, context),
  );
  return server;
}

export function registerControlMcpServer(app: FastifyInstance, options: ControlMcpOptions = {}): void {
  const configResult = options.config ?? readControlPlaneConfig();
  const controlIssuer = configResult.ok ? configResult.config.operator.issuer : undefined;
  const provider = platformCatalogProviderOf(options.modules);

  if (!configResult.ok) {
    app.log.warn(
      { missing: configResult.missing },
      `Platform administrator MCP is not configured; ${CONTROL_MCP_PATH} will refuse every request.`,
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
    administrator: PlatformAdministrator;
  }> {
    if (!configResult.ok) {
      throw new HttpError(
        503,
        "CONTROL_PLANE_NOT_CONFIGURED",
        "The platform administrator MCP is not configured. Missing environment: " +
          `${configResult.missing.join(", ")}.`,
      );
    }
    let administrator: PlatformAdministrator;
    try {
      administrator = await resolvePlatformAdministrator(
        headersFromFastify(request.headers),
        configResult.config,
      );
    } catch (error) {
      if (error instanceof ControlAuthorizationError) {
        throw new HttpError(error.code === "FORBIDDEN" ? 403 : 401, error.code, error.message);
      }
      throw error;
    }
    if (!options.db) {
      throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured for MCP access.");
    }
    return { db: options.db, administrator };
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

    instance.setErrorHandler((error, request, reply) => {
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
      const { db, administrator } = await requirePlatformSession(request);
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
        const server = buildPlatformServer({ db, administrator, provider, log });
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
      const server = buildPlatformServer({ db, administrator, provider, log });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      reply.hijack();
      await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    };

    instance.route({ url: CONTROL_MCP_PATH, method: ["GET", "POST", "DELETE"], handler: handle });
  });
}
