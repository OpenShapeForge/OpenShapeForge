// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { withDbSession } from "../session.js";
import { runMigrationChain } from "../migration-chain.js";
import { applySearchIndex, searchIndexConfigs } from "./search-index.js";
import { withAuditContext } from "../../platform/audit-context.js";
import type { GeneratedCrudTable } from "../../operations/entity/types.js";

// The index on a database the whole chain built: the declared table, its
// forced tenant policy and the grants are the real ones, and the trigger's
// definer is an ordinary role that row-level security binds like any other.

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminUrl).hostname)) throw new Error("Scratch tests require a local postgres admin database.");
const tenant = crypto.randomUUID(), otherTenant = crypto.randomUUID(), user = crypto.randomUUID();
const session = (tenantId: string) => ({ tenantId, userId: user, roles: [], groups: [], scope: "tenant" as const, credential: "trusted-context" as const, principalKind: "person" as const });
const column = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, required: false, primaryKey: name === "id", generated: null, sourceField: name, ...extra });
const table = (entity: string, name: string, key = "uuid"): GeneratedCrudTable => ({ name: `search_probe.${name}`, schema: "search_probe", table: name, primaryKey: "id", tenantScoped: true, domainInternal: false, generatedCrudEligible: true,
  columns: [column("id", key), column("tenant_id", "uuid"), column("name", "text"), column("description", "text"), column("secret", "text", { classification: "pii" }), column("amount", "numeric")],
  source: { authoringEntityName: entity } } as GeneratedCrudTable);
const notes = table("ProbeNote", "notes"), codes = table("ProbeCode", "codes", "text");
const sources = [{ entity: "ProbeNote", field: "name", descriptionField: "description" }, { entity: "ProbeCode", field: "name" },
  { entity: "ProbeNote.secret", field: "secret" }, { entity: "Absent", field: "name" }];

test("only what every reader may filter by is indexed, and only for records with a uuid identity", () => {
  expect(searchIndexConfigs([notes, codes], sources)).toEqual([{ entity: "ProbeNote", schema: "search_probe", table: "notes", pk: "id", columns: ["name", "description"] }]);
  expect(searchIndexConfigs([notes], [{ entity: "ProbeNote", field: "secret", descriptionField: "amount" }])).toEqual([]);
  expect(searchIndexConfigs([notes], [{ entity: "ProbeNote", field: "name", descriptionField: "secret" }])[0]!.columns).toEqual(["name"]);
  // Two sources for one entity would need two different sets of entries.
  expect(searchIndexConfigs([notes], [{ entity: "ProbeNote", field: "name" }, { entity: "ProbeNote", field: "description" }])).toEqual([]);
});

test("entries are built once, kept by every writer whatever its session, and never writable by the application role", async () => {
  const name = `search_index_${crypto.randomUUID().replaceAll("-", "")}`, owner = `search_probe_owner_${name.slice(-8)}`;
  const admin = new SQL(adminUrl, { max: 1 }); await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  url.username = url.password = "openshapeforge_app";
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  const entries = async () => (await sql<{ tenant: string; text: string }>`select tenant_id::text as tenant, text_norm as text from platform.search_entries where entity='ProbeNote' order by text_norm`.execute(privileged.db)).rows;
  try {
    const chain = await privileged.db.connection().execute(connection => runMigrationChain(connection));
    expect(chain).toBeDefined();
    // The chain installed the product's own index; a second run rebuilds nothing.
    expect((await applySearchIndex(privileged.db)).rebuilt).toEqual([]);
    // Nor does the chain refuse what it installed: the index, the policy and the triggers are no drift.
    await privileged.db.connection().execute(connection => runMigrationChain(connection));
    expect((await applySearchIndex(privileged.db)).rebuilt).toEqual([]);
    await sql.raw(`create schema search_probe;
      create table search_probe.notes(id uuid primary key,tenant_id uuid not null,name text,description text,secret text,amount numeric);
      alter table search_probe.notes enable row level security; alter table search_probe.notes force row level security;
      create policy tenant on search_probe.notes using(app.bypass_rls() or tenant_id=app.current_tenant()) with check(app.bypass_rls() or tenant_id=app.current_tenant());
      grant usage on schema search_probe to openshapeforge_app; grant select,insert,update,delete on search_probe.notes to openshapeforge_app;
      insert into search_probe.notes values(gen_random_uuid(),'${tenant}','Existing Note',null,'classified',1),(gen_random_uuid(),'${otherTenant}','Other Tenant','About THINGS','classified',2);`).execute(privileged.db);
    const installed = await applySearchIndex(privileged.db, [notes, codes], sources);
    expect(installed).toEqual({ installed: true, entities: 1, rebuilt: ["ProbeNote"] });
    // An entity the configuration no longer names loses its trigger and its entries.
    expect((await sql<{ count: number }>`select count(*)::int as count from pg_trigger where tgname='search_entry' and not tgisinternal`.execute(privileged.db)).rows[0]!.count).toBe(1);
    expect(await entries()).toEqual([{ tenant, text: "existing note\n" }, { tenant: otherTenant, text: "other tenant\nabout things" }]);
    // From here the definer is an ordinary role: forced row-level security applies to it.
    await sql.raw(`create role ${owner} nologin nosuperuser nobypassrls;
      grant usage on schema platform, app to ${owner}; grant execute on all functions in schema app to ${owner};
      alter table platform.search_entries owner to ${owner}; alter function platform.search_entry() owner to ${owner};
      drop policy search_entries_maintainer on platform.search_entries;
      create policy search_entries_maintainer on platform.search_entries to ${owner} using (true) with check (true);`).execute(privileged.db);
    const id = crypto.randomUUID();
    await withAuditContext("ProbeNote.create", "trusted-context", () => withDbSession(runtime.db, session(tenant), async trx => {
      await sql`insert into search_probe.notes values(${id}::uuid,${tenant}::uuid,'Fresh',${"Line"},'classified',3)`.execute(trx);
      // In the writer's own transaction, before it commits.
      expect((await sql`select 1 from platform.search_entries where record_id=${id}::uuid and text_norm=E'fresh\nline'`.execute(trx)).rows).toHaveLength(1);
      // The application role reads its tenant's entries and writes none.
      expect((await sql<{ count: number }>`select count(*)::int as count from platform.search_entries`.execute(trx)).rows[0]!.count).toBe(2);
    }));
    for (const statement of [sql`insert into platform.search_entries(tenant_id,entity,record_id,text_norm) values(${tenant}::uuid,'ProbeNote',gen_random_uuid(),'forged')`,
      sql`update platform.search_entries set text_norm='forged'`, sql`delete from platform.search_entries`]) {
      await expect(withAuditContext("ProbeNote.forge", "trusted-context", () => withDbSession(runtime.db, session(tenant), trx => statement.execute(trx)))).rejects.toThrow(/permission denied/);
    }
    // A write that changes nothing searchable leaves the entry alone; one that does replaces it.
    await withAuditContext("ProbeNote.update", "trusted-context", () => withDbSession(runtime.db, session(tenant), async trx => {
      await sql`update search_probe.notes set amount=4, secret='still classified' where id=${id}::uuid`.execute(trx);
      await sql`update search_probe.notes set description='Changed' where id=${id}::uuid`.execute(trx);
    }));
    expect((await entries()).map(entry => entry.text)).toEqual(["existing note\n", "fresh\nchanged", "other tenant\nabout things"]);
    // A writer with no tenant in its session — a worker's shape — still keeps the entry.
    const loose = crypto.randomUUID();
    await sql`insert into search_probe.notes values(${loose}::uuid,${otherTenant}::uuid,'Loose',null,null,null)`.execute(privileged.db);
    await sql`delete from search_probe.notes where id=${id}::uuid`.execute(privileged.db);
    expect(await entries()).toEqual([{ tenant, text: "existing note\n" }, { tenant: otherTenant, text: "loose\n" }, { tenant: otherTenant, text: "other tenant\nabout things" }]);
    expect((await entries()).some(entry => entry.text.includes("classified"))).toBe(false);
  } finally {
    await runtime.close(); await privileged.close();
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.unsafe(`drop role if exists ${owner}`);
    await admin.close();
  }
}, 120000);
