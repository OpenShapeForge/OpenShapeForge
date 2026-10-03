// SPDX-License-Identifier: BUSL-1.1
import { operationFailure, type OperationError } from "@openshapeforge/operations";
import type { OperationAvailabilityDecision } from "@openshapeforge/plugin-runtime";
import type { ModuleOperationAvailabilityHandler } from "../modules/contract.js";
import type { OperationContract } from "./runtime.js";

const contractFailure = () => operationFailure({
  code: "HANDLER_CONTRACT_VIOLATION",
  message: "The available actions could not be determined safely.",
  retryable: false,
});
const errorKeys = new Set(["code", "message", "detail", "violations", "retryable", "retryAt", "data"]);

function plainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => plainJson(child, ancestors));
  ancestors.delete(value);
  return valid;
}

/** Validate the complete batch; omitted targets must never silently become allowed. */
export function validateAvailabilityDecisions(
  operation: Pick<OperationContract, "errors">,
  targetIds: readonly string[],
  value: unknown,
): Readonly<Record<string, OperationAvailabilityDecision>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractFailure();
  const result = value as Record<string, OperationAvailabilityDecision>;
  const expected = new Set(targetIds);
  if (Object.keys(result).length !== expected.size || Object.keys(result).some(id => !expected.has(id))) {
    throw contractFailure();
  }
  for (const id of expected) {
    if (!Object.hasOwn(result, id)) throw contractFailure();
    const decision = result[id];
    if (!decision || typeof decision !== "object" || typeof decision.available !== "boolean") throw contractFailure();
    if (decision.available) {
      if (Object.keys(decision).some(key => key !== "available")) throw contractFailure();
      continue;
    }
    const error = decision.error;
    if (Object.keys(decision).some(key => key !== "available" && key !== "error") ||
        !error || typeof error !== "object" || Array.isArray(error) || Object.keys(error).some(key => !errorKeys.has(key)) || typeof error.code !== "string" ||
        typeof error.message !== "string" || !error.message.trim() ||
        !operation.errors.some(declared => declared.code === error.code) ||
        (error.detail !== undefined && typeof error.detail !== "string") ||
        typeof error.retryable !== "boolean" ||
        (error.data !== undefined && (!error.data || typeof error.data !== "object" || Array.isArray(error.data))) ||
        (error.violations !== undefined && (!Array.isArray(error.violations) || error.violations.some(violation =>
          !violation || (violation.field !== undefined && typeof violation.field !== "string") || typeof violation.code !== "string" ||
          Object.keys(violation).some(key => !["field", "code", "message", "detail"].includes(key)) ||
          typeof violation.message !== "string" || (violation.detail !== undefined && typeof violation.detail !== "string")))) ||
        (error.retryAt !== undefined && (typeof error.retryAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(error.retryAt) || !Number.isFinite(Date.parse(error.retryAt))))) {
      throw contractFailure();
    }
    // No cyclic values, class instances or transport objects may cross an offer boundary.
    if (!plainJson(decision)) throw contractFailure();
  }
  return JSON.parse(JSON.stringify(result)) as Record<string, OperationAvailabilityDecision>;
}

export async function evaluateOperationAvailability(
  operation: Pick<OperationContract, "errors">,
  handler: ModuleOperationAvailabilityHandler,
  targetIds: readonly string[],
  context: Parameters<ModuleOperationAvailabilityHandler>[1],
): Promise<Readonly<Record<string, OperationAvailabilityDecision>>> {
  if (targetIds.length === 0) return {};
  let result: unknown;
  try { result = await handler(targetIds, context); }
  catch { throw contractFailure(); }
  return validateAvailabilityDecisions(operation, targetIds, result);
}

export function unavailableError(decision: OperationAvailabilityDecision): OperationError | undefined {
  return decision.available ? undefined : decision.error;
}
