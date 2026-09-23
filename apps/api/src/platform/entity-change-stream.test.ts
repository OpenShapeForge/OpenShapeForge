// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
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
const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
const secret = "sse-synthetic-test-context-secret";
beforeAll(async () => {
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${database}"`);
  const url = new URL(adminUrl); url.pathname = `/${database}`;
  privileged = createDatabaseRuntime({ databaseUrl: url.toString() });
  await privileged.db.connection().execute(conn => runMigrationChain(conn));
  url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 6 });
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
  registerEntityChangeStream(app, { db: runtime.db });
  origin = await app.listen({ port: 0, host: "127.0.0.1" });
}, 90_000);
afterAll(async () => {
  await app.close(); await runtime?.close(); await privileged?.close();
  await admin?.unsafe(`drop database if exists "${database}" with (force)`); await admin?.close();
  if (previousSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousSecret;
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
  const current = await readChangeBatch(runtime.db, actor);
  await sql`update platform.entity_events set occurred_at = now() - interval '2 days' where delivery_sequence = ${current.cursor}`.execute(privileged.db);
  expect((await readChangeBatch(runtime.db, actor, current.cursor)).reset).toBe(true);
  expect((await readChangeBatch(runtime.db, actor, "9223372036854775807")).reset).toBe(true);
  expect((await readChangeBatch(runtime.db, actor, "0")).reset).toBe(true);
});

test("a recent checkpoint cannot replay an older expired event delivered after it", async () => {
  const isolated = { ...actor, tenantId: randomUUID() };
  await withDbSession(runtime.db, isolated, async trx => appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "recent", eventType: "updated" }));
  const checkpoint = await readChangeBatch(runtime.db, isolated);
  const late = await withDbSession(runtime.db, isolated, async trx => appendScopedEntityEventInTransaction(trx, { aggregateType: "fixture", aggregateId: "late", eventType: "updated" }));
  const delivered = await readChangeBatch(runtime.db, isolated, checkpoint.cursor);
  await sql`update platform.entity_events set occurred_at = now() - interval '2 days' where id = ${late.id}`.execute(privileged.db);
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
