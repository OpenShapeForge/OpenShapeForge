// SPDX-License-Identifier: BUSL-1.1
import policy from '../generated/compiler/access-policy.json' with { type: 'json' };

export type AccessPolicy = {
  permissions: string[];
  roles: string[];
  groups: { key: string; name: string; roles: string[] }[];
};
export const accessPolicy = policy as AccessPolicy;
export const customRolePrefix = 'custom:';
export const customRoleId = (key: string) => /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key)?.[1];
/** Exact names only: no platform roles, wildcards or nested custom composites. */
export function permittedPermissions(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => accessPolicy.permissions.includes(value)))].sort();
}
