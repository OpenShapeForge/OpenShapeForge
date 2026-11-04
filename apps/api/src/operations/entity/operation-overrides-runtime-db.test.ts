// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../../db/connection.js";

// Register compiled caller contracts before runtime catalog caches are built.
if (process.env.OSF_OVERRIDE_RUNTIME_ISOLATED !== "1") {
  test("operation overrides take generated update and delete", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OSF_OVERRIDE_RUNTIME_ISOLATED: "1" },
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
  }, 180_000);
} else {
  const root = new URL("../../../../../packages/compiler/src/", import.meta.url);
  const { fixture } = await import(new URL("authoring/collection-operations.fixtures.ts", root).pathname);
  const { generateArtifacts } = await import(new URL("generate.ts", root).pathname);
  const { entityOperationJsonSchemas } = await import(new URL("entity-operation-json-schema.ts", root).pathname);
  let manifest: any;
  const entries = fixture(
    (owner: any, child: any) => {
      owner.fields.push({
        key: "name",
        osfType: "string",
        required: true,
        persisted: { column: "name", storageClass: "core" },
      });
      // Stamped by Owner.update in the stamp test (writer metadata patched below).
      for (const [key, column] of [["changedBy", "changed_by"], ["changedRelation", "changed_relation"]]) {
        owner.fields.push({ key, osfType: "string", validation: { format: "uuid" }, persisted: { column, storageClass: "core" } });
      }
      for (const entity of [owner, child]) {
        entity.fields.push({
          key: "tenantId",
          osfType: "string",
          required: true,
          validation: { format: "uuid" },
          persisted: { column: "tenant_id", storageClass: "core" },
        });
      }
      child.operations.update.concurrency.editLease = { mode: "required", expiresAfterInactivity: "PT15M" };
      owner.authorization.roles.delete = ["Example.Delete"];
      owner.operations.delete = {
        name: "delete",
        description: "delete",
        implementation: { type: "entity", action: "delete" },
        effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "natural" } },
        confirmation: { mode: "none" },
        concurrency: { version: { mode: "required", field: "updatedAt" } },
      };
      delete owner.operations.moveChild;
      delete owner.operations.insertChild;
      Object.assign(child.fields.find((field: any) => field.key === "owner").relationship.inverse,
        { ownership: "reference", sortable: false });
    },
    [],
    (value: any) => (manifest = value),
  );
  const artifacts = generateArtifacts(manifest);
  const tables = JSON.parse(
    artifacts.find((artifact: any) => artifact.path.endsWith("db/manifest.json")).contents,
  ).tables;
  const { default: runtimeManifest } = await import("../../generated/db/manifest.json", { with: { type: "json" } });
  const { default: catalog } = await import("../../generated/operations/catalog.json", { with: { type: "json" } });
  for (const column of tables.find((table: any) => table.source?.authoringEntityName === "Owner").columns) {
    if (column.name === "changed_by" || column.name === "changed_relation") column.writtenBy = [{ operation: "Owner.update" }];
  }
  (runtimeManifest.tables as any[]).push(...tables);
  for (const { contract } of entries)
    for (const op of Object.values(contract.entityOperations) as any[]) {
      (catalog.entityOperations as any[]).push({
        ...op,
        ...entityOperationJsonSchemas(contract, op, entries.map((e: any) => e.contract), {}),
      });
    }
  const { executeEntityOperation, acquireEditLeaseForEntityOperation, entityOperationContract } =
    await import("./runtime.js");
  const { registerEntityOperationOverrides, unregisterEntityOperationOverridesForTests, takeoverInputHash } =
    await import("./operation-overrides.js");
  const { runMigrationChain } = await import("../../db/migration-chain.js");
  const { applyAuditHistory } = await import("../../db/migrations/audit-history.js");
  const { registerGeneratedRestRoutes, REST_MOUNT_PATH } = await import("../../rest/generated-rest-routes.js");
  const { applyTrustedContextHeaders } = await import("@openshapeforge/auth");
  const { __resetSessionResolverForTests } = await import("../../auth/identity.js");
  const { default: Fastify } = await import("fastify");

  const url = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const database = `override_runtime_${randomUUID().replaceAll("-", "")}`;
  let admin: SQL, privileged: DatabaseRuntime, runtime: DatabaseRuntime;
  const roles = ["Example.Read", "Example.Create", "Example.Update", "Example.Delete"];
  const actor = { tenantId: randomUUID(), userId: randomUUID(), roles, groups: [], scope: "tenant" as const };
  const otherTenant = randomUUID();
  const service = (tenantId = actor.tenantId, clientId = "svc-a") => ({
    tenantId, userId: randomUUID(), roles, groups: [], scope: "tenant" as const,
    credential: "bearer" as const, principalKind: "service" as const, organizationServiceIdentityId: clientId,
  });
  process.env.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES = JSON.stringify([
    { tenantId: actor.tenantId, clientId: "svc-a", clientSecret: "local-only" },
    { tenantId: otherTenant, clientId: "svc-b", clientSecret: "local-only" },
  ]);

  // One fake override module; each test sets what it answers.
  type Behaviour = {
    finished?: (request: any) => boolean;
    takes?: (request: any) => boolean;
    execute?: (context: any, request: any) => Promise<any>;
  };
  let behaviour: Behaviour = {};
  let ambiguous = false;
  const executed: any[] = [];
  const resolved: any[] = [];
  const register = () => registerEntityOperationOverrides(runtime.db, {
    overrides: [
      {
        module: "workflow-test",
        override: {
          id: "workflow-test.overrides",
          async resolve(_session: any, request: any) {
            resolved.push(request);
            return behaviour.takes?.(request) ? { overrideId: "definition-1" } : undefined;
          },
          async execute(context: any, request: any) {
            executed.push(request);
            return behaviour.execute
              ? behaviour.execute(context, request)
              : { accepted: { by: { kind: "workflow", ref: `run-${executed.length}` }, status: "waiting" } };
          },
          async finished(_session: any, request: any) {
            return behaviour.finished?.(request) ?? false;
          },
        },
      },
      {
        module: "second-test",
        override: {
          id: "second-test.overrides",
          async resolve() { return ambiguous ? { overrideId: "other" } : undefined; },
          async execute() { throw new Error("unused"); },
        },
      },
    ],
    accepts: (session: any) => session.internal !== true,
    activate: (session: any, work: any) => work(session),
    execute: (session: any, request: any) => executeEntityOperation(runtime.db, session, {
      operation: request.operation, ...(request.input ? { input: request.input } : {}),
    }) as never,
  });

  beforeAll(async () => {
    const target = new URL(url);
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/postgres")
      throw Error("Local scratch database required");
    admin = new SQL(url);
    await admin.unsafe(`create database "${database}"`);
    target.pathname = `/${database}`;
    privileged = createDatabaseRuntime({ databaseUrl: target.href });
    runtimeManifest.tables.splice(-tables.length);
    try {
      await privileged.db.connection().execute((connection) => runMigrationChain(connection));
    } finally {
      (runtimeManifest.tables as any[]).push(...tables);
    }
    await sql.raw(artifacts.find((artifact: any) => artifact.path.endsWith("schema.sql")).contents).execute(privileged.db);
    await applyAuditHistory(privileged.db);
    await sql`grant usage on schema erp to openshapeforge_app; grant select,insert,update,delete on all tables in schema erp to openshapeforge_app`.execute(privileged.db);
    for (const tenant of [actor.tenantId, otherTenant]) {
      await sql`insert into platform.tenants (id, slug, name, status) values (${tenant}::uuid, ${`t-${tenant.slice(0, 8)}`}, ${`Tenant ${tenant.slice(0, 8)}`}, 'active') on conflict do nothing`.execute(privileged.db)
        .catch(() => undefined);
    }
    target.username = "openshapeforge_app";
    target.password = "openshapeforge_app";
    runtime = createDatabaseRuntime({ databaseUrl: target.href });
    register();
  }, 120_000);
  afterAll(async () => {
    await runtime?.close();
    await privileged?.close();
    if (admin) {
      await admin.unsafe(`drop database if exists "${database}" with(force)`);
      await admin.close();
    }
  });
  beforeEach(() => {
    behaviour = {};
    ambiguous = false;
    executed.length = 0;
    resolved.length = 0;
  });

  const run = (id: string, input: any, session: any = actor) =>
    executeEntityOperation(runtime.db, session, { operation: { id, intent: id.split(".")[1] as any }, input });
  const record = (result: any) => {
    if (result.error || result.accepted) throw Error(JSON.stringify(result));
    return result.data;
  };
  const stored = async (table: string, id: string) =>
    (await sql<any>`select to_jsonb(t.*) as row, updated_at::text as version from ${sql.id("erp", table)} t where id=${id}::uuid`.execute(privileged.db)).rows[0];
  const takeovers = async (recordId: string) =>
    (await sql<any>`select * from platform.operation_takeovers where record_id = ${recordId} order by created_at`.execute(privileged.db)).rows;
  const takesOwnerUpdate = (request: any) => request.operation.id === "Owner.update";
  const newOwner = async (name = "Before", session: any = actor) => record(await run("Owner.create", { values: { name } }, session));
  const updateInput = async (id: string, name: string) => ({
    id, expectedVersion: (await stored("owners", id)).version, values: { name },
  });

  test("without an answering override the original runs unchanged", async () => {
    const owner = await newOwner();
    const result = await run("Owner.update", await updateInput(owner.id, "Hidden"));
    expect(record(result).name).toBe("Hidden");
    expect(resolved).toHaveLength(1);
    expect(executed).toHaveLength(0);
    expect(await takeovers(owner.id)).toHaveLength(0);
    // A session the host does not accept as a verified caller is core's own.
    behaviour = { takes: takesOwnerUpdate };
    expect(record(await run("Owner.update", await updateInput(owner.id, "Internal"), { ...actor, internal: true })).name).toBe("Internal");
    expect(executed).toHaveLength(0);
    behaviour = {};
    unregisterEntityOperationOverridesForTests(runtime.db);
    try {
      expect(record(await run("Owner.update", await updateInput(owner.id, "Unregistered"))).name).toBe("Unregistered");
    } finally {
      register();
    }
  });

  test("an override takes an update: accepted, nothing written, retry finds the same run", async () => {
    behaviour = { takes: takesOwnerUpdate };
    const owner = await newOwner();
    const input = await updateInput(owner.id, "After");
    const result: any = await run("Owner.update", input);
    expect(result).toMatchObject({ intent: "update", accepted: { by: { kind: "workflow", ref: "run-1" }, status: "waiting" } });
    expect(result).not.toHaveProperty("data");
    expect(Array.isArray(result.operations)).toBe(true);
    expect((await stored("owners", owner.id)).row.name).toBe("Before");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      operation: { id: "Owner.update", intent: "update" }, recordId: owner.id, overrideId: "definition-1",
      input: { id: owner.id, values: { name: "After" } },
    });
    expect(executed[0].idempotencyKey).toMatch(/^osf-takeover:[0-9a-f]{64}$/);
    const [row] = await takeovers(owner.id);
    expect(row).toMatchObject({
      id: executed[0].takeoverId, tenant_id: actor.tenantId, operation_id: "Owner.update",
      input_hash: takeoverInputHash(input), caller_user_id: actor.userId, owner_module: "workflow-test",
      owner_kind: "workflow", owner_ref: "run-1", owner_status: "waiting", completed_at: null,
    });
    // A retry of the same call: the same run, no second execute.
    const retry: any = await run("Owner.update", input);
    expect(retry.accepted).toEqual(result.accepted);
    expect(executed).toHaveLength(1);
    // A different input is a different takeover.
    const other: any = await run("Owner.update", await updateInput(owner.id, "Other"));
    expect(other.accepted.by.ref).toBe("run-2");
  });

  test("a takeover whose owner finished without the original answers the next call anew", async () => {
    const asked: any[] = [];
    behaviour = { takes: takesOwnerUpdate, finished: (request: any) => { asked.push(request); return false; } };
    const owner = await newOwner();
    const input = await updateInput(owner.id, "After");
    await run("Owner.update", input);
    // The owner is still working: the same run, and it was asked about that one.
    const retry: any = await run("Owner.update", input);
    expect(retry.accepted.by.ref).toBe("run-1");
    expect(asked).toEqual([{ takeoverId: executed[0].takeoverId, by: { kind: "workflow", ref: "run-1" } }]);
    behaviour.finished = () => true;
    const next: any = await run("Owner.update", input);
    expect(next.accepted).toEqual({ by: { kind: "workflow", ref: "run-2" }, status: "waiting" });
    expect(executed[1].takeoverId).not.toBe(executed[0].takeoverId);
    const rows = await takeovers(owner.id);
    expect(rows.map((row: any) => row.completed_at === null)).toEqual([false, true]);
    expect((await stored("owners", owner.id)).row.name).toBe("Before");
  });

  test("a replay by the tenant's service identity performs the original once, skipping the caller's challenge", async () => {
    behaviour = { takes: takesOwnerUpdate };
    const operation = entityOperationContract("Owner.update");
    const original = operation.interaction.confirmation;
    operation.interaction.confirmation = { mode: "challenge", challenge: {
      kind: "type-current-field", field: "name", issuedBy: "server",
      bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
      expiresAfter: "PT5M", singleUse: true,
    } } as never;
    try {
      const owner = await newOwner("Guarded");
      const input = await updateInput(owner.id, "Replayed");
      const challenged: any = await run("Owner.update", input);
      expect(challenged.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(executed).toHaveLength(0);
      const token = challenged.error.data.confirmation.challengeToken;
      const accepted: any = await run("Owner.update", { ...input, confirmationToken: token, confirmationAnswer: "Guarded" });
      expect(accepted.accepted.status).toBe("waiting");
      const consumed = (await sql<any>`select consumed_at from platform.operation_confirmation_challenges where owner_user_id = ${actor.userId}::uuid order by expires_at desc limit 1`.execute(privileged.db)).rows[0];
      expect(consumed.consumed_at).not.toBeNull();
      const takeoverId = executed[0].takeoverId;
      // Not the caller, not another tenant's service identity, not another input.
      expect(await run("Owner.update", { ...input, osfTakeover: takeoverId })).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect(await run("Owner.update", { ...input, osfTakeover: takeoverId }, service(otherTenant, "svc-b"))).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect(await run("Owner.update", { ...input, osfTakeover: takeoverId }, service(actor.tenantId, "svc-b"))).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect(await run("Owner.update", { ...input, values: { name: "Tampered" }, osfTakeover: takeoverId }, service())).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect(await run("Owner.update", { ...input, osfTakeover: randomUUID() }, service())).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect(await run("Owner.update", { ...input, osfTakeover: "not-a-uuid" }, service())).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
      expect((await stored("owners", owner.id)).row.name).toBe("Guarded");
      // The service identity, without a challenge of its own: written, never overridden again.
      const replayed: any = await run("Owner.update", { ...input, osfTakeover: takeoverId }, service());
      expect(record(replayed).name).toBe("Replayed");
      expect(executed).toHaveLength(1);
      expect((await takeovers(owner.id))[0].completed_at).not.toBeNull();
      // A closed takeover is not replayable.
      expect(await run("Owner.update", { ...input, osfTakeover: takeoverId }, service())).toMatchObject({ error: { code: "TAKEOVER_INVALID" } });
    } finally {
      operation.interaction.confirmation = original;
    }
  });

  test("a replay skips the consumed edit lease but keeps the version check", async () => {
    behaviour = { takes: (request) => request.operation.id === "Child.update" };
    const owner = await newOwner();
    const child = record(await run("Child.create", { values: { owner: owner.id, body: "Before" } }));
    const leased = async () => ({
      id: child.id,
      expectedVersion: (await stored("childs", child.id)).version,
      leaseToken: (await acquireEditLeaseForEntityOperation(runtime.db, actor, { operationId: "Child.update", targetId: child.id })).leaseToken,
      values: { body: "After" },
    });
    const first = await leased();
    expect(((await run("Child.update", first)) as any).accepted).toBeDefined();
    const leases = async () => (await sql<{ count: number }>`select count(*)::int as count from platform.entity_edit_leases where target_id = ${child.id}`.execute(privileged.db)).rows[0]!.count;
    expect(await leases()).toBe(0);
    const { leaseToken: _lease, ...withoutLease } = first;
    const replayed: any = await run("Child.update", { ...withoutLease, osfTakeover: executed[0].takeoverId }, service());
    expect(record(replayed).body).toBe("After");

    const second = { ...(await leased()), values: { body: "Later" } };
    expect(((await run("Child.update", second)) as any).accepted).toBeDefined();
    await sql`update erp.childs set updated_at = updated_at + interval '1 second' where id = ${child.id}::uuid`.execute(privileged.db);
    const { leaseToken: _second, ...secondWithoutLease } = second;
    const conflict: any = await run("Child.update", { ...secondWithoutLease, osfTakeover: executed[1].takeoverId }, service());
    expect(conflict.error.code).toBe("VERSION_CONFLICT");
    expect((await takeovers(child.id)).at(-1).completed_at).toBeNull();
    expect((await stored("childs", child.id)).row.body).toBe("After");
  });

  test("an override takes a delete: accepted keeps the record, completed answers deleted", async () => {
    behaviour = { takes: (request) => request.operation.id === "Owner.delete" };
    const owner = await newOwner();
    const input = { id: owner.id, expectedVersion: (await stored("owners", owner.id)).version, confirmed: true };
    const accepted: any = await run("Owner.delete", input);
    expect(accepted).toMatchObject({ intent: "delete", accepted: { by: { kind: "workflow", ref: "run-1" } } });
    expect(await stored("owners", owner.id)).toBeDefined();
    expect(record(await run("Owner.delete", { ...input, osfTakeover: executed[0].takeoverId }, service()))).toEqual({ deleted: true });
    expect(await stored("owners", owner.id)).toBeUndefined();

    const done = await newOwner();
    behaviour.execute = async () => {
      await sql`delete from erp.owners where id = ${done.id}::uuid`.execute(privileged.db);
      return { completed: { deleted: true } };
    };
    const completed: any = await run("Owner.delete", { id: done.id, expectedVersion: (await stored("owners", done.id)).version, confirmed: true });
    expect(completed).toMatchObject({ intent: "delete", data: { deleted: true } });
    expect((await takeovers(done.id))[0].completed_at).not.toBeNull();
  });

  test("a completed update answers the record as it now is", async () => {
    const owner = await newOwner();
    behaviour = {
      takes: takesOwnerUpdate,
      execute: async () => {
        await sql`update erp.owners set name = 'By workflow', updated_at = now() where id = ${owner.id}::uuid`.execute(privileged.db);
        return { completed: { anything: "ignored" } };
      },
    };
    const result: any = await run("Owner.update", await updateInput(owner.id, "Requested"));
    expect(result.data.name).toBe("By workflow");
    expect(result.data).not.toHaveProperty("anything");
    const statusCompleted = await newOwner();
    behaviour.execute = async () => ({ accepted: { by: { kind: "workflow", ref: "run-x" }, status: "completed" } });
    const handled: any = await run("Owner.update", await updateInput(statusCompleted.id, "Declined"));
    expect(handled.accepted.status).toBe("completed");
    expect((await takeovers(statusCompleted.id))[0].completed_at).not.toBeNull();
  });

  test("an override's refusal is the answer and leaves no takeover behind", async () => {
    const owner = await newOwner();
    behaviour = {
      takes: takesOwnerUpdate,
      execute: async () => ({ error: { code: "ACTION_UNAVAILABLE", message: "Not for this record.", retryable: false } }),
    };
    expect(await run("Owner.update", await updateInput(owner.id, "Refused"))).toMatchObject({ error: { code: "ACTION_UNAVAILABLE" } });
    expect((await stored("owners", owner.id)).row.name).toBe("Before");
    expect(await takeovers(owner.id)).toHaveLength(0);
    behaviour.execute = async () => ({ accepted: { by: { kind: "workflow", ref: "" }, status: "running" } });
    expect(await run("Owner.update", await updateInput(owner.id, "Invalid"))).toMatchObject({ error: { code: "HANDLER_CONTRACT_VIOLATION" } });
    expect(await takeovers(owner.id)).toHaveLength(0);
  });

  test("unauthorized and cross-tenant callers never reach an override", async () => {
    behaviour = { takes: (request) => request.operation.id.startsWith("Owner.") };
    const owner = await newOwner();
    const input = await updateInput(owner.id, "Denied");
    expect(await run("Owner.update", input, { ...actor, roles: ["Example.Read"] })).toHaveProperty("error");
    expect(executed).toHaveLength(0);
    // Another tenant cannot open a takeover of this tenant's record.
    expect(await run("Owner.update", input, { ...actor, tenantId: otherTenant })).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await run("Owner.delete", { id: owner.id, confirmed: true, expectedVersion: input.expectedVersion }, { ...actor, tenantId: otherTenant }))
      .toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(executed).toHaveLength(0);
    expect((await sql<{ count: number }>`select count(*)::int as count from platform.operation_takeovers where tenant_id = ${otherTenant}::uuid`.execute(privileged.db)).rows[0]!.count).toBe(0);
    expect((await stored("owners", owner.id)).row.name).toBe("Before");
  });

  test("relatedChanges with an overridden child or parent is refused without a run", async () => {
    const owner = await newOwner();
    const child = record(await run("Child.create", { values: { owner: owner.id, body: "Before" } }));
    const save = async () => run("Owner.update", {
      id: owner.id,
      expectedVersion: (await stored("owners", owner.id)).version,
      values: { name: "Parent" },
      relatedChanges: [{ relationship: "children", update: [{
        id: child.id,
        expectedVersion: (await stored("childs", child.id)).version,
        leaseToken: (await acquireEditLeaseForEntityOperation(runtime.db, actor, { operationId: "Child.update", targetId: child.id })).leaseToken,
        values: { body: "Child" },
      }] }],
    });
    behaviour = { takes: (request) => request.operation.id === "Child.update" };
    expect(await save()).toMatchObject({ error: { code: "VALIDATION" } });
    behaviour = { takes: takesOwnerUpdate };
    expect(await save()).toMatchObject({ error: { code: "VALIDATION" } });
    expect(executed).toHaveLength(0);
    expect((await stored("owners", owner.id)).row.name).toBe("Before");
    expect((await stored("childs", child.id)).row.body).toBe("Before");
  });

  test("an override re-entering its own operation is a cycle; two answering is ambiguous", async () => {
    const owner = await newOwner();
    behaviour = {
      takes: takesOwnerUpdate,
      execute: async (context, request) => {
        const inner: any = await context.execute({ operation: request.operation, input: request.input });
        return inner.error ? { error: inner.error } : inner;
      },
    };
    expect(await run("Owner.update", await updateInput(owner.id, "Loop"))).toMatchObject({ error: { code: "OPERATION_CYCLE" } });
    expect(await takeovers(owner.id)).toHaveLength(0);
    behaviour = { takes: takesOwnerUpdate };
    executed.length = 0;
    ambiguous = true;
    expect(await run("Owner.update", await updateInput(owner.id, "Two"))).toMatchObject({ error: { code: "OPERATION_AMBIGUOUS" } });
    expect(executed).toHaveLength(0);
  });

  test("a takeover recorded without an owner reference is asked again under the same id", async () => {
    behaviour = { takes: takesOwnerUpdate };
    const owner = await newOwner();
    const input = await updateInput(owner.id, "Orphan");
    // As if the process stopped after the takeover committed and before the
    // owner's answer was stored.
    const orphan = (await sql<{ id: string }>`
      insert into platform.operation_takeovers (tenant_id, operation_id, record_id, input_hash, caller_user_id, owner_module, override_id)
      values (${actor.tenantId}::uuid, 'Owner.update', ${owner.id}, ${takeoverInputHash(input)}, ${actor.userId}::uuid, 'workflow-test', 'definition-1')
      returning id`.execute(privileged.db)).rows[0]!.id;
    const keys: string[] = [];
    behaviour.execute = async (_context, request) => {
      keys.push(request.idempotencyKey);
      return { error: { code: "ACTION_UNAVAILABLE", message: "No run.", retryable: false } };
    };
    // The owner reports no run: the orphan is discarded, not left in progress.
    expect(await run("Owner.update", input)).toMatchObject({ error: { code: "ACTION_UNAVAILABLE" } });
    expect(executed.at(-1).takeoverId).toBe(orphan);
    expect(await takeovers(owner.id)).toHaveLength(0);

    const second = (await sql<{ id: string }>`
      insert into platform.operation_takeovers (tenant_id, operation_id, record_id, input_hash, caller_user_id, owner_module, override_id)
      values (${actor.tenantId}::uuid, 'Owner.update', ${owner.id}, ${takeoverInputHash(input)}, ${actor.userId}::uuid, 'workflow-test', 'definition-1')
      returning id`.execute(privileged.db)).rows[0]!.id;
    behaviour.execute = async (_context, request) => {
      keys.push(request.idempotencyKey);
      return { accepted: { by: { kind: "workflow", ref: "run-existing" }, status: "running" } };
    };
    const resumed: any = await run("Owner.update", input);
    expect(resumed.accepted.by.ref).toBe("run-existing");
    expect(executed.at(-1).takeoverId).toBe(second);
    expect(keys[0]).toBe(keys[1]);
    expect((await takeovers(owner.id))[0]).toMatchObject({ id: second, owner_ref: "run-existing" });
    const calls = executed.length;
    expect(((await run("Owner.update", input)) as any).accepted.by.ref).toBe("run-existing");
    expect(executed).toHaveLength(calls);
  });

  test("a completed delete reports deleted only when the record is gone", async () => {
    behaviour = {
      takes: (request) => request.operation.id === "Owner.delete",
      execute: async () => ({ completed: { deleted: true } }),
    };
    const owner = await newOwner();
    const result: any = await run("Owner.delete", { id: owner.id, expectedVersion: (await stored("owners", owner.id)).version, confirmed: true });
    expect(result).toMatchObject({ intent: "delete", data: { deleted: false } });
    expect(await stored("owners", owner.id)).toBeDefined();
  });

  test("a replay stamps the recorded caller, not the service identity", async () => {
    behaviour = { takes: takesOwnerUpdate };
    const operation = entityOperationContract("Owner.update");
    const original = operation.stamps;
    (operation as any).stamps = [
      { field: "changedBy", source: "actorUserId" },
      { field: "changedRelation", source: "actorRelation" },
    ];
    try {
      const owner = await newOwner();
      const relationId = randomUUID();
      const caller = { ...actor, relation: { status: "linked", relationId, displayName: "Caller" } };
      const input = await updateInput(owner.id, "Stamped");
      expect(((await run("Owner.update", input, caller)) as any).accepted).toBeDefined();
      expect((await takeovers(owner.id))[0]).toMatchObject({ caller_user_id: actor.userId, caller_relation_id: relationId });
      // The service identity has no linked Relation of its own.
      const replayed: any = await run("Owner.update", { ...input, osfTakeover: executed[0].takeoverId }, service());
      expect(record(replayed).name).toBe("Stamped");
      expect((await stored("owners", owner.id)).row).toMatchObject({ changed_by: actor.userId, changed_relation: relationId });
    } finally {
      (operation as any).stamps = original;
    }
  });

  test("REST answers a taken-over update and delete with 202", async () => {
    const secret = "override-rest-test-secret";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER ??= "https://issuer.invalid/realms/test";
    __resetSessionResolverForTests();
    const app = Fastify();
    registerGeneratedRestRoutes(app, { db: runtime.db });
    await app.ready();
    try {
      const table = tables.find((candidate: any) => candidate.source?.authoringEntityName === "Owner");
      const base = `${REST_MOUNT_PATH}/${table.source.rest.basePath}`;
      const headers = () => {
        const value = new Headers({ "content-type": "application/json" });
        applyTrustedContextHeaders(value, { tenantId: actor.tenantId, userId: actor.userId, roles }, { secret });
        return Object.fromEntries(value.entries());
      };
      behaviour = { takes: (request) => request.operation.id.startsWith("Owner.") };
      const owner = await newOwner();
      const version = (await stored("owners", owner.id)).version;
      const updated = await app.inject({ method: "PATCH", url: `${base}/${owner.id}`, headers: headers(), payload: JSON.stringify({ name: "Rest", expectedVersion: version }) });
      expect({ status: updated.statusCode, body: updated.body }).toMatchObject({ status: 202 });
      expect(updated.json()).toMatchObject({ accepted: { by: { kind: "workflow" }, status: "waiting" } });
      const deleted = await app.inject({ method: "DELETE", url: `${base}/${owner.id}`, headers: headers(), payload: JSON.stringify({ expectedVersion: version, confirmed: true }) });
      expect(deleted.statusCode).toBe(202);
      expect(deleted.json().accepted.by.kind).toBe("workflow");
      expect((await stored("owners", owner.id)).row.name).toBe("Before");
    } finally {
      await app.close();
      delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
      __resetSessionResolverForTests();
    }
  });
}
