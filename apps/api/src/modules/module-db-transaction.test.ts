// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  sql, type CompiledQuery, type DatabaseConnection } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "./platform.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const subjectId = "30000000-0000-4000-8000-000000000001";
const session: TrustedSessionContext = { tenantId, userId, roles: ["reader"], groups: [], scope: "tenant", credential: "bearer" };
type Observation = { connection: number; sql: string };

class RecordingDriver extends DummyDriver {
  next = 0;
  ids = new WeakMap<DatabaseConnection, number>();
  constructor(readonly observations: Observation[]) { super(); }
  override async acquireConnection(): Promise<DatabaseConnection> {
    const connection = ++this.next;
    const observations = this.observations;
    const result: DatabaseConnection = {
      executeQuery: async <R>(query: CompiledQuery) => {
        observations.push({ connection, sql: query.sql });
        return { rows: [{ id: subjectId, tenant_id: tenantId, payload: {}, sequence: "1", occurred_at: new Date() }] as R[] };
      },
      streamQuery: async function* <R>() { yield { rows: [] as R[] }; },
    };
    this.ids.set(result, connection);
    return result;
  }
  override async commitTransaction(connection?: DatabaseConnection) { this.observations.push({ connection: this.ids.get(connection!)!, sql: "<commit>" }); }
  override async rollbackTransaction(connection?: DatabaseConnection) { this.observations.push({ connection: this.ids.get(connection!)!, sql: "<rollback>" }); }
}

async function exercise(fail: boolean) {
  const observations: Observation[] = [];
  const db = new Kysely<DB>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new RecordingDriver(observations),
    createIntrospector: (database) => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  const runtime = new ModulePlatformRuntime(db, { capabilityOperations: new Set(["fixture.callback.complete"]) });
  const definition = {
    id: "fixture.nested.write", key: "fixture.nested.write", intent: "invoke", name: "Fixture nested write", description: "Fixture.",
    input: { kind: "json-schema" as const, schema: { type: "object" } }, output: { kind: "json-schema" as const, schema: {} },
    effects: { data: "write" as const, external: "none" as const }, reliability: { idempotency: { mode: "natural" as const } },
  };
  runtime.registerStaticOperations([{ definition, available: () => true, execute: async (active) => {
    await runtime.withOperationTransaction(active, async (trx) => { await sql`select 1 as nested_canonical_write`.execute(trx); });
    return { data: {}, operations: [] };
  } }]);
  const work = () => withModuleOperationSession(runtime.services, session, async (active) => {
    await runtime.services.db.withSession(active!, async (trx) => {
      await sql`select 1 as module_owned_write`.execute(trx);
      await runtime.services.grants.issue(active!, {
        operations: ["fixture.callback.complete"], subject: { entity: "FixtureWait", id: subjectId },
        recipient: { kind: "fixture" }, maxUses: 1, expiresAt: new Date(Date.now() + 60_000),
      });
      await runtime.services.events.append(active!, { aggregateType: "FixtureWait", aggregateId: subjectId, eventType: "fixture.ready", payload: {} });
      await runtime.services.operations.execute(active!, { operation: { id: definition.id, intent: "invoke" } });
      expect(() => runtime.services.db.withSession({ ...active! }, async () => undefined)).toThrow("live verified session");
      if (fail) throw new Error("fixture refusal after all writes");
    });
  });
  try {
    if (fail) await expect(work()).rejects.toThrow("fixture refusal"); else await work();
    for (const marker of ["module_owned_write", "capability_grants", "entity_events", "nested_canonical_write"]) {
      expect(observations.some((entry) => entry.sql.includes(marker))).toBe(true);
    }
    expect(new Set(observations.map((entry) => entry.connection)).size).toBe(1);
    expect(observations.filter((entry) => entry.sql === "<commit>")).toHaveLength(fail ? 0 : 1);
    expect(observations.filter((entry) => entry.sql === "<rollback>")).toHaveLength(fail ? 1 : 0);
  } finally { await db.destroy(); }
}

test("module-owned transaction joins grant, event and nested canonical writes on the exact live session", () => exercise(false));
test("module-owned transaction refuses session substitution and rolls every nested write back together", () => exercise(true));
