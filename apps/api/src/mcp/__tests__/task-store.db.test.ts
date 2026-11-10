// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { applyAppHelpersMigration } from "../../db/migrations/app-helpers.js";
import { applyMcpTasksMigration } from "../../db/migrations/mcp-tasks.js";
import { createTaskStore } from "../task-store.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@127.0.0.1:5434/postgres";
const name = `mcp_tasks_${randomUUID().replaceAll("-", "")}`;
const tenant = randomUUID(), actor = randomUUID();
const session: TrustedSessionContext = { tenantId: tenant, userId: actor, roles: [], groups: [], scope: "tenant", credential: "trusted-context" };
let admin: SQL, runtime: DatabaseRuntime;
beforeAll(async () => {
  const url = new URL(adminUrl); url.pathname = "/postgres";
  admin = new SQL(url.toString());
  await admin.unsafe(`create database "${name}"`);
  url.pathname = `/${name}`; runtime = createDatabaseRuntime({ databaseUrl: url.toString() });
  await applyAppHelpersMigration(runtime.db);
  const schema = readFileSync(new URL("../../generated/db/schema.sql", import.meta.url), "utf8");
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS "platform"."mcp_tasks"');
  const end = schema.indexOf('CREATE SCHEMA', start);
  expect(start).toBeGreaterThan(0);
  await sql.raw('create schema platform;\n' + schema.slice(start, end)).execute(runtime.db);
  await applyMcpTasksMigration(runtime.db);
  await applyMcpTasksMigration(runtime.db);
  await sql`grant usage on schema platform, app to openshapeforge_app;
    grant select, insert, update, delete on platform.mcp_tasks to openshapeforge_app;`.execute(runtime.db);
}, 30000);
afterAll(async () => {
  if (runtime) await runtime.close();
  if (admin) { await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.close(); }
});
test("persists idempotent handles across store reconstruction and isolates actor, tenant and authenticated client", async () => {
  const store = createTaskStore(runtime.db, session, "client-a");
  const ref = { kind: "example-job", ref: randomUUID() };
  const first = await store.retain(ref);
  const replay = await Promise.all(Array.from({ length: 4 }, () => createTaskStore(runtime.db, session, "client-a").retain(ref)));
  expect(new Set(replay.map(row => row.id))).toEqual(new Set([first.id]));
  expect((await createTaskStore(runtime.db, session, "client-a").get(first.id))?.owner_ref).toBe(ref.ref);
  expect(await createTaskStore(runtime.db, { ...session, userId: randomUUID() }, "client-a").get(first.id)).toBeUndefined();
  expect(await createTaskStore(runtime.db, { ...session, tenantId: randomUUID() }, "client-a").get(first.id)).toBeUndefined();
  expect(await createTaskStore(runtime.db, session, "client-b").get(first.id)).toBeUndefined();
  await sql`update platform.mcp_tasks set expires_at = clock_timestamp() - interval '1 second' where id = ${first.id}::uuid`.execute(runtime.db);
  expect(await store.get(first.id)).toBeUndefined();
  expect((await store.retain(ref)).id).not.toBe(first.id);
});
test("the restricted database role cannot read another actor or tenant even without store predicates", async () => {
  const first = await createTaskStore(runtime.db, session, "raw-test").retain({ kind: "example-job", ref: randomUUID() });
  const count = async (tenantId: string, userId: string, authority = "raw-test", bypass = false) => runtime.db.transaction().execute(async trx => {
    await sql`set local role openshapeforge_app`.execute(trx);
    await sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true),
      set_config('app.mcp_task_authority', ${authority}, true), set_config('app.bypass_rls', ${String(bypass)}, true)`.execute(trx);
    const { rows } = await sql<{ count: string }>`select count(*)::text as count from platform.mcp_tasks where id = ${first.id}::uuid`.execute(trx);
    return Number(rows[0]!.count);
  });
  expect(await count(tenant, actor)).toBe(1);
  expect(await count(tenant, randomUUID())).toBe(0);
  expect(await count(randomUUID(), actor)).toBe(0);
  expect(await count(tenant, actor, "other-authority")).toBe(0);
  expect(await count(tenant, actor, "")).toBe(0);
  expect(await count(tenant, actor, "raw-test", true)).toBe(1);
  expect(await count(tenant, randomUUID(), "raw-test", true)).toBe(0);
  expect(await count(randomUUID(), actor, "raw-test", true)).toBe(0);
  expect(await count(tenant, actor, "other-authority", true)).toBe(0);
});
