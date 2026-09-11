// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  isOperationFailure,
  operationErrorOf,
  operationFailure,
  type OperationResult,
} from "./index.js";

test("validation and temporary refusals use one canonical failure contract", () => {
  const result: OperationResult<never> = {
    error: {
      code: "VALIDATION",
      message: "Check the entered values.",
      violations: [
        { field: "email", code: "INVALID_EMAIL", message: "Enter a valid email address." },
      ],
      retryable: false,
    },
  };

  expect(isOperationFailure(result)).toBe(true);
});

test("OperationFailure carries only interface-neutral failure meaning", () => {
  const failure = operationFailure({
    code: "LOCKED",
    message: "This record is currently being edited.",
    retryable: true,
    retryAt: "2026-09-11T15:15:00.000Z",
  });

  expect(operationErrorOf(failure)).toEqual({
    code: "LOCKED",
    message: "This record is currently being edited.",
    retryable: true,
    retryAt: "2026-09-11T15:15:00.000Z",
  });
});
