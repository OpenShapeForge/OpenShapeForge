// SPDX-License-Identifier: BUSL-1.1
/**
 * REST surface for the connector catalog and configuration.
 *
 * The counterpart of the GraphQL resolvers, delegating to the SAME service —
 * the discipline the entity surfaces already follow, where GraphQL and REST
 * both call `generated-crud.ts`. Two protocols must never be able to answer
 * differently about who may configure what.
 *
 * Everything mounts under a fixed `connectors/` segment of the REST mount, so a
 * connector route can never collide with a generated entity base path.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { REST_MOUNT_PATH } from "../rest/rest-paths.js";
import {
  ConnectorAuthorizationError,
  requireConnectorAdmin,
  requireConnectorRead,
} from "./authorization.js";
import { listConnectorContracts } from "./catalog.js";
import {
  configureConnector,
  describeConnector,
  listConnectors,
  setConnectorEnabled,
  ConnectorServiceError,
  type CatalogContext,
  type ConnectorRuntimeConfig,
} from "./service.js";

const CONNECTOR_MOUNT = `${REST_MOUNT_PATH}/connectors`;

/**
 * Error-code → HTTP status. Deliberately explicit rather than a default:
 * an unmapped code becoming a 500 is the right failure, because it means a new
 * failure mode has appeared that nobody decided how to present.
 */
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONNECTOR_NOT_FOUND: 404,
  CONNECTOR_NOT_CONFIGURED: 409,
  CONNECTOR_NEEDS_REPAIR: 409,
  CONNECTOR_SINGLE_INSTANCE: 409,
  // Not 402: the tenant is not being asked to pay at this endpoint, it is being
  // refused. 403 is the honest answer, with the reason in the body.
  CONNECTOR_NOT_LICENSED: 403,
  CONNECTOR_INVALID_CONFIGURATION: 400,
  CONNECTOR_SECRETS_NOT_CONFIGURED: 503,
  DATABASE_NOT_CONFIGURED: 503,
};

function sendError(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply
    .status(STATUS_BY_CODE[code] ?? 500)
    .send({ error: { code, message } });
}

function handleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConnectorAuthorizationError) {
    return sendError(reply, error.code, error.message);
  }
  if (error instanceof ConnectorServiceError) {
    return sendError(reply, error.code, error.message);
  }
  if (error instanceof Error && error.name === "ConnectorConfigurationError") {
    return sendError(reply, "CONNECTOR_INVALID_CONFIGURATION", error.message);
  }
  // Anything unexpected is redacted: a connector error may carry upstream text.
  reply.log.error({ err: error }, "Connector REST route failed.");
  return reply
    .status(500)
    .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
}

function parseJsonBody(body: unknown): unknown {
  // The API parses application/json as a raw buffer (see roles/api.ts), so the
  // route owns parsing — and owns rejecting malformed JSON as 400, not 500.
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return JSON.parse(body);
  if (body instanceof Uint8Array) {
    const text = Buffer.from(body).toString("utf8");
    return text.trim() === "" ? {} : JSON.parse(text);
  }
  return body;
}

export type ConnectorRestOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  config: ConnectorRuntimeConfig;
  now?: () => number;
};

export function registerConnectorRestRoutes(
  app: FastifyInstance,
  options: ConnectorRestOptions,
): void {
  const now = options.now ?? (() => Date.now());

  async function contextFor(request: FastifyRequest): Promise<CatalogContext> {
    if (!options.db) {
      throw new ConnectorServiceError(
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured.",
      );
    }
    const resolved = await resolveSessionContext(headersFromFastify(request.headers));
    return {
      db: options.db,
      session: {
        tenantId: resolved.tenantId ?? "",
        userId: resolved.userId ?? "",
        roles: [...resolved.roles],
        groups: [...resolved.groups],
        scope: resolved.scope,
      },
      config: options.config,
      now: now(),
      contracts: listConnectorContracts(),
    };
  }

  /** Session shape the authorization helpers take, before the DB is touched. */
  async function sessionFor(request: FastifyRequest) {
    const resolved = await resolveSessionContext(headersFromFastify(request.headers));
    return {
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      roles: [...resolved.roles],
    };
  }

  app.get(CONNECTOR_MOUNT, async (request, reply) => {
    try {
      requireConnectorRead(await sessionFor(request));
      return reply.send({ connectors: await listConnectors(await contextFor(request)) });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${CONNECTOR_MOUNT}/:slug`, async (request, reply) => {
    try {
      requireConnectorRead(await sessionFor(request));
      const { slug } = request.params as { slug: string };
      const connector = await describeConnector(await contextFor(request), slug);
      if (!connector) {
        return sendError(reply, "CONNECTOR_NOT_FOUND", `Unknown connector "${slug}".`);
      }
      return reply.send(connector);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put(`${CONNECTOR_MOUNT}/:slug/installations/:instanceKey`, async (request, reply) => {
    try {
      requireConnectorAdmin(await sessionFor(request));
      const { slug, instanceKey } = request.params as {
        slug: string;
        instanceKey: string;
      };
      let body: unknown;
      try {
        body = parseJsonBody(request.body);
      } catch {
        return sendError(reply, "CONNECTOR_INVALID_CONFIGURATION", "Malformed JSON body.");
      }
      const payload = (body ?? {}) as {
        displayName?: string | null;
        configuration?: unknown;
      };
      const installation = await configureConnector(await contextFor(request), {
        slug,
        instanceKey,
        ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
        configuration: payload.configuration ?? {},
      });
      return reply.status(200).send(installation);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  for (const [suffix, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(
      `${CONNECTOR_MOUNT}/:slug/installations/:instanceKey/${suffix}`,
      async (request, reply) => {
        try {
          requireConnectorAdmin(await sessionFor(request));
          const { slug, instanceKey } = request.params as {
            slug: string;
            instanceKey: string;
          };
          const changed = await setConnectorEnabled(
            await contextFor(request),
            slug,
            instanceKey,
            enabled,
          );
          if (!changed) {
            return sendError(
              reply,
              "CONNECTOR_NOT_CONFIGURED",
              `Connector "${slug}" has no installation "${instanceKey}".`,
            );
          }
          return reply.status(204).send();
        } catch (error) {
          return handleError(reply, error);
        }
      },
    );
  }
}
