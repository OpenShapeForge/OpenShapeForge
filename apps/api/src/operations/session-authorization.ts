// SPDX-License-Identifier: BUSL-1.1
/**
 * Role restriction for an already authenticated Operation session.
 *
 * Omitted means the Operation requires no role beyond its authenticated
 * session/tenancy/scopes contract. An explicit empty list remains a useful
 * fail-closed switch. Entity Operations never use this helper: their authored
 * role lists remain mandatory and non-empty.
 */
/**
 * Apply the optional role restriction of an authenticated-session Operation.
 *
 * Authentication, tenant and scope checks live at the caller: this helper
 * deliberately distinguishes an omitted role restriction from an authored
 * empty allow-list. That keeps `{ mode: "session" }` useful for session
 * bootstrap Operations without turning `{ roles: [] }` into public access.
 */
export function sessionOperationRolesAllow(
  required: readonly string[] | undefined,
  held: readonly string[],
): boolean {
  if (required === undefined) return true;
  if (required.length === 0) return false;
  const audience = new Set(held);
  return required.some((role) => audience.has(role));
}
