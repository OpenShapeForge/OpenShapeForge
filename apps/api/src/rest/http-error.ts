// SPDX-License-Identifier: BUSL-1.1
import { GraphQLError } from "graphql";
import { httpStatusForCode, type FailureBody } from "../connectors/provider-outcome.js";
import { classifyOperationFailure, type ClassifiedOperationFailure } from "../operations/operation-failure-classification.js";

export { OperationRefusal as HttpError } from "../operations/operation-refusal.js";
export type HttpErrorBody = FailureBody;

/**
 * @fastify/rate-limit rejects with an error carrying `statusCode: 429`. It is a
 * deliberate, client-actionable answer rather than an internal fault, so it must
 * survive the redaction below: a 500 tells a client to retry, which is the
 * opposite of what the limiter is trying to say — and retry libraries (and
 * agents on the MCP transport) escalate on 500 while backing off on 429.
 *
 * Recognised structurally rather than by instanceof: the plugin's error type is
 * not exported, and matching on the status it already set keeps this independent
 * of the plugin's internals.
 */
function rateLimitStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 429 ? 429 : undefined;
}

/** Preserve rate-limit and legacy GraphQL refusals at the interface boundary. */
export function toHttpError(error: unknown): ClassifiedOperationFailure {
  if (rateLimitStatus(error) !== undefined) {
    // Mirrors errorResponseBuilder in roles/api.ts: no limiter internals in the
    // body. Retry-After is set by the plugin and survives on the reply.
    return {
      status: 429,
      body: {
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Please retry later.",
          retryable: true,
        },
      },
    };
  }

  if (error instanceof GraphQLError) {
    const code =
      typeof error.extensions?.code === "string"
        ? error.extensions.code
        : "INTERNAL_SERVER_ERROR";
    const status =
      typeof error.extensions?.status === "number"
        ? error.extensions.status
        : httpStatusForCode(code);
    if (status !== undefined) {
      // A database refusal translated by the generated CRUD layer carries the
      // rule's authored detail and hint in its extensions; nothing else does.
      const { detail, hint } = error.extensions ?? {};
      return {
        status,
        body: {
          error: {
            code,
            message: error.message,
            retryable:
              typeof error.extensions?.retryable === "boolean"
                ? error.extensions.retryable
                : false,
            ...(typeof detail === "string" ? { detail } : {}),
            ...(typeof hint === "string" ? { hint } : {}),
          },
        },
      };
    }
  }

  return classifyOperationFailure(error);
}
