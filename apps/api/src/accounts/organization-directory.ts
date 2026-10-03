// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { withDbSession } from "../db/session.js";
import { HttpError } from "../rest/http-error.js";
import { guarded, customRolePermissionsByKey } from "./custom-roles.js";
import { accountSession } from "./account-session.js";
import { sourceId, sourcePage } from "./source-query.js";
import { linkedProviders } from "./linked-providers.js";
import { expandRoleComposites } from "../auth/person-roles.js";
import { realmName } from "./roles.js";
import { accountRevision } from "./account-management.js";

export const ACCOUNT_QUERY_FIELDS = ["id", "label", "email", "status", "issuer", "relationId"] as const;

function accounts(tenantId: string) {
  return sql`
    select i.id::text as id, coalesce(i.display_name,i.email,'Account') as label,
      coalesce(i.email,'') as email, i.issuer,
      case when ir.access_blocked then 'blocked' else ir.status end as status,
      ir.relation_id::text as "relationId", ir.linked_at as "linkedAt", ir.roles as "directRoles", ${accountRevision} as revision,
      array(select distinct gr.role from platform.relation_group_roles gr
        join erp.relation_groups g on g.tenant_id=gr.tenant_id and g.id=gr.relation_group_id
        join erp.relation_group_memberships m on m.tenant_id=g.tenant_id and m.relation_group_id=g.id
        where m.tenant_id=ir.tenant_id and m.relation_id=ir.relation_id and m.status='active' and g.status='active'
          and (m.start_date is null or m.start_date<=current_date) and (m.end_date is null or m.end_date>=current_date)) as "groupRoles",
      array(select distinct g.name from erp.relation_groups g
        join erp.relation_group_memberships m on m.tenant_id=g.tenant_id and m.relation_group_id=g.id
        where m.tenant_id=ir.tenant_id and m.relation_id=ir.relation_id and g.status='active' and m.status='active'
          and (m.start_date is null or m.start_date<=current_date) and (m.end_date is null or m.end_date>=current_date)
        order by g.name) as groups
    from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
    where ir.tenant_id=${tenantId}::uuid`;
}
type Account = { id: string; label: string; email: string; issuer: string; status: string;
  relationId: string | null; linkedAt: Date | string | null; directRoles: string[]; groupRoles: string[]; groups: string[] };
function view(row: Account, customPermissions: Readonly<Record<string, readonly string[]>>) {
  const keys = [...new Set([...row.directRoles, ...row.groupRoles])];
  return { ...row, linkedAt: row.linkedAt === null ? null : new Date(row.linkedAt).toISOString(),
    directRoles: [...row.directRoles].sort(), groupRoles: [...row.groupRoles].sort(),
    effectiveRoles: row.status === "linked"
      ? [...new Set([...expandRoleComposites(realmName(), keys), ...keys.flatMap(key => customPermissions[key] ?? [])])].sort()
      : [],
    providers: null, providerState: null, providersCheckedAt: null };
}
export const listOrganizationAccounts = guarded(async (input, context) => {
  const session = accountSession(context);
  const page = await sourcePage<Account>(context, input, "Account", ACCOUNT_QUERY_FIELDS, accounts(session.tenantId));
  const permissions = await customRolePermissionsByKey(context.db!, session, page.items.flatMap(row => [...row.directRoles, ...row.groupRoles]));
  return { value: { ...page, items: page.items.map(row => view(row, permissions)) } };
});
export const getOrganizationAccount = guarded(async (input, context) => {
  const session = accountSession(context), id = sourceId(input.id);
  // A real tenant-scoped point query, independent of collection paging/filtering.
  const row = await withDbSession(context.db!, session, async tx =>
    (await sql<Account>`select * from (${accounts(session.tenantId)}) as accounts where id=${id}`.execute(tx)).rows[0]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Account not found in this organization.");
  const permissions = await customRolePermissionsByKey(context.db!, session, [...row.directRoles, ...row.groupRoles]);
  return { value: { ...view(row, permissions), ...await linkedProviders(context, id) } };
});
