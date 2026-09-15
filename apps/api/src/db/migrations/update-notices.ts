// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Row-level security for the update notices — what changed in this
 * deployment since a person last connected (platform.update_notices) and the
 * durable record that one person was told (platform.user_update_notices).
 * Both tables are declared in packages/compiler/config/platform-schema.yaml,
 * which also says why the acknowledgement is its own table keyed on the
 * session's user; this runs after the generated step and owns only the
 * policies, which the manifest cannot express:
 *
 *   - update_notices is readable by every session and writable by none.
 *     Publishing therefore has to come through withSystemSession, which
 *     refuses an actor without Platform.SystemBypass and audits the one that
 *     has it. The write right is the brake; nothing here inspects what the
 *     text says.
 *   - user_update_notices carries the same tenant fence the rest of
 *     platform.* uses, and only the person themselves may write their own
 *     acknowledgement: an administrator cannot mark a colleague as brought up
 *     to date, in the database, not just in the tools.
 */
export async function applyUpdateNoticesMigration(db: OpenShapeForgeDatabase) {
  await sql`
    alter table platform.update_notices enable row level security;
    alter table platform.update_notices force row level security;
    alter table platform.user_update_notices enable row level security;
    alter table platform.user_update_notices force row level security;

    drop policy if exists update_notices_readable on platform.update_notices;
    create policy update_notices_readable on platform.update_notices
      using (true)
      with check (app.bypass_rls());

    drop policy if exists user_update_notices_tenant_isolation
      on platform.user_update_notices;
    create policy user_update_notices_tenant_isolation
      on platform.user_update_notices
      using (
        app.bypass_rls()
        or tenant_id = app.current_tenant()
      )
      with check (
        app.bypass_rls()
        or (tenant_id = app.current_tenant() and user_id = app.current_user_id())
      );
  `.execute(db);
}
