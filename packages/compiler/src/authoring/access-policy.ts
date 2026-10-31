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

/** A database projection of the compiled application contract, never editable tenant content. */
export function buildAuthorizationOperationInventory(
  catalog: import('../plugins.js').StaticOperationCatalog,
  manifest: import('../schema.js').PlatformSchemaManifest,
  policy: { permissions: readonly string[] },
) {
  const rows = catalog.operations.flatMap(operation => {
    const entity = 'entityName' in operation ? operation.entityName : operation.target?.entityName;
    if (!entity) return [];
    const roles = 'authorization' in operation ? operation.authorization.roles : operation.auth.mode === 'session' ? operation.auth.roles ?? [] : [];
    const table = [...manifest.tables, ...(manifest.entitySubtypes ?? [])].find(table => table.source?.authoringEntityName === entity);
    if (!table) return [{ id: operation.id, entity, roles, grantable: false, fields: {} as Record<string,{column:string;type:string;display:boolean}> }];
    const displayFields = new Set([...(table.source?.displayTemplate ?? '').matchAll(/{{\s*([\w]+)\s*}}/g)].map(match => match[1]));
    const fields = Object.fromEntries(table.columns.flatMap(column =>
      !column.classification && !column.fieldPolicy && !column.document &&
      ['text','uuid','boolean','integer'].includes(column.type)
        ? [[column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_,char:string)=>char.toUpperCase()), { column: column.name, type: column.type, display: displayFields.has(column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_,char:string)=>char.toUpperCase())) }]] : []));
    const grantable = !entity.startsWith('Authorization') && !roles.includes('Organization.Security.Manage') &&
      (roles.some(role => policy.permissions.includes(role)) || ('auth' in operation && operation.auth.mode === 'session' && Boolean(operation.auth.recordAction)));
    return [{ id: operation.id, entity, roles, grantable, fields }];
  });
  return rows.sort((a,b)=>a.id.localeCompare(b.id));
}
