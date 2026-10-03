// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { IDENTITY_LINK_ADMIN_ROLE } from "../../auth/organization-roles.js";

export async function applyRelationGroupRolesMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    alter table platform.relation_group_roles enable row level security;
    alter table platform.relation_group_roles force row level security;
    drop policy if exists relation_group_roles_read on platform.relation_group_roles;
    create policy relation_group_roles_read on platform.relation_group_roles for select
      using (app.bypass_rls() or tenant_id = app.current_tenant());
    drop policy if exists relation_group_roles_write on platform.relation_group_roles;
    create policy relation_group_roles_write on platform.relation_group_roles for all
      using (app.bypass_rls() or (tenant_id = app.current_tenant() and
        ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any(string_to_array(coalesce(current_setting('app.roles', true), ''), ','))))
      with check (app.bypass_rls() or (tenant_id = app.current_tenant() and
        ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any(string_to_array(coalesce(current_setting('app.roles', true), ''), ','))));

    create or replace function app.relation_group_access_guard() returns trigger
    language plpgsql as $$
    declare
      old_group uuid;
      new_group uuid;
      selected_tenant uuid;
      allowed boolean := app.bypass_rls() or ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any(
        string_to_array(coalesce(current_setting('app.roles', true), ''), ','));
    begin
      if tg_table_name = 'relation_group_memberships' then
        if tg_op <> 'INSERT' then old_group := old.relation_group_id; selected_tenant := old.tenant_id; end if;
        if tg_op <> 'DELETE' then new_group := new.relation_group_id; selected_tenant := new.tenant_id; end if;
      elsif tg_table_name = 'relation_groups' then
        if tg_op <> 'INSERT' then old_group := old.id; selected_tenant := old.tenant_id; end if;
        if tg_op <> 'DELETE' then new_group := new.id; selected_tenant := new.tenant_id; end if;
      else
        if tg_op <> 'INSERT' then old_group := old.relation_group_id; selected_tenant := old.tenant_id; end if;
        if tg_op <> 'DELETE' then new_group := new.relation_group_id; selected_tenant := new.tenant_id; end if;
      end if;
      -- Serialize membership and grant changes for each group, in stable order.
      perform id from erp.relation_groups
        where tenant_id = selected_tenant and (id = old_group or id = new_group)
        order by id for update;
      if not allowed and (tg_table_name = 'relation_group_roles' or exists (
        select 1 from platform.relation_group_roles
        where tenant_id = selected_tenant and (relation_group_id = old_group or relation_group_id = new_group)
      )) then
        raise exception 'Only an organization administrator may modify groups or memberships that grant access'
          using errcode = '42501';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end $$;
    drop trigger if exists relation_group_roles_access_guard on platform.relation_group_roles;
    create trigger relation_group_roles_access_guard before insert or update or delete on platform.relation_group_roles
      for each row execute function app.relation_group_access_guard();
    drop trigger if exists relation_group_memberships_access_guard on erp.relation_group_memberships;
    create trigger relation_group_memberships_access_guard before insert or update or delete on erp.relation_group_memberships
      for each row execute function app.relation_group_access_guard();
    drop trigger if exists relation_groups_access_guard on erp.relation_groups;
    create trigger relation_groups_access_guard before update or delete on erp.relation_groups
      for each row execute function app.relation_group_access_guard();
  `.execute(db);
}
