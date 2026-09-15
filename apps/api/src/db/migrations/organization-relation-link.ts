// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * The write path for `platform.tenants.relation_id` — the tenant's own
 * organization Relation (auth/organization-relation.ts,
 * mcp/organization-profile-tools.ts). The column and its foreign key are
 * declared in packages/compiler/config/platform-schema.yaml; only the policy
 * lives here, because the manifest cannot express one.
 *
 * `platform.tenants` normally accepts writes only through the audited
 * `withSystemSession` bypass (see `control/tenant-registry.ts`) — its
 * generated `tenants_tenant_registry` policy's WITH CHECK is `app.bypass_rls()`
 * only, because every other mutable column (`status`, `name`,
 * `keycloak_organization_id`, ...) is control-plane-owned. `relation_id` is
 * different: it is a tenant's own self-service link (`set_organization_relation`,
 * for `Organization.All.ReadWrite`, mirroring the identity-link write gate),
 * not a control-plane operation, so it needs its own path into the row.
 *
 * A second PERMISSIVE policy, scoped to UPDATE only, is added rather than
 * touching the generated policy (which regenerates from platform-schema.yaml
 * and would drop a hand-edit the next time schema.sql is applied). Postgres
 * OR's every permissive policy's USING/WITH CHECK together, so this only ADDS
 * a path — the generated policy's own protection for every other column is
 * untouched, and the application layer (`setOrganizationRelation`) is what
 * actually restricts the UPDATE statement it issues to `relation_id`.
 */
export async function applyOrganizationRelationLinkMigration(db: OpenShapeForgeDatabase) {
  await sql`
    drop policy if exists tenants_relation_link_write on platform.tenants;
    create policy tenants_relation_link_write on platform.tenants
      for update
      using (
        app.bypass_rls()
        or (
          id = app.current_tenant()
          and 'Organization.All.ReadWrite' = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      )
      with check (
        app.bypass_rls()
        or (
          id = app.current_tenant()
          and 'Organization.All.ReadWrite' = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
  `.execute(db);
}
