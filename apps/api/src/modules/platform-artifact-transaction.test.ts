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

class ResultDriver extends DummyDriver {
  #nextConnectionId = 1;

  constructor(private readonly observations: QueryObservation[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const connectionId = this.#nextConnectionId++;
    const observations = this.observations;
    return {
      executeQuery: async <R>(query: CompiledQuery) => {
        observations.push({ connectionId, sql: query.sql });
        return { rows: [{ present: 1 }] as R[] };
      },
      streamQuery: async function* <R>() {
        yield { rows: [] as R[] };
      },
    };
  }
}

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
});
