// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationFailure } from "@openshapeforge/operations";
import { GraphQLError } from "graphql";
import { ConnectorAuthorizationError } from "../connectors/authorization.js";
import { toHttpError } from "../rest/http-error.js";
import { classifyOperationFailure } from "./operation-failure-classification.js";
import { OperationRefusal } from "./operation-refusal.js";
import { DeclaredOperationError, runtimeOperationError } from "./runtime.js";

test("a trusted Operation refusal preserves status and authored detail at the REST edge", () => {
  const refusal = new OperationRefusal(403, "FORBIDDEN", "Session lacks a required operation role.", {
    detail: "Read permission is required.",
    hint: "Contact an administrator.",
  });
  const expected = {
    status: 403,
    body: { error: {
      code: "FORBIDDEN",
      message: "Session lacks a required operation role.",
      retryable: false,
      detail: "Read permission is required.",
      data: { hint: "Contact an administrator." },
    } },
  };
  expect(classifyOperationFailure(refusal)).toEqual(expected);
  expect(toHttpError(refusal)).toEqual(expected);
});

test("only the interface adapter recognizes legacy GraphQL refusals", () => {
  const legacy = new GraphQLError("Legacy refusal.", {
    extensions: { code: "FORBIDDEN", status: 403, detail: "Legacy detail.", hint: "Legacy hint." },
  });
  const projectedLegacy = {
    status: 403,
    body: { error: {
      code: "FORBIDDEN", message: "Legacy refusal.", retryable: false,
      detail: "Legacy detail.", hint: "Legacy hint.",
    } },
  };
  expect(toHttpError(legacy)).toEqual(projectedLegacy);
  expect(runtimeOperationError(legacy)).toEqual({
    code: "INTERNAL_SERVER_ERROR", message: "Internal server error.", retryable: false,
  });
});

test("nested Operations preserve a declared refusal instead of projecting it as a resolver error", () => {
  const declaration = { status: 409, code: "WORKFLOW_CONFLICT", description: "Workflow conflict." };
  const error = {
    code: declaration.code,
    message: "The workflow changed since it was read.",
    detail: "Reload the workflow.",
    retryable: false,
  };
  const declared = new DeclaredOperationError(declaration, {
    ok: false, status: declaration.status, code: declaration.code, body: { error },
  });

  expect(runtimeOperationError(declared)).toEqual(error);
});

test("trusted Operation failures preserve an unrecognized domain code as a conflict", () => {
  const error = { code: "WORKFLOW_CONFLICT", message: "The workflow changed.", retryable: false };
  const failure = operationFailure(error);

  expect(classifyOperationFailure(failure)).toEqual({ status: 409, body: { error } });
  expect(runtimeOperationError(failure)).toEqual(error);
});

test("nested Operations keep connector denial codes and messages", () => {
  const refusal = new ConnectorAuthorizationError("UNAUTHENTICATED", "Connector session required.");

  expect(toHttpError(refusal).status).toBe(401);
  expect(runtimeOperationError(refusal)).toMatchObject({
    code: "UNAUTHENTICATED", message: "Connector session required.", retryable: false,
  });
});
