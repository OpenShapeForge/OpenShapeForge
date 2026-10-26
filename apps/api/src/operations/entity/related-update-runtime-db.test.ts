// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../../db/connection.js";

// Register compiled caller contracts before runtime catalog caches are built.
if (process.env.OSF_RELATED_RUNTIME_ISOLATED !== "1") {
  test("atomic related saves through canonical Operations", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OSF_RELATED_RUNTIME_ISOLATED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(out + err);
    console.log(err.trim());
    expect(code).toBe(0);
  }, 120_000);
} else {
  const root = new URL(
    "../../../../../packages/compiler/src/",
    import.meta.url,
  );
  const { fixture, native } = await import(
    new URL("authoring/collection-operations.fixtures.ts", root).pathname
  );
  const { generateArtifacts } = await import(
    new URL("generate.ts", root).pathname
  );
  const { entityOperationJsonSchemas } = await import(
    new URL("entity-operation-json-schema.ts", root).pathname
  );
  let manifest: any;
  const entries = fixture(
    (owner: any, child: any) => {
      owner.fields.push({
        key: "name",
        osfType: "string",
        required: true,
        persisted: { column: "name", storageClass: "core" },
      });
      for (const entity of [owner, child]) {
        entity.fields.push({
          key: "tenantId",
          osfType: "string",
          required: true,
          validation: { format: "uuid" },
          persisted: { column: "tenant_id", storageClass: "core" },
        });
      }
      child.operations.update.concurrency.editLease = {
        mode: "required",
        expiresAfterInactivity: "PT15M",
      };
      delete owner.operations.moveChild;
      owner.operations.updateChild = {
        ...native("insert"),
        implementation: {
          type: "collection",
          action: "update",
          field: "children",
        },
      };
      Object.assign(
        child.fields.find((field: any) => field.key === "owner").relationship
          .inverse,
        { ownership: "reference", sortable: false },
      );
    },
    [],
    (value: any) => (manifest = value),
  );
  const artifacts = generateArtifacts(manifest);
  const tables = JSON.parse(
    artifacts.find((artifact: any) =>
      artifact.path.endsWith("db/manifest.json"),
    ).contents,
  ).tables;
  const { default: runtimeManifest } = await import(
    "../../generated/db/manifest.json",
    { with: { type: "json" } }
  );
  const { default: catalog } = await import(
    "../../generated/operations/catalog.json",
    { with: { type: "json" } }
  );
  (runtimeManifest.tables as any[]).push(...tables);
  for (const { contract } of entries)
    for (const op of Object.values(contract.entityOperations) as any[]) {
      (catalog.entityOperations as any[]).push({
        ...op,
        ...entityOperationJsonSchemas(
          contract,
          op,
          entries.map((e: any) => e.contract),
          {},
        ),
      });
    }
  const { executeEntityOperation, acquireEditLeaseForEntityOperation } =
    await import("./runtime.js");
  const { runMigrationChain } = await import("../../db/migration-chain.js");
  const { applyAuditHistory } =
    await import("../../db/migrations/audit-history.js");
  const url =
    process.env.SCRATCH_ADMIN_DATABASE_URL ??
    "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const database = `related_runtime_${randomUUID().replaceAll("-", "")}`;
  let admin: SQL, privileged: DatabaseRuntime, runtime: DatabaseRuntime;
  const actor = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roles: ["Example.Read", "Example.Create", "Example.Update"],
    groups: [],
    scope: "tenant" as const,
  };
  beforeAll(async () => {
    const target = new URL(url);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/postgres"
    )
      throw Error("Local scratch database required");
    admin = new SQL(url);
    await admin.unsafe(`create database "${database}"`);
    target.pathname = `/${database}`;
    privileged = createDatabaseRuntime({ databaseUrl: target.href });
    runtimeManifest.tables.splice(-tables.length);
    try {
      await privileged.db
        .connection()
        .execute((connection) => runMigrationChain(connection));
    } finally {
      (runtimeManifest.tables as any[]).push(...tables);
    }
    await sql
      .raw(
        artifacts.find((artifact: any) => artifact.path.endsWith("schema.sql"))
          .contents,
      )
      .execute(privileged.db);
    await applyAuditHistory(privileged.db);
    await sql`grant usage on schema erp to openshapeforge_app; grant select,insert,update,delete on all tables in schema erp to openshapeforge_app`.execute(
      privileged.db,
    );
    target.username = "openshapeforge_app";
    target.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: target.href });
  }, 90_000);
  afterAll(async () => {
    await runtime?.close();
    await privileged?.close();
    if (admin) {
      await admin.unsafe(`drop database if exists "${database}" with(force)`);
      await admin.close();
    }
  });
  const run = (id: string, input: any, session = actor) =>
    executeEntityOperation(runtime.db, session, {
      operation: { id, intent: id.split(".")[1] as any },
      input,
    });
  const record = (result: any) => {
    if (result.error) throw Error(JSON.stringify(result.error));
    return result.data;
  };
  const stored = async (table: string, id: string) =>
    (
      await sql<any>`select to_jsonb(t.*) as row, updated_at::text as version from ${sql.id("erp", table)} t where id=${id}::uuid`.execute(
        privileged.db,
      )
    ).rows[0]!;
  test("updates and creates atomically, preserving child authorization, tenant and versions", async () => {
    const owner = record(
      await run("Owner.create", { values: { name: "Before" } }),
    );
    const child = record(
      await run("Child.create", {
        values: { owner: owner.id, body: "Before" },
      }),
    );
    let attempt = 0;
    const save = async (updates: any[], creates: any[] = [], session = actor) =>
      run(
        "Owner.update",
        {
          id: owner.id,
          expectedVersion: (await stored("owners", owner.id)).version,
          values: { name: `Attempt ${++attempt}` },
          relatedChanges: [
            { relationship: "children", update: updates, create: creates },
          ],
        },
        session,
      );
    const change = async () => ({
      id: child.id,
      leaseToken: (
        await acquireEditLeaseForEntityOperation(runtime.db, actor, {
          operationId: "Child.update",
          targetId: child.id,
        })
      ).leaseToken,
      expectedVersion: (await stored("childs", child.id)).version,
      values: { body: "After" },
    });
    record(await save([await change()], [{ body: "New" }]));
    expect((await stored("owners", owner.id)).row.name).toBe("Attempt 1");
    expect((await stored("childs", child.id)).row.body).toBe("After");
    expect((await sql<{ count: number }>`select count(*)::int as count from erp.childs where owner_id=${owner.id}::uuid`.execute(privileged.db)).rows[0]!.count).toBe(2);
    const before = await stored("owners", owner.id),
      beforeChild = await stored("childs", child.id);
    const denied = await save(
      [{ ...(await change()), values: { body: "Rollback" } }],
      [{ body: "Denied" }],
      { ...actor, roles: ["Example.Read", "Example.Update"] },
    );
    expect(denied).toHaveProperty("error");
    expect(await stored("owners", owner.id)).toEqual(before);
    expect(await stored("childs", child.id)).toEqual(beforeChild);
    expect(
      await save([
        { ...(await change()), expectedVersion: "2000-01-01T00:00:00Z" },
      ]),
    ).toHaveProperty("error");
    expect(await save([{ ...await change(), leaseToken: "invalid-lease" }])).toHaveProperty("error");
    const other = { ...actor, tenantId: randomUUID() };
    const foreignOwner = record(
      await run("Owner.create", { values: { name: "Other" } }, other),
    );
    const foreign = record(
      await run(
        "Child.create",
        { values: { owner: foreignOwner.id, body: "Other" } },
        other,
      ),
    );
    expect(
      await save([
        {
          id: foreign.id,
          leaseToken: (await acquireEditLeaseForEntityOperation(runtime.db, other, { operationId: "Child.update", targetId: foreign.id })).leaseToken,
          expectedVersion: (await stored("childs", foreign.id)).version,
          values: { body: "Denied" },
        },
      ]),
    ).toHaveProperty("error");
    expect(await stored("owners", owner.id)).toEqual(before);
  });
}
