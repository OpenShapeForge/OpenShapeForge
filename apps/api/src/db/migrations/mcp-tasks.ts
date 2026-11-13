// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/** Handles remain private to the tenant, creator and verified authority, even during bypass. */
export async function applyMcpTasksMigration(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    alter table platform.mcp_tasks enable row level security;
    alter table platform.mcp_tasks force row level security;
    drop policy if exists mcp_tasks_actor on platform.mcp_tasks;
    create policy mcp_tasks_actor on platform.mcp_tasks as restrictive
      using (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
        and authority_hash = current_setting('app.mcp_task_authority', true))
      with check (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
        and authority_hash = current_setting('app.mcp_task_authority', true));
  `.execute(db);
}
