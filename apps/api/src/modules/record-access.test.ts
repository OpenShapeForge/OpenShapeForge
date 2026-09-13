// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Transaction,
} from "kysely";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { DB } from "../generated/db/types.js";
import {
  getEntityOperationContracts,
  tableForEntityOperation,
} from "../operations/entity/runtime.js";
import { RecordAccessRuntime } from "./record-access.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";

const session: TrustedSessionContext = {
  tenantId,
  userId,
  roles: ["Relations.All.Read", "Relations.All.ReadWrite", "Relations.All.Delete"],
  oauthScopes: ["records:read"],
  groups: [],
  relationGroupIds: [],
  scope: "tenant",
  credential: "bearer",
};

class ResultDriver extends DummyDriver {
  constructor(
    private readonly rows: (query: CompiledQuery) => readonly Record<string, unknown>[],
  ) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const rows = this.rows;
    return {
      executeQuery: async <R>(query: CompiledQuery) => ({ rows: [...rows(query)] as R[] }),
      streamQuery: async function* <R>() {
        yield { rows: [] as R[] };
      },
    };
  }
}

function errorCode(error: unknown): string | undefined {
  return operationErrorOf(error)?.code;
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(errorCode(failure)).toBe(code);
}

function harness(
  rows: (query: CompiledQuery) => readonly Record<string, unknown>[] = () => [{ present: 1 }],
) {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ResultDriver((query) => {
        queries.push(query);
        return rows(query);
      }),
      createIntrospector: (candidate) => new PostgresIntrospector(candidate),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const transaction = db as unknown as Transaction<DB>;
  const live = new Set<TrustedSessionContext>();
  let active: TrustedSessionContext | undefined;
  let withSessionCalls = 0;
  const runtime = new RecordAccessRuntime({
    acceptsSession: (candidate) => live.has(candidate),
    currentTransaction: (candidate) => candidate === active ? transaction : undefined,
    withSession: async (_candidate, work) => {
      withSessionCalls += 1;
      return work(transaction);
    },
  });
  return {
    db,
    services: runtime.services,
    live,
    queries,
    activate: (candidate: TrustedSessionContext | undefined) => {
      active = candidate;
    },
    withSessionCalls: () => withSessionCalls,
  };
}

describe("RecordAccessRuntime", () => {
  test("requires the exact live session and current canonical Entity role", async () => {
    const state = harness();
    const forged = { ...session };
    state.live.add(session);
    try {
      await state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "get",
      });
      await expectFailure(state.services.assertAccess(forged, {
        entityName: "Relation",
        id: recordId,
        intent: "get",
      }), "FORBIDDEN");
      await expectFailure(state.services.assertAccess({ ...session, roles: [] }, {
        entityName: "Relation",
        id: recordId,
        intent: "get",
      }), "FORBIDDEN");
      state.live.delete(session);
      await expectFailure(state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "get",
      }), "FORBIDDEN");
      expect(state.queries).toHaveLength(1);
    } finally {
      await state.db.destroy();
    }
  });

  test("uses the active Operation transaction and checks exact row visibility", async () => {
    const state = harness();
    state.live.add(session);
    state.activate(session);
    try {
      await state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "update",
      });
      expect(state.withSessionCalls()).toBe(0);
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0]!.sql).toContain('from "erp"."relations" as row_source');
      expect(state.queries[0]!.parameters).toEqual([recordId, tenantId]);
    } finally {
      await state.db.destroy();
    }
  });

  test("opens one core session transaction outside an Operation and denies an absent row", async () => {
    const state = harness(() => []);
    state.live.add(session);
    try {
      await expectFailure(state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "delete",
      }), "FORBIDDEN");
      expect(state.withSessionCalls()).toBe(1);
      expect(state.queries).toHaveLength(1);
    } finally {
      await state.db.destroy();
    }
  });

  test("denies unknown entities and entities without the requested canonical Operation", async () => {
    const state = harness();
    state.live.add(session);
    try {
      await expectFailure(state.services.assertAccess(session, {
        entityName: "UnknownEntity",
        id: recordId,
        intent: "get",
      }), "FORBIDDEN");
      await expectFailure(state.services.assertAccess(session, {
        entityName: "DocumentVersion",
        id: recordId,
        intent: "update",
      }), "FORBIDDEN");
      expect(state.queries).toHaveLength(0);
    } finally {
      await state.db.destroy();
    }
  });

  test("fails closed for plugin-backed CRUD until its full canonical auth is linkable", async () => {
    const operation = getEntityOperationContracts().find(
      (candidate) => candidate.entityName === "Relation" && candidate.intent === "update",
    )!;
    const previousImplementation = operation.implementation;
    operation.implementation = {
      type: "plugin",
      plugin: "example",
      handler: "updateRelation",
    };
    const state = harness();
    state.live.add(session);
    try {
      await expectFailure(state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "update",
      }), "FORBIDDEN");
      expect(state.queries).toHaveLength(0);
    } finally {
      if (previousImplementation) {
        operation.implementation = previousImplementation;
      } else {
        delete operation.implementation;
      }
      await state.db.destroy();
    }
  });

  test("evaluates every authored record permission in the same active transaction", async () => {
    const operation = getEntityOperationContracts().find(
      (candidate) => candidate.entityName === "Relation" && candidate.intent === "update",
    )!;
    const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
    const authorization = table.source!.authorization!;
    const previousTablePermissions = authorization.recordPermissions;
    const previousOperationPermissions = operation.authorization.recordPermissions;
    authorization.recordPermissions = {
      field: "authorization",
      column: "authorization",
      empty: "restricted",
      createRequires: ["view"],
    };
    operation.authorization.recordPermissions = ["view", "edit"];

    let permissionChecks = 0;
    const state = harness((query) => {
      if (query.sql.includes("app.record_permission_allows")) {
        permissionChecks += 1;
        return [{ allowed: permissionChecks === 1 }];
      }
      return [{ present: 1 }];
    });
    state.live.add(session);
    state.activate(session);
    try {
      await expectFailure(state.services.assertAccess(session, {
        entityName: "Relation",
        id: recordId,
        intent: "update",
      }), "FORBIDDEN");
      expect(permissionChecks).toBe(2);
      expect(state.withSessionCalls()).toBe(0);
    } finally {
      if (previousTablePermissions) {
        authorization.recordPermissions = previousTablePermissions;
      } else {
        delete authorization.recordPermissions;
      }
      if (previousOperationPermissions) {
        operation.authorization.recordPermissions = previousOperationPermissions;
      } else {
        delete operation.authorization.recordPermissions;
      }
      await state.db.destroy();
    }
  });

  test("rejects malformed requests before catalog or database access", async () => {
    const state = harness();
    state.live.add(session);
    try {
      await expectFailure(state.services.assertAccess(session, {
        entityName: " Relation",
        id: recordId,
        intent: "get",
      }), "VALIDATION");
      await expectFailure(state.services.assertAccess(session, {
        entityName: "Relation",
        id: "",
        intent: "get",
      }), "VALIDATION");
      expect(state.queries).toHaveLength(0);
    } finally {
      await state.db.destroy();
    }
  });
});
