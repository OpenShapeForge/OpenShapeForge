// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { ModuleOperationContext, ModuleOperationHandler } from '../modules/contract.js';
import type { OpenShapeForgeDatabase } from '../db/connection.js';
import { withDbSession, type DbSessionInput } from '../db/session.js';
import { appendScopedEntityEventInTransaction } from '../platform/entity-events.js';
import { HttpError } from '../rest/http-error.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../auth/organization-roles.js';
import { ACCOUNT_MANAGE } from './account-session.js';
import { accessPolicy, customRoleId, customRolePrefix, permittedPermissions } from './access-policy.js';

type RoleRow = { id: string; label: string; permissions: string[]; version: number };
export function accessSession(c: ModuleOperationContext, intent: 'manage' | 'catalog' = 'manage') {
  const s = c.session;
  if (!s?.tenantId || !s.userId) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first.');
  const allowed = intent === 'catalog' ? [IDENTITY_LINK_ADMIN_ROLE, ACCOUNT_MANAGE] : [IDENTITY_LINK_ADMIN_ROLE];
  if (!allowed.some(role => s.roles.includes(role))) throw new HttpError(403, 'FORBIDDEN', 'Organization administrator required.');
  if (!c.db) throw new HttpError(503, 'OPERATION_UNAVAILABLE', 'Database unavailable.');
  return { ...s, tenantId: s.tenantId, userId: s.userId };
}
/**
 * Stored permissions that no longer grant anything because the realm dropped
 * them (e.g. CpqCatalog.All.ReadWrite, split by #917). The session ignores
 * them (resolveCustomRolePermissions); the administrator sees them here
 * instead of the role silently losing rights (#943), and may remove them.
 */
export function unavailablePermissions(values: readonly string[]): string[] {
  const granted = new Set(permittedPermissions(values));
  return [...new Set(values.filter(value => !granted.has(value)))].sort();
}
export function roleView(row: RoleRow) {
  const unavailable = unavailablePermissions(row.permissions);
  return { key: customRolePrefix + row.id, label: row.label, permissions: permittedPermissions(row.permissions).join(', '),
    ...(unavailable.length ? { unavailablePermissions: unavailable.join(', ') } : {}), version: row.version, source: 'custom' };
}
export async function customRoles(c: ModuleOperationContext) {
  const s = accessSession(c, 'catalog');
  return withDbSession(c.db!, s, async tx => (await sql<RoleRow>`select id,label,permissions,version
    from platform.organization_access_roles where tenant_id=${s.tenantId}::uuid order by label,id`.execute(tx)).rows);
}
/** One tenant-fenced read for a page of accounts; never combine grants across accounts. */
export async function customRolePermissionsByKey(db: OpenShapeForgeDatabase, session: DbSessionInput, keys: readonly string[]): Promise<Record<string, string[]>> {
  const ids = [...new Set(keys.map(customRoleId).filter((id): id is string => !!id))];
  if (!ids.length) return {};
  return withDbSession(db, session, async tx => {
    const rows = await sql<{id: string; permissions: string[]}>`select id,permissions from platform.organization_access_roles
      where tenant_id=${session.tenantId}::uuid and id in (${sql.join(ids.map(id => sql`${id}::uuid`))})`.execute(tx);
    return Object.fromEntries(rows.rows.map(row => [customRolePrefix + row.id, permittedPermissions(row.permissions)]));
  });
}
export async function resolveCustomRolePermissions(db: OpenShapeForgeDatabase, session: DbSessionInput, keys: readonly string[]) {
  return permittedPermissions(Object.values(await customRolePermissionsByKey(db, session, keys)).flat());
}
export function guarded(handler: ModuleOperationHandler): ModuleOperationHandler {
  return async (input, c) => { try { return await handler(input, c); } catch (error) {
    if (error instanceof HttpError) return {ok:false,status:error.status,code:error.code,body:{error:{code:error.code,message:error.message}}};
    if ([(error as {code?:string})?.code,(error as {errno?:string})?.errno].includes('23505')) return {ok:false,status:409,code:'CONFLICT',body:{error:{code:'CONFLICT',message:'A record with this key or name already exists.'}}};
    throw error;
  } };
}
export const listPermissions = guarded(async (_input,c) => {
  accessSession(c);
  return {value:{permissions:accessPolicy.permissions.map(key=>({key,label:key}))}};
});
export const createRole = guarded(async (input,c) => {
  const s=accessSession(c);
  if(typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length>100) throw new HttpError(400,'VALIDATION','Give a role name of 1–100 characters.');
  const label=input.label.trim();
  const role=await withDbSession(c.db!,s,async tx=>{
    const result=await sql<RoleRow>`insert into platform.organization_access_roles(tenant_id,label)
      values(${s.tenantId}::uuid,${label}) returning id,label,permissions,version`.execute(tx);
    const row=result.rows[0]!;
    await appendScopedEntityEventInTransaction(tx,{aggregateType:'AccessRole',aggregateId:row.id,eventType:'created',payload:{label,actor:s.userId}});
    return roleView(row);
  });
  return {value:role};
});
type Change = { permissions: string[]; revoked: string[]; assigned: string[] };
/**
 * Row locking plus a displayed revision avoids silently overwriting another
 * administrator. `change` sees the locked row and says what it becomes; an
 * unchanged permission list is answered without a write.
 */
function editRole(input: Record<string, unknown>, c: ModuleOperationContext, change: (row: RoleRow) => Change) {
  const s=accessSession(c);
  const id=typeof input.key==='string' ? customRoleId(input.key):undefined;
  if(!id) throw new HttpError(409,'READ_ONLY_ROLE','Default roles are read-only. Create a custom role instead.');
  return withDbSession(c.db!,s,async tx=>{
    const rows=await sql<RoleRow>`select id,label,permissions,version from platform.organization_access_roles
      where tenant_id=${s.tenantId}::uuid and id=${id}::uuid for update`.execute(tx);
    const row=rows.rows[0];
    if(!row)throw new HttpError(404,'NOT_FOUND','Role not found in this organization.');
    const next=change(row);
    if(input.version!==row.version)throw new HttpError(409,'VERSION_CONFLICT','The role changed. Refresh it and try again.');
    if(!next.revoked.length && !next.assigned.length)return roleView(row);
    const updated=await sql<RoleRow>`update platform.organization_access_roles set permissions=ARRAY[${sql.join(next.permissions.map(value=>sql`${value}`))}]::text[],version=version+1,updated_at=now()
      where tenant_id=${s.tenantId}::uuid and id=${id}::uuid returning id,label,permissions,version`.execute(tx);
    for (const [action, list] of [['permission.assigned', next.assigned], ['permission.revoked', next.revoked]] as const) for (const permission of list)
      await appendScopedEntityEventInTransaction(tx,{aggregateType:'AccessRole',aggregateId:id,eventType:'updated',payload:{action,permission,actor:s.userId}});
    return roleView(updated.rows[0]!);
  });
}
const INVALID_PERMISSION = () => new HttpError(400,'VALIDATION','Choose a tenant-assignable permission.');
export const addRolePermission=guarded(async(input,c)=>{
  const permission=input.permission;
  if(typeof permission!=='string' || !accessPolicy.permissions.includes(permission)) throw INVALID_PERMISSION();
  return {value:await editRole(input,c,row=>row.permissions.includes(permission)
    ? {permissions:row.permissions,assigned:[],revoked:[]}
    : {permissions:[...new Set([...row.permissions,permission])].sort(),assigned:[permission],revoked:[]})};
});
/** Also removes a stored permission the realm no longer offers (#943); an unknown one not on the role is refused. */
export const removeRolePermission=guarded(async(input,c)=>{
  const permission=input.permission;
  if(typeof permission!=='string') throw INVALID_PERMISSION();
  return {value:await editRole(input,c,row=>{
    if(!accessPolicy.permissions.includes(permission) && !row.permissions.includes(permission)) throw INVALID_PERMISSION();
    return row.permissions.includes(permission)
      ? {permissions:row.permissions.filter(value=>value!==permission),assigned:[],revoked:[permission]}
      : {permissions:row.permissions,assigned:[],revoked:[]};
  })};
});
/** Drops every stored permission the realm no longer offers, so a returning name cannot silently grant again (#943). */
export const clearUnavailablePermissions=guarded(async(input,c)=>({value:await editRole(input,c,row=>{
  const revoked=unavailablePermissions(row.permissions);
  return {permissions:row.permissions.filter(value=>!revoked.includes(value)),assigned:[],revoked};
})}));
