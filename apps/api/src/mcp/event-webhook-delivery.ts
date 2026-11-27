// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ModuleEgressDispatch } from "../modules/egress.js";
import { requireEntityOperation, getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { readChangeBatch } from "../platform/entity-change-stream.js";
import type { SecretKeyring } from "../platform/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { resolveEventWebhookAuthority } from "./event-webhook-authority.js";
import { eventWebhookDestination, sendEventWebhook } from "./event-webhook-callback.js";
import { decodeEventWebhookSecret } from "./event-webhook-signature.js";
import { openEventWebhookDelivery, type EventWebhookSubscription } from "./event-webhook-store.js";

const workerRole = "mcp-events-worker";
const maxAttempts = 8;
type Claim = EventWebhookSubscription & { lease_token: string };

async function workerTransaction<T>(db: OpenShapeForgeDatabase, work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async trx => {
    await sql`select set_config('app.worker_role', ${workerRole}, true)`.execute(trx);
    return work(trx);
  });
}

async function claimNext(db: OpenShapeForgeDatabase, tenantId: string): Promise<Claim | undefined> {
  return workerTransaction(db, async trx => {
    await sql`delete from platform.mcp_event_subscriptions where id in (
      select id from platform.mcp_event_subscriptions where expires_at <= clock_timestamp()
      limit 25 for update skip locked)`.execute(trx);
    return (await sql<Claim>`
      with candidate as (
        select id from platform.mcp_event_subscriptions
        where tenant_id = ${tenantId}::uuid and expires_at > clock_timestamp() and next_attempt_at <= clock_timestamp()
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
        order by next_attempt_at, id limit 1 for update skip locked
      )
      update platform.mcp_event_subscriptions subscription
      set lease_token = ${randomUUID()}::uuid, lease_expires_at = clock_timestamp() + interval '1 minute'
      from candidate where subscription.id = candidate.id
      returning subscription.*
    `.execute(trx)).rows[0];
  });
}

/** One bounded lease, one delivery attempt. Authorized row reads use the API pool, not worker authority. */
export async function deliverMcpEventWebhookOnce(options: {
  apiDb: OpenShapeForgeDatabase;
  workerDb: OpenShapeForgeDatabase;
  keys: SecretKeyring;
  owner: NonNullable<ModuleEgressDispatch["owner"]>;
  allowlist: readonly string[];
  tenantId: string;
}): Promise<"idle" | "checked" | "delivered" | "retried" | "removed"> {
  const claimed = await claimNext(options.workerDb, options.tenantId);
  if (!claimed) return "idle";
  const { id, lease_token: lease } = claimed;
  const remove = () => workerTransaction(options.workerDb, async trx => {
    await sql`delete from platform.mcp_event_subscriptions where id = ${id} and lease_token = ${lease}::uuid`.execute(trx);
    return "removed" as const;
  });
  const update = (cursor: string, attempts: number, delaySeconds: number) => workerTransaction(options.workerDb, async trx => {
    await sql`update platform.mcp_event_subscriptions
      set cursor = ${cursor}, attempts = ${attempts}, lease_token = null, lease_expires_at = null,
        next_attempt_at = clock_timestamp() + ${delaySeconds} * interval '1 second'
      where id = ${id} and lease_token = ${lease}::uuid`.execute(trx);
  });
  const retry = async () => {
    const attempts = claimed.attempts + 1;
    if (attempts >= maxAttempts) return remove();
    await update(claimed.cursor, attempts, Math.min(60, 2 ** attempts));
    return "retried" as const;
  };
  if (claimed.entity !== "Notification") return remove();
  try {
    const principal = { tenantId: claimed.tenant_id, userId: claimed.actor_id, issuer: claimed.issuer, clientId: claimed.oauth_client_id };
    const session = await resolveEventWebhookAuthority(options.apiDb, principal);
    if (!session) return remove();
    const table = getGeneratedCrudTables().find(candidate => candidate.source?.authoringEntityName === claimed.entity);
    if (!table?.realtime || table.source?.mcp?.operations.get !== true) return remove();
    try { requireEntityOperation(table, "get", session); }
    catch { return remove(); }
    const batch = await readChangeBatch(options.apiDb, session, claimed.cursor, true, undefined, claimed.entity);
    if (batch.reset) return remove();
    const next = batch.changes[0];
    if (!next?.eventId || !next.timestamp) {
      await update(batch.cursor, 0, 3);
      return "checked";
    }
    const { url, secret } = openEventWebhookDelivery(options.keys, claimed);
    const target = eventWebhookDestination(url, { owner: options.owner, purpose: "probe", scope: {
      tenantId: claimed.tenant_id, actorId: claimed.actor_id, provider: "mcp-events", operation: "delivery", kind: "mutation",
    } }, options.allowlist);
    const stillActive = await workerTransaction(options.workerDb, async trx => (await sql`select 1 from platform.mcp_event_subscriptions
      where id = ${id} and lease_token = ${lease}::uuid and expires_at > clock_timestamp()`.execute(trx)).rows.length === 1);
    if (!stillActive) return "checked";
    const status = await sendEventWebhook(target, {
      key: decodeEventWebhookSecret(secret), subscriptionId: id, messageId: next.eventId, signedAt: new Date(),
      value: { eventId: next.eventId, name: "resource.created", timestamp: next.timestamp,
        data: { entity: claimed.entity, id: next.data.id }, cursor: next.cursor },
    });
    if (status >= 200 && status < 300) {
      await update(next.cursor, 0, 0);
      return "delivered";
    }
    if (status === 408 || status === 429 || status >= 500) return retry();
    return remove();
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return remove();
    return retry();
  }
}
