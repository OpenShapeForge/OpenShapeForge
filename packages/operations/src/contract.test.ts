// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  isOperationFailure,
  operationErrorOf,
  operationFailure,
  type OperationConfirmation,
  type OperationConcurrency,
  type OperationResult,
} from "./index.js";

test("a challenge is server-issued, version-bound and single-use", () => {
  const confirmation = {
    mode: "challenge",
    challenge: {
      kind: "type-current-field",
      field: "displayName",
      issuedBy: "server",
      bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
      expiresAfter: "PT5M",
      singleUse: true,
    },
  } satisfies OperationConfirmation;

  expect(confirmation.challenge.bindTo).toContain("target.version");
});

test("an acknowledgement is distinct from server-issued proof", () => {
  const confirmation = {
    mode: "acknowledgement",
  } satisfies OperationConfirmation;

  expect(confirmation).toEqual({ mode: "acknowledgement" });
});

test("concurrency declares version and edit-lease requirements without interface details", () => {
  const concurrency = {
    version: { mode: "required", field: "updatedAt" },
    editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
  } satisfies OperationConcurrency;

  expect(concurrency).toEqual({
    version: { mode: "required", field: "updatedAt" },
    editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
  });
});

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
