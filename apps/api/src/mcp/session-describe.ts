// SPDX-License-Identifier: BUSL-1.1
/**
 * `describeSession` — the orchestrator behind `whoami` and `osf://session`:
 * gathers one live session's facts (the credential's display facts, what the
 * client said at `initialize`, the tenant's display name, the counts the
 * server supplies) and hands them to the pure `buildSessionInfo` in
 * `session-info.ts`, plus the two result shapes the transport returns.
 *
 * Split out of `session-info.ts` so the pure projection and its tests stay
 * free of the database; `session-info.ts` re-exports these names.
 */
import { sql } from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { sessionClientOf } from "./session-client.js";
import { sessionIdentityOf } from "./session-identity.js";
import {
  buildSessionInfo,
  JSON_MIME_TYPE,
  SESSION_RESOURCE_URI,
  type SessionInfo,
} from "./session-info.js";

/**
 * The session's own tenant row, by display name only.
 *
 * Runs inside `withDbSession`, so the `tenants_tenant_registry` policy reduces
 * to `id = app.current_tenant()`; the bound predicate makes the query's scope a
 * property of the query as well (see graphql/current-tenant.ts for the full
 * argument). Null when the registry has no row for the tenant.
 */
export async function readSessionOrganization(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
): Promise<{ name: string } | null> {
  if (!session.tenantId || !session.userId) return null;
  return withDbSession(db, session, async (trx, dbSession) => {
    const result = await sql<{ name: string }>`
      select name
        from platform.tenants
       where id = ${dbSession.tenantId}::uuid
    `.execute(trx);
    return result.rows[0] ?? null;
  });
}

/**
 * Build the answer for one live session. `access` is supplied by the server
 * and must count through its own per-session list builders, so the numbers
 * are exactly what `tools/list` and `resources/list` would return.
 */
export async function describeSession(input: {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  access: () => Promise<{ tools: number; resources: number }>;
  nowMs?: number;
}): Promise<SessionInfo> {
  const [organization, access] = await Promise.all([
    readSessionOrganization(input.db, input.session),
    input.access(),
  ]);
  return buildSessionInfo({
    identity: sessionIdentityOf(input.session),
    roles: input.session.roles ?? [],
    organization,
    relation: input.session.relation ?? null,
    client: sessionClientOf(input.session),
    access,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

/** `tools/call` result: the JSON as text for every client, structured for those that read it. */
export function sessionInfoToolResult(info: SessionInfo) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
    structuredContent: info as unknown as Record<string, unknown>,
  };
}

/** `resources/read` result for `osf://session`. */
export function sessionInfoResourceResult(info: SessionInfo) {
  return {
    contents: [
      {
        uri: SESSION_RESOURCE_URI,
        mimeType: JSON_MIME_TYPE,
        text: JSON.stringify(info, null, 2),
      },
    ],
  };
}
