// SPDX-License-Identifier: BUSL-1.1
/**
 * The provisioning surface: `/api/api-keys`.
 *
 * Thin by design. Everything that decides anything lives in `service.ts` and
 * `ceiling.ts`; this file parses input, maps errors to status codes, and — the
 * one thing it must not get wrong — refuses to register at all when
 * provisioning is not configured. A 404 on an unconfigured deployment is the
 * honest answer and leaks nothing about why.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { headersFromFastify } from "../../http/headers.js";
import { resolveSessionContext } from "../identity.js";
import { ApiKeyAuthorizationError } from "./ceiling.js";
import type { ApiKeyProvisioningConfig } from "./runtime-config.js";
import {
  ApiKeyNotFoundError,
  ApiKeyProvisioningError,
  createIntegration,
  disableIntegration,
  issueKey,
  listKeys,
  revokeKey,
  type ApiKeyServiceDeps,
  type ProvisioningSession,
} from "./service.js";
import {
  ApiKeyRolePolicyError,
  normalizeRequestedRoleSubset,
} from "./role-subset.js";

export const API_KEY_MOUNT = "/api/api-keys";

export type ApiKeyRestOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  config?: ApiKeyProvisioningConfig | undefined;
};

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiKeyAuthorizationError) {
    return sendError(reply, error.status, error.code, error.message);
  }
  if (error instanceof ApiKeyNotFoundError) {
    return sendError(reply, error.status, error.code, error.message);
  }
  if (error instanceof ApiKeyProvisioningError) {
    return sendError(reply, error.status, error.code, error.message);
  }
  if (error instanceof ApiKeyRolePolicyError) {
    return sendError(reply, error.status, error.code, error.message);
  }
  // Anything else is ours, not the caller's. Do not describe it.
  reply.log.error({ err: error }, "API key provisioning request failed.");
  return sendError(reply, 500, "INTERNAL", "Request failed.");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function asExpiry(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

export function registerApiKeyRestRoutes(
  app: FastifyInstance,
  options: ApiKeyRestOptions,
): void {
  const { db, config } = options;
  if (!db || !config) {
    app.log.info(
      "API key provisioning is not configured; /api/api-keys is not served. " +
        "Set OPENSHAPEFORGE_API_KEY_SECRET_KEYS and the Keycloak admin variables to enable it.",
    );
    return;
  }

  const deps: ApiKeyServiceDeps = {
    db,
    keyring: config.keyring,
    admin: config.admin,
    entityRoleClientId: config.entityRoleClientId,
  };

  /**
   * Resolve the caller. `credential` is carried through untouched — the ceiling
   * reads it to refuse an API key session, so flattening it here would quietly
   * disable that control.
   */
  async function sessionFor(request: FastifyRequest): Promise<ProvisioningSession> {
    const resolved = await resolveSessionContext(headersFromFastify(request.headers), { db });
    if (!resolved.tenantId || !resolved.userId) {
      throw new ApiKeyAuthorizationError("Authentication is required to manage API keys.");
    }
    return {
      tenantId: resolved.tenantId,
      userId: resolved.userId,
      roles: resolved.roles,
      groups: resolved.groups,
      credential: resolved.credential,
    };
  }

  void app.register(async (instance) => {
    instance.removeContentTypeParser("application/json");
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        if (body === "" || body === undefined) {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(new Error("Request body is not valid JSON."), undefined);
        }
      },
    );

    instance.get(API_KEY_MOUNT, async (request, reply) => {
      try {
        return reply.send({ keys: await listKeys(deps, await sessionFor(request)) });
      } catch (error) {
        return handleError(reply, error);
      }
    });

    instance.post(API_KEY_MOUNT, async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const expiresInDays = asExpiry(body.expiresInDays);
        const created = await createIntegration(deps, await sessionFor(request), {
          displayName: typeof body.displayName === "string" ? body.displayName : "",
          roles: asStringArray(body.roles),
          ...(expiresInDays === undefined ? {} : { expiresInDays }),
          ...(body.roleSubset === undefined
            ? {}
            : { roleSubset: normalizeRequestedRoleSubset(body.roleSubset) }),
        });
        // 201 with the token in the body, once. Never logged, never in a URL.
        return reply.status(201).send(created);
      } catch (error) {
        return handleError(reply, error);
      }
    });

    instance.post(`${API_KEY_MOUNT}/:integrationId/keys`, async (request, reply) => {
      try {
        const { integrationId } = request.params as { integrationId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const expiresInDays = asExpiry(body.expiresInDays);
        const created = await issueKey(deps, await sessionFor(request), {
          integrationId,
          displayName: typeof body.displayName === "string" ? body.displayName : "rotated",
          ...(expiresInDays === undefined ? {} : { expiresInDays }),
          ...(body.roleSubset === undefined
            ? {}
            : { roleSubset: normalizeRequestedRoleSubset(body.roleSubset) }),
        });
        return reply.status(201).send(created);
      } catch (error) {
        return handleError(reply, error);
      }
    });

    instance.delete(`${API_KEY_MOUNT}/keys/:keyId`, async (request, reply) => {
      try {
        const { keyId } = request.params as { keyId: string };
        await revokeKey(deps, await sessionFor(request), keyId);
        return reply.status(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    });

    instance.delete(`${API_KEY_MOUNT}/:integrationId`, async (request, reply) => {
      try {
        const { integrationId } = request.params as { integrationId: string };
        await disableIntegration(deps, await sessionFor(request), integrationId);
        return reply.status(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    });
  });
}
