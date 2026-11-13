// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { OperationExecutionReference } from "@openshapeforge/operations";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

export type TaskBinding = {
  id: string; owner_kind: string; owner_ref: string;
  created_at: Date | string; expires_at: Date | string;
};
export type TaskStore = {
  retain(reference: OperationExecutionReference): Promise<TaskBinding>;
  get(id: string): Promise<TaskBinding | undefined>;
};
export const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Database-owned handles survive process/reconnect; they contain no result or credential. */
export function createTaskStore(db: OpenShapeForgeDatabase, session: TrustedSessionContext, authorityHash: string): TaskStore {
  return {
    retain: reference => withDbSession(db, session, async trx => {
      await sql`select set_config('app.mcp_task_authority', ${authorityHash}, true)`.execute(trx);
      // Expiry ends only the protocol handle's retention, never the business process.
      await sql`delete from platform.mcp_tasks where tenant_id = ${session.tenantId}::uuid
        and actor_id = ${session.userId}::uuid and authority_hash = ${authorityHash} and expires_at <= clock_timestamp()`.execute(trx);
      const { rows: [row] } = await sql<TaskBinding>`
        insert into platform.mcp_tasks (id, tenant_id, actor_id, authority_hash, owner_kind, owner_ref, expires_at)
        values (${randomUUID()}::uuid, ${session.tenantId}::uuid, ${session.userId}::uuid,
          ${authorityHash}, ${reference.kind}, ${reference.ref}, clock_timestamp() + interval '7 days')
        on conflict (tenant_id, actor_id, authority_hash, owner_kind, owner_ref)
        do update set owner_ref = excluded.owner_ref
        returning id, owner_kind, owner_ref, created_at, expires_at
      `.execute(trx);
      if (!row) throw new Error("Task handle could not be retained.");
      return row;
    }),
    get: id => withDbSession(db, session, async trx => {
      await sql`select set_config('app.mcp_task_authority', ${authorityHash}, true)`.execute(trx);
      const { rows: [row] } = await sql<TaskBinding>`select id, owner_kind, owner_ref, created_at, expires_at
        from platform.mcp_tasks where id = ${id}::uuid and tenant_id = ${session.tenantId}::uuid
          and actor_id = ${session.userId}::uuid and authority_hash = ${authorityHash}
          and expires_at > clock_timestamp()`.execute(trx);
      return row;
    }),
  };
}
