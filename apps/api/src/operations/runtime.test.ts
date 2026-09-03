// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type {
  McpInvocationContext,
  ModuleInvocationSource,
  RuntimeModule,
} from "../modules/contract.js";
import {
  createModuleSessionCapability,
  ModulePlatformRuntime,
  type ModuleMcpServerBinding,
} from "../modules/platform.js";
import { bindOperationHandlers, invokeOperation, operationRestInput, requireOperationAuthorization, type OperationContract } from "./runtime.js";

const session = {
  tenantId: "tenant-a",
  userId: "user-a",
  roles: ["workflow-admin"],
  groups: [],
  scope: "tenant" as const,
  credential: "trusted-context" as const,
};

const testDatabase = () => new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe("canonical operation runtime", () => {
  test("fails closed when the compiler contract has no runtime handler", () => {
    expect(() => bindOperationHandlers([])).toThrow(/has no loaded runtime module/);
    expect(() => bindOperationHandlers([{ name: "workflow" }])).toThrow(/has no runtime handler/);
  });

  test("validates input and handler output against the generated contract", async () => {
    const module: RuntimeModule = {
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input) => ({
          value: { status: "accepted", instanceId: "11111111-1111-4111-8111-111111111111", definitionId: input.definitionId },
        }),
      },
    };
    const bound = bindOperationHandlers([module]).get("workflow.instance.webhook-start")!;
    await expect(invokeOperation(bound, {}, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
    await expect(invokeOperation(bound, {
      definitionId: "not-a-uuid",
      idempotencyKey: "webhook-invalid",
    }, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
    const result = await invokeOperation(bound, {
      definitionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "webhook-1",
    }, { transport: "graphql", session });
    expect(result.value).toMatchObject({ status: "accepted" });
  });

  test("activates the handler session for platform database work", async () => {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    let retainedSession: TrustedSessionContext | undefined;
    const module: RuntimeModule = {
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input, context) => {
          if (!context.session || !context.platform) {
            throw new Error("Expected an authenticated database operation.");
          }
          retainedSession = context.session;
          await context.platform.db.withSession(
            context.session,
            async () => undefined,
          );
          expect(() => context.platform!.db.withSession(
            { ...context.session!, roles: [...context.session!.roles] },
            async () => undefined,
          )).toThrow(/live verified session/);
          return {
            value: {
              status: "accepted",
              instanceId: "11111111-1111-4111-8111-111111111111",
              definitionId: input.definitionId,
            },
          };
        },
      },
    };
    const bound = bindOperationHandlers([module]).get("workflow.instance.webhook-start")!;
    const verified = {
      ...session,
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
    };
    try {
      await expect(invokeOperation(bound, {
        definitionId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "database-session",
      }, {
        db,
        platform: platform.services,
        transport: "rest",
        session: verified,
      })).resolves.toMatchObject({ value: { status: "accepted" } });
      expect(retainedSession).not.toBe(verified);
      expect(() => platform.services.db.withSession(
        retainedSession!,
        async () => undefined,
      )).toThrow(/live verified session/);
    } finally {
      await db.destroy();
    }
  });

  test("preserves the live MCP binding throughout a canonical operation", async () => {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    const liveSession = createModuleSessionCapability({
      ...session,
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
    });
    const server = {} as Server;
    const source: ModuleInvocationSource = {
      sourceHandle: "source-handle",
      sourceReference: "source-reference",
      scope: "tenant",
      binding: 1,
      definition: { kind: "http", id: "definition-id", version: 1 },
    };
    const registered: ModuleMcpServerBinding = {
      server,
      session: liveSession,
      liveNotifications: false,
      notifyToolsChanged: async () => undefined,
      notifyResourcesChanged: async () => undefined,
      authorize: async (action, subject) =>
        action === "call" &&
        subject.kind === "tool" &&
        subject.name === "known_tool"
          ? { allowed: true }
          : { allowed: false, code: "NOT_FOUND" },
      resolveInvocationSources: async () => [source],
      callTool: async () => ({ result: { content: [] } }),
    };
    platform.registerServer(registered);
    const invocation = Object.freeze({
      db,
      session: liveSession,
      server,
      requestId: "operation-request",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    const bound = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input, context) => {
          expect(context.session).toBe(liveSession);
          expect(await context.platform!.mcp.authorize(context.session!, {
            action: "call",
            subject: { kind: "tool", name: "known_tool" },
          })).toEqual({ allowed: true });
          expect(await context.platform!.mcp.resolveInvocationSources(
            context.session!,
            "known_tool",
            { mode: "default" },
          )).toEqual([source]);
          await expect(context.platform!.db.withSession(
            context.session!,
            async () => "accepted",
          )).resolves.toBe("accepted");
          return {
            value: {
              status: "accepted",
              instanceId: "11111111-1111-4111-8111-111111111111",
              definitionId: input.definitionId,
            },
          };
        },
      },
    }]).get("workflow.instance.webhook-start")!;
    try {
      const result = await platform.withActiveInvocation(invocation, () =>
        invokeOperation(bound, {
          definitionId: "44444444-4444-4444-8444-444444444444",
          idempotencyKey: "mcp-binding",
        }, {
          db,
          platform: platform.services,
          transport: "mcp",
          session: liveSession,
        }),
      );
      expect(result).toMatchObject({ value: { status: "accepted" } });
      await expect(platform.services.mcp.authorize(liveSession, {
        action: "call",
        subject: { kind: "tool", name: "known_tool" },
      })).resolves.toEqual({ allowed: true });
      await expect(platform.services.mcp.authorize(
        { ...liveSession, roles: [...liveSession.roles] },
        { action: "call", subject: { kind: "tool", name: "known_tool" } },
      )).resolves.toEqual({ allowed: false, code: "NOT_FOUND" });
    } finally {
      platform.unregisterServer(server);
      await db.destroy();
    }
  });

  test("rejects a platform-shaped object that core does not own", async () => {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    let invoked = false;
    const bound = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async () => {
          invoked = true;
          return { value: {} };
        },
      },
    }]).get("workflow.instance.webhook-start")!;
    try {
      await expect(invokeOperation(bound, {
        definitionId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "fabricated-platform",
      }, {
        db,
        platform: { ...platform.services },
        transport: "rest",
        session,
      })).rejects.toThrow(/not core-owned/);
      expect(invoked).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  test("does not let nested dispatch omit the platform to widen authority", async () => {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    let nestedInvoked = false;
    const nestedBase = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async () => {
          nestedInvoked = true;
          return { value: {} };
        },
      },
    }]).get("workflow.instance.webhook-start")!;
    const nested = {
      ...nestedBase,
      operation: {
        ...nestedBase.operation,
        auth: { mode: "session" as const, roles: ["elevated"] },
      },
    };
    const outer = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input) => {
          await expect(invokeOperation(nested, input, {
            transport: "graphql",
            session: { ...session, roles: [...session.roles, "elevated"] },
          })).rejects.toThrow(/required operation role/);
          return {
            value: {
              status: "accepted",
              instanceId: "11111111-1111-4111-8111-111111111111",
              definitionId: input.definitionId,
            },
          };
        },
      },
    }]).get("workflow.instance.webhook-start")!;
    try {
      await expect(invokeOperation(outer, {
        definitionId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "nested-authority",
      }, {
        db,
        platform: platform.services,
        transport: "rest",
        session,
      })).resolves.toMatchObject({ value: { status: "accepted" } });
      expect(nestedInvoked).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  test("enforces declared OAuth scopes on every projected transport", async () => {
    const operation = {
      ...bindOperationHandlers([{
        name: "workflow",
        operationHandlers: { startWebhook: async () => ({ value: {} }) },
      }]).get("workflow.instance.webhook-start")!.operation,
      auth: { mode: "session" as const, roles: ["workflow-admin"], scopes: ["workflow:write"] },
    };
    expect(() => requireOperationAuthorization(operation, session)).toThrow(/OAuth scope/);
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      oauthScopes: ["workflow:write"],
    })).not.toThrow();
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      credential: "api-key",
      oauthScopes: ["workflow:write"],
    })).toThrow(/cannot be invoked with an API key/);
  });

  test("rejects a success status that differs from the canonical contract", async () => {
    const bound = bindOperationHandlers([{
      name: "workflow",
      operationHandlers: {
        startWebhook: async (input) => ({
          status: 201,
          value: { status: "accepted", instanceId: "11111111-1111-4111-8111-111111111111", definitionId: input.definitionId },
        }),
      },
    }]).get("workflow.instance.webhook-start")!;
    await expect(invokeOperation(bound, {
      definitionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "webhook-2",
    }, { transport: "rest", session })).rejects.toMatchObject({ status: 500 });
  });

  test("does not advertise an uncontracted runtime handler", () => {
    expect(() => bindOperationHandlers([{
      name: "workflow",
      operationHandlers: { startWebhook: () => ({ value: {} }), hidden: () => ({ value: {} }) },
    }])).toThrow(/absent from its compiler contract: hidden/);
  });

  test("caches one immutable handler binding per initialized module set", () => {
    const modules: RuntimeModule[] = [{
      name: "workflow",
      operationHandlers: { startWebhook: async () => ({ value: {} }) },
    }];
    expect(bindOperationHandlers(modules)).toBe(bindOperationHandlers(modules));
  });
});

test("REST maps a required idempotency header into canonical input only", () => {
  const operation = {
    inputSchema: {
      type: "object",
      required: ["quoteId", "idempotencyKey"],
      properties: { quoteId: { type: "string" }, idempotencyKey: { type: "string" } },
      additionalProperties: false,
    },
    idempotency: {
      mode: "idempotency-key",
      header: "Idempotency-Key",
      inputField: "idempotencyKey",
    },
    transports: { rest: { method: "POST", path: "/api/demo/quotes/:quoteId" } },
  } as unknown as OperationContract;
  const request = {
    body: {},
    query: {},
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-1" },
  } as never;
  expect(operationRestInput(request, operation)).toEqual({ quoteId: "quote-1", idempotencyKey: "replay-1" });
  const bodyRequest = {
    body: { idempotencyKey: "body-value" },
    query: {},
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-1" },
  } as never;
  expect(() => operationRestInput(bodyRequest, operation))
    .toThrow(/must only be supplied through/);
  const emptyBodyRequest = {
    body: new Uint8Array(),
    query: { utm_source: "sender" },
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-2" },
  } as never;
  expect(operationRestInput(emptyBodyRequest, operation)).toEqual({ quoteId: "quote-1", idempotencyKey: "replay-2" });
  const collidingQueryRequest = {
    body: {},
    query: { idempotencyKey: "query-value" },
    params: { quoteId: "quote-1" },
    headers: { "idempotency-key": "replay-3" },
  } as never;
  expect(() => operationRestInput(collidingQueryRequest, operation)).toThrow(/query parameters/);
});

test("REST coerces typed GET and DELETE query values before canonical validation", () => {
  const operation = {
    key: "demo.quote.list",
    inputSchema: {
      type: "object",
      required: ["limit", "enabled"],
      properties: { limit: { type: "integer" }, enabled: { type: "boolean" } },
      additionalProperties: false,
    },
    idempotency: { mode: "none" },
    transports: { rest: { method: "GET", path: "/api/demo/quotes" } },
  } as unknown as OperationContract;
  const request = {
    body: undefined,
    query: { limit: "5", enabled: "true" },
    params: {},
    headers: {},
  } as never;
  expect(operationRestInput(request, operation)).toEqual({ limit: 5, enabled: true });
});
