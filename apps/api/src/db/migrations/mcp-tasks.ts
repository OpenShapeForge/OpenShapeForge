// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/** Tenant isolation is generated; tighten it to the creator as well. */
export async function applyMcpTasksMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    alter table platform.mcp_tasks enable row level security;
    alter table platform.mcp_tasks force row level security;
    drop policy if exists mcp_tasks_actor on platform.mcp_tasks;
    create policy mcp_tasks_actor on platform.mcp_tasks as restrictive
      using (app.bypass_rls() or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()))
      with check (app.bypass_rls() or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()));
  `.execute(db);
}
