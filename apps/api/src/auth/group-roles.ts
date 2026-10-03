// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";

/** Read every request: withdrawing a group grant must not wait for token expiry. */
export async function resolveGroupRoles(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput & { tenantId: string; userId: string },
  groupIds: readonly string[],
): Promise<string[]> {
  if (!groupIds.length) return [];
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ role: string }>`select distinct role
      from platform.relation_group_roles
      where tenant_id = ${session.tenantId}::uuid
        and relation_group_id in (${sql.join(groupIds.map(id => sql`${id}::uuid`))})
      order by role`.execute(trx);
    return result.rows.map(row => row.role);
  });
}
