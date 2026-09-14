// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { validateAvailabilityDecisions, evaluateOperationAvailability } from "./availability.js";

const operation = { errors: [{ status: 409, code: "INVALID_STATE", description: "Current state refuses this action." }] };
const refusal = { available: false as const, error: { code: "INVALID_STATE", message: "This record is already published.", retryable: false } };

test("availability preserves declared friendly refusals and complete allowed batches", () => {
  expect(validateAvailabilityDecisions(operation, ["a", "b"], { a: refusal, b: { available: true } })).toEqual({ a: refusal, b: { available: true } });
});

test("availability fails closed for missing, extra, malformed or undeclared decisions", () => {
  for (const value of [null, [], {}, { b: refusal }, { a: refusal, b: refusal },
    { a: { available: true, error: refusal.error } },
    { a: { available: false, error: { code: "PRIVATE_INTERNAL_ERROR", message: "secret" } } },
    { a: { available: false, error: { code: "INVALID_STATE", message: "", retryable: false } } },
    { a: { available: false, error: { ...refusal.error, retryAt: "later" } } },
    { a: { available: false, error: { ...refusal.error, data: new Date() } } },
    { a: { available: false, error: { ...refusal.error, stack: "private runtime detail" } } },
    { a: { available: false, error: { ...refusal.error, violations: [{ code: "STATE" }] } } },
    { a: { available: false, error: { ...refusal.error, retryAt: "2026-09-13" } } },
  ]) expect(() => validateAvailabilityDecisions(operation, ["a"], value)).toThrow("could not be determined safely");
});

test("availability does not expose owner exceptions", async () => {
  await expect(evaluateOperationAvailability(operation, async () => { throw new Error("private database detail"); }, ["a"], {} as never))
    .rejects.toThrow("could not be determined safely");
});
