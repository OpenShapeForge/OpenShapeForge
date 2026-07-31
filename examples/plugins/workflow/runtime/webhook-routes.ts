// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from "fastify";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { resolveSessionContext } from "../../../../apps/api/src/auth/identity.js";
import {
  enqueueWorkflowInstanceStart,
  WorkflowInstanceCommandError,
} from "./instance-commands.js";

export function registerWorkflowWebhookRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase } = {},
) {
  app.post<{ Params: { definitionId: string } }>(
    "/api/workflow/triggers/webhook/:definitionId",
    async (request, reply) => {
      if (!options.db) {
        return reply.code(503).send({
          error: "workflow_database_unavailable",
          message: "DATABASE_URL is required before workflow webhook triggers can dispatch.",
        });
      }

      const session = await resolveSessionContext(headersFromFastify(request.headers));
      if (!session.tenantId || !session.userId) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "A signed tenant and user context is required.",
        });
      }

      try {
        const instance = await enqueueWorkflowInstanceStart(options.db, session, {
          definitionId: request.params.definitionId,
          context: readBodyRecord(request.body),
          triggerType: "webhook",
          triggerMeta: {
            path: request.url,
            method: request.method,
            userAgent: readHeader(request.headers["user-agent"]),
          },
        });

        return reply.code(202).send({
          status: "accepted",
          instanceId: instance.id,
          definitionId: request.params.definitionId,
        });
      } catch (error) {
        if (error instanceof WorkflowInstanceCommandError) {
          return reply.code(statusForWorkflowCommandError(error)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}

function headersFromFastify(headers: Record<string, string | string[] | undefined>) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function readHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(",") : value;
}

function readBodyRecord(body: unknown): Record<string, unknown> {
  if (body instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function statusForWorkflowCommandError(error: WorkflowInstanceCommandError) {
  switch (error.code) {
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "BAD_USER_INPUT":
      return 400;
    default:
      return 409;
  }
}
