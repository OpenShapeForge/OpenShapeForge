// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "../../modules/platform.js";
import { listOperationContracts, runtimeStaticOperationRegistrations, type OperationContract } from "../runtime.js";

/** The compiled remove as an author who declares the acknowledgement gets it: the control in its closed input. */
function acknowledged(operation: OperationContract): OperationContract {
  const schema = operation.inputSchema as { properties: Record<string, unknown>; additionalProperties?: boolean };
  expect(schema.additionalProperties).toBe(false);
  return { ...operation, confirmation: { mode: "acknowledgement" },
    inputSchema: { ...schema, properties: { ...schema.properties, confirmed: { type: "boolean" } } } };
}

test("a remove that asks an acknowledgement deletes the child only once it is given", async () => {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw Error("A scratch admin endpoint is required");
  const name = `collection_remove_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  let privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    url.pathname = `/${name}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await privileged.db.connection().execute(runMigrationChain);
    url.username = "openshapeforge_app"; url.password = "openshapeforge_app";
    restricted = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });
    const db = privileged.db;
    const tenant = randomUUID(), document = randomUUID(), variant = randomUUID(), block = randomUUID();
    await sql`insert into platform.tenants(id,slug,name,status) values(${tenant}::uuid,${tenant},'Remove fixture','active')`.execute(db);
    await sql`insert into erp.tenants(id,tenant_id,slug,name,tenant_kind) values(${tenant}::uuid,${tenant}::uuid,${tenant},'Remove fixture','customer')`.execute(db);
    await sql`insert into erp.document_types(tenant_id,code,name) values(${tenant}::uuid,'note','Note')`.execute(db);
    await sql`insert into erp.documents(id,tenant_id,title,document_type,status) values(${document}::uuid,${tenant}::uuid,'Remove fixture','note','draft')`.execute(db);
    await sql`insert into erp.document_variants(id,tenant_id,document_id,channel,locale) values(${variant}::uuid,${tenant}::uuid,${document}::uuid,'document','nl')`.execute(db);
    await sql`insert into erp.blocks(id,tenant_id,document_variant_id,document_variant_id_position,definition_key,definition_version,values) values(${block}::uuid,${tenant}::uuid,${variant}::uuid,0,'TextBlock',1,${jsonbLiteral({ markdown: "stays" })})`.execute(db);

    const remove = acknowledged(listOperationContracts().find((operation) => operation.key === "DocumentVariant.removeBlock")!);
    const runtime = new ModulePlatformRuntime(restricted.db);
    runtime.registerStaticOperations(runtimeStaticOperationRegistrations([], { db: restricted.db, platform: runtime.services }, [remove]));
    const editor = { tenantId: tenant, userId: randomUUID(), roles: ["Organization.All.ReadWrite", "CaseFile.All.ReadWrite", "General.All.ReadWrite", "Templates.Manage"], groups: [], scope: "tenant" as const, credential: "trusted-context" as const };
    const execute = (id: string, intent: "get" | "invoke", input: Record<string, unknown>) =>
      withModuleOperationSession(runtime.services, editor, (active) => runtime.services.operations.execute(active!, { operation: { id, intent }, input }));
    const version = async () => {
      const result = await execute("DocumentVariant.get", "get", { id: variant });
      if ("error" in result) throw Error(result.error.code);
      return String((result.data as { updatedAt: unknown }).updatedAt);
    };
    const blocks = async () => (await sql<{ id: string }>`select id::text from erp.blocks where document_variant_id = ${variant}::uuid`.execute(db)).rows.map((row) => row.id);
    const input = { id: variant, expectedVersion: await version(), childId: block };

    for (const denied of [input, { ...input, confirmed: false }]) {
      const refused = await execute(remove.key, "invoke", denied);
      expect("error" in refused && refused.error).toMatchObject({ code: "CONFIRMATION_REQUIRED", data: { confirmation: { kind: "acknowledgement", requiredValue: true } } });
      expect(await blocks()).toEqual([block]);
    }

    // The same request, its version untouched by the refusal, with the control
    // that a closed schema admits and the collection handler never sees.
    const removed = await execute(remove.key, "invoke", { ...input, confirmed: true });
    expect("error" in removed ? removed.error : undefined).toBeUndefined();
    expect(await blocks()).toEqual([]);
  } finally {
    await restricted?.close();
    await privileged?.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 90_000);
