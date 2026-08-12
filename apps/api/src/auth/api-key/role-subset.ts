// SPDX-License-Identifier: BUSL-1.1

export type RoleSubset = string[] | null;

export class ApiKeyRolePolicyError extends Error {
  readonly code = "API_KEY_ROLE_POLICY_INVALID";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ApiKeyRolePolicyError";
  }
}

function parseRoleArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (role): role is string => typeof role === "string" && role.trim().length > 0,
    )
  ) {
    return undefined;
  }
  return [...value];
}

function decodeStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a subset supplied by a provisioning caller.
 *
 * Omitted and explicit null both retain the documented unrestricted meaning.
 * An empty array deliberately grants no roles. Any other shape is malformed
 * and also grants no roles, rather than being filtered into a wider value.
 */
export function normalizeRequestedRoleSubset(value: unknown): RoleSubset {
  if (value === undefined || value === null) return null;
  return parseRoleArray(value) ?? [];
}

/**
 * Interpret a subset read from Postgres.
 *
 * Only SQL NULL means unrestricted. JSON null, invalid JSON and arrays with an
 * invalid element are corrupt stored data and therefore narrow to no roles.
 */
export function parseStoredRoleSubset(value: unknown, isSqlNull: boolean): RoleSubset {
  if (isSqlNull) return null;
  return parseRoleArray(decodeStoredJson(value)) ?? [];
}

export type IssuedKeyRolePolicy = {
  /** The exact subset persisted on the new key. */
  roleSubset: string[];
  /** The full resulting role set the privilege ceiling must evaluate. */
  rolesForCeiling: string[];
};

/**
 * Resolve the role policy for a key issued against an existing integration.
 *
 * A null subset snapshots the integration's complete declared role set into
 * the key. Persisting the same set the ceiling checks prevents later Keycloak
 * drift from widening the key. A malformed stored set aborts issuance.
 */
export function resolveIssuedKeyRolePolicy(
  storedGrantedRoles: unknown,
  requestedSubset: unknown,
): IssuedKeyRolePolicy {
  const grantedRoles = parseRoleArray(decodeStoredJson(storedGrantedRoles));
  if (!grantedRoles) {
    throw new ApiKeyRolePolicyError(
      "The integration's stored role grant is invalid; no API key was issued.",
    );
  }

  const roleSubset = normalizeRequestedRoleSubset(requestedSubset);
  if (roleSubset !== null) {
    return { roleSubset, rolesForCeiling: [...roleSubset] };
  }

  return { roleSubset: [...grantedRoles], rolesForCeiling: grantedRoles };
}
