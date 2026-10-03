// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { EntityOperationContract } from "./types.js";

/** Preserve the authored schema; only bind transport-owned identifiers. */
export function pluginEntityTransportInput(operation: EntityOperationContract, value: unknown, targetId?: string, idempotencyKey?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operationFailure({ code: "VALIDATION", message: "Operation input must be an object.", retryable: false });
  }
  const input = { ...value } as Record<string, unknown>;
  const bind = (field: string, value: string) => {
    if (Object.hasOwn(input, field) && input[field] !== value) {
      throw operationFailure({ code: "VALIDATION", message: "The request contains conflicting Operation identifiers.", retryable: false,
        violations: [{ field, code: "CONFLICTING_VALUE", message: "This value differs from the request binding." }] });
    }
    input[field] = value;
  };
  if (targetId !== undefined) bind(operation.target?.scope === "record" ? operation.target.inputField : "id", targetId);
  if (idempotencyKey !== undefined && operation.reliability.idempotency.mode === "keyed") {
    const field = operation.reliability.idempotency.inputField;
    if (!field) throw operationFailure({ code: "INTERNAL_SERVER_ERROR", message: "The Operation key binding is missing.", retryable: false });
    bind(field, idempotencyKey);
  }
  return input;
}
