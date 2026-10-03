// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { appendScopedEntityEventInTransaction } from '../platform/entity-events.js';
import { HttpError } from '../rest/http-error.js';
import { accessSession, guarded } from './custom-roles.js';
import type { ModuleOperationHandler } from '../modules/contract.js';

function membership(add:boolean):ModuleOperationHandler{return guarded(async(input,c)=>{
 const s=accessSession(c);
 if(!s.roles.includes('Relations.RelationGroups.ReadWrite'))throw new HttpError(403,'FORBIDDEN','Group membership management permission required.');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(typeof input.relationId!=='string'||!uuid.test(input.relationId)||typeof input.groupId!=='string'||!uuid.test(input.groupId))throw new HttpError(400,'VALIDATION','Select a member and a group.');
 const relationId=input.relationId,groupId=input.groupId;
 const updated=await withDbSession(c.db!,s,async tx=>{
  const group=await sql`select id from erp.relation_groups where tenant_id=${s.tenantId}::uuid and id=${groupId}::uuid and status='active' for update`.execute(tx);
  const member=await sql`select identity_id from platform.identity_relations where tenant_id=${s.tenantId}::uuid and relation_id=${relationId}::uuid and status='linked'`.execute(tx);
  if(!group.rows.length||!member.rows.length)throw new HttpError(404,'NOT_FOUND','Select an active group and linked member from this organization.');
  if(add){
    await sql`update erp.relation_group_memberships set status='inactive',updated_at=now()
      where tenant_id=${s.tenantId}::uuid and relation_id=${relationId}::uuid and relation_group_id=${groupId}::uuid
      and status='active' and end_date<current_date`.execute(tx);
    const existing=await sql<{valid:boolean}>`select (start_date is null or start_date<=current_date) and (end_date is null or end_date>=current_date) as valid
      from erp.relation_group_memberships where tenant_id=${s.tenantId}::uuid and relation_id=${relationId}::uuid and relation_group_id=${groupId}::uuid and status='active'`.execute(tx);
    if(existing.rows.some(row=>!row.valid))throw new HttpError(409,'CONFLICT','An existing membership has validity dates. Edit it explicitly.');
    if(existing.rows.length)return false;
    await sql`insert into erp.relation_group_memberships(tenant_id,relation_id,relation_group_id,status,role,start_date,is_primary)
      values(${s.tenantId}::uuid,${relationId}::uuid,${groupId}::uuid,'active','member',current_date,false)
      on conflict (tenant_id,relation_id,relation_group_id,start_date)
      do update set status='active',end_date=null,updated_at=now()`.execute(tx);
  }else {
    const removed=await sql`update erp.relation_group_memberships set status='inactive',updated_at=now()
      where tenant_id=${s.tenantId}::uuid and relation_id=${relationId}::uuid and relation_group_id=${groupId}::uuid and status='active'
      returning id`.execute(tx);
    if(!removed.rows.length)return false;
  }
  await appendScopedEntityEventInTransaction(tx,{aggregateType:'RelationGroup',aggregateId:groupId,eventType:'updated',payload:{action:add?'member.added':'member.removed',relationId,actor:s.userId}});
  return true;
 });
 return {value:{updated}};
});}
export const addMemberGroup=membership(true);
export const removeMemberGroup=membership(false);
