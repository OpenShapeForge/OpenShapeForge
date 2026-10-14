// SPDX-License-Identifier: BUSL-1.1
/**
 * The host execution admission guard against PostgreSQL.
 *
 * What only a real database can establish, and what this file is for:
 *
 *  - the policy runs in a tenant-scoped transaction under the CALLER's own
 *    session, so its reads are restricted by row-level security and one
 *    tenant's deadline can never decide another tenant's writes;
 *  - the authoritative deadline is a persisted row read by the server, not a
 *    claim in the request or a client clock;
 *  - a refusal leaves the database untouched on the ordinary entity CRUD fast
 *    path, on a custom plugin Operation, on a collection mutation and on a
 *    keyed Operation (no receipt row), while every read keeps working;
 *  - work admitted while the tenant was still writable is refused when it
 *    actually executes later — the queued/broker case;
 *  - core's own identity bookkeeping, which does not run as a canonical
 *    Operation, is not denied along with the tenant's product writes.
 *
 * The offline half — classification, decision validation, composition,
 * fail-closed behaviour and a second unrelated policy — is in
 * operations/execution-policy.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { DB } from "../../generated/db/types.js";
import type {
  ModuleExecutionPolicy,
  RuntimeModule,
} from "../../modules/contract.js";
import {
  ModulePlatformRuntime,
  withModuleOperationSession,
} from "../../modules/platform.js";
import {
  listOperationContracts,
  runtimeStaticOperationRegistrations,
  type OperationContract,
} from "../../operations/runtime.js";
import {
  EXECUTION_NOT_PERMITTED,
  registerOperationExecutionPolicies,
} from "../../operations/execution-policy.js";
import { getGeneratedCrudTables } from "../../operations/entity/index.js";
import { createGeneratedEntityForTable } from "../../operations/entity/mutations.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = "openshapeforge_app";
const SCRATCH = `execution_policy_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const WRITE_ROLES = [
  "Relations.All.ReadWrite",
  "Relations.All.Read",
  "Relations.All.Delete",
  "CaseFile.All.ReadWrite",
];

function databaseUrl(app = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH}`;
  if (app) {
    url.username = APP_ROLE;
    url.password = APP_ROLE_PASSWORD;
  }
  return url.toString();
}

/** One custom plugin Operation, parameterised by the effects under test. */
function customOperation(
  key: string,
  effects: OperationContract["effects"],
  idempotency: OperationContract["idempotency"] = { mode: "none" },
): OperationContract {
  return {
    key,
    plugin: "execution-policy-example",
    title: key,
    description: key,
    handler: key.split(".")[1]!,
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string" },
        requestKey: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ran"],
      properties: { ran: { const: true } },
      additionalProperties: false,
    },
    errors: [],
    auth: { mode: "session", roles: ["Relations.All.ReadWrite"] },
    tenancy: { mode: "required" },
    idempotency,
    effects,
    transports: {
      rest: { method: "POST", path: `/api/example/${key}`, response: { kind: "json" } },
      mcp: { enabled: false },
      graphql: { enabled: false },
      typescript: { enabled: false },
    },
  };
}

const CUSTOM_WRITE = customOperation("example.write", { data: "write", external: "none" });
const CUSTOM_PUBLISH = customOperation("example.publish", { data: "read", external: "write" });
const CUSTOM_READ = customOperation("example.read", { data: "read", external: "none" });
const CUSTOM_KEYED = customOperation(
  "example.keyed",
  { data: "write", external: "none" },
  { mode: "idempotency-key", header: "Idempotency-Key", inputField: "requestKey" },
);

let admin: SQL | undefined;
let created = false;
let privileged: DatabaseRuntime | undefined;
let app: DatabaseRuntime | undefined;
let platform: ModulePlatformRuntime | undefined;

/** What the handlers did, so a refusal can be proven to precede them. */
const ran: string[] = [];
const delivered: string[] = [];
/** The server clock the deadline policy reads; never a caller's. */
let serverNow = new Date("2026-10-14T09:00:00.000Z");
/** Which policies the guard reached, and what they saw of their tenant. */
const policyCalls: { policy: string; tenantId: string | null; relations: number }[] = [];

const exampleModule: RuntimeModule = {
  name: "execution-policy-example",
  operationHandlers: {
    write: async (_input, context) => {
      ran.push("write");
      await context.platform!.db.withSession(context.session!, (trx) =>
        sql`insert into erp.relations (id, tenant_id, display_name, relation_type)
            values (${randomUUID()}::uuid, ${context.session!.tenantId}::uuid, 'Handler row', 'organization')`
          .execute(trx));
      return { value: { ran: true } };
    },
    publish: async () => {
      ran.push("publish");
      delivered.push("published");
      return { value: { ran: true } };
    },
    read: async () => {
      ran.push("read");
      return { value: { ran: true } };
    },
    keyed: async () => {
      ran.push("keyed");
      return { value: { ran: true } };
    },
  },
};

/**
 * The demonstrated host need, as a policy: writes stop at a deadline the
 * SERVER persisted per tenant. It reads its own tenant's row through the
 * transaction core supplies, so RLS decides which row it can see at all.
 */
const deadlinePolicy: ModuleExecutionPolicy = {
  name: "tenant-write-deadline",
  evaluate: async (_request, context) => {
    const rows = await sql<{ tenant_id: string; writes_until: Date }>`
      select tenant_id, writes_until from public.execution_policy_deadline
    `.execute(context.db);
    const relations = await sql<{ count: string }>`
      select count(*)::text as count from erp.relations
    `.execute(context.db);
    policyCalls.push({
      policy: "tenant-write-deadline",
      tenantId: context.session.tenantId,
      relations: Number(relations.rows[0]!.count),
    });
    // Exactly one row is visible under this tenant's RLS, or none.
    const deadline = rows.rows[0];
    if (!deadline) return { admitted: true };
    if (rows.rows.length !== 1 || deadline.tenant_id !== context.session.tenantId) {
      return { admitted: false, refusal: { message: "The workspace policy is ambiguous." } };
    }
    if (serverNow < new Date(deadline.writes_until)) return { admitted: true };
    return {
      admitted: false,
      refusal: {
        message: "This workspace is read-only.",
        detail: "Its write period ended; everything stays readable.",
      },
    };
  },
};

function session(tenantId: string, overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return {
    tenantId,
    userId: randomUUID(),
    roles: WRITE_ROLES,
    groups: [],
    relationGroupIds: [],
    scope: "tenant",
    credential: "trusted-context",
    ...overrides,
  };
}

const execute = (
  active: TrustedSessionContext,
  id: string,
  intent: string,
  input?: Record<string, unknown>,
  idempotencyKey?: string,
) =>
  withModuleOperationSession(
    platform!.services,
    active,
    (live) => platform!.services.operations.execute(live!, {
      operation: { id, intent },
      ...(input ? { input } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  );

async function relationCount(tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from erp.relations where tenant_id = ${tenantId}::uuid
  `.execute(privileged!.db);
  return Number(rows.rows[0]!.count);
}

let tenantA = randomUUID();
let tenantB = randomUUID();

describe("host execution policies against PostgreSQL", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${SCRATCH}"`);
    created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 4 });
    await privileged.db.connection().execute((trx) => runMigrationChain(trx));
    await sql`
      create table public.execution_policy_deadline (
        tenant_id uuid primary key,
        writes_until timestamptz not null
      )
    `.execute(privileged.db);
    await sql`alter table public.execution_policy_deadline enable row level security`.execute(privileged.db);
    await sql`alter table public.execution_policy_deadline force row level security`.execute(privileged.db);
    await sql`create policy tenant on public.execution_policy_deadline
      using (tenant_id = app.current_tenant())`.execute(privileged.db);
    await sql`grant select on public.execution_policy_deadline to ${sql.id(APP_ROLE)}`.execute(privileged.db);
    app = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 6 });
    platform = new ModulePlatformRuntime(app.db);
    platform.registerStaticOperations(runtimeStaticOperationRegistrations(
      [exampleModule],
      { db: app.db, platform: platform.services },
      [
        CUSTOM_WRITE,
        CUSTOM_PUBLISH,
        CUSTOM_READ,
        CUSTOM_KEYED,
        listOperationContracts().find((operation) => operation.key === "Document.insertVariant")!,
      ],
    ));
    registerOperationExecutionPolicies(app.db, [
      { ...exampleModule, executionPolicies: [deadlinePolicy] },
    ]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await privileged?.close();
    if (created) await admin?.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin?.close();
  });

  beforeEach(async () => {
    ran.length = 0;
    delivered.length = 0;
    policyCalls.length = 0;
    serverNow = new Date("2026-10-14T09:00:00.000Z");
    tenantA = randomUUID();
    tenantB = randomUUID();
    await sql`truncate public.execution_policy_deadline`.execute(privileged!.db);
    await sql`delete from platform.operation_execution_receipts`.execute(privileged!.db);
    await sql`delete from erp.relations`.execute(privileged!.db);
    // Tenant A may write until 10:00; tenant B until the far future.
    await sql`insert into public.execution_policy_deadline (tenant_id, writes_until) values
      (${tenantA}::uuid, '2026-10-14T10:00:00Z'), (${tenantB}::uuid, '2099-01-01T00:00:00Z')`
      .execute(privileged!.db);
  });

  test("admits the ordinary entity create while the tenant may still write", async () => {
    const result = await execute(session(tenantA), "Relation.create", "create", {
      values: { displayName: "Within the window", relationType: "organization" },
    });
    expect(result).not.toHaveProperty("error");
    expect(await relationCount(tenantA)).toBe(1);
    expect(policyCalls.map((call) => call.policy)).toEqual(["tenant-write-deadline"]);
  });

  test("refuses entity create, update and delete past the deadline, and writes nothing", async () => {
    const created = await execute(session(tenantA), "Relation.create", "create", {
      values: { displayName: "Before the deadline", relationType: "organization" },
    });
    const id = (created as { data: { id: string } }).data.id;
    serverNow = new Date("2026-10-14T10:00:00.001Z");

    for (const [id_, intent, input] of [
      ["Relation.create", "create", { values: { displayName: "After", relationType: "organization" } }],
      ["Relation.update", "update", { id, values: { displayName: "Renamed" } }],
      ["Relation.delete", "delete", { id }],
    ] as const) {
      expect(await execute(session(tenantA), id_, intent, input)).toMatchObject({
        error: {
          code: EXECUTION_NOT_PERMITTED,
          message: "This workspace is read-only.",
          detail: "Its write period ended; everything stays readable.",
          retryable: false,
        },
      });
    }
    expect(await relationCount(tenantA)).toBe(1);
    const row = await sql<{ display_name: string }>`
      select display_name from erp.relations where id = ${id}::uuid
    `.execute(privileged!.db);
    expect(row.rows[0]!.display_name).toBe("Before the deadline");
  });

  test("keeps the read Operations available while every write is refused", async () => {
    await execute(session(tenantA), "Relation.create", "create", {
      values: { displayName: "Readable", relationType: "organization" },
    });
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    const actor = session(tenantA);
    const list = await execute(actor, "Relation.list", "list");
    expect(list).not.toHaveProperty("error");
    expect((list as { data: { items: unknown[] } }).data.items).toHaveLength(1);
    const read = await execute(actor, "example.read", "invoke");
    expect(read).toMatchObject({ data: { ran: true } });
    expect(ran).toContain("read");
    // A read is never offered to a policy at all.
    expect(policyCalls).toHaveLength(1);
  });

  test("refuses a custom plugin write before its handler runs", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    expect(await execute(session(tenantA), "example.write", "invoke", { note: "x" }))
      .toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    expect(ran).toEqual([]);
    expect(await relationCount(tenantA)).toBe(0);
  });

  test("prevents the external effect of an Operation that only reads data", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    expect(await execute(session(tenantA), "example.publish", "invoke"))
      .toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    expect(ran).toEqual([]);
    expect(delivered).toEqual([]);
  });

  test("refuses a collection mutation", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    // Refused before its own input contract: a frozen tenant cannot write
    // whatever the request body says, so no parent record is needed.
    expect(await execute(session(tenantA), "Document.insertVariant", "invoke", {}))
      .toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
  });

  test("refuses a keyed Operation without persisting a receipt it could replay", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    expect(await execute(session(tenantA), "example.keyed", "invoke", {}, "request-1"))
      .toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    expect(ran).toEqual([]);
    const receipts = await sql<{ count: string }>`
      select count(*)::text as count from platform.operation_execution_receipts
    `.execute(privileged!.db);
    expect(receipts.rows[0]!.count).toBe("0");
  });

  test("work admitted while the tenant could write is refused when it actually executes", async () => {
    // The enqueue-time decision: admitted.
    const actor = session(tenantA);
    expect(await execute(actor, "example.write", "invoke")).toMatchObject({ data: { ran: true } });
    expect(ran).toEqual(["write"]);
    // The same request, dispatched later by a worker or broker, is decided
    // again on the live deadline rather than on the earlier admission.
    serverNow = new Date("2026-10-14T10:00:00.001Z");
    expect(await execute(actor, "example.write", "invoke"))
      .toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    expect(ran).toEqual(["write"]);
    expect(await relationCount(tenantA)).toBe(1);
  });

  test("one tenant's deadline never decides another tenant's writes", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    expect(await execute(session(tenantA), "Relation.create", "create", {
      values: { displayName: "Refused", relationType: "organization" },
    })).toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    const allowed = await execute(session(tenantB), "Relation.create", "create", {
      values: { displayName: "Allowed", relationType: "organization" },
    });
    expect(allowed).not.toHaveProperty("error");
    expect(await relationCount(tenantA)).toBe(0);
    expect(await relationCount(tenantB)).toBe(1);
  });

  test("the policy reads only its own tenant's rows", async () => {
    await execute(session(tenantB), "Relation.create", "create", {
      values: { displayName: "B one", relationType: "organization" },
    });
    await execute(session(tenantB), "Relation.create", "create", {
      values: { displayName: "B two", relationType: "organization" },
    });
    policyCalls.length = 0;
    await execute(session(tenantA), "Relation.create", "create", {
      values: { displayName: "A one", relationType: "organization" },
    });
    expect(policyCalls).toEqual([
      { policy: "tenant-write-deadline", tenantId: tenantA, relations: 0 },
    ]);
    policyCalls.length = 0;
    await execute(session(tenantB), "Relation.create", "create", {
      values: { displayName: "B three", relationType: "organization" },
    });
    expect(policyCalls).toEqual([
      { policy: "tenant-write-deadline", tenantId: tenantB, relations: 2 },
    ]);
  });

  test("a tenant with no persisted policy row keeps writing", async () => {
    const unknown = randomUUID();
    serverNow = new Date("2099-06-01T00:00:00.000Z");
    const result = await execute(session(unknown), "Relation.create", "create", {
      values: { displayName: "Ungoverned", relationType: "organization" },
    });
    expect(result).not.toHaveProperty("error");
    expect(await relationCount(unknown)).toBe(1);
  });

  test("a policy whose own query fails denies the write and leaves it unapplied", async () => {
    const broken: ModuleExecutionPolicy = {
      name: "broken",
      evaluate: async (_request, context) => {
        await sql`select * from public.table_that_does_not_exist`.execute(context.db);
        return { admitted: true };
      },
    };
    registerOperationExecutionPolicies(app!.db, [
      { ...exampleModule, executionPolicies: [broken] },
    ]);
    try {
      expect(await execute(session(tenantA), "Relation.create", "create", {
        values: { displayName: "Never", relationType: "organization" },
      })).toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
      expect(await relationCount(tenantA)).toBe(0);
    } finally {
      registerOperationExecutionPolicies(app!.db, [
        { ...exampleModule, executionPolicies: [deadlinePolicy] },
      ]);
    }
  });

  test("core's own bookkeeping write is not a canonical Operation and is not denied", async () => {
    serverNow = new Date("2026-10-14T11:00:00.000Z");
    const actor = session(tenantA);
    expect(await execute(actor, "Relation.create", "create", {
      values: { displayName: "Refused", relationType: "organization" },
    })).toMatchObject({ error: { code: EXECUTION_NOT_PERMITTED } });
    // The runtime-surface create the OAuth callback and identity linking use:
    // core's own bookkeeping, outside canonical Operation admission, so a
    // frozen tenant can still sign in and have its identity recorded.
    const table = getGeneratedCrudTables().find(
      (candidate) => candidate.source?.authoringEntityName === "Relation",
    )!;
    const row = await createGeneratedEntityForTable(app!.db, actor, table, {
      displayName: "Bookkeeping",
      relationType: "organization",
    });
    expect(row).toMatchObject({ display_name: "Bookkeeping" });
    expect(await relationCount(tenantA)).toBe(1);
  });
});
