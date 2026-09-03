// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import Fastify from "fastify";
import { GraphQLError } from "graphql";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { __resetSessionResolverForTests } from "../auth/identity.js";
import type {
  McpInvocationContext,
  ModuleInvocationSource,
  ModuleOperationResult,
  RuntimeModule,
} from "../modules/contract.js";
import { __buildGeneratedMcpServerForTests } from "../mcp/generated-mcp-server.js";
import {
  createModuleSessionCapability,
  ModulePlatformRuntime,
  type ModuleMcpServerBinding,
} from "../modules/platform.js";
import { HttpError } from "../rest/http-error.js";
import {
  bindOperationHandlers,
  DeclaredOperationError,
  invokeOperation,
  operationGraphqlContribution,
  operationRestInput,
  registerOperationRestRoutes,
  requireOperationAuthorization,
  type OperationContract,
} from "./runtime.js";

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

const restOperation: OperationContract = {
  key: "demo.quote.publish",
  plugin: "demo",
  title: "Publish quote",
  description: "Publishes a quote.",
  handler: "publishQuote",
  inputSchema: {
    type: "object",
    required: ["quoteId", "idempotencyKey"],
    properties: {
      quoteId: { type: "string" },
      idempotencyKey: { type: "string" },
      outcome: { type: "string", enum: ["ok", "conflict"] },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["quoteId", "idempotencyKey", "tenantId", "userId"],
    properties: {
      quoteId: { type: "string" },
      idempotencyKey: { type: "string" },
      tenantId: { type: "string" },
      userId: { type: "string" },
    },
    additionalProperties: false,
  },
  errors: [{ status: 409, code: "CONFLICT", description: "Quote conflicts." }],
  auth: { mode: "session", roles: ["quote-publisher"] },
  tenancy: { mode: "required" },
  idempotency: {
    mode: "idempotency-key",
    header: "Idempotency-Key",
    inputField: "idempotencyKey",
  },
  transports: {
    rest: {
      method: "POST",
      path: "/api/demo/quotes/:quoteId/publish",
      response: { status: 202, kind: "json" },
    },
    mcp: { enabled: false, reason: "REST transport test." },
    graphql: { enabled: false, reason: "REST transport test." },
    typescript: { enabled: false, reason: "REST transport test." },
  },
};

const declaredErrorOperation: OperationContract = {
  key: "demo.order.submit",
  plugin: "demo",
  title: "Submit order",
  description: "Submits an order.",
  handler: "submitOrder",
  inputSchema: {
    type: "object",
    required: [],
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["accepted"],
    properties: { accepted: { const: true } },
    additionalProperties: false,
  },
  errors: [{
    status: 409,
    code: "CONFLICT",
    description: "Order conflicts.",
    schema: {
      type: "object",
      required: ["error", "requestId", "details"],
      properties: {
        error: { const: "conflict" },
        requestId: { type: "string" },
        details: { type: "object" },
      },
      additionalProperties: false,
    },
    rest: { contentType: "application/problem+json" },
  }],
  auth: { mode: "public" },
  tenancy: { mode: "none" },
  idempotency: { mode: "none" },
  transports: {
    rest: {
      method: "POST",
      path: "/api/demo/orders/submit",
      response: { status: 200, kind: "json" },
    },
    mcp: { enabled: false, reason: "Transport-specific fixture." },
    graphql: { enabled: false, reason: "Transport-specific fixture." },
    typescript: { enabled: false, reason: "Transport-specific fixture." },
  },
};

const declaredConflict = {
  ok: false as const,
  status: 409,
  code: "CONFLICT",
  body: {
    error: "conflict",
    requestId: "request-1",
    details: { currentVersion: 3 },
  },
};

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

  test("accepts only schema-valid errors declared by status and code", async () => {
    const invoke = (result: ModuleOperationResult) => {
      const bound = bindOperationHandlers([{
        name: "demo",
        operationHandlers: { submitOrder: () => result },
      }], [declaredErrorOperation]).get(declaredErrorOperation.key)!;
      return invokeOperation(bound, {}, { transport: "rest" });
    };

    await expect(invoke(declaredConflict)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      body: declaredConflict.body,
    });
    await expect(invoke({ ...declaredConflict, status: 422 })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
    await expect(invoke({ ...declaredConflict, code: "OTHER_CONFLICT" })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
    await expect(invoke({
      ...declaredConflict,
      ok: "false",
    } as unknown as ModuleOperationResult)).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
    await expect(invoke({ ...declaredConflict, body: { error: "conflict" } })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
    await expect(invoke({ ...declaredConflict, contentType: "application/json" })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
    const cyclic = { ...declaredConflict.body, details: {} as Record<string, unknown> };
    cyclic.details.self = cyclic;
    await expect(invoke({ ...declaredConflict, body: cyclic })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });

    const inner = bindOperationHandlers([{
      name: "demo",
      operationHandlers: { submitOrder: () => declaredConflict },
    }], [declaredErrorOperation]).get(declaredErrorOperation.key)!;
    const outer = bindOperationHandlers([{
      name: "demo",
      operationHandlers: {
        submitOrder: async () => invokeOperation(inner, {}, { transport: "rest" }),
      },
    }], [declaredErrorOperation]).get(declaredErrorOperation.key)!;
    await expect(invokeOperation(outer, {}, { transport: "rest" })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
  });

  test("selects the matching schema when error codes share an HTTP status", async () => {
    const alternateBody = {
      error: "locked",
      retryAfterSeconds: 30,
    };
    const operation: OperationContract = {
      ...declaredErrorOperation,
      errors: [
        ...declaredErrorOperation.errors,
        {
          status: 409,
          code: "LOCKED",
          description: "Order submission is locked.",
          schema: {
            type: "object",
            required: ["error", "retryAfterSeconds"],
            properties: {
              error: { const: "locked" },
              retryAfterSeconds: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      ],
    };
    const invoke = (result: ModuleOperationResult) => {
      const bound = bindOperationHandlers([{
        name: "demo",
        operationHandlers: { submitOrder: () => result },
      }], [operation]).get(operation.key)!;
      return invokeOperation(bound, {}, { transport: "rest" });
    };

    await expect(invoke(declaredConflict)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      body: declaredConflict.body,
    });
    await expect(invoke({
      ok: false,
      status: 409,
      code: "LOCKED",
      body: alternateBody,
    })).rejects.toMatchObject({
      status: 409,
      code: "LOCKED",
      body: alternateBody,
    });
    await expect(invoke({
      ok: false,
      status: 409,
      code: "LOCKED",
      body: declaredConflict.body,
    })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
  });

  test("requires the standard matching-code envelope when an error schema is omitted", async () => {
    const operation: OperationContract = {
      ...declaredErrorOperation,
      errors: [{ status: 409, code: "CONFLICT", description: "Order conflicts." }],
    };
    const invoke = (body: unknown) => {
      const bound = bindOperationHandlers([{
        name: "demo",
        operationHandlers: {
          submitOrder: () => ({ ok: false, status: 409, code: "CONFLICT", body }),
        },
      }], [operation]).get(operation.key)!;
      return invokeOperation(bound, {}, { transport: "rest" });
    };
    await expect(invoke({ error: { code: "CONFLICT", message: "Order conflicts." } }))
      .rejects.toBeInstanceOf(DeclaredOperationError);
    await expect(invoke({ error: { code: "OTHER", message: "Order conflicts." } }))
      .rejects.toMatchObject({ status: 500, code: "HANDLER_CONTRACT_VIOLATION" });
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

test("the canonical REST route preserves authorization, tenancy, idempotency, input, output, and errors", async () => {
  const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  const previousJwks = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  const previousIssuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  const secret = "operation-rest-test-context-secret";
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  __resetSessionResolverForTests();
  const observations: unknown[] = [];
  const module: RuntimeModule = {
    name: "demo",
    operationHandlers: {
      publishQuote: async (input, context) => {
        observations.push({ input, session: context.session, transport: context.transport });
        if (input.outcome === "conflict") {
          throw new HttpError(409, "CONFLICT", "Quote conflicts.");
        }
        return {
          status: 202,
          headers: { "x-operation-handler": "publishQuote" },
          value: {
            quoteId: input.quoteId,
            idempotencyKey: input.idempotencyKey,
            tenantId: context.session!.tenantId,
            userId: context.session!.userId,
          },
        };
      },
    },
  };
  const app = Fastify();
  registerOperationRestRoutes(app, [module], {}, [restOperation]);
  const paths = ["/api/demo/quotes/quote-1/publish"];
  try {
    for (const path of paths) {
      expect((await app.inject({ method: "POST", url: path, payload: {} })).statusCode)
        .toBe(401);
    }
    const undeclaredUnavailable = await app.inject({
      method: "POST",
      url: paths[0]!,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(undeclaredUnavailable.statusCode).toBe(401);
    expect(undeclaredUnavailable.json() as unknown).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Operation requires an authenticated bearer session.",
      },
    });

    const wrongRole = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(wrongRole, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["reader"],
      groups: [],
    }, { secret });
    for (const path of paths) {
      expect((await app.inject({
        method: "POST",
        url: path,
        headers: Object.fromEntries(wrongRole),
        payload: {},
      })).statusCode).toBe(403);
    }

    const authorized = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(authorized, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["quote-publisher"],
      groups: ["/sales"],
    }, { secret });
    const successfulBodies: unknown[] = [];
    for (const path of paths) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: {
          ...Object.fromEntries(authorized),
          "idempotency-key": "request-1",
        },
        payload: { outcome: "ok" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.headers["x-operation-handler"]).toBe("publishQuote");
      successfulBodies.push(response.json());
    }
    expect(successfulBodies).toHaveLength(1);
    expect(observations).toHaveLength(1);

    for (const path of paths) {
      const conflict = await app.inject({
        method: "POST",
        url: path,
        headers: {
          ...Object.fromEntries(authorized),
          "idempotency-key": "request-2",
        },
        payload: { outcome: "conflict" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json() as unknown).toEqual({
        error: { code: "CONFLICT", message: "Quote conflicts." },
      });
    }

    for (const path of paths) {
      const duplicated = await app.inject({
        method: "POST",
        url: path,
        headers: {
          ...Object.fromEntries(authorized),
          "idempotency-key": "request-3",
        },
        payload: { idempotencyKey: "body-value" },
      });
      expect(duplicated.statusCode).toBe(400);
    }
  } finally {
    await app.close();
    if (previousSecret === undefined) {
      delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    } else {
      process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousSecret;
    }
    if (previousJwks === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = previousJwks;
    if (previousIssuer === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = previousIssuer;
    __resetSessionResolverForTests();
  }
});

test("REST sends a declared handler error body and metadata unchanged", async () => {
  const app = Fastify();
  registerOperationRestRoutes(app, [{
    name: "demo",
    operationHandlers: {
      submitOrder: () => ({
        ...declaredConflict,
        headers: { "x-error-source": "operation" },
        contentType: "application/problem+json",
      }),
    },
  }], {}, [declaredErrorOperation]);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/demo/orders/submit",
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers["x-error-source"]).toBe("operation");
    expect(response.headers["content-type"]).toBe("application/problem+json");
    expect(JSON.parse(response.body)).toEqual(declaredConflict.body);
  } finally {
    await app.close();
  }
});

test("REST JSON-encodes scalar declared errors under the default advertised media type", async () => {
  const operation: OperationContract = {
    ...declaredErrorOperation,
    errors: [{
      status: 409,
      code: "CONFLICT",
      description: "Order conflicts.",
      schema: { type: "string" },
    }],
  };
  const app = Fastify();
  registerOperationRestRoutes(app, [{
    name: "demo",
    operationHandlers: {
      submitOrder: () => ({
        ok: false,
        status: 409,
        code: "CONFLICT",
        body: "Order conflicts.",
      }),
    },
  }], {}, [operation]);
  try {
    const response = await app.inject({
      method: "POST",
      url: operation.transports.rest.path,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toBe('"Order conflicts."');
  } finally {
    await app.close();
  }
});

test("REST applies the exact status-and-code fixed representation to core authorization errors", async () => {
  const errorSchema = (value: string) => ({
    type: "object",
    required: ["error"],
    properties: { error: { const: value } },
    additionalProperties: false,
  });
  const operation: OperationContract = {
    ...declaredErrorOperation,
    auth: { mode: "session", roles: ["seller"] },
    tenancy: { mode: "required" },
    errors: [
      {
        status: 401,
        code: "UNAUTHENTICATED",
        description: "Authentication is required.",
        schema: errorSchema("unauthorized"),
        rest: { body: { error: "unauthorized" } },
      },
      {
        status: 403,
        code: "FORBIDDEN",
        description: "The required role is missing.",
        schema: errorSchema("forbidden"),
        rest: { body: { error: "forbidden" } },
      },
      {
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        description: "The service is unavailable.",
        schema: errorSchema("service_unavailable"),
        rest: { body: { error: "service_unavailable" } },
      },
      {
        status: 503,
        code: "AUTHENTICATION_UNAVAILABLE",
        description: "Authentication is unavailable.",
        schema: errorSchema("authentication_unavailable"),
        rest: { body: { error: "authentication_unavailable" } },
      },
    ],
  };
  const previous = {
    secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
    jwks: process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI,
    issuer: process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER,
  };
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "declared-auth-error-test-secret";
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  __resetSessionResolverForTests();
  let throwFromHandler = false;
  const app = Fastify();
  registerOperationRestRoutes(app, [{
    name: "demo",
    operationHandlers: {
      submitOrder: () => {
        if (throwFromHandler) throw new HttpError(403, "FORBIDDEN", "Handler failure.");
        return { value: { accepted: true } };
      },
    },
  }], {}, [operation]);
  try {
    const unauthenticated = await app.inject({
      method: "POST",
      url: operation.transports.rest.path,
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(unauthenticated.body)).toEqual({ error: "unauthorized" });

    const wrongRole = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(wrongRole, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["reader"],
      groups: [],
    }, { secret: "declared-auth-error-test-secret" });
    const forbidden = await app.inject({
      method: "POST",
      url: operation.transports.rest.path,
      headers: Object.fromEntries(wrongRole),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(JSON.parse(forbidden.body)).toEqual({ error: "forbidden" });

    const unavailable = await app.inject({
      method: "POST",
      url: operation.transports.rest.path,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body)).toEqual({ error: "authentication_unavailable" });

    const authorized = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(authorized, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["seller"],
      groups: [],
    }, { secret: "declared-auth-error-test-secret" });
    throwFromHandler = true;
    const handlerFailure = await app.inject({
      method: "POST",
      url: operation.transports.rest.path,
      headers: Object.fromEntries(authorized),
      payload: {},
    });
    expect(handlerFailure.statusCode).toBe(403);
    expect(JSON.parse(handlerFailure.body)).toEqual({
      error: { code: "FORBIDDEN", message: "Handler failure." },
    });
  } finally {
    await app.close();
    if (previous.secret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previous.secret;
    if (previous.jwks === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = previous.jwks;
    if (previous.issuer === undefined) delete process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
    else process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = previous.issuer;
    __resetSessionResolverForTests();
  }
});

test("GraphQL and MCP project declared handler results as transport errors", async () => {
  const body = {
    error: { code: "CONFLICT", message: "The operation conflicts." },
  };
  const module: RuntimeModule = {
    name: "workflow",
    operationHandlers: {
      startWebhook: () => ({
        ok: false,
        status: 409,
        code: "CONFLICT",
        body,
      }),
    },
  };
  const input = {
    definitionId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "declared-error",
  };

  const contribution = operationGraphqlContribution([module], {})?.graphql?.({});
  const resolver = contribution?.resolvers?.Mutation?.workflowStartWebhook as
    | ((_parent: unknown, args: { input: unknown }, context: { session: TrustedSessionContext }) => Promise<unknown>)
    | undefined;
  expect(resolver).toBeDefined();
  let graphqlError: unknown;
  try {
    await resolver!(undefined, { input }, { session });
  } catch (error) {
    graphqlError = error;
  }
  expect(graphqlError).toBeInstanceOf(GraphQLError);
  expect(graphqlError).toMatchObject({
    extensions: { code: "CONFLICT", status: 409, body },
  });

  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session,
    modules: [module],
    modulePlatform: platform,
  });
  const client = new Client(
    { name: "declared-operation-error-test", version: "1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "workflow_start_webhook",
      arguments: input,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(body);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: "text",
      text: "CONFLICT: The operation conflicts.",
    }));
  } finally {
    await client.close();
    await server.close();
    await db.destroy();
  }
});

test("binary and stream responses pass through canonical REST routes without buffering changes", async () => {
  const base = (input: {
    key: string;
    handler: string;
    path: string;
    kind: "binary" | "stream";
    contentType: string;
  }): OperationContract => ({
    key: input.key,
    plugin: "media",
    title: "Read artifact",
    description: "Reads an artifact.",
    handler: input.handler,
    inputSchema: {
      type: "object",
      required: ["artifactId"],
      properties: { artifactId: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {},
    errors: [],
    auth: { mode: "public" },
    tenancy: { mode: "none" },
    idempotency: { mode: "none" },
    transports: {
      rest: {
        method: "GET",
        path: input.path,
        response: { status: 200, kind: input.kind, contentType: input.contentType },
      },
      mcp: { enabled: false, reason: "Binary fixture." },
      graphql: { enabled: false, reason: "Binary fixture." },
      typescript: { enabled: false, reason: "Binary fixture." },
    },
  });
  const operations = [
    base({
      key: "media.artifact.binary",
      handler: "binaryArtifact",
      path: "/api/media/binary/:artifactId",
      kind: "binary",
      contentType: "application/octet-stream",
    }),
    base({
      key: "media.artifact.stream",
      handler: "streamArtifact",
      path: "/api/media/stream/:artifactId",
      kind: "stream",
      contentType: "text/plain",
    }),
  ];
  const module: RuntimeModule = {
    name: "media",
    operationHandlers: {
      binaryArtifact: async () => ({ value: Buffer.from([0, 1, 2, 255]) }),
      streamArtifact: async () => ({ value: Readable.from(["one", "-two"]) }),
    },
  };
  const app = Fastify();
  registerOperationRestRoutes(app, [module], {}, operations);
  try {
    const binary = await app.inject({ method: "GET", url: "/api/media/binary/id" });
    expect(binary.statusCode).toBe(200);
    expect(binary.headers["content-type"]).toContain("application/octet-stream");
    expect([...binary.rawPayload]).toEqual([0, 1, 2, 255]);

    const stream = await app.inject({ method: "GET", url: "/api/media/stream/id" });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/plain");
    expect(stream.body).toBe("one-two");
  } finally {
    await app.close();
  }
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
