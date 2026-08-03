// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from "fastify";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { resolveSessionContext } from "../../../../apps/api/src/auth/identity.js";
import {
  enqueueWorkflowInstanceStart,
  WorkflowInstanceCommandError,
} from "./instance-commands.js";

/**
 * `db` is `| undefined` rather than merely optional so this matches
 * `RuntimeModule["restRoutes"]`'s context under `exactOptionalPropertyTypes`,
 * where a present-but-undefined `db` and an absent one are different types.
 * The module contract passes the former, and the 503 below is the reason it can.
 */
export function registerWorkflowWebhookRoutes(
  app: FastifyInstance,
  options: { db?: OpenShapeForgeDatabase | undefined } = {},
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
          idempotencyKey: readDeliveryKey(request.headers),
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

/**
 * What a redelivery of one webhook has in common with its original, and nothing
 * else does.
 *
 * Only the sender can say. Nothing the request carries of its own works: a hash
 * of the body collapses two deliveries that happen to carry the same payload,
 * and two identical callbacks are two runs rather than one; anything derived
 * from the connection is fresh on the retry, which is a key in name only. So the
 * answer is the header a sender stamps on both the original and its retry, and
 * `Idempotency-Key` is the name for it that is not vendor-specific.
 *
 * A delivery without one starts a run per delivery. That is the honest outcome:
 * this route has no way to tell that such a delivery is a repeat, and inventing
 * a key would only move the duplicate somewhere harder to see.
 */
function readDeliveryKey(headers: Record<string, string | string[] | undefined>) {
  return readHeader(headers["idempotency-key"])?.trim() || null;
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
