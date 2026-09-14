// SPDX-License-Identifier: BUSL-1.1
/** REST projection of the central edit-lease service. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import { headersFromFastify } from "../http/headers.js";
import {
  acquireEditLeaseForEntityOperation,
  releaseEntityEditLease,
  restEditLeaseOperationIdsForSession,
  renewEntityEditLease,
} from "../operations/entity/index.js";
import { HttpError, toHttpError } from "./http-error.js";

export const OPERATION_LEASES_PATH = "/api/operation-leases";

function requireString(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "BAD_USER_INPUT", `Request body requires ${key}.`);
  }
  return value;
}

export function registerEditLeaseRestRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
): void {
  async function requireContext(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: DbSessionInput;
  }> {
    const resolved = await resolveSessionContext(
      headersFromFastify(request.headers),
      { db: options.db },
    );
    if (!resolved.tenantId || !resolved.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Edit leases require an authenticated session.",
      );
    }
    if (!options.db) {
      throw new HttpError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured for edit leases.",
      );
    }
    return {
      db: options.db,
      session: {
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        userDisplayName: resolved.userDisplayName ?? null,
        roles: [...resolved.roles],
        groups: [...resolved.groups],
        relationGroupIds: [...(resolved.relationGroupIds ?? [])],
        scope: resolved.scope,
      },
    };
  }

  void app.register(async (instance) => {
    instance.removeContentTypeParser("application/json");
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, body ? JSON.parse(body as string) : {});
        } catch {
          done(new HttpError(400, "BAD_USER_INPUT", "Request body is not valid JSON."), undefined);
        }
      },
    );
    instance.setErrorHandler((error, _request, reply) => {
      const projected = toHttpError(error);
      void reply.status(projected.status).send(projected.body);
    });

    instance.post(OPERATION_LEASES_PATH, async (request, reply) => {
      const context = await requireContext(request);
      const operationId = requireString(request.body, "operationId");
      if (!restEditLeaseOperationIdsForSession(context.session).includes(operationId)) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "The requested edit operation is not available through this REST API.",
        );
      }
      const lease = await acquireEditLeaseForEntityOperation(
        context.db,
        context.session,
        {
          operationId,
          targetId: requireString(request.body, "targetId"),
        },
      );
      return reply.status(201).send({ data: lease, operations: [] });
    });

    instance.post(`${OPERATION_LEASES_PATH}/renew`, async (request, reply) => {
      const context = await requireContext(request);
      const lease = await renewEntityEditLease(
        context.db,
        context.session,
        requireString(request.body, "leaseToken"),
        restEditLeaseOperationIdsForSession(context.session),
      );
      return reply.send({ data: lease, operations: [] });
    });

    instance.post(`${OPERATION_LEASES_PATH}/release`, async (request, reply) => {
      const context = await requireContext(request);
      const released = await releaseEntityEditLease(
        context.db,
        context.session,
        requireString(request.body, "leaseToken"),
      );
      return reply.send({ data: released, operations: [] });
    });
  });
}
