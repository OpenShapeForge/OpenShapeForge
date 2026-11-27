// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { WORKER_ROLE } from "./worker-role.js";
import type { OpenShapeForgeDatabase } from "../connection.js";

export async function applyMcpEventSubscriptionPolicy(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    alter table platform.mcp_event_subscriptions enable row level security;
    alter table platform.mcp_event_subscriptions force row level security;
    drop policy if exists mcp_event_subscriptions_owner on platform.mcp_event_subscriptions;
    create policy mcp_event_subscriptions_owner on platform.mcp_event_subscriptions as restrictive
      using (
        app.bypass_rls() or (current_user = ${sql.lit(WORKER_ROLE)} and app.current_worker_role() = 'mcp-events-worker')
        or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
          and issuer = current_setting('app.mcp_event_issuer', true)
          and oauth_client_id = current_setting('app.mcp_event_oauth_client', true))
      )
      with check (
        app.bypass_rls() or (current_user = ${sql.lit(WORKER_ROLE)} and app.current_worker_role() = 'mcp-events-worker')
        or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
          and issuer = current_setting('app.mcp_event_issuer', true)
          and oauth_client_id = current_setting('app.mcp_event_oauth_client', true))
      );
  `.execute(db);
}
