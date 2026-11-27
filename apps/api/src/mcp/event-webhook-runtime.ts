// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { WORKER_ROLE } from "../db/migrations/worker-role.js";
import { createDatabaseRuntime } from "../db/connection.js";
import { personalKeyOwnerLookup } from "../auth/session-resolver.js";
import { keyringFromEnv } from "../platform/secrets.js";
import type { McpRegistrationOptions } from "./route-context.js";
import { deliverMcpEventWebhookOnce } from "./event-webhook-delivery.js";

/** Only advertise webhook subscriptions when this deployment has an active delivery loop. */
export function attachMcpEventWebhookRuntime(app: FastifyInstance, options: McpRegistrationOptions): (tenantId: string | null) => string | undefined {
  const apiDb = options.db;
  const owner = options.egressOwner;
  const url = process.env.OPENSHAPEFORGE_MCP_EVENT_WORKER_DATABASE_URL?.trim();
  const allowlist = (process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean);
  const tenantId = process.env.OPENSHAPEFORGE_MCP_EVENT_PILOT_TENANT_ID?.trim();
  const entity = process.env.OPENSHAPEFORGE_MCP_EVENT_ENTITY?.trim();
  if (!apiDb || !owner?.pinsResolvedAddresses || !url || !allowlist.length || !tenantId || !entity) return () => undefined;
  if (!personalKeyOwnerLookup() || !process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim()) {
    throw new Error("MCP Events delivery requires the configured issuer and account lookup.");
  }
  const keys = keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
  if (!keys) throw new Error("MCP event webhook secrets require the configured application keyring.");
  const pool = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  const step = () => {
    work = deliverMcpEventWebhookOnce({ apiDb, workerDb: pool.db, keys, owner, allowlist, tenantId, entity })
      .then(result => {
        if (result === "delivered" || result === "lease-lost") app.log.info({ result }, "MCP event webhook callback accepted.");
      })
      .catch(() => { app.log.warn({ code: "MCP_EVENT_DELIVERY_INTERRUPTED" }, "MCP Events delivery worker will retry."); })
      .finally(() => { if (active) timer = setTimeout(step, 1000); });
  };
  app.addHook("onReady", async () => {
    await pool.db.transaction().execute(async trx => {
      const current = (await sql<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>`
        select current_user as role, rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = current_user`.execute(trx)).rows[0];
      if (current?.role !== WORKER_ROLE || current.rolsuper || current.rolbypassrls) {
        throw new Error("MCP Events delivery requires the restricted worker database role.");
      }
      await sql`select set_config('app.worker_role', 'mcp-events-worker', true)`.execute(trx);
      await sql`select id from platform.mcp_event_subscriptions limit 1`.execute(trx);
    });
    active = true;
    step();
  });
  app.addHook("onClose", async () => {
    active = false;
    clearTimeout(timer);
    try { await work; } finally { await pool.close(); }
  });
  return candidate => active && candidate === tenantId ? entity : undefined;
}
