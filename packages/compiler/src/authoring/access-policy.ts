// SPDX-License-Identifier: BUSL-1.1
import type { AuthorizationConfigFile } from './types/authoring.js';
import { buildRoleComposites } from './role-composites.js';
import type { KeycloakRealmArtifact } from './generators/keycloak.js';

export function buildAccessPolicy(configs: readonly AuthorizationConfigFile[], realms: readonly KeycloakRealmArtifact[]) {
  const owners = configs.filter(config => config.organizationAccess);
  if (owners.length > 1) throw new Error('Only one tenant organizationAccess policy may be authored.');
  const config = owners[0];
  const policy = config?.organizationAccess ?? { permissions: [], roles: [], groups: [] };
  if (!config) return policy;
  const realm = config.realm?.name ?? 'openshapeforge';
  const client = config.keycloak?.entityRoleClient ?? config.keycloak?.client;
  if (typeof client !== 'string') throw new Error('organizationAccess requires an entity-role client.');
  const artifact = realms.map(item => JSON.parse(item.contents)).find(item => item.realm === realm);
  const declared = new Set<string>((artifact?.roles?.client?.[client] ?? []).map((role: {name: string}) => role.name));
  const composites = buildRoleComposites(realms)[realm]?.clients[client] ?? {};
  for (const permission of policy.permissions) {
    if (!declared.has(permission) || composites[permission] || permission.startsWith('Platform.') || permission === config.identity?.administratorRole) {
      throw new Error(`Not a tenant-assignable leaf permission: ${permission}`);
    }
  }
  for (const role of policy.roles) if (!composites[role]) throw new Error(`Unknown default access role: ${role}`);
  const keys = new Set<string>();
  for (const group of policy.groups) {
    if (keys.has(group.key)) throw new Error(`Duplicate starter group: ${group.key}`);
    keys.add(group.key);
    for (const role of group.roles) if (!policy.roles.includes(role)) throw new Error(`Unknown starter role: ${role}`);
  }
  return policy;
}
