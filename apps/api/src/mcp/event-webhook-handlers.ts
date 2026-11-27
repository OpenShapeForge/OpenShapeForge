// SPDX-License-Identifier: BUSL-1.1
import { fromJsonSchema, ProtocolError, ProtocolErrorCode, type Server } from "@modelcontextprotocol/server";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { ModuleEgressDispatch } from "../modules/egress.js";
import { keyringFromEnv } from "../platform/secrets.js";
import { parseStreamCursor, readChangeBatch } from "../platform/entity-change-stream.js";
import { eventWebhookPrincipal } from "./event-webhook-authority.js";
import { eventWebhookDestination, verifyEventWebhook } from "./event-webhook-callback.js";
import { decodeEventWebhookSecret } from "./event-webhook-signature.js";
import { createEventWebhookStore, eventWebhookId, EVENT_WEBHOOK_TTL_MS } from "./event-webhook-store.js";

const eventName = "resource.created";
const argsSchema = { type: "object", required: ["entity"], additionalProperties: false,
  properties: { entity: { type: "string" } } };
const schema = {
  type: "object", required: ["name", "arguments", "delivery"],
  properties: { name: { type: "string" }, arguments: argsSchema },
};
const subscribeParams = fromJsonSchema<{ name: string; arguments: { entity: string };
  delivery: { mode: "webhook"; url: string; secret: string }; cursor?: string | null }>({
  ...schema,
  properties: { ...schema.properties, cursor: { type: ["string", "null"] }, delivery: {
    type: "object", required: ["mode", "url", "secret"], additionalProperties: false, properties: {
      mode: { const: "webhook" }, url: { type: "string", maxLength: 4096 }, secret: { type: "string", maxLength: 128 },
    },
  } },
});
const unsubscribeParams = fromJsonSchema<{ name: string; arguments: { entity: string }; delivery: { url: string } }>({
  ...schema, properties: { ...schema.properties, delivery: { type: "object", required: ["url"],
    properties: { url: { type: "string", maxLength: 4096 } } } },
});

export function registerMcpEventWebhookHandlers(server: Server, db: OpenShapeForgeDatabase,
  session: TrustedSessionContext, entities: readonly string[], owner: ModuleEgressDispatch["owner"]): boolean {
  if (!owner?.pinsResolvedAddresses || !entities.includes("Notification")) return false;
  const keys = keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);
  const allowlist = (process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean);
  const principal = eventWebhookPrincipal(session);
  if (!principal || !keys || !allowlist.length) return false;
  const store = createEventWebhookStore(db, session, principal);
  const dispatch: ModuleEgressDispatch = { owner, purpose: "probe", scope: {
    tenantId: principal.tenantId, actorId: principal.userId, provider: "mcp-events", operation: "callback", kind: "mutation",
  } };
  function destination(name: string, entity: string, url: string) {
    if (name !== eventName) throw new ProtocolError(-32023, "Event not found.");
    if (entity !== "Notification") throw new ProtocolError(-32024, "Event subscription is forbidden.");
    try { return eventWebhookDestination(url, dispatch, allowlist); }
    catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid webhook callback URL."); }
  }
  server.setRequestHandler("events/subscribe", { params: subscribeParams }, async params => {
    const { entity } = params.arguments;
    const target = destination(params.name, entity, params.delivery.url);
    const now = Date.now();
    const expiresAt = new Date(Math.min(now + EVENT_WEBHOOK_TTL_MS, session.bearerExpiresAt ?? 0));
    if (expiresAt.getTime() < now + 30_000) {
      throw new ProtocolError(-32024, "Refresh the OAuth access token before subscribing to this event.");
    }
    const id = eventWebhookId(principal, entity, target.url);
    let key: Buffer;
    let requested: string | undefined;
    try {
      key = decodeEventWebhookSecret(params.delivery.secret);
      requested = parseStreamCursor(params.cursor ?? undefined);
    } catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid signing key or cursor."); }
    const existing = await store.get(id);
    const knownCursor = existing?.cursor ?? requested;
    const batch = await readChangeBatch(db, session, knownCursor, true, undefined, entity);
    const cursor = batch.reset ? batch.cursor : knownCursor!;
    try { await verifyEventWebhook(target, key, id); }
    catch { throw new ProtocolError(-32015, "Webhook callback could not be verified.", { reason: "challenge_failed" }); }
    const row = await store.retain({ keys, id, entity, url: target.url, secret: params.delivery.secret, cursor, expiresAt });
    if (!row) throw new ProtocolError(-32025, "Too many active event subscriptions.", { limit: "subscriptions", max: 5 });
    return { resultType: "complete", id, cursor: row.cursor, truncated: knownCursor !== undefined && batch.reset,
      refreshBefore: expiresAt.toISOString() };
  });
  server.setRequestHandler("events/unsubscribe", { params: unsubscribeParams }, async params => {
    const target = destination(params.name, params.arguments.entity, params.delivery.url);
    await store.remove(eventWebhookId(principal, params.arguments.entity, target.url));
    return { resultType: "complete" };
  });
  return true;
}
