// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf } from "@openshapeforge/operations";
import { classifyDatabaseError } from "../db/database-refusals.js";
import {
  failureBody,
  httpStatusForCode,
  providerOutcomeOf,
  type FailureBody,
} from "../connectors/provider-outcome.js";

import { OperationRefusal } from "./operation-refusal.js";

export type ClassifiedOperationFailure = { status: number; body: FailureBody };

/**
 * Connector errors are plain classes rather than GraphQLErrors, so they need
 * recognising here or the mapper redacts them. Matched on the `code` field
 * against the canonical table in provider-outcome.ts — the same one the
 * connector REST routes and the MCP renderer read, so the three cannot drift.
 * An unknown code still falls through to a redacted 500, which is the right
 * default for something nobody classified.
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
    named !== "ConnectorConfigurationError" &&
    named !== "ProviderOutcomeError"
  ) {
    return undefined;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Classify trusted failures and redact unexpected exceptions. */
export function classifyOperationFailure(error: unknown): ClassifiedOperationFailure {
  const operationError = operationErrorOf(error);
  if (operationError !== undefined) {
    return {
      // OperationFailure is an intentional, server-authored refusal. Unknown
      // domain codes therefore remain conflicts rather than becoming 500s;
      // unexpected exceptions never reach this branch.
      status: httpStatusForCode(operationError.code) ?? 409,
      body: { error: operationError },
    };
  }

  if (error instanceof OperationRefusal) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
          ...(error.hint !== undefined ? { data: { hint: error.hint } } : {}),
        },
      },
    };
  }

  const connectorCode = connectorErrorCode(error);
  if (connectorCode !== undefined) {
    const status = httpStatusForCode(connectorCode);
    if (status !== undefined) {
      return {
        status,
        body: failureBody(connectorCode, (error as Error).message, providerOutcomeOf(error)),
      };
    }
  }

  // A database refusal that did not pass through the generated CRUD layer
  // (a module or derived tool writing on its own): the same narrow classifier
  // decides, without table context, so constraint answers are generic here.
  const refusal = classifyDatabaseError(error);
  if (refusal !== undefined) {
    return {
      status: refusal.status,
      body: {
        error: {
          code: refusal.code,
          message: refusal.message,
          retryable: refusal.retryable === true,
          ...(refusal.detail !== undefined ? { detail: refusal.detail } : {}),
          ...(refusal.hint !== undefined ? { data: { hint: refusal.hint } } : {}),
        },
      },
    };
  }

  // Anything else (driver errors, bugs) is redacted — parity with the
  // GraphQL endpoint, where Yoga masks unexpected errors.
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error.",
        retryable: false,
      },
    },
  };
}
