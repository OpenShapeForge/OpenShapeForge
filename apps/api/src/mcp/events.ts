// SPDX-License-Identifier: BUSL-1.1
import { setTimeout as delay } from "node:timers/promises";
import { fromJsonSchema, ProtocolError, ProtocolErrorCode, type Server } from "@modelcontextprotocol/server";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { getGeneratedCrudTables, requireEntityOperation } from "../operations/entity/catalog.js";
import { registerMcpEventWebhookHandlers } from "./event-webhook-handlers.js";
import type { ModuleEgressDispatch } from "../modules/egress.js";
import { parseStreamCursor, readChangeBatch } from "../platform/entity-change-stream.js";

const extension = "io.modelcontextprotocol/events";
const name = "resource.created";
const heartbeatMs = 15_000;
const maxLifetimeMs = 55_000;
const maxStreamsPerUser = 5;
const activeStreams = new Map<string, number>();
const listParams = fromJsonSchema({ type: "object" });
const streamParams = fromJsonSchema<{ name: string; arguments: { entity: string }; cursor?: string | null; maxAgeMs?: number }>({
  type: "object", required: ["name", "arguments"], properties: {
    name: { type: "string" },
    arguments: { type: "object", required: ["entity"], additionalProperties: false, properties: { entity: { type: "string" } } },
    cursor: { type: ["string", "null"] },
    maxAgeMs: { type: "integer", minimum: 0 },
    heartbeatMs: { type: "integer", minimum: 1 },
  },
});

function visibleEntities(session: TrustedSessionContext): string[] {
  return getGeneratedCrudTables().flatMap(table => {
    const entity = table.source?.authoringEntityName;
    if (!entity || !table.realtime || !table.primaryKey || table.source?.mcp?.operations.get !== true) return [];
    try { requireEntityOperation(table, "get", session); }
    catch { return []; }
    return [entity];
  }).sort();
}

export function registerMcpEvents(server: Server, db: OpenShapeForgeDatabase, session: TrustedSessionContext,
  refresh: () => Promise<TrustedSessionContext>, egressOwner?: ModuleEgressDispatch["owner"]): void {
  if (!session.tenantId || !session.userId || session.appPrincipal) return;
  const entities = visibleEntities(session);
  if (!entities.length) return;
  const webhook = registerMcpEventWebhookHandlers(server, db, session, entities, egressOwner);
  server.registerCapabilities({ extensions: { [extension]: {} }, ...(webhook ? { events: {} } : {}) });
  server.setRequestHandler("events/list", { params: listParams }, async () => ({
    resultType: "complete",
    events: [{
      name, description: webhook
        ? "A new readable resource of the selected entity was created. Webhook delivery is available for personal notifications."
        : "A new readable resource of the selected entity was created.",
      delivery: webhook ? ["push", "webhook"] : ["push"],
      inputSchema: { type: "object", required: ["entity"], additionalProperties: false, properties: { entity: { type: "string", enum: entities } } },
      payloadSchema: { type: "object", required: ["entity", "id"], additionalProperties: false,
        properties: { entity: { type: "string" }, id: { type: "string" } } },
    }],
  }));
  server.setRequestHandler("events/stream", { params: streamParams }, async (params, { mcpReq }) => {
    const { entity } = params.arguments;
    if (params.name !== name) throw new ProtocolError(-32023, "Event not found.");
    if (!entities.includes(entity)) throw new ProtocolError(-32024, "Event subscription is forbidden.");
    let cursor: string | undefined;
    try { cursor = parseStreamCursor(params.cursor ?? undefined); }
    catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid cursor."); }
    const key = `${session.tenantId}:${session.userId}`;
    const count = activeStreams.get(key) ?? 0;
    if (count >= maxStreamsPerUser) {
      throw new ProtocolError(-32025, "Too many active event streams.", { limit: "subscriptions", max: maxStreamsPerUser });
    }
    activeStreams.set(key, count + 1);
    const meta = { "io.modelcontextprotocol/subscriptionId": mcpReq.id };
    const signal = mcpReq.signal;
    let lastSent = Date.now();
    const send = async (type: string, fields: Record<string, unknown>) => {
      await mcpReq.notify({ method: `notifications/events/${type}`, params: { ...fields, _meta: meta } });
      lastSent = Date.now();
    };
    const deadline = lastSent + maxLifetimeMs;
    const startsNow = cursor === undefined;
    const earliest = startsNow ? lastSent : params.maxAgeMs === undefined ? 0 : lastSent - params.maxAgeMs;
    let first = true;
    try {
      while (!signal.aborted && Date.now() < deadline) {
        const current = first ? session : await refresh().catch(() => undefined);
        if (!current || current.tenantId !== session.tenantId || current.userId !== session.userId || !visibleEntities(current).includes(entity)) {
          await send("terminated", { error: { code: -32024, message: "Forbidden", data: { reason: "Access revoked" } } });
          break;
        }
        const batch = await readChangeBatch(db, current, cursor, first, undefined, entity);
        if (signal.aborted) break;
        if (first || batch.reset) {
          await send("active", { cursor: batch.reset ? batch.cursor : cursor, truncated: cursor !== undefined && batch.reset, heartbeatMs });
        }
        for (const event of batch.changes) {
          if (signal.aborted) break;
          if (!event.eventId || !event.timestamp) continue;
          if (Date.parse(event.timestamp) < earliest) {
            if (!startsNow) await send("active", { cursor: event.cursor, truncated: true, heartbeatMs });
            continue;
          }
          await send("event", { eventId: event.eventId, name, timestamp: event.timestamp,
            data: { entity, id: event.data.id }, cursor: event.cursor });
        }
        cursor = batch.cursor;
        first = false;
        if (!signal.aborted && Date.now() - lastSent >= heartbeatMs) await send("heartbeat", { cursor });
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      const remaining = (activeStreams.get(key) ?? 1) - 1;
      if (remaining) activeStreams.set(key, remaining);
      else activeStreams.delete(key);
    }
    return { resultType: "complete", _meta: meta };
  });
}
