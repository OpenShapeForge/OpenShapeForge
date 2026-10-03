// SPDX-License-Identifier: BUSL-1.1
import {sql} from 'kysely';
import type {ModuleOperationContext} from '../modules/contract.js';
import {withDbSession} from '../db/session.js';
import {appendScopedEntityEventInTransaction} from '../platform/entity-events.js';
import {HttpError} from '../rest/http-error.js';
import composites from '../generated/compiler/role-composites.json' with {type:'json'};
import labels from '../generated/compiler/role-labels.json' with {type:'json'};
import {expandRoleComposites} from '../auth/person-roles.js';
import {memberRoleClientId} from '../auth/employee-invitations.js';
import { accessSession, customRoles, roleView, guarded } from './custom-roles.js';
import { accessPolicy } from './access-policy.js';

export function realmName(){return new URL(process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim() || 'http://localhost/realms/openshapeforge').pathname.split('/realms/')[1]?.split('/')[0];}
export function roleCatalog(locale='en'){
 const table=(composites as any)[realmName() ?? '']?.clients?.[memberRoleClientId()] ?? {};
 return Object.keys(table).filter(key=>!accessPolicy.roles.length || accessPolicy.roles.includes(key)).sort().map(key=>({key,label:(labels as any)[key]?.label?.[locale] ?? (labels as any)[key]?.label?.en ?? key,permissions:expandRoleComposites(realmName(),[key]).filter(r=>r!==key).join(', '),source:'default',version:0}));
}
export function labelRoles(roles:readonly string[],locale='en'){return roles.map(key=>(labels as any)[key]?.label?.[locale] ?? (labels as any)[key]?.label?.en ?? key).join(', ');}
function uuid(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new HttpError(400,'VALIDATION','A valid record id is required.');return value;}
async function catalogue(c:ModuleOperationContext){return [...roleCatalog(c.session?.locale),...(await customRoles(c)).map(roleView)];}
async function roleKey(value:unknown,c:ModuleOperationContext){if(typeof value!=='string'||!(await catalogue(c)).some(r=>r.key===value))throw new HttpError(400,'VALIDATION','Choose a role from this organization.');return value;}
function assignment(row:any,locale?:string,catalogue:readonly {key:string;label:string}[]=[]){return {id:row.id,relationGroupId:row.relation_group_id,roleKey:row.role,roleLabel:catalogue.find(r=>r.key===row.role)?.label ?? labelRoles([row.role],locale)};}
export const listRoles=guarded(async(_input,c)=>{accessSession(c,'catalog');return {value:{roles:await catalogue(c)}};});
export const getRole=guarded(async(input,c)=>{accessSession(c,'catalog');const role=(await catalogue(c)).find(r=>r.key===(input.key??input.id));if(!role)throw new HttpError(404,'NOT_FOUND','Role not found.');return {value:role};});
export const listGroupRoles=guarded(async(input,c)=>{const s=accessSession(c);const group=uuid(input.relationGroupId);const rows=await withDbSession(c.db!,s,async tx=>(await sql`select id,relation_group_id,role from platform.relation_group_roles where tenant_id=${s.tenantId}::uuid and relation_group_id=${group}::uuid order by role`.execute(tx)).rows);const names=await catalogue(c);return {value:{assignments:rows.map(r=>assignment(r,s.locale,names))}};});
export const getGroupRole=guarded(async(input,c)=>{const s=accessSession(c);const id=uuid(input.id);const group=uuid(input.relationGroupId);const rows=await withDbSession(c.db!,s,async tx=>(await sql`select id,relation_group_id,role from platform.relation_group_roles where tenant_id=${s.tenantId}::uuid and id=${id}::uuid and relation_group_id=${group}::uuid`.execute(tx)).rows);if(!rows[0])throw new HttpError(404,'NOT_FOUND','Assignment not found.');return {value:assignment(rows[0],s.locale,await catalogue(c))};});
export const assignGroupRole=guarded(async(input,c)=>{const s=accessSession(c);const group=uuid(input.relationGroupId);const role=await roleKey(input.roleKey,c);const row=await withDbSession(c.db!,s,async tx=>{
 const target=await sql`select id from erp.relation_groups where tenant_id=${s.tenantId}::uuid and id=${group}::uuid for update`.execute(tx);if(!target.rows.length)throw new HttpError(404,'NOT_FOUND','Group not found.');
 const result = (await sql`insert into platform.relation_group_roles (tenant_id,relation_group_id,role) values (${s.tenantId}::uuid,${group}::uuid,${role}) on conflict (tenant_id,relation_group_id,role) do update set role=excluded.role returning id,relation_group_id,role`.execute(tx)).rows[0];
 await appendScopedEntityEventInTransaction(tx,{aggregateType:"RelationGroup",aggregateId:group,eventType:"updated",payload:{action:"role.assigned",role,actor:s.userId}});
 return result;
 });return {value:assignment(row,s.locale,await catalogue(c))};});
export const revokeGroupRole=guarded(async(input,c)=>{const s=accessSession(c);const id=uuid(input.id);const group=uuid(input.relationGroupId);await withDbSession(c.db!,s,async tx=>{const removed=await sql`delete from platform.relation_group_roles where tenant_id=${s.tenantId}::uuid and id=${id}::uuid and relation_group_id=${group}::uuid returning role`.execute(tx); if(removed.rows.length) await appendScopedEntityEventInTransaction(tx,{aggregateType:"RelationGroup",aggregateId:group,eventType:"updated",payload:{action:"role.revoked",actor:s.userId}});});return {value:{removed:true}};});
