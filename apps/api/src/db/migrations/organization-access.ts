// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../connection.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../../auth/organization-roles.js';

export async function applyOrganizationAccessMigration(db: OpenShapeForgeDatabase) {
  for(const table of ['organization_access_roles','organization_access_seed']) {
    await sql`alter table ${sql.table('platform.'+table)} enable row level security;
      alter table ${sql.table('platform.'+table)} force row level security;
      drop policy if exists access_read on ${sql.table('platform.'+table)};
      create policy access_read on ${sql.table('platform.'+table)} for select
        using(app.bypass_rls() or tenant_id=app.current_tenant());
      drop policy if exists access_write on ${sql.table('platform.'+table)};
      create policy access_write on ${sql.table('platform.'+table)} for all
        using(app.bypass_rls() or (tenant_id=app.current_tenant() and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)}=any(string_to_array(coalesce(current_setting('app.roles',true),''),','))))
        with check(app.bypass_rls() or (tenant_id=app.current_tenant() and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)}=any(string_to_array(coalesce(current_setting('app.roles',true),''),','))));`.execute(db);
  }
}
