// SPDX-License-Identifier: BUSL-1.1

export type RoleSubset = string[] | null;

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
  roleSubset: RoleSubset;
  /** The full resulting role set the privilege ceiling must evaluate. */
  rolesForCeiling: string[];
};

/**
 * Resolve the role policy for a key issued against an existing integration.
 *
 * A null subset inherits the integration's complete declared role set. If that
 * stored set is malformed, persisting an empty subset prevents the key from
 * falling through to the service account's unrestricted runtime roles.
 */
export function resolveIssuedKeyRolePolicy(
  storedGrantedRoles: unknown,
  requestedSubset: unknown,
): IssuedKeyRolePolicy {
  const roleSubset = normalizeRequestedRoleSubset(requestedSubset);
  if (roleSubset !== null) {
    return { roleSubset, rolesForCeiling: [...roleSubset] };
  }

  const grantedRoles = parseRoleArray(decodeStoredJson(storedGrantedRoles));
  if (!grantedRoles) {
    return { roleSubset: [], rolesForCeiling: [] };
  }

  return { roleSubset: null, rolesForCeiling: grantedRoles };
}
