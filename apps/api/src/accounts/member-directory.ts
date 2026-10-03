// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import { withDbSession } from '../db/session.js';
import { HttpError } from '../rest/http-error.js';
import { accessSession, guarded } from './custom-roles.js';
import { labelRoles } from './roles.js';
import { KeycloakAdminError } from '../control/keycloak-organization-admin.js';
import type { ModuleOperationContext } from '../modules/contract.js';

export const memberId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new HttpError(400, 'VALIDATION', 'Select a member or invitation.');
  return value;
};
type Row = { id: string; label: string; email: string; status: string; relationId: string | null;
  linkedAt: Date | string | null; direct: string[]; inherited: string[]; groups: string };

/** Account identity is the record key: a person may have several independent logins. */
export async function directory(c: ModuleOperationContext) {
  const s = accessSession(c);
  const rows = await withDbSession(c.db!, s, async tx => (await sql<Row>`
    select i.id, coalesce(i.display_name,i.email,'Member') as label, coalesce(i.email,'') as email,
      case when ir.access_blocked then 'blocked' else ir.status end as status,
      ir.relation_id as "relationId", ir.linked_at as "linkedAt", ir.roles as direct,
      array(select distinct gr.role from platform.relation_group_roles gr
        join erp.relation_groups g on g.tenant_id=gr.tenant_id and g.id=gr.relation_group_id
        join erp.relation_group_memberships m on m.tenant_id=g.tenant_id and m.relation_group_id=g.id
        where m.tenant_id=ir.tenant_id and m.relation_id=ir.relation_id and m.status='active' and g.status='active'
          and (m.start_date is null or m.start_date<=current_date) and (m.end_date is null or m.end_date>=current_date)) as inherited,
      coalesce((select string_agg(distinct g.name,', ' order by g.name)
        from erp.relation_groups g join erp.relation_group_memberships m on m.tenant_id=g.tenant_id and m.relation_group_id=g.id
        where m.tenant_id=ir.tenant_id and m.relation_id=ir.relation_id and g.status='active' and m.status='active'
          and (m.start_date is null or m.start_date<=current_date) and (m.end_date is null or m.end_date>=current_date)),'') as groups
    from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
    where ir.tenant_id=${s.tenantId}::uuid
    union all
    select p.id, coalesce(nullif(trim(concat_ws(' ',p.first_name,p.last_name)),''),p.email),p.email,
      case when p.status='pending' then 'invited' else p.status end,
      p.relation_id,p.invited_at,array[]::text[],array[]::text[],''
    from platform.employee_invitations p where p.tenant_id=${s.tenantId}::uuid and p.status in ('pending','revoked')
    order by label,id`.execute(tx)).rows);
  return rows.map(({ direct, inherited, ...row }) => ({ ...row,
    linkedAt: row.linkedAt instanceof Date ? row.linkedAt.toISOString() : row.linkedAt,
    directRoles: labelRoles(direct, s.locale), effectiveRoles: labelRoles([...new Set([...direct,...inherited])], s.locale),
    credentialTypes: '',
  }));
}
export const listMembers = guarded(async (_input,c) => ({value:{members:await directory(c)}}));
export const getMember = guarded(async (input,c) => {
  const id=memberId(input.id);
  const member=(await directory(c)).find(row=>row.id===id);
  if(!member)throw new HttpError(404,'NOT_FOUND','Member not found in this organization.');
  if(member.status==='linked' || member.status==='blocked' || member.status==='pending_confirmation') {
    const {providerMember}=await import('./member-provider.js');
    try {
      const p=await providerMember(c,id);
      member.credentialTypes=[...new Set((await p.client.listCredentials(p.member.memberId)).map(row=>row.type))].sort().join(', ');
    } catch(error) {
      if(error instanceof HttpError && error.code==='EXTERNAL_IDENTITY')member.credentialTypes='External identity provider';
      else if(error instanceof KeycloakAdminError || (error instanceof HttpError && [409,503].includes(error.status)))
        member.credentialTypes='Identity provider details unavailable';
      else throw error;
    }
  }
  return {value:member};
});
