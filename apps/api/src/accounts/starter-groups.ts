// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db/types.js';
import { accessPolicy } from './access-policy.js';

/** Called inside provisioning's privileged transaction. Once means once,
 * including after a tenant removes a group or its grants. Never backfill members. */
export async function seedStarterGroups(tx: Transaction<DB>, tenantId:string) {
  if(!accessPolicy.groups.length)return;
  const claimed=await sql`insert into platform.organization_access_seed(tenant_id) values(${tenantId}::uuid)
    on conflict(tenant_id) do nothing returning tenant_id`.execute(tx);
  if(!claimed.rows.length)return;
  for(const group of accessPolicy.groups) {
    const existing=await sql`select id from erp.relation_groups where tenant_id=${tenantId}::uuid and lower(name)=lower(${group.name})`.execute(tx);
    // A same-named group already belongs to the tenant: do not change its grants.
    if(existing.rows.length)continue;
    const created=await sql<{id:string}>`insert into erp.relation_groups(tenant_id,name,group_type,status,external_id,source_authority)
      values(${tenantId}::uuid,${group.name},'general','active',${'starter:'+group.key},'organization-access-starter') returning id`.execute(tx);
    for(const role of group.roles)await sql`insert into platform.relation_group_roles(tenant_id,relation_group_id,role)
      values(${tenantId}::uuid,${created.rows[0]!.id}::uuid,${role}) on conflict do nothing`.execute(tx);
  }
}
