// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

export async function applyMcpEventSubscriptionPolicy(db: OpenShapeForgeDatabase): Promise<void> {
  await sql`
    alter table platform.mcp_event_subscriptions enable row level security;
    alter table platform.mcp_event_subscriptions force row level security;
    drop policy if exists mcp_event_subscriptions_owner on platform.mcp_event_subscriptions;
    create policy mcp_event_subscriptions_owner on platform.mcp_event_subscriptions as restrictive
      using (
        (current_user = 'openshapeforge_worker' and app.current_worker_role() = 'mcp-events-worker')
        or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
          and issuer = current_setting('app.mcp_event_issuer', true)
          and oauth_client_id = current_setting('app.mcp_event_oauth_client', true))
      )
      with check (
        (current_user = 'openshapeforge_worker' and app.current_worker_role() = 'mcp-events-worker')
        or (tenant_id = app.current_tenant() and actor_id = app.current_user_id()
          and issuer = current_setting('app.mcp_event_issuer', true)
          and oauth_client_id = current_setting('app.mcp_event_oauth_client', true))
      );
  `.execute(db);
}
