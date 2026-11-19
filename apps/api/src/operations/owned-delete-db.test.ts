// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import migrateOwnedDelete from "../db/migrations/versioned/0030_owned-delete-foreign-keys.js";
import { readOwnedDeleteForeignKeys } from "../db/owned-delete-foreign-keys.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "../modules/platform.js";
import { listOperationContracts, runtimeStaticOperationRegistrations } from "./runtime.js";

test("compiled document delete requires confirmation and role, removes owned rows and audits the actor", async () => {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw Error("A scratch admin endpoint is required.");
  }
  const name = `owned_delete_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  let privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    url.pathname = `/${name}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await privileged.db.connection().execute(runMigrationChain);
    url.username = "openshapeforge_app";
    url.password = "openshapeforge_app";
    restricted = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
    const db = privileged.db;
    const tenant = randomUUID(), document = randomUUID(), variant = randomUUID(), block = randomUUID();
    const actor = randomUUID();
    await sql`insert into platform.tenants(id,slug,name,status) values(${tenant}::uuid,${tenant},'Owned delete fixture','active')`.execute(db);
    await sql`insert into erp.tenants(id,tenant_id,slug,name,tenant_kind) values(${tenant}::uuid,${tenant}::uuid,${tenant},'Owned delete fixture','customer')`.execute(db);
    await sql`insert into erp.document_types(tenant_id,code,name) values(${tenant}::uuid,'note','Note')`.execute(db);
    await sql`insert into erp.documents(id,tenant_id,title,document_type,status) values(${document}::uuid,${tenant}::uuid,'Delete fixture','note','draft')`.execute(db);
    await sql`insert into erp.document_variants(id,tenant_id,document_id,channel,locale) values(${variant}::uuid,${tenant}::uuid,${document}::uuid,'document','nl')`.execute(db);
    await sql`insert into erp.blocks(id,tenant_id,document_variant_id,document_variant_id_position,definition_key,definition_version,values)
      values(${block}::uuid,${tenant}::uuid,${variant}::uuid,0,'TextBlock',1,${jsonbLiteral({ markdown: "Synthetic content" })})`.execute(db);
    const legacyEdge = async () => (await readOwnedDeleteForeignKeys(db, ["erp.documents"]))
      .find(edge => edge.source === "erp.document_variants" && edge.sourceColumns.includes("document_id"))!;
    const edge = await legacyEdge();
    const constraint = sql.id(edge.constraint);
    await sql`alter table erp.document_variants drop constraint ${constraint},
      add constraint ${constraint} foreign key (tenant_id, document_id) references erp.documents (tenant_id, id) on delete cascade`.execute(db);
    expect((await legacyEdge()).action).toBe("c");
    await db.transaction().execute(migrateOwnedDelete.up);
    expect((await legacyEdge()).action).toBe("a");
    expect((await sql`select id from erp.document_variants where id = ${variant}::uuid`.execute(db)).rows).toHaveLength(1);
    const operation = listOperationContracts().find(candidate => candidate.key === "Document.deleteWithContents")!;
    expect(operation.implementation?.type).toBe("ownedDelete");
    const runtime = new ModulePlatformRuntime(restricted.db);
    runtime.registerStaticOperations(runtimeStaticOperationRegistrations([], { db: restricted.db, platform: runtime.services }, [operation]));
    const editor = { tenantId: tenant, userId: actor, roles: ["Organization.All.ReadWrite", "CaseFile.All.ReadWrite"],
      groups: [], scope: "tenant" as const, credential: "trusted-context" as const };
    const execute = (confirmed: boolean, roles = editor.roles) =>
      withModuleOperationSession(runtime.services, { ...editor, roles }, active =>
        runtime.services.operations.execute(active!, {
          operation: { id: operation.key, intent: "invoke" }, input: { id: document, confirmed },
        }));
    const denied = await execute(true, ["CaseFile.All.Read"]);
    expect("error" in denied && denied.error.code).toBe("OPERATION_NOT_FOUND");
    const otherTenant = await withModuleOperationSession(runtime.services, { ...editor, tenantId: randomUUID() }, active =>
      runtime.services.operations.execute(active!, {
        operation: { id: operation.key, intent: "invoke" }, input: { id: document, confirmed: true },
      }));
    expect("error" in otherTenant).toBe(true);
    const unconfirmed = await execute(false);
    expect("error" in unconfirmed && unconfirmed.error.code).toBe("CONFIRMATION_REQUIRED");
    await db.transaction().execute(async trx => {
      await sql`select set_config('app.document_command', 'follow', true)`.execute(trx);
      await sql`update erp.blocks set locked = true where id = ${block}::uuid`.execute(trx);
    });
    const locked = await execute(true);
    expect("error" in locked && locked.error.code).toBe("OPERATION_REFUSED");
    expect(await sql`select id from erp.blocks where id = ${block}::uuid`.execute(db).then(result => result.rows)).toHaveLength(1);
    await db.transaction().execute(async trx => {
      await sql`select set_config('app.document_command', 'follow', true)`.execute(trx);
      await sql`update erp.blocks set locked = false where id = ${block}::uuid`.execute(trx);
    });
    await sql`create policy fixture_hide_block on erp.blocks as restrictive for select using (app.bypass_rls() or id <> ${sql.lit(block)}::uuid)`.execute(db);
    const hidden = await execute(true);
    expect("error" in hidden && hidden.error.code).toBe("OPERATION_REFUSED");
    expect(await sql`select id from erp.documents where id = ${document}::uuid`.execute(db).then(result => result.rows)).toHaveLength(1);
    const before = await sql`select id from platform.entity_events where tenant_id = ${tenant}::uuid and event_type = 'deleted'`.execute(db);
    expect(before.rows).toHaveLength(0);
    await sql`drop policy fixture_hide_block on erp.blocks`.execute(db);
    const result = await execute(true);
    expect("error" in result ? result.error : undefined).toBeUndefined();
    const audit = await sql<{ aggregate_id: string; actor: string }>`
      select aggregate_id, payload->'audit'->>'actorId' as actor
      from platform.entity_events where tenant_id = ${tenant}::uuid
        and event_type = 'deleted' and payload->'audit'->>'operationId' = ${operation.key}
      order by aggregate_id`.execute(db);
    expect(audit.rows.map(row => row.aggregate_id)).toEqual([document, variant, block].sort());
    expect(new Set(audit.rows.map(row => row.actor))).toEqual(new Set([actor]));
  } finally {
    await restricted?.close();
    await privileged?.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 90_000);
