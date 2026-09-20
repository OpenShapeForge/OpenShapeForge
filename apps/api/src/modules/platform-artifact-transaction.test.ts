// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, mock, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import type { RuntimeArtifactDescriptor } from "@openshapeforge/plugin-runtime";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
} from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB } from "../generated/db/types.js";
import type { RuntimeModule } from "./contract.js";

const providerId = "test-artifact-provider";

mock.module("./settings.js", () => ({
  runtimeSettings: Object.freeze({
    get: () => undefined,
    providerSupports: (candidate: string, capability: string) =>
      candidate === providerId && capability === "artifact-storage",
    selectedProviders: (capability: string) =>
      Object.freeze(capability === "artifact-storage" ? [providerId] : []),
  }),
}));

const { ModulePlatformRuntime, withModuleOperationSession } = await import(
  "./platform.js"
);

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const artifactId = "30000000-0000-4000-8000-000000000001";
const documentId = "40000000-0000-4000-8000-000000000001";
const descriptor: RuntimeArtifactDescriptor = {
  artifactId,
  version: 1,
  fileName: "evidence.pdf",
  mediaType: "application/pdf",
  sha256: "a".repeat(64),
  byteSize: 3,
};

type QueryObservation = { connectionId: number; sql: string };

/** Records every statement and every commit or rollback, per connection. */
class ResultDriver extends DummyDriver {
  #nextConnectionId = 1;
  readonly #ids = new WeakMap<DatabaseConnection, number>();

  constructor(private readonly observations: QueryObservation[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const connectionId = this.#nextConnectionId++;
    const observations = this.observations;
    const connection: DatabaseConnection = {
      executeQuery: async <R>(query: CompiledQuery) => {
        observations.push({ connectionId, sql: query.sql });
        return { rows: [{ present: 1, tenant_id: tenantId, occurred_at: new Date(0), payload: {} }] as R[] };
      },
      streamQuery: async function* <R>() {
        yield { rows: [] as R[] };
      },
    };
    this.#ids.set(connection, connectionId);
    return connection;
  }

  // Kysely passes the connection; DummyDriver's declaration omits it.
  override async commitTransaction(connection?: DatabaseConnection): Promise<void> {
    this.observations.push({ connectionId: this.#ids.get(connection!)!, sql: "<commit>" });
  }

  override async rollbackTransaction(connection?: DatabaseConnection): Promise<void> {
    this.observations.push({ connectionId: this.#ids.get(connection!)!, sql: "<rollback>" });
  }
}

function trustedSession(userId: string): TrustedSessionContext {
  return { tenantId, userId, roles: ["CaseFile.All.Read"], groups: [], relationGroupIds: [], scope: "tenant", credential: "bearer" };
}

/** A storage module whose `stage` runs `work` inside the artifact transaction it opened. */
function stagingModule(
  platform: InstanceType<typeof ModulePlatformRuntime>,
  work: (context: { session: TrustedSessionContext }, transaction: unknown) => Promise<void>,
): RuntimeModule {
  return {
    name: "test-artifact-storage",
    artifactStorage: {
      providerId,
      stage: async (context) => context.withTransaction(async (transaction) => {
        await sql`select 1 as provider_stage_marker`.execute(transaction);
        await work(context, transaction);
        return descriptor;
      }),
      bind: async () => descriptor,
      read: async () => ({ descriptor, bytes: Uint8Array.of(1, 2, 3), owner: { entity: "Document", id: documentId } }),
    },
  };
}

const gcJob = { kind: "storage.gc", payload: { artifactId }, deliveryKey: artifactId, availableAt: new Date("2030-01-01T00:00:00Z") };
const stageInput = () => ({ purpose: "record-upload", fileName: "evidence.pdf", source: (async function* () { yield Uint8Array.of(1, 2, 3); })() });
const connectionsOf = (observations: QueryObservation[]) => new Set(observations.map((entry) => entry.connectionId));

function database(observations: QueryObservation[]): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ResultDriver(observations),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

describe("artifact record authorization transaction scope", () => {
  test("shares the read transaction with record checks without granting bind authority", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    const session: TrustedSessionContext = {
      tenantId,
      userId,
      roles: ["CaseFile.All.Read"],
      groups: [],
      relationGroupIds: [],
      scope: "tenant",
      credential: "bearer",
    };
    let bindError: unknown;
    const module: RuntimeModule = {
      name: "test-artifact-storage",
      artifactStorage: {
        providerId,
        stage: async () => descriptor,
        bind: async () => descriptor,
        read: async (context) => context.withTransaction(async (transaction) => {
          await sql`select 1 as artifact_transaction_marker`.execute(transaction);
          await platform.services.records.assertAccess(context.session, {
            entityName: "Document",
            id: documentId,
            intent: "get",
          });
          try {
            await platform.services.artifacts.bind(context.session, {
              artifactId,
              owner: { entity: "Document", id: documentId },
              expectedArtifactVersion: 1,
            });
          } catch (error) {
            bindError = error;
          }
          return { descriptor, bytes: Uint8Array.of(1, 2, 3), owner: { entity: "Document", id: documentId } };
        }),
      },
    };
    platform.registerArtifactStorage([module]);

    try {
      await withModuleOperationSession(
        platform.services,
        session,
        async (active) => platform.services.artifacts.read(active!, {
          artifactId,
          owner: { entity: "Document", id: documentId },
        }),
      );
      const artifactQuery = observations.find((entry) =>
        entry.sql.includes("artifact_transaction_marker")
      );
      const recordQuery = observations.find((entry) =>
        entry.sql.includes('from "erp"."documents" as row_source')
      );
      expect(artifactQuery).toBeDefined();
      expect(recordQuery).toBeDefined();
      expect(recordQuery?.connectionId).toBe(artifactQuery?.connectionId);
      expect(operationErrorOf(bindError)?.code).toBe(
        "ARTIFACT_TRANSACTION_REQUIRED",
      );
    } finally {
      await db.destroy();
    }
  });

  test("a download without an Operation transaction reads the oracle and the provider on one connection", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    const session: TrustedSessionContext = {
      tenantId,
      userId,
      roles: ["CaseFile.All.Read"],
      groups: [],
      relationGroupIds: [],
      scope: "tenant",
      credential: "bearer",
    };
    const module: RuntimeModule = {
      name: "test-artifact-storage",
      artifactStorage: {
        providerId,
        stage: async () => descriptor,
        bind: async () => descriptor,
        // The provider takes the documented handle and nothing else: no oracle call of its own.
        read: async (context) => context.withTransaction(async (transaction) => {
          await sql`select 1 as provider_read_marker`.execute(transaction);
          return { descriptor, bytes: Uint8Array.of(1, 2, 3), owner: { entity: "Document", id: documentId } };
        }),
      },
    };
    platform.registerArtifactStorage([module]);

    try {
      await withModuleOperationSession(
        platform.services,
        session,
        async (active) => platform.services.artifacts.read(active!, {
          artifactId,
          owner: { entity: "Document", id: documentId },
        }),
      );
      const oracle = observations.find((entry) => entry.sql.includes('from "erp"."documents" as row_source'));
      const provider = observations.find((entry) => entry.sql.includes("provider_read_marker"));
      expect(oracle).toBeDefined();
      expect(provider).toBeDefined();
      expect(provider?.connectionId).toBe(oracle?.connectionId);
      expect(new Set(observations.map((entry) => entry.connectionId)).size).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  test("a job enqueued while staging joins the artifact transaction, so the row and the job commit together", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    platform.registerArtifactStorage([stagingModule(platform, (context) => platform.services.jobs.enqueue(context.session, gcJob).then(() => undefined))]);
    try {
      await withModuleOperationSession(platform.services, trustedSession(userId), (active) =>
        platform.services.artifacts.stage(active!, stageInput()));
      const stage = observations.find((entry) => entry.sql.includes("provider_stage_marker"));
      const enqueue = observations.find((entry) => entry.sql.includes('into "platform"."jobs"'));
      expect(stage).toBeDefined();
      expect(enqueue).toBeDefined();
      expect(enqueue?.connectionId).toBe(stage?.connectionId);
      expect(connectionsOf(observations).size).toBe(1);
      expect(observations.at(-1)).toEqual({ connectionId: stage!.connectionId, sql: "<commit>" });
    } finally {
      await db.destroy();
    }
  });

  test("a stage that fails after enqueueing rolls the job back with the row: nothing is committed", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    platform.registerArtifactStorage([stagingModule(platform, async (context) => {
      await platform.services.jobs.enqueue(context.session, gcJob);
      throw new Error("provider write failed after the job was enqueued");
    })]);
    try {
      await expect(withModuleOperationSession(platform.services, trustedSession(userId), (active) =>
        platform.services.artifacts.stage(active!, stageInput()))).rejects.toThrow("provider write failed");
      const enqueue = observations.find((entry) => entry.sql.includes('into "platform"."jobs"'));
      expect(enqueue).toBeDefined();
      expect(observations.some((entry) => entry.sql === "<commit>")).toBe(false);
      expect(observations.at(-1)).toEqual({ connectionId: enqueue!.connectionId, sql: "<rollback>" });
    } finally {
      await db.destroy();
    }
  });

  test("an Operation-outer enqueue stays on the Operation transaction", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    const session = trustedSession(userId);
    try {
      await withModuleOperationSession(platform.services, session, (active) =>
        platform.withOperationTransaction(active!, async (trx) => {
          await sql`select 1 as operation_marker`.execute(trx);
          await platform.services.jobs.enqueue(active!, gcJob);
        }));
      const operation = observations.find((entry) => entry.sql.includes("operation_marker"));
      const enqueue = observations.find((entry) => entry.sql.includes('into "platform"."jobs"'));
      expect(enqueue?.connectionId).toBe(operation?.connectionId);
      expect(connectionsOf(observations).size).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  test("an Operation nested in a stage joins the artifact transaction instead of opening a second one", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    platform.registerArtifactStorage([stagingModule(platform, (context) =>
      platform.withOperationTransaction(context.session, async (trx) => {
        await sql`select 1 as nested_operation_marker`.execute(trx);
        await platform.services.jobs.enqueue(context.session, gcJob);
        await platform.services.db.withSession(context.session, async (inner) => { await sql`select 1 as module_db_marker`.execute(inner); });
        await platform.services.events.append(context.session, { aggregateType: "Document", aggregateId: documentId, eventType: "document.staged", payload: {} });
      }))]);
    try {
      await withModuleOperationSession(platform.services, trustedSession(userId), (active) =>
        platform.services.artifacts.stage(active!, stageInput()));
      for (const marker of ["provider_stage_marker", "nested_operation_marker", 'into "platform"."jobs"', "module_db_marker", "entity_events"]) {
        expect(observations.some((entry) => entry.sql.includes(marker))).toBe(true);
      }
      expect(connectionsOf(observations).size).toBe(1);
      expect(observations.filter((entry) => entry.sql === "<commit>")).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  test("module database work and entity events inside a stage join the artifact transaction", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    platform.registerArtifactStorage([stagingModule(platform, async (context) => {
      await platform.services.db.withSession(context.session, async (inner) => { await sql`select 1 as module_db_marker`.execute(inner); });
      await platform.services.events.append(context.session, { aggregateType: "Document", aggregateId: documentId, eventType: "document.staged", payload: {} });
    })]);
    try {
      await withModuleOperationSession(platform.services, trustedSession(userId), (active) =>
        platform.services.artifacts.stage(active!, stageInput()));
      const stage = observations.find((entry) => entry.sql.includes("provider_stage_marker"));
      const moduleDb = observations.find((entry) => entry.sql.includes("module_db_marker"));
      const event = observations.find((entry) => entry.sql.includes("entity_events"));
      expect(moduleDb?.connectionId).toBe(stage?.connectionId);
      expect(event?.connectionId).toBe(stage?.connectionId);
      expect(connectionsOf(observations).size).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  test("two concurrent stages keep their own transactions, and neither can enqueue on the other's", async () => {
    const observations: QueryObservation[] = [];
    const db = database(observations);
    const platform = new ModulePlatformRuntime(db);
    const sessions = [trustedSession(userId), trustedSession("20000000-0000-4000-8000-000000000002")];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let waiting = 0;
    const crossed: unknown[] = [];
    platform.registerArtifactStorage([stagingModule(platform, async (context) => {
      if (++waiting === 2) release();
      await gate; // both stages are open at once before either enqueues
      await platform.services.jobs.enqueue(context.session, { ...gcJob, deliveryKey: context.session.userId! });
      const other = sessions.find((candidate) => candidate !== context.session)!;
      try { await platform.services.jobs.enqueue(other, gcJob); } catch (error) { crossed.push(error); }
    })]);
    try {
      await Promise.all(sessions.map((session) =>
        withModuleOperationSession(platform.services, session, (active) => platform.services.artifacts.stage(active!, stageInput()))));
      expect(connectionsOf(observations).size).toBe(2);
      const enqueues = observations.filter((entry) => entry.sql.includes('into "platform"."jobs"'));
      expect(enqueues).toHaveLength(2);
      expect(new Set(enqueues.map((entry) => entry.connectionId)).size).toBe(2);
      for (const connectionId of connectionsOf(observations)) {
        const own = observations.filter((entry) => entry.connectionId === connectionId);
        expect(own.some((entry) => entry.sql.includes("provider_stage_marker"))).toBe(true);
        expect(own.some((entry) => entry.sql.includes('into "platform"."jobs"'))).toBe(true);
        expect(own.at(-1)?.sql).toBe("<commit>");
      }
      // The other stage's session is not this call's live session: refused, and nothing crossed connections.
      expect(crossed).toHaveLength(2);
      expect(String(crossed[0])).toContain("session");
    } finally {
      await db.destroy();
    }
  });
});
