// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { GraphQLError } from "graphql";
import { toHttpError } from "../rest/http-error.js";
import { classifyOperationFailure } from "./operation-failure-classification.js";
import { OperationRefusal } from "./operation-refusal.js";

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
  expect(toHttpError(legacy)).toEqual({
    status: 403,
    body: { error: {
      code: "FORBIDDEN", message: "Legacy refusal.", retryable: false,
      detail: "Legacy detail.", hint: "Legacy hint.",
    } },
  });
  expect(classifyOperationFailure(legacy)).toEqual({
    status: 500,
    body: { error: {
      code: "INTERNAL_SERVER_ERROR", message: "Internal server error.", retryable: false,
    } },
  });
});
