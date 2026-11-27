// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import { withDbSession } from "../db/session.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { encryptSecret, decryptSecret, type SecretKeyring, type StoredSecret } from "../platform/secrets.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { EventWebhookPrincipal } from "./event-webhook-authority.js";

const FIELD = "mcp-event-delivery";
export const EVENT_WEBHOOK_TTL_MS = 15 * 60_000;

export type EventWebhookSubscription = {
  id: string;
  tenant_id: string;
  actor_id: string;
  issuer: string;
  oauth_client_id: string;
  entity: string;
  sealed_delivery: StoredSecret;
  cursor: string;
  expires_at: Date | string;
  attempts: number;
};

export function eventWebhookId(principal: EventWebhookPrincipal, entity: string, url: URL): string {
  const identity = JSON.stringify([principal.tenantId, principal.issuer, principal.userId, principal.clientId, entity, url.href]);
  return "sub_" + createHash("sha256").update(identity).digest("base64url");
}

export function openEventWebhookDelivery(keys: SecretKeyring, row: EventWebhookSubscription): { url: string; secret: string } {
  return JSON.parse(decryptSecret(keys, row.tenant_id + ":" + row.id, FIELD, row.sealed_delivery));
}

export function createEventWebhookStore(db: OpenShapeForgeDatabase, session: TrustedSessionContext, principal: EventWebhookPrincipal) {
  function run<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return withDbSession(db, session, async trx => {
      await sql`select set_config('app.mcp_event_issuer', ${principal.issuer}, true),
        set_config('app.mcp_event_oauth_client', ${principal.clientId}, true)`.execute(trx);
      return work(trx);
    });
  }
  return {
    get: (id: string) => run(async trx =>
      (await sql<EventWebhookSubscription>`select * from platform.mcp_event_subscriptions
        where id = ${id} and expires_at > clock_timestamp()`.execute(trx)).rows[0]),
    remove: (id: string) => run(async trx =>
      (await sql`delete from platform.mcp_event_subscriptions where id = ${id}`.execute(trx)).numAffectedRows !== 0n),
    retain: (input: { keys: SecretKeyring; id: string; entity: string; url: URL; secret: string; cursor: string; expiresAt: Date }) => run(async trx => {
      const sealed = encryptSecret(input.keys, principal.tenantId + ":" + input.id, FIELD,
        JSON.stringify({ url: input.url.href, secret: input.secret }));
      const lock = JSON.stringify([principal.tenantId, principal.issuer, principal.userId, principal.clientId]);
      await sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`.execute(trx);
      await sql`delete from platform.mcp_event_subscriptions where expires_at <= clock_timestamp()`.execute(trx);
      const count = await sql<{ count: number }>`select count(*)::int as count
        from platform.mcp_event_subscriptions where id <> ${input.id}`.execute(trx);
      if ((count.rows[0]?.count ?? 0) >= 5) return;
      const result = await sql<EventWebhookSubscription>`
        insert into platform.mcp_event_subscriptions
          (id, tenant_id, actor_id, issuer, oauth_client_id, entity, sealed_delivery, cursor, expires_at)
        values (${input.id}, ${principal.tenantId}::uuid, ${principal.userId}::uuid, ${principal.issuer},
          ${principal.clientId}, ${input.entity}, ${jsonbLiteral(sealed)}, ${input.cursor}, ${input.expiresAt})
        on conflict (id) do update set sealed_delivery = excluded.sealed_delivery,
          expires_at = excluded.expires_at, next_attempt_at = clock_timestamp(),
          lease_token = null, lease_expires_at = null, attempts = 0
        returning *
      `.execute(trx);
      return result.rows[0];
    }),
  };
}
