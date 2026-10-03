// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql,
  type CompiledQuery, type DatabaseConnection } from "kysely";
import { controlSessionFor } from "../control/control-session.js";
import { systemSessionForAdministrator } from "../control/platform-admin.js";
import { withSystemSession } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { bindOperationHandlers, invokeOperation, type OperationContract } from "../operations/runtime.js";
import type { RuntimeModule } from "./contract.js";
import { ModulePlatformRuntime } from "./platform.js";

test("a tenantless control write reaches its own audited system transaction", async () => {
  const statements: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery) => {
          statements.push(query.sql);
          return { rows: [] as R[] };
        },
        streamQuery: async function* <R>() { yield { rows: [] as R[] }; },
      };
    }
    override async commitTransaction() { statements.push("<commit>"); }
  }
  const db = new Kysely<DB>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  const administrator = {
    issuer: "https://identity.test/realms/control", subject: "operator-subject", username: "operator",
    name: null, email: null, authorizedParty: "control-ui", expiresAtMs: null,
  };
  const session = controlSessionFor(administrator, ["platform-operator"]);
  const operation: OperationContract = {
    key: "test.control-write", plugin: "test", title: "Control write", description: "Control write", handler: "write",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
    auth: { mode: "control", roles: ["platform-operator"] }, tenancy: { mode: "none" },
    idempotency: { mode: "intrinsic" }, effects: { data: "write", external: "write" },
    confirmation: { mode: "acknowledgement" },
    transports: { rest: { method: "POST", path: "/api/test/control-write", response: { kind: "json", status: 200 } },
      mcp: { enabled: false, reason: "Test" }, graphql: { enabled: false, reason: "Test" },
      typescript: { enabled: false, reason: "Test" } },
  };
  const module: RuntimeModule = { name: "test", operationHandlers: { write: async (input, context) => {
    expect(context.session?.tenantId).toBeNull();
    expect(input.confirmed).toBeUndefined();
    await withSystemSession(context.db!, systemSessionForAdministrator(administrator, operation.key), async trx => {
      await sql`select 1 as control_write_marker`.execute(trx);
    });
    return { value: {} };
  } } };
  try {
    const platform = new ModulePlatformRuntime(db);
    const bound = bindOperationHandlers([module], [operation]).get(operation.key)!;
    expect(await invokeOperation(bound, { confirmed: true }, { db, platform: platform.services, session, transport: "rest" }))
      .toEqual({ value: {} });
    expect(statements.some(statement => statement.includes("control_write_marker"))).toBe(true);
    expect(statements.filter(statement => statement.includes("insert into platform.system_bypass_audit"))).toHaveLength(1);
    expect(statements.filter(statement => statement === "<commit>")).toHaveLength(1);
    const beforeUnauthorized = statements.length;
    await expect(invokeOperation(bound, { confirmed: true }, {
      db, platform: platform.services, session: { ...session, roles: [] }, transport: "rest",
    })).rejects.toMatchObject({ status: 403 });
    expect(statements).toHaveLength(beforeUnauthorized);
  } finally { await db.destroy(); }
});
