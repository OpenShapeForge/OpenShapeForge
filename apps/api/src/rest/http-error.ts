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
  // Connector invocation and execution. These carry their own code and a
  // message that is already safe to surface; without an entry here they fall
  // through to the redacted 500 below, and a caller learns nothing about a
  // refusal it could act on (not configured, disabled, rate limited).
  CONNECTOR_NOT_FOUND: 404,
  CONNECTOR_NOT_EXECUTABLE: 503,
  CONNECTOR_NOT_CONFIGURED: 409,
  CONNECTOR_NEEDS_REPAIR: 409,
  CONNECTOR_DISABLED: 409,
  CONNECTOR_SECRETS_NOT_CONFIGURED: 503,
  CONNECTOR_VERIFY_UNSUPPORTED: 501,
  CONNECTOR_PROVENANCE_REFUSED: 403,
  CONNECTOR_INVALID_INPUT: 400,
  CONNECTOR_INVALID_OUTPUT: 502,
  CONNECTOR_CONTRACT_MISMATCH: 500,
  CONNECTOR_EGRESS_DENIED: 502,
  CONNECTOR_UPSTREAM_ERROR: 502,
  CONNECTOR_TIMEOUT: 504,
  CONNECTOR_RATE_LIMITED: 429,
  CONNECTOR_CIRCUIT_OPEN: 503,
};

/**
 * Connector errors are plain classes rather than GraphQLErrors, so they need
 * recognising here or the mapper redacts them. Matched on the `code` field
 * against the table above: an unknown code still falls through to a redacted
 * 500, which is the right default for something nobody classified.
 */
function connectorErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const named = error.name;
  if (
    named !== "ConnectorInvocationError" &&
    named !== "ConnectorExecutionError" &&
    named !== "ConnectorBoundaryError" &&
    named !== "ConnectorServiceError" &&
    named !== "ConnectorAuthorizationError" &&
    named !== "ConnectorConfigurationError"
  ) {
    return undefined;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function toHttpError(error: unknown): {
  status: number;
  body: HttpErrorBody;
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }

  const connectorCode = connectorErrorCode(error);
  if (connectorCode !== undefined) {
    const status = STATUS_BY_CODE[connectorCode];
    if (status !== undefined) {
      return {
        status,
        body: { error: { code: connectorCode, message: (error as Error).message } },
      };
    }
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
