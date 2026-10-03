// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { applyAppHelpersMigration } from "../db/migrations/app-helpers.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "./platform.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `module_transaction_${randomUUID().replaceAll("-", "")}`;
const tenantId = randomUUID(), userId = randomUUID(), otherTenant = randomUUID();
const session: TrustedSessionContext = {
  tenantId, userId, roles: ["Fixture.Write"], groups: [], scope: "tenant", credential: "bearer",
};
let admin: SQL | undefined, privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
let created = false;

beforeAll(async () => {
  const owner = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(owner.hostname) || owner.pathname !== "/postgres") {
    throw new Error("Module transaction tests require a local scratch admin database.");
  }
  admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  created = true;
  owner.pathname = `/${scratchName}`;
  privileged = createDatabaseRuntime({ databaseUrl: owner.toString(), maxConnections: 1 });
  await applyAppHelpersMigration(privileged.db);
  await sql`create schema platform; create schema fixture;
    create table fixture.writes(id uuid primary key, tenant_id uuid not null, kind text not null);
    alter table fixture.writes enable row level security;
    alter table fixture.writes force row level security;
    create policy fixture_write on fixture.writes
      using (tenant_id=app.current_tenant() and app.has_any_role(array['Fixture.Write']))
      with check (tenant_id=app.current_tenant() and app.has_any_role(array['Fixture.Write']));
  `.execute(privileged.db);
  const generated = readFileSync(new URL("../generated/db/schema.sql", import.meta.url), "utf8");
  for (const name of ["capability_grants", "entity_events"]) {
    const start = generated.indexOf(`CREATE TABLE IF NOT EXISTS "platform"."${name}" (`);
    const end = generated.indexOf("CREATE SCHEMA IF NOT EXISTS", start + 1);
    if (start < 0 || end < 0) throw new Error(`Missing generated ${name} fixture.`);
    await sql.raw(generated.slice(start, end)).execute(privileged.db);
  }
  await sql`grant usage on schema app, platform, fixture to openshapeforge_app;
    grant select, insert on fixture.writes, platform.capability_grants, platform.entity_events to openshapeforge_app;
    grant usage, select on all sequences in schema platform to openshapeforge_app;
  `.execute(privileged.db);
  owner.username = "openshapeforge_app";
  owner.password = "openshapeforge_app";
  restricted = createDatabaseRuntime({ databaseUrl: owner.toString(), maxConnections: 4 });
  const role = (await sql<{ superuser: boolean; bypass: boolean }>`
    select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname=current_user
  `.execute(restricted.db)).rows[0]!;
  expect(role).toEqual({ superuser: false, bypass: false });
}, 30_000);

afterAll(async () => {
  await restricted?.close(); await privileged?.close();
  if (created) await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
});

async function exercise(fail: boolean) {
  const subjectId = randomUUID(), nestedId = randomUUID();
  const observations: Array<{ pid: number; xid: string }> = [];
  const witness = async (trx: Transaction<DB>) => {
    observations.push((await sql<{ pid: number; xid: string }>`
      select pg_backend_pid() as pid, pg_current_xact_id()::text as xid
    `.execute(trx)).rows[0]!);
  };
  const runtime = new ModulePlatformRuntime(restricted!.db, { capabilityOperations: new Set(["fixture.callback.complete"]) });
  const definition = {
    id: "fixture.nested.write", key: "fixture.nested.write", intent: "invoke", name: "Fixture nested write", description: "Fixture.",
    input: { kind: "json-schema" as const, schema: { type: "object" } }, output: { kind: "json-schema" as const, schema: {} },
    effects: { data: "write" as const, external: "none" as const }, reliability: { idempotency: { mode: "natural" as const } },
  };
  runtime.registerStaticOperations([{ definition, available: () => true, execute: async (active) => {
    await runtime.withOperationTransaction(active, async (trx) => {
      await witness(trx);
      await sql`insert into fixture.writes values(${nestedId}::uuid, ${tenantId}::uuid, 'nested')`.execute(trx);
    });
    return { data: {}, operations: [] };
  } }]);
  const work = () => withModuleOperationSession(runtime.services, session, async (active) => {
    await runtime.services.db.withSession(active!, async (trx) => {
      await witness(trx);
      await sql`insert into fixture.writes values(${subjectId}::uuid, ${tenantId}::uuid, 'outer')`.execute(trx);
      const grant = await runtime.services.grants.issue(active!, {
        operations: ["fixture.callback.complete"], subject: { entity: "FixtureWait", id: subjectId },
        recipient: { kind: "fixture" }, maxUses: 1, expiresAt: new Date(Date.now() + 60_000),
      });
      await runtime.services.events.append(active!, {
        aggregateType: "FixtureWait", aggregateId: subjectId, eventType: "fixture.ready", payload: {},
      });
      expect(await runtime.services.operations.execute(active!, { operation: definition })).toEqual({ data: {}, operations: [] });
      expect(() => runtime.services.db.withSession({ ...active! }, async () => undefined)).toThrow("live verified session");
      const events = (await sql<{ xid: string }>`select origin_xid as xid from platform.entity_events
        where aggregate_id in (${subjectId}, ${grant.id})`.execute(trx)).rows;
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.xid === observations[0]!.xid)).toBe(true);
      if (fail) throw new Error("Fixture fanout rollback");
    });
  });
  if (fail) await expect(work()).rejects.toThrow("Fixture fanout rollback"); else await work();
  expect(observations).toHaveLength(2);
  expect(observations[1]).toEqual(observations[0]!);
  const count = async (query: string) => (await sql<{ count: number }>`${sql.raw(query)}`.execute(privileged!.db)).rows[0]!.count;
  expect(await count(`select count(*)::int as count from fixture.writes where id in ('${subjectId}', '${nestedId}')`)).toBe(fail ? 0 : 2);
  expect(await count(`select count(*)::int as count from platform.capability_grants where subject_id='${subjectId}'`)).toBe(fail ? 0 : 1);
  expect(await count(`select count(*)::int as count from platform.entity_events where aggregate_id='${subjectId}' or
    aggregate_id in (select id::text from platform.capability_grants where subject_id='${subjectId}')`)).toBe(fail ? 0 : 2);
}

test("restricted module DB work commits grants, journal and nested canonical writes on one connection and transaction", () => exercise(false));
test("an enclosing module failure rolls back grants, journal and nested canonical writes together", () => exercise(true));
test("restricted module DB work refuses session substitution, cross-tenant writes and missing roles", async () => {
  const runtime = new ModulePlatformRuntime(restricted!.db);
  for (const actor of [session, { ...session, roles: [] }]) {
    await expect(withModuleOperationSession(runtime.services, actor, async (active) => {
      await runtime.services.db.withSession(active!, async (trx) => {
        await sql`insert into fixture.writes values(${randomUUID()}::uuid, ${actor.roles.length ? otherTenant : tenantId}::uuid, 'denied')`.execute(trx);
      });
    })).rejects.toThrow("row-level security policy");
  }
  expect((await sql<{ count: number }>`select count(*)::int as count from fixture.writes where kind='denied'`.execute(privileged!.db)).rows[0]!.count).toBe(0);
});
