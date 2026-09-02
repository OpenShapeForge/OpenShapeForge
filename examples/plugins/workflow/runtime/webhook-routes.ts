// SPDX-License-Identifier: BUSL-1.1
import type { ModuleOperationHandler } from "../../../../apps/api/src/modules/contract.js";
import { HttpError } from "../../../../apps/api/src/rest/http-error.js";
import {
  enqueueWorkflowInstanceStart,
  WorkflowInstanceCommandError,
} from "./instance-commands.js";

export const handleWorkflowWebhookOperation: ModuleOperationHandler = async (input, context) => {
  if (!context.db) {
    throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "DATABASE_URL is required before workflow webhook triggers can dispatch.");
  }
  if (!context.session?.tenantId || !context.session.userId) {
    throw new HttpError(401, "UNAUTHENTICATED", "A signed tenant and user context is required.");
  }
  const request = context.request;
  const requestBody = request ? readBodyRecord(request.body) : undefined;
  const explicitContext = input.context && typeof input.context === "object" && !Array.isArray(input.context)
    ? input.context as Record<string, unknown>
    : undefined;
  const idempotencyKey = String(input.idempotencyKey).trim();
  try {
    const instance = await enqueueWorkflowInstanceStart(context.db, context.session, {
      definitionId: String(input.definitionId),
      context: explicitContext ?? requestBody ?? {},
      idempotencyKey,
      triggerType: "webhook",
      triggerMeta: request ? {
        path: request.url,
        method: request.method,
        userAgent: readHeader(request.headers["user-agent"]),
      } : { transport: context.transport },
    });
    return {
      ...(context.transport === "rest" ? { status: 202 } : {}),
      value: { status: "accepted", instanceId: instance.id, definitionId: String(input.definitionId) },
    };
  } catch (error) {
    if (error instanceof WorkflowInstanceCommandError) {
      throw new HttpError(statusForWorkflowCommandError(error), error.code, error.message);
    }
    throw error;
  }
};

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
