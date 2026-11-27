// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { registerMcpEvents } from "../mcp/events.js";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { withDbSession } from "../db/session.js";
import { createGeneratedEntity, updateGeneratedEntity, deleteGeneratedEntity } from "../operations/entity/index.js";
import { appendScopedEntityEventInTransaction } from "./entity-events.js";
import { encodeStreamFrame, parseStreamCursor, readChangeBatch } from "./entity-change-stream.js";
import { registerEntityChangeStream } from "../rest/entity-change-stream.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const database = `sse_${randomUUID().replaceAll("-", "")}`;
const actor = { tenantId: randomUUID(), userId: randomUUID(), roles: ["Relations.RelationGroups.ReadWrite"], groups: [], scope: "self" as const };
const reader = { ...actor, userId: randomUUID() };
let admin: SQL;
let privileged: DatabaseRuntime;
let runtime: DatabaseRuntime;
const app = Fastify({ logger: false });
let origin: string;
let stallStream: (() => Promise<void>) | undefined;
app.addHook("onSend", async (request, reply, payload) => {
  if (request.headers["x-sse-test-stall"] === "yes" && reply.getHeader("content-type")?.toString().startsWith("text/event-stream")) {
    await stallStream?.();
  }
  return payload;
});
const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
const previousIssuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
const secret = "sse-synthetic-test-context-secret";
const issuer = "https://identity.example.test/realms/sse-test";
beforeAll(async () => {
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  const url = new URL(adminUrl); url.pathname = `/${database}`;
  privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute(conn => runMigrationChain(conn));
  url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 6 });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
  process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = issuer;
  registerEntityChangeStream(app, { db: runtime.db });
  origin = await app.listen({ port: 0, host: "127.0.0.1" });
}, 90_000);
afterAll(async () => {
  await app.close(); await runtime?.close(); await privileged?.close();
  await admin?.unsafe(`drop database if exists "${database}" with (force)`); await admin?.close();
  if (previousSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousSecret;
  if (previousIssuer === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = previousIssuer;
});

test("cursor syntax and frame encoding reject injection and preserve exact identifiers", () => {
  for (const invalid of ["-1", "1\nevent: attack", "01", "9223372036854775808", ["1"]]) expect(() => parseStreamCursor(invalid)).toThrow();
  expect(parseStreamCursor("123")).toBe("123");
  expect(encodeStreamFrame("1", "resource.changed", { id: "line\nbreak" })).toBe('id: 1\nevent: resource.changed\ndata: {"id":"line\\nbreak"}\n\n');
});

test("committed CRUD is replayed to another session; unauthorized tenants and roles see no ids", async () => {
  const start = await readChangeBatch(runtime.db, reader);
  const row = await createGeneratedEntity(runtime.db, actor, { table: "erp.relation_groups", values: { name: "SSE fixture", groupType: "team" } });
  const id = String(row.id);
  let batch = await readChangeBatch(runtime.db, reader, start.cursor);
  expect(batch.changes.map(e => e.data)).toEqual([{ entity: "RelationGroup", id, change: "created" }]);
  expect((await readChangeBatch(runtime.db, { ...reader, roles: [] }, start.cursor)).changes).toEqual([]);
  expect((await readChangeBatch(runtime.db, { ...reader, tenantId: randomUUID() }, "0")).changes).toEqual([]);
  const cursor = batch.cursor;
  await updateGeneratedEntity(runtime.db, actor, { table: "erp.relation_groups", id, values: { name: "Changed elsewhere" } });
  batch = await readChangeBatch(runtime.db, reader, cursor);
  expect(batch.changes.map(e => e.data.change)).toEqual(["updated"]);
  expect((await readChangeBatch(runtime.db, reader, batch.cursor)).changes).toEqual([]);
  await deleteGeneratedEntity(runtime.db, actor, { table: "erp.relation_groups", id });
  expect((await readChangeBatch(runtime.db, reader, batch.cursor)).changes.map(e => e.data)).toEqual([{ entity: "RelationGroup", id, change: "deleted" }]);
});

test("rollback never publishes and late commits get later delivery cursors without blocking writers", async () => {
  const baseline = await readChangeBatch(runtime.db, actor);
  await expect(withDbSession(runtime.db, actor, async trx => {
    await appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "rollback", eventType: "updated" });
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await readChangeBatch(runtime.db, actor, baseline.cursor)).cursor).toBe(baseline.cursor);
  let release!: () => void;
  let inserted!: () => void;
  const ready = new Promise<void>(resolve => { inserted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withDbSession(runtime.db, actor, async trx => {
    const event = await appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "first", eventType: "updated" });
    inserted(); await gate; return event;
  });
  await ready;
  const b = await withDbSession(runtime.db, actor, async trx => appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "second", eventType: "updated" }));
  const beforeCommit = await readChangeBatch(runtime.db, actor, baseline.cursor);
  release(); const a = await first;
  expect(BigInt(a.sequence) < BigInt(b.sequence)).toBe(true);
  const afterCommit = await readChangeBatch(runtime.db, actor, beforeCommit.cursor);
  expect(BigInt(afterCommit.cursor) > BigInt(beforeCommit.cursor)).toBe(true);
  const delivered = await sql<{ aggregate_id: string }>`select aggregate_id from platform.entity_events where id in (${a.id}, ${b.id}) order by delivery_sequence`.execute(privileged.db);
  expect(delivered.rows.map(row => row.aggregate_id)).toEqual(["second", "first"]);
});

test("expired and unavailable cursors reset to current high water", async () => {
  const isolated = { ...actor, tenantId: randomUUID() };
  await sql`insert into platform.entity_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,occurred_at,delivery_sequence) values(${isolated.tenantId}::uuid,'fixture','old','updated','{}',now()-interval '2 days',1)`.execute(privileged.db);
  const current = await readChangeBatch(runtime.db, isolated);
  expect((await readChangeBatch(runtime.db, isolated, current.cursor)).reset).toBe(true);
  expect((await readChangeBatch(runtime.db, isolated, "9223372036854775807")).reset).toBe(true);
  expect((await readChangeBatch(runtime.db, isolated, "0")).reset).toBe(true);
});

test("a recent checkpoint cannot replay an older expired event delivered after it", async () => {
  const isolated = { ...actor, tenantId: randomUUID() };
  await withDbSession(runtime.db, isolated, async trx => appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "recent", eventType: "updated" }));
  const checkpoint = await readChangeBatch(runtime.db, isolated);
  await sql`insert into platform.entity_events(tenant_id,aggregate_type,aggregate_id,event_type,payload,occurred_at,delivery_sequence) values(${isolated.tenantId}::uuid,'fixture','late','updated','{}',now()-interval '2 days',${BigInt(checkpoint.cursor)+1n})`.execute(privileged.db);
  const delivered = await readChangeBatch(runtime.db, isolated, checkpoint.cursor);
  const replay = await readChangeBatch(runtime.db, isolated, checkpoint.cursor);
  expect(replay).toEqual({ cursor: delivered.cursor, reset: true, changes: [] });
});

test("real HTTP SSE receives another session's mutation and reconnect replays it", async () => {
  const headers = new Headers({ accept: "text/event-stream" });
  applyTrustedContextHeaders(headers, reader, { secret });
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events`, { headers, signal: controller.signal });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/event-stream");
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  const initial = decoder.decode((await stream.read()).value);
  const cursor = initial.match(/id: (\d+)/)![1]!;
  const row = await createGeneratedEntity(runtime.db, actor, { table: "erp.relation_groups", values: { name: "Live HTTP fixture", groupType: "team" } });
  let received = "";
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    while (!received.includes(String(row.id))) {
      const chunk = await stream.read(); if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    expect(received).toContain("event: resource.changed"); expect(received).toContain(String(row.id));
  } finally { clearTimeout(timeout); controller.abort(); await stream.cancel().catch(() => {}); }
  const replay = await readChangeBatch(runtime.db, reader, cursor, false);
  expect(replay.changes.some(event => event.data.id === row.id)).toBe(true);
  expect((await fetch(`${origin}/api/events`)).status).toBe(401);
  expect((await fetch(`${origin}/api/events`, { headers: { "last-event-id": "invalid" } })).status).toBe(400);
}, 15_000);

test("a client that disconnects releases its stream slot at once (#886)", async () => {
  // Five concurrent streams per person are allowed. Seven opened and dropped
  // one after another must all be admitted: a navigation is not a new stream
  // on top of the old one until the old one rotates.
  const headers = new Headers({ accept: "text/event-stream" });
  applyTrustedContextHeaders(headers, { ...reader, userId: randomUUID() }, { secret });
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { headers, signal: controller.signal });
    statuses.push(response.status);
    if (response.ok) await response.body!.getReader().read();
    controller.abort();
    await delay(150);
  }
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200]);
}, 15_000);

test("an unconsumed response cannot hold a stream slot past its lifetime", async () => {
  const headers = new Headers({ accept: "text/event-stream" });
  applyTrustedContextHeaders(headers, { ...reader, userId: randomUUID() }, { secret });
  const blocked = new AbortController();
  const stalled = new Headers(headers);
  stalled.set("x-sse-test-stall", "yes");
  let entered = 0;
  let allEntered!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>(resolve => { allEntered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  stallStream = async () => {
    if (++entered === 5) allEntered();
    await paused;
  };
  const requests = Array.from({ length: 5 }, () =>
    fetch(`${origin}/api/events`, { headers: stalled, signal: blocked.signal }).catch(() => undefined));
  try {
    await Promise.race([ready, delay(5_000).then(() => { throw new Error("Five response streams did not reach onSend"); })]);
    const refused = await fetch(`${origin}/api/events`, { headers });
    expect(refused.status).toBe(429);
    await refused.body?.cancel();
    await delay(61_000);
    const admitted = await fetch(`${origin}/api/events`, { headers, signal: AbortSignal.timeout(5_000) });
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
  } finally {
    blocked.abort();
    resume();
    stallStream = undefined;
    await Promise.all(requests);
  }
}, 75_000);

test("MCP Events streams a committed, authorized creation with its journal identity", async () => {
  const who = { ...reader, credential: "trusted-context" } as Parameters<typeof registerMcpEvents>[2];
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "events-test", version: "1" });
    registerMcpEvents(server, runtime.db, who, async () => who);
    return server;
  }, { legacy: "reject" });
  const abort = new AbortController();
  const post = (method: string, params: Record<string, unknown> = {}) => handler.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method },
    signal: abort.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/events": {} } },
      "io.modelcontextprotocol/clientInfo": { name: "events-test", version: "1" },
    } } }),
  }));
  try {
    expect(await (await post("server/discover")).json()).toMatchObject({
      result: { capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } },
    });
    expect(await (await post("events/list")).json()).toMatchObject({
      result: { events: [{ name: "resource.created", delivery: ["push"] }] },
    });
    const stream = await post("events/stream", { name: "resource.created", arguments: { entity: "RelationGroup" }, cursor: null });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    async function next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Events stream ended early.");
          buffer += chunk.value;
        }
      }
    }
    expect(await next()).toMatchObject({ method: "notifications/events/active", params: {
      truncated: false, _meta: { "io.modelcontextprotocol/subscriptionId": 1 },
    } });
    const row = await createGeneratedEntity(runtime.db, actor, { table: "erp.relation_groups", values: { name: "MCP Events fixture", groupType: "team" } });
    expect(await next()).toMatchObject({ method: "notifications/events/event", params: {
      name: "resource.created", eventId: expect.any(String), timestamp: expect.any(String),
      data: { entity: "RelationGroup", id: String(row.id) }, cursor: expect.any(String),
    } });
    await reader.cancel();
  } finally { abort.abort(); await handler.close(); }
}, 15_000);

test("MCP event subscription metadata is isolated by actor and OAuth client", async () => {
  const { createEventWebhookStore, eventWebhookId, openEventWebhookDelivery } = await import("../mcp/event-webhook-store.js");
  const session = { ...reader, credential: "bearer" as const, relationGroupIds: [],
    issuer: "https://issuer.example.test/realms/events", oauthClientId: "work-test" };
  const principal = { tenantId: session.tenantId, userId: session.userId, issuer: session.issuer, clientId: session.oauthClientId };
  await sql`insert into platform.tenants (id, slug, name, status)
    values (${principal.tenantId}::uuid, 'event-test', 'Event test', 'active')`.execute(privileged.db);
  const store = createEventWebhookStore(runtime.db, session, principal);
  const url = new URL("https://work.example.test/events");
  const id = eventWebhookId(principal, "Notification", url);
  const keys = { activeKeyId: "local", keys: new Map([["local", Buffer.alloc(32, 7)]]) };
  const secret = "whsec_" + Buffer.alloc(32, 3).toString("base64");
  const row = await store.retain({ keys, id, entity: "Notification", url, secret, cursor: "0", expiresAt: new Date(Date.now() + 60_000) });
  expect(row?.id).toBe(id);
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(openEventWebhookDelivery(keys, row!)).toEqual({ url: url.href, secret, grant: { scope: session.scope, roles: session.roles, groups: session.groups, oauthScopes: [] } });

  const otherClient = { ...principal, clientId: "other-client" };
  expect(await createEventWebhookStore(runtime.db, { ...session, oauthClientId: otherClient.clientId }, otherClient).get(id)).toBeUndefined();
  const otherPerson = { ...principal, userId: actor.userId };
  expect(await createEventWebhookStore(runtime.db, { ...session, userId: actor.userId }, otherPerson).get(id)).toBeUndefined();
  await store.remove(id);
  expect(await store.get(id)).toBeUndefined();
});

test("MCP Events advertises, verifies and renews a webhook on the configured entity", async () => {
  const bearerExpiresAt = Date.now() + 180_000;
  const who: Parameters<typeof registerMcpEvents>[2] = {
    ...reader, tenantId: randomUUID(), credential: "bearer", principalKind: "person",
    issuer, oauthClientId: "work-test", bearerExpiresAt,
    relation: {
      status: "linked", identityId: randomUUID(), issuer, subject: reader.userId, relationId: randomUUID(),
      displayName: null, relationType: "person", candidateRelationId: null, linkedBy: null,
      needsRoleAssignment: false, roles: reader.roles,
    },
  };
  await sql`insert into platform.tenants (id, slug, name, status)
    values (${who.tenantId}::uuid, 'event-hooks-test', 'Event hooks test', 'active')`.execute(privileged.db);
  const key = Buffer.alloc(32, 3).toString("base64");
  const previousKeys = process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
  const previousHosts = process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS;
  process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = `test:${key}`;
  process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS = "8.8.8.8";
  let verifications = 0;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "events-test", version: "1" });
    registerMcpEvents(server, runtime.db, who, async () => who, {
      pinsResolvedAddresses: true,
      fetch: async ({ init }) => {
        verifications++;
        expect(new Headers(init.headers).get("webhook-signature")).toMatch(/^v1,/);
        const body = await new Response(init.body).json();
        expect(body.type).toBe("verification");
        return Response.json({ challenge: body.challenge });
      },
    }, "RelationGroup");
    return server;
  }, { legacy: "reject" });
  const post = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "events-test", version: "1" },
      } } }),
    }));
    return response.json();
  };
  try {
    expect(await post("server/discover")).toMatchObject({ result: { capabilities: { events: {} } } });
    expect(await post("events/list")).toMatchObject({ result: { events: [{ name: "resource.created", delivery: ["push", "webhook"] }] } });
    const args = { name: "resource.created", arguments: { entity: "RelationGroup" } };
    const url = "https://8.8.8.8/callback";
    const request = { ...args, delivery: { mode: "webhook", url, secret: `whsec_${key}` } };
    const subscribed = await post("events/subscribe", request);
    expect(subscribed).toMatchObject({ result: { id: expect.any(String), refreshBefore: new Date(bearerExpiresAt).toISOString() } });
    expect(await post("events/subscribe", request)).toMatchObject({ result: { id: subscribed.result.id } });
    expect(verifications).toBe(1);
    expect(await post("events/unsubscribe", { ...args, delivery: { url } })).toMatchObject({ result: { resultType: "complete" } });
  } finally {
    await handler.close();
    if (previousKeys === undefined) delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
    else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS = previousKeys;
    if (previousHosts === undefined) delete process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS;
    else process.env.OPENSHAPEFORGE_MCP_EVENT_CALLBACK_HOSTS = previousHosts;
  }
}, 15_000);
