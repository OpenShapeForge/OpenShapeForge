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
import { clientInfoFromInitializeBody, type McpClientInfo } from "./session-client.js";
import {
  readControlPlaneConfig,
  type ControlPlaneConfig,
  type ControlPlaneConfigResult,
} from "../control/config.js";
import type { FirstAdministratorClients } from "../control/first-tenant-administrator.js";
import { createKeycloakOrganizationMembersClient } from "../control/keycloak-organization-members.js";
import { createKeycloakOrganizationAdminClient, KeycloakAdminError } from "../control/keycloak-organization-admin.js";
import { createServiceAccountTokenProvider } from "../control/keycloak-service-account.js";
import { createKeycloakSpiClient, KeycloakSpiError } from "../control/keycloak-spi-client.js";
import { createOrganizationScopeAdminClient } from "../control/organization-scopes.js";
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
import type { ControlDeps } from "../control/tenant-registry.js";
import { HttpError, toHttpError } from "../rest/http-error.js";
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

/**
 * Keycloak clients used by the platform MCP. Kept as one composition boundary
 * so tests can prove that the SPI and Admin API preserve their own refusal
 * classes even though both obtain the same service-account credential.
 */
export function createPlatformKeycloakClients(
  config: ControlPlaneConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): {
  firstAdministrator: FirstAdministratorClients;
  control: Omit<ControlDeps, "db" | "operator">;
} {
  const spiTokens = createServiceAccountTokenProvider(config.keycloak, {
    ...options,
    unauthorized: (message, status) =>
      new KeycloakSpiError("KEYCLOAK_SPI_UNAUTHORIZED", message, status),
    unavailable: (message, status) =>
      new KeycloakSpiError("KEYCLOAK_SPI_UNAVAILABLE", message, status),
  });
  const adminTokens = createServiceAccountTokenProvider(config.keycloak, {
    ...options,
    unauthorized: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAUTHORIZED", message, status),
    unavailable: (message, status) =>
      new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", message, status),
  });
  const keycloak = createKeycloakSpiClient(config.keycloak, { ...options, tokens: spiTokens });
  const keycloakAdmin = createKeycloakOrganizationAdminClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  const organizationScopes = createOrganizationScopeAdminClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  const members = createKeycloakOrganizationMembersClient(config.keycloak, {
    ...options,
    tokens: adminTokens,
  });
  return {
    firstAdministrator: {
      tenantRealm: config.keycloak.tenantRealm,
      members,
      organizations: keycloakAdmin,
    },
    control: {
      keycloak,
      keycloakAdmin,
      organizationScopes,
      mcpResource: config.mcpResource,
      tenantRealm: config.keycloak.tenantRealm,
    },
  };
}

/**
 * A correlation id is diagnostic metadata and therefore server-owned. MCP
 * request ids are client-controlled JSON values and may contain credentials,
 * personal data or unbounded text; never copy them into control-plane logs.
 */
export function platformCorrelationId(_requestId: unknown): string {
  return randomUUID();
}

function buildPlatformServer(input: {
  firstAdministrator: FirstAdministratorClients | undefined;
  control: Omit<ControlDeps, "db" | "operator"> | undefined;
  db: OpenShapeForgeDatabase;
  administrator: PlatformAdministrator;
  provider: PlatformCatalogProvider | undefined;
  /** What the client said at `initialize` (mcp/session-client.ts); null on a single shot. */
  client: McpClientInfo | null;
  log: (error: unknown) => void;
}): Server {
  const server = new Server(PLATFORM_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: PLATFORM_SERVER_INSTRUCTIONS,
  });
  const access = () => ({ tools: PLATFORM_TOOLS.length, resources: 1 });
  const context = {
    ...(input.firstAdministrator ? { firstAdministrator: input.firstAdministrator } : {}),
    ...(input.control ? { control: input.control } : {}),
    db: input.db,
    administrator: input.administrator,
    provider: input.provider,
    client: input.client,
    access,
    log: input.log,
  };

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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callPlatformTool(request.params.name, request.params.arguments ?? {}, {
      ...context,
      correlationId: platformCorrelationId(extra.requestId),
    }),
  );
  return server;
}

export function registerControlMcpServer(app: FastifyInstance, options: ControlMcpOptions = {}): void {
  const configResult = options.config ?? readControlPlaneConfig();
  const controlIssuer = configResult.ok ? configResult.config.operator.issuer : undefined;
  const provider = platformCatalogProviderOf(options.modules);
  const clients = configResult.ok
    ? createPlatformKeycloakClients(configResult.config)
    : undefined;
  const firstAdministrator = clients?.firstAdministrator;
  const control = clients?.control;

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
        { resource: controlResourceUri(request) },
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
        const client = clientInfoFromInitializeBody(request.body);
        const server = buildPlatformServer({ db, administrator, provider, client, log, firstAdministrator, control });
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
      const server = buildPlatformServer({ db, administrator, provider, client: null, log, firstAdministrator, control });
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
