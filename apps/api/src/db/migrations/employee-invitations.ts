// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { IDENTITY_LINK_ADMIN_ROLE } from "../../auth/organization-roles.js";
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureCheckConstraint } from "./sql-invariants.js";

/**
 * The invariants of `platform.employee_invitations` — the pending-role side
 * of an organization administrator inviting a colleague
 * (auth/employee-invitations.ts, mcp/employee-invitation-tools.ts) — that the
 * manifest cannot express. The table itself is declared in
 * packages/compiler/config/platform-schema.yaml, which also says why it
 * exists separately from platform.identity_relations; this runs after the
 * generated step and adds, idempotently on every migrate:
 *
 *   - ONE PENDING ROW PER (tenant, lower(email)): a partial unique index over
 *     an expression, not a table-wide key, so revoking and re-inviting the
 *     same address is not a conflict — only two simultaneously PENDING
 *     invitations for the same address in the same tenant are;
 *   - `role` held to the two composite client roles an invitation may name
 *     today (`org_admin`, `org_employee`). Whatever applies the role after
 *     sign-in is free to grow that list; the check only has to track what an
 *     invitation itself may name;
 *   - `status` held to pending | revoked | accepted, with the timestamps each
 *     requires. `accepted` is reserved for the day the sign-in path in
 *     identity-link.ts consumes a matching row; nothing sets it yet;
 *   - row-level security: tenant-fenced like every other platform.* row with
 *     a tenant_id, and writes additionally require Organization.All.ReadWrite
 *     — the same defence-in-depth the identity-link write policy uses. The
 *     MCP tool layer checks the same role; this is the belt under the braces
 *     for any other path that might reach this table.
 */
export async function applyEmployeeInvitationsMigration(db: OpenShapeForgeDatabase) {
  await sql`
    create unique index if not exists employee_invitations_pending_email_uidx
      on platform.employee_invitations (tenant_id, lower(email))
      where status = 'pending';
  `.execute(db);

  await ensureCheckConstraint(db, {
    table: "platform.employee_invitations",
    name: "employee_invitations_role_check",
    expression: "role in ('org_admin', 'org_employee')",
  });
  await ensureCheckConstraint(db, {
    table: "platform.employee_invitations",
    name: "employee_invitations_status_check",
    expression: "status in ('pending', 'revoked', 'accepted')",
  });
  await ensureCheckConstraint(db, {
    table: "platform.employee_invitations",
    name: "employee_invitations_status_shape",
    expression: `
      (status = 'pending' and revoked_at is null and accepted_at is null)
      or (status = 'revoked' and revoked_at is not null and accepted_at is null)
      or (status = 'accepted' and accepted_at is not null)
    `,
  });

  await sql`
    alter table platform.employee_invitations enable row level security;
    alter table platform.employee_invitations force row level security;

    drop policy if exists employee_invitations_tenant_isolation on platform.employee_invitations;
    drop policy if exists employee_invitations_insertable on platform.employee_invitations;
    drop policy if exists employee_invitations_updatable on platform.employee_invitations;
    drop policy if exists employee_invitations_deletable on platform.employee_invitations;
    create policy employee_invitations_tenant_isolation on platform.employee_invitations for select
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      );
    create policy employee_invitations_insertable on platform.employee_invitations for insert
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
    create policy employee_invitations_updatable on platform.employee_invitations for update
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      )
      with check (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
    create policy employee_invitations_deletable on platform.employee_invitations for delete
      using (
        app.bypass_rls()
        or (
          tenant_id = app.current_tenant()
          and ${sql.lit(IDENTITY_LINK_ADMIN_ROLE)} = any (
            string_to_array(coalesce(current_setting('app.roles', true), ''), ',')
          )
        )
      );
  `.execute(db);
}
