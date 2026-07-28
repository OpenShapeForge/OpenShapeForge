// SPDX-License-Identifier: BUSL-1.1
/**
 * Single translation point from the generated CRUD layer's GraphQLError
 * vocabulary (extensions.code / extensions.status) to REST HTTP responses.
 * Keeping the mapping here means REST handlers delegate to the exact same
 * CRUD functions as the GraphQL resolvers without duplicating error policy.
 */
import { GraphQLError } from "graphql";

export type HttpErrorBody = { error: { code: string; message: string } };

/** REST-local error for conditions that never pass through the CRUD layer. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  BAD_USER_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  GENERATED_CRUD_NOT_ENABLED: 404,
  DATABASE_NOT_CONFIGURED: 503,
};

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

export function toHttpError(error: unknown): {
  status: number;
  body: HttpErrorBody;
} {
  if (rateLimitStatus(error) !== undefined) {
    // Mirrors errorResponseBuilder in roles/api.ts: no limiter internals in the
    // body. Retry-After is set by the plugin and survives on the reply.
    return {
      status: 429,
      body: {
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Please retry later.",
        },
      },
    };
  }

  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
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
        : STATUS_BY_CODE[code];
    if (status !== undefined) {
      return { status, body: { error: { code, message: error.message } } };
    }
  }

  // Anything else (driver errors, bugs) is redacted — parity with the
  // GraphQL endpoint, where Yoga masks unexpected errors.
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error." },
    },
  };
}
