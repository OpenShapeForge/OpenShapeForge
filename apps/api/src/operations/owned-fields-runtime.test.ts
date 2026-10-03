// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DB } from "../generated/db/types.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import type { RuntimeModule } from "../modules/contract.js";
import { bindOperationHandlers, invokeOperation, type OperationContract } from "./runtime.js";

test("canonical non-write handlers cannot use or promote the owned-field capability", async () => {
  for (const data of ["read", "delete"] as const) {
    const statements: string[] = [];
    const db = new Kysely<DB>({
      log: event => { if (event.level === "query") statements.push(event.query.sql); },
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: database => new PostgresIntrospector(database),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const platform = new ModulePlatformRuntime(db);
    const operation: OperationContract = {
      key: `fixture.${data}.stamp`, plugin: "fixture", title: "Fixture reader", description: "Fixture.",
      handler: "read", target: { entityId: "Fixture", entityName: "Fixture", scope: "record", inputField: "id" },
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      outputSchema: { type: "object" }, errors: [], auth: { mode: "session", roles: ["Fixture.Read"] },
      tenancy: { mode: "required" }, idempotency: { mode: "none" }, effects: { data, external: "none" },
      transports: {
        rest: { method: "POST", path: `/api/fixture/${data}`, response: { status: 200, kind: "json" } },
        mcp: { enabled: false, reason: "Unit fixture." }, graphql: { enabled: false, reason: "Unit fixture." },
        typescript: { enabled: false, reason: "Unit fixture." },
      },
    };
    let handlerCalls = 0;
    const module: RuntimeModule = { name: "fixture", operationHandlers: { read: async (input, context) => {
      handlerCalls++;
      // Metadata mutation after admission cannot promote a read into a writer.
      operation.effects.data = "write";
      await expect(context.applyOwnedEntityFields!({ id: String(input.id), values: { status: "changed" } }))
        .rejects.toThrow("originally authorized canonical record");
      return { value: {} };
    } } };
    const bound = bindOperationHandlers([module], [operation]).get(operation.key)!;
    try {
      await expect(invokeOperation(bound, { id: "44444444-4444-4444-8444-444444444444" }, {
        db, platform: platform.services, transport: "rest", session: {
          tenantId: "11111111-1111-4111-8111-111111111111", userId: "33333333-3333-4333-8333-333333333333",
          roles: ["Fixture.Read"], groups: [], scope: "tenant", credential: "trusted-context",
        },
      })).resolves.toEqual({ value: {} });
      expect(handlerCalls).toBe(1);
      expect(statements).toEqual([]);
    } finally { await db.destroy(); }
  }
});
