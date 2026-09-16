// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { BoundOperation } from "../runtime.js";
import { entityBusinessUnavailability, registerEntityOperationAvailability } from "./availability.js";

const session = { tenantId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333", roles: ["editor"], groups: [], scope: "tenant" as const, credential: "bearer" as const };
const database = () => new Kysely<DB>({ dialect: {
  createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
  createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
} });
const bound = (availability: NonNullable<BoundOperation["availability"]>): BoundOperation => ({
  operation: { key: "demo.publish", auth: { mode: "session", roles: ["editor"] }, tenancy: { mode: "required" },
    errors: [{ status: 409, code: "CONFLICT", description: "Wrong state" }] } as BoundOperation["operation"],
  handler: async () => ({ value: {} }), availability,
});

test("authorized offer targets are batched once per owner operation", async () => {
  const db = database();
  const batches: string[][] = [];
  try {
    const binding = bound(async (ids, context) => {
      batches.push([...ids]);
      expect(context.session.tenantId).toBe(session.tenantId);
      expect(context.db.isTransaction).toBe(true);
      return Object.fromEntries(ids.map(id => [id, id === "b" ? {
        available: false, error: { code: "CONFLICT", message: "Already published.", retryable: false },
      } : { available: true }]));
    });
    registerEntityOperationAvailability(db, new Map([["demo.publish", binding]]));
    const result = await entityBusinessUnavailability(db, session, [
      { id: "a", operationIds: ["demo.publish"] }, { id: "b", operationIds: ["demo.publish", "demo.publish"] },
      { id: "hidden", operationIds: [] },
    ]);
    expect(batches).toEqual([["a", "b"]]);
    expect([...result.entries()]).toEqual([["b", { "demo.publish": { code: "CONFLICT", message: "Already published.", retryable: false } }]]);
    await expect(entityBusinessUnavailability(db, { ...session, roles: [] }, [{ id: "a", operationIds: ["demo.publish"] }]))
      .rejects.toThrow("required operation role");
    expect(batches).toHaveLength(1);
  } finally { await db.destroy(); }
});

test("failed owner metadata disables its actions without undoing a successful response", async () => {
  const db = database();
  try {
    registerEntityOperationAvailability(db, new Map([["demo.publish", bound(async () => ({}))]]));
    const result = await entityBusinessUnavailability(db, session, [{ id: "a", operationIds: ["demo.publish"] }]);
    expect(result.get("a")?.["demo.publish"]?.code).toBe("HANDLER_CONTRACT_VIOLATION");
  } finally { await db.destroy(); }
});
