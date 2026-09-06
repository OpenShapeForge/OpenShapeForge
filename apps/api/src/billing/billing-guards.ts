// SPDX-License-Identifier: BUSL-1.1
import type { DbSessionInput } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";

/**
 * Input and authorization guards shared by the billing services. They are
 * deliberately tiny: each throws the HttpError the REST layer already knows
 * how to translate, so a service never has to reason about status codes.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireRole(session: DbSessionInput, role: string, action: string): void {
  if (!(session.roles ?? []).includes(role)) {
    throw new HttpError(403, "FORBIDDEN", `Not authorized to ${action}.`);
  }
}

export function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_USER_INPUT", `${label} must be a UUID.`);
  }
  return value;
}

/** Round to cents the same way currency amounts are handled elsewhere on the ledger. */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
