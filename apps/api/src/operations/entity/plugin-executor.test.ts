// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { __setOperationExecutionReceiptExecutorForTests } from "../execution-receipts.js";
import { bindOperationHandlers, entityPluginOperationContract } from "../runtime.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { createEntityPluginExecutor } from "./plugin-executor.js";
import { entityRecordOfferBinding } from "./runtime.js";
import type { EntityOperationContract } from "./types.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const session = {
  tenantId,
  userId,
  roles: ["Relations.All.ReadWrite"],
  groups: [],
  relationGroupIds: [],
  scope: "tenant" as const,
  credential: "trusted-context" as const,
};

function database() {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function relationTable() {
  return getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "Relation")!;
}

function entityOperation(intent: "create" | "update" | "delete"): EntityOperationContract {
  const inputField = intent === "create" ? undefined : "relationId";
  return {
    id: `example.relations.${intent}`,
    key: intent,
    intent,
    entityId: "example-relation",
    entityName: "Relation",
    name: { en: `${intent} relation` },
    description: { en: `${intent} relation through its owning module` },
    implementation: { type: "plugin", plugin: "example", handler: `${intent}Relation` },
    target:
      intent === "create"
        ? { entityId: "example-relation", entityName: "Relation", scope: "collection" }
        : {
            entityId: "example-relation",
            entityName: "Relation",
            scope: "record",
            inputField: inputField!,
          },
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: {
          ...(inputField ? { [inputField]: { type: "string", format: "uuid" } } : {}),
          displayName: {
            type: "string",
            "x-osf-sourceField": "displayName",
            "x-osf-control": "artifact-upload",
          },
        },
      },
    },
    output: { kind: "json-schema", schema: {} },
    inputSchema: {
      type: "object",
      required: [...(inputField ? [inputField] : []), "displayName"],
      properties: {
        ...(inputField ? { [inputField]: { type: "string", format: "uuid" } } : {}),
        displayName: {
          type: "string",
          "x-osf-sourceField": "displayName",
          "x-osf-control": "artifact-upload",
        },
      },
      additionalProperties: false,
    },
    outputSchema: intent === "delete"
      ? {
          type: "object",
          required: ["deleted"],
          properties: { deleted: { type: "boolean" } },
          additionalProperties: false,
        }
      : {
          type: "object",
          required: ["id", "tenantId", "displayName", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            tenantId: { type: "string", format: "uuid" },
            displayName: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
    authorization: { action: intent, roles: ["Relations.All.ReadWrite"] },
    effects: { data: intent === "delete" ? "delete" : "write", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
    interaction: { confirmation: { mode: "none" } },
    interfaces: {
      rest: {
        method: intent === "create" ? "POST" : intent === "delete" ? "DELETE" : "PATCH",
        path: `/api/example/relations${intent === "create" ? "" : "/:relationId"}`,
        response: { status: intent === "create" ? 201 : 200, kind: "json" },
      },
    },
  };
}

function head(id = recordId) {
  return {
    id,
    tenant_id: tenantId,
    displayName: "Example relation",
    created_at: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:01:00.000Z",
    private_internal_value: "must not cross the entity boundary",
  };
}

describe("plugin-backed Entity Operation runtime", () => {
  test("adapts canonical CRUD intent, auth, schemas and interface metadata", () => {
    const operation = entityOperation("create");
    const adapted = entityPluginOperationContract(operation, relationTable());
    expect(adapted).toMatchObject({
      key: operation.id,
      intent: "create",
      plugin: "example",
      handler: "createRelation",
      auth: { mode: "session", roles: ["Relations.All.ReadWrite"] },
      tenancy: { mode: "required" },
      effects: { data: "write", external: "none" },
      transports: { rest: { method: "POST", response: { status: 201, kind: "json" } } },
    });
    expect(adapted.inputSchema.properties).toMatchObject({
      displayName: { "x-osf-sourceField": "displayName" },
    });

    const deletion = entityPluginOperationContract({
      ...entityOperation("delete"),
      authorization: {
        action: "delete",
        roles: ["Relations.All.Delete"],
        recordPermissions: ["delete"],
      },
    }, relationTable());
    expect(deletion).toMatchObject({
      intent: "delete",
      auth: {
        mode: "session",
        roles: ["Relations.All.Delete"],
        recordPermissions: ["delete"],
      },
      effects: { data: "delete", external: "none" },
      transports: { rest: { method: "DELETE", response: { status: 200, kind: "json" } } },
    });
  });

  test("binds plugin update offers to the authored target input", () => {
    expect(
      entityRecordOfferBinding(entityOperation("update"), {
        id: recordId,
        version: "2026-09-13T10:01:00.000Z",
      }),
    ).toEqual({
      binding: {
        target: {
          entityId: "example-relation",
          id: recordId,
          version: "2026-09-13T10:01:00.000Z",
        },
        input: { relationId: recordId },
      },
    });
    expect(
      entityRecordOfferBinding(entityOperation("delete"), {
        id: recordId,
        version: "2026-09-13T10:01:00.000Z",
      }),
    ).toEqual({
      binding: {
        target: {
          entityId: "example-relation",
          id: recordId,
          version: "2026-09-13T10:01:00.000Z",
        },
        input: { relationId: recordId },
      },
    });
    expect(entityRecordOfferBinding(entityOperation("create"), { id: recordId })).toEqual({});
  });

  test("returns a canonical delete result without requiring or fabricating a record head", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const operation = entityOperation("delete");
    const adapted = entityPluginOperationContract(operation, relationTable());
    const bindings = bindOperationHandlers(
      [{
        name: "example",
        operationHandlers: {
          deleteRelation: async (input) => {
            expect(input).toEqual({ relationId: recordId, displayName: "Unused" });
            return {
              status: 200,
              value: { deleted: true },
            };
          },
        },
      }],
      [adapted],
    );
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      await expect(execute(session, operation, {
        relationId: recordId,
        displayName: "Unused",
      })).resolves.toEqual({ deleted: true });
    } finally {
      await db.destroy();
    }
  });

  test("runs create in the live module transaction and returns only DB row fields", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const operation = entityOperation("create");
    const adapted = entityPluginOperationContract(operation, relationTable());
    let handlerSession: unknown;
    const module: RuntimeModule = {
      name: "example",
      operationHandlers: {
        createRelation: async (input, context) => {
          handlerSession = context.session;
          await context.platform!.db.withSession(context.session!, async () => undefined);
          return {
            status: 201,
            value: { ...head(), displayName: input.displayName },
            mcp: {
              content: [{ type: "text", text: "legacy handler projection" }],
              structuredContent: { ignored: true },
            },
          };
        },
      },
    };
    const bindings = bindOperationHandlers([module], [adapted]);
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      const row = await execute(session, operation, { displayName: "Created" });
      expect(handlerSession).not.toBe(session);
      expect(row).toMatchObject({
        id: recordId,
        tenant_id: tenantId,
        display_name: "Created",
        created_at: "2026-09-13T10:00:00.000Z",
        updated_at: "2026-09-13T10:01:00.000Z",
      });
      expect(row).not.toHaveProperty("private_internal_value");
      expect(row).not.toHaveProperty("displayName");
    } finally {
      await db.destroy();
    }
  });

  test("binds keyed receipts to the canonical create intent", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const base = entityOperation("create");
    const operation: EntityOperationContract = {
      ...base,
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      inputSchema: {
        ...base.inputSchema,
        required: ["displayName", "requestKey"],
        properties: {
          ...(base.inputSchema?.properties as Record<string, unknown>),
          requestKey: { type: "string", minLength: 1 },
        },
      },
    };
    const adapted = entityPluginOperationContract(operation, relationTable());
    const bindings = bindOperationHandlers(
      [
        {
          name: "example",
          operationHandlers: {
            createRelation: async () => ({ status: 201, value: head() }),
          },
        },
      ],
      [adapted],
    );
    let receiptIntent: string | undefined;
    __setOperationExecutionReceiptExecutorForTests(db, async (_active, options) => {
      receiptIntent = options.operation.intent;
      return options.execute(() => undefined);
    });
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      await expect(
        execute(session, operation, {
          displayName: "Created",
          requestKey: "create-one",
        }),
      ).resolves.toMatchObject({ id: recordId });
      expect(receiptIntent).toBe("create");
    } finally {
      __setOperationExecutionReceiptExecutorForTests(db, undefined);
      await db.destroy();
    }
  });

  test("binds keyed receipts and replay data to the canonical delete intent", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const base = entityOperation("delete");
    const operation: EntityOperationContract = {
      ...base,
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      inputSchema: {
        ...base.inputSchema,
        required: ["relationId", "displayName", "requestKey"],
        properties: {
          ...(base.inputSchema?.properties as Record<string, unknown>),
          requestKey: { type: "string", minLength: 1 },
        },
      },
    };
    const adapted = entityPluginOperationContract(operation, relationTable());
    const bindings = bindOperationHandlers(
      [{
        name: "example",
        operationHandlers: {
          deleteRelation: async () => ({ value: { deleted: true } }),
        },
      }],
      [adapted],
    );
    let receiptIntent: string | undefined;
    __setOperationExecutionReceiptExecutorForTests(db, async (_active, options) => {
      receiptIntent = options.operation.intent;
      expect(options.authorizeReplay).toBeUndefined();
      const executed = await options.execute(() => undefined);
      return options.decode(options.encode(executed));
    });
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      await expect(execute(session, operation, {
        relationId: recordId,
        displayName: "Unused",
        requestKey: "delete-one",
      })).resolves.toEqual({ deleted: true });
      expect(receiptIntent).toBe("delete");
    } finally {
      __setOperationExecutionReceiptExecutorForTests(db, undefined);
      await db.destroy();
    }
  });

  test("still checks record delete permission when a keyed receipt selects initial execution", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const table = relationTable();
    const authorization = table.source!.authorization!;
    const previousRecordPermissions = authorization.recordPermissions;
    authorization.recordPermissions = {
      field: "authorization",
      column: "authorization",
      empty: "restricted",
      createRequires: ["view"],
    };
    const base = entityOperation("delete");
    const operation: EntityOperationContract = {
      ...base,
      authorization: {
        action: "delete",
        roles: ["Relations.All.ReadWrite"],
        recordPermissions: ["delete"],
      },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      inputSchema: {
        ...base.inputSchema,
        required: ["relationId", "displayName", "requestKey"],
        properties: {
          ...(base.inputSchema?.properties as Record<string, unknown>),
          requestKey: { type: "string", minLength: 1 },
        },
      },
    };
    const adapted = entityPluginOperationContract(operation, table);
    let invoked = 0;
    const bindings = bindOperationHandlers(
      [{
        name: "example",
        operationHandlers: {
          deleteRelation: async () => {
            invoked += 1;
            return { value: { deleted: true } };
          },
        },
      }],
      [adapted],
    );
    __setOperationExecutionReceiptExecutorForTests(db, async (_active, options) => {
      expect(options.authorizeReplay).toBeUndefined();
      return options.execute(() => undefined);
    });
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      let error: unknown;
      try {
        await execute(session, operation, {
          relationId: recordId,
          displayName: "Unused",
          requestKey: "delete-missing-receipt",
        });
      } catch (cause) {
        error = cause;
      }
      expect(operationErrorOf(error)?.code).toBe("FORBIDDEN");
      expect(invoked).toBe(0);
    } finally {
      if (previousRecordPermissions) {
        authorization.recordPermissions = previousRecordPermissions;
      } else {
        delete authorization.recordPermissions;
      }
      __setOperationExecutionReceiptExecutorForTests(db, undefined);
      await db.destroy();
    }
  });

  test("refuses a forged DB session and a mismatched update result before returning", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const operation = entityOperation("update");
    const adapted = entityPluginOperationContract(operation, relationTable());
    let invoked = 0;
    const bindings = bindOperationHandlers(
      [
        {
          name: "example",
          operationHandlers: {
            updateRelation: async () => {
              invoked += 1;
              return { value: head("44444444-4444-4444-8444-444444444444") };
            },
          },
        },
      ],
      [adapted],
    );
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      let error: unknown;
      try {
        await execute({ ...session, credential: undefined } as never, operation, {
          relationId: recordId,
          displayName: "Changed",
        });
      } catch (cause) {
        error = cause;
      }
      expect(operationErrorOf(error)?.code).toBe("UNAUTHENTICATED");
      expect(invoked).toBe(0);
      error = undefined;
      try {
        await execute(session, operation, {
          relationId: recordId,
          displayName: "Changed",
        });
      } catch (cause) {
        error = cause;
      }
      expect(operationErrorOf(error)?.code).toBe("HANDLER_CONTRACT_VIOLATION");
      expect(invoked).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  test("preserves a declared handler refusal as a canonical Entity error", async () => {
    const db = database();
    const platform = new ModulePlatformRuntime(db);
    const operation: EntityOperationContract = {
      ...entityOperation("create"),
      errors: [
        {
          status: 409,
          code: "SOURCE_CONFLICT",
          description: "The source conflicts with current state.",
        },
      ],
    };
    const adapted = entityPluginOperationContract(operation, relationTable());
    const bindings = bindOperationHandlers(
      [
        {
          name: "example",
          operationHandlers: {
            createRelation: async () => ({
              ok: false,
              status: 409,
              code: "SOURCE_CONFLICT",
              body: {
                error: {
                  code: "SOURCE_CONFLICT",
                  message: "The source already exists.",
                },
              },
            }),
          },
        },
      ],
      [adapted],
    );
    const execute = createEntityPluginExecutor({
      bindings,
      runtime: { db, platform: platform.services },
    });
    try {
      let error: unknown;
      try {
        await execute(session, operation, { displayName: "Duplicate" });
      } catch (cause) {
        error = cause;
      }
      expect(operationErrorOf(error)).toMatchObject({
        code: "SOURCE_CONFLICT",
        message: "The source already exists.",
        retryable: false,
      });
    } finally {
      await db.destroy();
    }
  });

  test("fails boot binding when a canonical Entity handler is absent", () => {
    const adapted = entityPluginOperationContract(entityOperation("create"), relationTable());
    expect(() => bindOperationHandlers([{ name: "example" }], [adapted])).toThrow(/has no runtime handler/);
  });
});
