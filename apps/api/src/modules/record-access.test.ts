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
import { fieldNameForColumn } from "../operations/entity/columns.js";
import { RecordAccessRuntime } from "./record-access.js";
import { withAdmittedRecordAction } from "../operations/entity/record-action-admission.js";

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
  test("projects stored values through current classification without fetching or authorizing a row", async () => {
    const operation = getEntityOperationContracts().find(
      (candidate) => candidate.entityName === "Relation" && candidate.intent === "get",
    )!;
    const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
    const column = table.columns.find((candidate) => fieldNameForColumn(candidate) === "notes")!;
    const field = fieldNameForColumn(column);
    const previous = column.classification;
    column.classification = "confidential";
    const state = harness();
    const reader = { ...session, roles: ["Relations.All.Read"] };
    state.live.add(session);
    state.live.add(reader);
    try {
      expect(state.services.projectStoredFields(reader, { entityName: "Relation", fields: { [field]: "secret" } }))
        .toEqual({ [field]: null });
      expect(state.services.projectStoredFields(session, { entityName: "Relation", fields: { [field]: "secret" } }))
        .toEqual({ [field]: "secret" });
      expect(state.queries).toHaveLength(0);
      expect(() => state.services.projectStoredFields(reader, { entityName: "Relation", fields: { unknown: "secret" } }))
        .toThrow();
      expect(() => state.services.projectStoredFields({ ...reader }, { entityName: "Relation", fields: { [field]: "secret" } }))
        .toThrow();
    } finally {
      if (previous === undefined) delete column.classification;
      else column.classification = previous;
      await state.db.destroy();
    }
  });

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


test("batch access is bounded, deduplicated and indexable, and fails closed for a hidden identity", async () => {
  let visible = 2;
  const state = harness(() => [{ count: String(visible) }]);
  state.live.add(session);state.activate(session);
  const otherId = "44444444-4444-4444-8444-444444444444";
  try {
    await state.services.assertAccessMany(session, { entityName: "Relation", ids: [recordId, otherId, recordId], intent: "get" });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]!.sql).toContain('"row_source"."id" = $1::uuid');
    expect(state.queries[0]!.sql).not.toContain('"id"::text');
    expect(state.queries[0]!.parameters).toEqual([recordId, otherId, tenantId]);
    visible = 1;
    await expectFailure(state.services.assertAccessMany(session, { entityName: "Relation", ids: [recordId, otherId], intent: "get" }), "FORBIDDEN");
    await expectFailure(state.services.assertAccessMany({ ...session }, { entityName: "Relation", ids: [recordId], intent: "get" }), "FORBIDDEN");
    const unprivileged = { ...session, roles: [] };state.live.add(unprivileged);
    await expectFailure(state.services.assertAccessMany(unprivileged, { entityName: "Relation", ids: [recordId], intent: "get" }), "FORBIDDEN");
    await expectFailure(state.services.assertAccessMany(session, { entityName: "Relation", ids: [""], intent: "get" }), "VALIDATION");
    expect(state.withSessionCalls()).toBe(0);
  } finally { await state.db.destroy(); }
});

test("batch access enforces every record permission instead of substituting visibility", async () => {
  const operation = getEntityOperationContracts().find(item => item.entityName === "Relation" && item.intent === "get")!;
  const table = tableForEntityOperation({id: operation.id, intent: operation.intent});
  const previous = operation.authorization.recordPermissions;
  const oldPolicy = table.source!.authorization!.recordPermissions;
  operation.authorization.recordPermissions = ["view"];
  table.source!.authorization!.recordPermissions = {field:"authorization",column:"authorization",empty:"restricted",createRequires:["view"]};
  const state = harness(() => [{count: "1"}]);state.live.add(session);
  try {
    await expectFailure(state.services.assertAccessMany(session,{entityName:"Relation",ids:[recordId,"44444444-4444-4444-8444-444444444444"],intent:"get"}),"FORBIDDEN");
    expect(state.queries).toHaveLength(1);expect(state.queries[0]!.sql).toContain("app.record_permission_allows");expect(state.withSessionCalls()).toBe(1);
  } finally {
    if(previous)operation.authorization.recordPermissions=previous;else delete operation.authorization.recordPermissions;
    if(oldPolicy)table.source!.authorization!.recordPermissions=oldPolicy;else delete table.source!.authorization!.recordPermissions;
    await state.db.destroy();
  }
});

test("a large permission batch uses bounded statements and requires every row", async () => {
  const operation = getEntityOperationContracts().find(item => item.entityName === "Relation" && item.intent === "get")!;
  const table = tableForEntityOperation({ id: operation.id, intent: operation.intent });
  const previous = operation.authorization.recordPermissions, oldPolicy = table.source!.authorization!.recordPermissions;
  operation.authorization.recordPermissions = ["view", "edit"];
  table.source!.authorization!.recordPermissions = { field: "authorization", column: "authorization", empty: "restricted", createRequires: ["view"] };
  const state = harness(query => [{ count: String(query.parameters.filter(value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) && value !== tenantId).length) }]);
  state.live.add(session);
  const ids = Array.from({ length: 1001 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
  try {
    await state.services.assertAccessMany(session, { entityName: "Relation", ids, intent: "get" });
    expect(state.queries).toHaveLength(3);
    for (const query of state.queries) expect(query.sql.match(/app\.record_permission_allows/g)).toHaveLength(2);
  } finally {
    if (previous) operation.authorization.recordPermissions = previous; else delete operation.authorization.recordPermissions;
    if (oldPolicy) table.source!.authorization!.recordPermissions = oldPolicy; else delete table.source!.authorization!.recordPermissions;
    await state.db.destroy();
  }
});

/**
 * The bounded read is bound to the Operation's own target.
 *
 * `Notebook.deliver` is the shipped use: `auth.recordAction: deliver` on
 * `target.inputField: notebookId`, so the dispatcher admits exactly one
 * notebook and the handler reads exactly that one. These cases are about the
 * bound alone — the row answer is stubbed, so a refusal here is this service's
 * and not the database's.
 */
describe("readForAction is bound to the admitted Operation target", () => {
  const notebook = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherNotebook = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const request = (id: string, action = "deliver") =>
    ({ entityName: "Notebook", id, action } as const);

  function admitted(live: TrustedSessionContext, id: string, actions: string[]) {
    return { session: live, entityName: "Notebook", id, actions: new Set(actions) };
  }

  test("serves the admitted record and refuses every other record, action and session", async () => {
    // Two stubbed answers, because the bounded read asks two questions: is the
    // credential behind this session still live, and then what does the action
    // disclose. Only the second is what this group is about, so the fence is
    // answered true here and proven against real key rows in
    // db/__tests__/record-action-credential-fence-db.test.ts.
    const state = harness((query) =>
      query.sql.includes("record_action_principal_live")
        ? [{ live: true }]
        : [{ payload: { name: "Granted notes" } }]);
    const live = { ...session, credential: "api-key" as const, principalKind: "service" as const,
      appPrincipal: {
        integrationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        credentialId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      } };
    state.live.add(live);
    try {
      await withAdmittedRecordAction(admitted(live, notebook, ["deliver"]), async () => {
        expect(await state.services.readForAction(live, request(notebook)))
          .toEqual({ name: "Granted notes" });
        // Another record the same grant may well reach, the same record under
        // an action this invocation was not authorized on, and a session
        // object that is not the admitted one.
        await expectFailure(state.services.readForAction(live, request(otherNotebook)), "FORBIDDEN");
        await expectFailure(state.services.readForAction(live, request(notebook, "follow")), "FORBIDDEN");
        const twin = { ...live };
        state.live.add(twin);
        await expectFailure(state.services.readForAction(twin, request(notebook)), "FORBIDDEN");
      });
      // Outside the Operation that authorized it there is no target at all.
      await expectFailure(state.services.readForAction(live, request(notebook)), "FORBIDDEN");
      // An inner dispatch that admits nothing clears the outer admission.
      await withAdmittedRecordAction(admitted(live, notebook, ["deliver"]), () =>
        withAdmittedRecordAction(null, () =>
          expectFailure(state.services.readForAction(live, request(notebook)), "FORBIDDEN")));
    } finally { await state.db.destroy(); }
  });

  test("validates the request before the admission, and reads no row for either refusal", async () => {
    const state = harness(() => [{ payload: { name: "Granted notes" } }]);
    const live = { ...session };
    state.live.add(live);
    try {
      // An admission naming an unusable request cannot make it usable: a
      // malformed record key is a VALIDATION refusal, and a record permission
      // dressed up as an action name is refused by the entity's declarations.
      await withAdmittedRecordAction(admitted(live, "", ["deliver"]), () =>
        expectFailure(state.services.readForAction(live, request("")), "VALIDATION"));
      await withAdmittedRecordAction(admitted(live, notebook, ["view"]), () =>
        expectFailure(state.services.readForAction(live, request(notebook, "view")), "FORBIDDEN"));
      // Neither refusal opened a transaction or looked at a row.
      expect(state.queries).toEqual([]);
      expect(state.withSessionCalls()).toBe(0);
    } finally { await state.db.destroy(); }
  });
});
