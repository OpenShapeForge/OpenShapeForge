// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { Ajv } from "ajv";
import { operationErrorSchema } from "./index.js";

test("the shared error contract requires safe fields and preserves optional diagnostics", () => {
  const validate = new Ajv({ validateFormats: false }).compile(operationErrorSchema());
  expect(validate({ code: "DENIED", message: "Not available", retryable: false })).toBe(true);
  expect(validate({ code: "RETRY", message: "Wait", retryable: true, retryAt: "2026-11-06T10:00:00Z",
    violations: [{ code: "REQUIRED", message: "Required", field: "name" }], data: { reason: "unavailable" } })).toBe(true);
  expect(validate({ code: "DENIED", message: "Not available" })).toBe(false);
  expect(validate({ code: "DENIED", message: "Not available", retryable: false, secret: "unexpected" })).toBe(false);
  expect(validate({ code: "VALIDATION", message: "Invalid", retryable: false, violations: [{ field: "name" }] })).toBe(false);
});

test("a transport's schema customization cannot change the next projection", () => {
  const first = operationErrorSchema();
  first.required.pop();
  first.properties.message.type = "number";
  const next = operationErrorSchema();
  expect(next.required).toEqual(["code", "message", "retryable"]);
  expect(next.properties.message.type).toBe("string");
});
