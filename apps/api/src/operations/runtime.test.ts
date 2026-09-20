// SPDX-License-Identifier: BUSL-1.1
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { operationFailure } from "@openshapeforge/operations";
import documentsPluginRuntime from "@openshapeforge/documents/runtime";
import versioningPluginRuntime from "@openshapeforge/versioning/runtime";
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
import { operationContractFingerprint } from "./contract-fingerprint.js";
import {
  __setOperationExecutionReceiptExecutorForTests,
  keyedOperationReceiptIdentity,
  type TestReceiptExecutor,
} from "./execution-receipts.js";
import {
  bindOperationHandlers as bindCanonicalOperationHandlers,
  DeclaredOperationError,
  invokeOperation,
  operationGraphqlContribution,
  operationRestInput,
  registerOperationRestRoutes,
  registerRuntimeOperationRestRoutes,
  requireOperationAuthorization,
  runtimeStaticOperationRegistrations,
  type OperationContract,
} from "./runtime.js";

// Full-catalog transport tests need the actual modules declared by generated
// Operations. Keep explicitly supplied unit-test catalogs isolated instead.
// Match the runtime loader boundary: the public plugin uses an unbound Kysely
// database generic, while the API contract specializes it to the generated DB.
const documentsRuntime = documentsPluginRuntime as unknown as RuntimeModule;
const versioningRuntime = versioningPluginRuntime as unknown as RuntimeModule;
const notebookRuntime: RuntimeModule = (await import(new URL(
  "../../../../examples/plugins/notebook/runtime.ts", import.meta.url,
).pathname)).default;
const completeModuleSets = new WeakMap<readonly RuntimeModule[], RuntimeModule[]>();
function withDocuments(modules: readonly RuntimeModule[]): RuntimeModule[] {
  let complete = completeModuleSets.get(modules);
  if (!complete) {
    complete = [documentsRuntime, versioningRuntime, ...modules];
    completeModuleSets.set(modules, complete);
  }
  return complete;
}
const bindOperationHandlers: typeof bindCanonicalOperationHandlers = (modules, operations) =>
  operations === undefined
    ? bindCanonicalOperationHandlers(withDocuments(modules))
    : bindCanonicalOperationHandlers(modules, operations);

const session = {
  tenantId: "tenant-a",
  userId: "user-a",
  roles: ["Organization.All.ReadWrite"],
  groups: [],
  scope: "tenant" as const,
  credential: "trusted-context" as const,
};

const testDatabase = (receiptExecutor?: TestReceiptExecutor, statements?: string[]) => {
  const db = new Kysely<DB>({
    log: event => { if (event.level === "query") statements?.push(event.query.sql); },
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const stored = new Map<string, { request: string; contract: string; value: unknown }>();
  const inMemory: TestReceiptExecutor = async (active, options) => {
    await options.authorizeReplay?.(undefined as never);
    const identity = keyedOperationReceiptIdentity(active, options);
    const key = [identity.tenantId, identity.actorId, identity.operationId,
      identity.operationIntent, identity.keyHash].join(":");
    const existing = stored.get(key);
    if (existing) {
      if (existing.request !== identity.requestFingerprint ||
        existing.contract !== identity.contractFingerprint) {
        throw operationFailure({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This idempotency key was already used for different input.",
        });
      }
      return options.decode(existing.value);
    }
    const value = await options.execute(() => undefined);
    stored.set(key, {
      request: identity.requestFingerprint,
      contract: identity.contractFingerprint,
      value: options.encode(value),
    });
    return value;
  };
  __setOperationExecutionReceiptExecutorForTests(db, receiptExecutor ?? inMemory);
  return db;
};

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
  test("owner availability is rechecked inside the same transaction as execution", async () => {
    const statements: string[] = [];
    const db = testDatabase(undefined, statements);
    const platform = new ModulePlatformRuntime(db);
    const operation: OperationContract = {
      ...restOperation,
      key: "demo.relation.publish",
      handler: "publish",
      target: { entityId: "Relation", entityName: "Relation", scope: "record", inputField: "id" },
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      outputSchema: { type: "object" },
      idempotency: { mode: "none" },
      transports: { ...restOperation.transports, rest: { method: "POST", path: "/api/demo/relations/:id/publish", response: { status: 200, kind: "json" } } },
    };
    let allowed = false;
    let calls = 0;
    let policyDb: unknown;
    const module: RuntimeModule = {
      name: operation.plugin,
      operationAvailabilityHandlers: { publish: async (ids, context) => {
        policyDb = context.db;
        return Object.fromEntries(ids.map(id => [id, allowed ? { available: true } : {
          available: false, error: { code: "CONFLICT", message: "This record cannot be published yet.", retryable: false },
        }]));
      } },
      operationHandlers: { publish: async (_input, context) => {
        calls++;
        await context.platform!.db.withSession(context.session!, async trx => { expect(trx === policyDb).toBe(true); });
        return { value: {} };
      } },
    };
    const bound = bindOperationHandlers([module], [operation]).get(operation.key)!;
    const verified = { ...session, roles: ["quote-publisher"], tenantId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333" };
    try {
      const context = { db, platform: platform.services, transport: "rest" as const, session: verified };
      const input = { id: "44444444-4444-4444-8444-444444444444" };
      await expect(invokeOperation(bound, input, context)).rejects.toThrow("cannot be published yet");
      expect(calls).toBe(0);
      allowed = true;
      await expect(invokeOperation(bound, input, context)).resolves.toEqual({ value: {} });
      expect(calls).toBe(1);
      allowed = false;
      await expect(invokeOperation(bound, input, context)).rejects.toThrow("cannot be published yet");
      expect(calls).toBe(1);
      const protectedBound = { ...bound, operation: { ...operation,
        concurrency: { version: { mode: "required" as const, field: "updatedAt" as const } },
        confirmation: { mode: "challenge" as const, challenge: {
          kind: "type-current-field" as const, field: "displayName", issuedBy: "server" as const,
          bindTo: ["subject", "tenant", "operation", "target.id", "target.version"] as const,
          expiresAfter: "PT5M", singleUse: true as const,
        } },
        inputSchema: { type: "object", required: ["id", "expectedVersion"], properties: { id: { type: "string" }, expectedVersion: { type: "string" } } },
      } };
      await expect(invokeOperation(protectedBound, { ...input, expectedVersion: "2026-09-13T00:00:00.000Z" }, context))
        .rejects.toThrow("cannot be published yet");
      expect(statements.some(query => /insert\s+into\s+platform\.operation_confirmation_challenges/i.test(query))).toBe(false);
      expect(calls).toBe(1);
    } finally { await db.destroy(); }
  });

  test("availability cannot be registered outside the owning authored record operation", () => {
    const module: RuntimeModule = { name: restOperation.plugin,
      operationHandlers: { [restOperation.handler]: async () => ({ value: {} }) },
      operationAvailabilityHandlers: { [restOperation.handler]: async () => ({}) },
    };
    expect(() => bindOperationHandlers([module], [restOperation])).toThrow("authenticated tenant record target");
    expect(() => bindOperationHandlers([{ ...module, operationAvailabilityHandlers: { unknown: async () => ({}) } }], [restOperation]))
      .toThrow("absent from its compiler contract");
  });
  test("fails closed when the compiler contract has no runtime handler", () => {
    expect(() => bindOperationHandlers([{ name: "notebook" }])).toThrow(/has no runtime handler/);
    expect(() => bindOperationHandlers([{ name: "unrelated" }, { name: "notebook" }])).toThrow(/has no runtime handler/);
  });
  test("a process without any operation module binds core and native operations only", () => {
    const bound = bindCanonicalOperationHandlers([]);
    expect(bound.has("notebook.import")).toBe(false);
    expect(bound.has("entityTypes.list")).toBe(true);
    expect(bound.has("control.list-tenants")).toBe(true);
    expect(bound.has("grants.revoke")).toBe(true);
    expect(bound.has("AgreementMilestone.trigger")).toBe(true);
    expect(bound.has("BillingRun.execute")).toBe(true);
    expect(
      [...bound.values()].every(({ operation }) =>
        operation.implementation?.type === "collection" ||
        operation.implementation?.type === "entity-type-list" ||
        operation.implementation?.type === "constrained-reference-create" ||
        operation.plugin === "osf-billing" ||
        operation.plugin === "osf-blueprints" ||
        operation.plugin === "osf-control" ||
        operation.plugin === "osf-grants" ||
        operation.plugin === "osf-jobs" ||
        operation.plugin === "osf-transitions"
      ),
    ).toBe(true);
    // Once any operation module is present, every plugin operation must bind.
    const noOperationModule = { name: "no-operation-module" };
    expect(() => bindCanonicalOperationHandlers([noOperationModule])).not.toThrow();
    expect(bindCanonicalOperationHandlers([noOperationModule]).has("notebook.import")).toBe(false);
  });

  test("validates input and handler output against the generated contract", async () => {
    const module: RuntimeModule = {
      name: "notebook",
      operationHandlers: {
        importNotebook: async (input) => ({
          value: { status: "accepted", importId: "11111111-1111-4111-8111-111111111111", notebookId: input.notebookId },
        }),
      },
    };
    const bound = bindOperationHandlers([module]).get("notebook.import")!;
    await expect(invokeOperation(bound, {}, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
    await expect(invokeOperation(bound, {
      notebookId: "not-a-uuid",
      idempotencyKey: "webhook-invalid",
    }, { transport: "graphql", session })).rejects.toMatchObject({ status: 400 });
    const result = await invokeOperation(bound, {
      notebookId: "22222222-2222-4222-8222-222222222222",
      body: "imported",
      idempotencyKey: "webhook-1",
    }, { transport: "graphql", session });
    expect(result.value).toMatchObject({ status: "accepted" });
  });

  test("activates the handler session for platform database work", async () => {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    let retainedSession: TrustedSessionContext | undefined;
    const module: RuntimeModule = {
      name: "notebook",
      operationHandlers: {
        importNotebook: async (input, context) => {
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
              importId: "11111111-1111-4111-8111-111111111111",
              notebookId: input.notebookId,
            },
          };
        },
      },
    };
    const bound = bindOperationHandlers([module]).get("notebook.import")!;
    const verified = {
      ...session,
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
    };
    try {
      await expect(invokeOperation(bound, {
        notebookId: "44444444-4444-4444-8444-444444444444",
        body: "imported",
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
      resolveInvocationSources: async () => ({
        sources: [source],
        unavailable: [],
      }),
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
      name: "notebook",
      operationHandlers: {
        importNotebook: async (input, context) => {
          expect(context.session).toBe(liveSession);
          expect(await context.platform!.mcp.authorize(context.session!, {
            action: "call",
            subject: { kind: "tool", name: "known_tool" },
          })).toEqual({ allowed: true });
          expect(await context.platform!.mcp.resolveInvocationSources(
            context.session!,
            "known_tool",
            { selector: "accepted" },
            { mode: "default" },
          )).toEqual({ sources: [source], unavailable: [] });
          await expect(context.platform!.db.withSession(
            context.session!,
            async () => "accepted",
          )).resolves.toBe("accepted");
          return {
            value: {
              status: "accepted",
              importId: "11111111-1111-4111-8111-111111111111",
              notebookId: input.notebookId,
            },
          };
        },
      },
    }]).get("notebook.import")!;
    try {
      const result = await platform.withActiveInvocation(invocation, () =>
        invokeOperation(bound, {
          notebookId: "44444444-4444-4444-8444-444444444444",
          body: "imported",
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
      name: "notebook",
      operationHandlers: {
        importNotebook: async () => {
          invoked = true;
          return { value: {} };
        },
      },
    }]).get("notebook.import")!;
    try {
      await expect(invokeOperation(bound, {
        notebookId: "44444444-4444-4444-8444-444444444444",
        body: "imported",
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
      name: "notebook",
      operationHandlers: {
        importNotebook: async () => {
          nestedInvoked = true;
          return { value: {} };
        },
      },
    }]).get("notebook.import")!;
    const nested = {
      ...nestedBase,
      operation: {
        ...nestedBase.operation,
        auth: { mode: "session" as const, roles: ["elevated"] },
      },
    };
    const outer = bindOperationHandlers([{
      name: "notebook",
      operationHandlers: {
        importNotebook: async (input) => {
          await expect(invokeOperation(nested, input, {
            transport: "graphql",
            session: { ...session, roles: [...session.roles, "elevated"] },
          })).rejects.toThrow(/required operation role/);
          return {
            value: {
              status: "accepted",
              importId: "11111111-1111-4111-8111-111111111111",
              notebookId: input.notebookId,
            },
          };
        },
      },
    }]).get("notebook.import")!;
    try {
      await expect(invokeOperation(outer, {
        notebookId: "44444444-4444-4444-8444-444444444444",
        body: "imported",
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
        name: "notebook",
        operationHandlers: { importNotebook: async () => ({ value: {} }) },
      }]).get("notebook.import")!.operation,
      auth: { mode: "session" as const, roles: ["Organization.All.ReadWrite"], scopes: ["notebook:write"] },
    };
    expect(() => requireOperationAuthorization(operation, session)).toThrow(/OAuth scope/);
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      oauthScopes: ["notebook:write"],
    })).not.toThrow();
    expect(() => requireOperationAuthorization(operation, {
      ...session,
      credential: "api-key",
      oauthScopes: ["notebook:write"],
    })).toThrow(/cannot be invoked with an API key/);
  });

  test("allows an authenticated tenant session when roles are omitted and keeps empty fail-closed", () => {
    const authenticated: OperationContract = {
      ...restOperation,
      auth: { mode: "session" },
    };
    expect(() => requireOperationAuthorization(authenticated, {
      ...session,
      roles: [],
    })).not.toThrow();
    expect(() => requireOperationAuthorization(authenticated, undefined))
      .toThrow(/authenticated bearer session/);
    expect(() => requireOperationAuthorization(authenticated, {
      ...session,
      credential: "none",
      roles: [],
    })).toThrow(/authenticated bearer session/);
    expect(() => requireOperationAuthorization(authenticated, {
      ...session,
      tenantId: null as never,
      roles: [],
    })).toThrow(/tenant context/);

    const denied: OperationContract = {
      ...authenticated,
      auth: { mode: "session", roles: [] },
    };
    expect(() => requireOperationAuthorization(denied, session))
      .toThrow(/required operation role/);
    expect(() => requireOperationAuthorization(restOperation, session))
      .toThrow(/required operation role/);
    expect(() => requireOperationAuthorization(restOperation, {
      ...session,
      roles: ["quote-publisher"],
    })).not.toThrow();

    const scoped: OperationContract = {
      ...authenticated,
      auth: { mode: "session", scopes: ["session:read"] },
    };
    expect(() => requireOperationAuthorization(scoped, { ...session, roles: [] }))
      .toThrow(/OAuth scope/);
    expect(() => requireOperationAuthorization(scoped, {
      ...session,
      roles: [],
      oauthScopes: ["session:read"],
    })).not.toThrow();

    const module: RuntimeModule = {
      name: "demo",
      operationHandlers: { publishQuote: async () => ({ value: {} }) },
    };
    const [available] = runtimeStaticOperationRegistrations([module], {}, [authenticated]);
    const [unavailable] = runtimeStaticOperationRegistrations([module], {}, [denied]);
    expect(available!.available({ ...session, roles: [] })).toBe(true);
    expect(unavailable!.available({ ...session, roles: ["admin"] })).toBe(false);

    const conjunctive: OperationContract = {
      ...authenticated,
      auth: { mode: "session", roleGroups: [["target-a", "target-b"], ["child"]] },
    };
    const [conjunctiveOffer] = runtimeStaticOperationRegistrations([module], {}, [conjunctive]);
    expect(conjunctiveOffer!.available({ ...session, roles: ["target-b", "child"] })).toBe(true);
    expect(conjunctiveOffer!.available({ ...session, roles: ["target-a"] })).toBe(false);
  });

  test("rejects a success status that differs from the canonical contract", async () => {
    const bound = bindOperationHandlers([{
      name: "notebook",
      operationHandlers: {
        importNotebook: async (input) => ({
          status: 201,
          value: { status: "accepted", importId: "11111111-1111-4111-8111-111111111111", notebookId: input.notebookId },
        }),
      },
    }]).get("notebook.import")!;
    await expect(invokeOperation(bound, {
      notebookId: "22222222-2222-4222-8222-222222222222",
      body: "imported",
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
      name: "notebook",
      operationHandlers: { importNotebook: () => ({ value: {} }), hidden: () => ({ value: {} }) },
    }])).toThrow(/absent from its compiler contract: hidden/);
  });

  test("caches one immutable handler binding per initialized module set", () => {
    const modules: RuntimeModule[] = [{
      name: "notebook",
      operationHandlers: { importNotebook: async () => ({ value: {} }) },
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
  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  registerOperationRestRoutes(app, [module], { db, platform: platform.services }, [restOperation]);
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
        retryable: false,
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
    const replay = await app.inject({
      method: "POST",
      url: paths[0]!,
      headers: {
        ...Object.fromEntries(authorized),
        "idempotency-key": "request-1",
      },
      payload: { outcome: "ok" },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["x-operation-handler"]).toBe("publishQuote");
    successfulBodies.push(replay.json());
    expect(successfulBodies).toHaveLength(2);
    expect(successfulBodies[1]).toEqual(successfulBodies[0]);
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
        error: { code: "CONFLICT", message: "Quote conflicts.", retryable: false },
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
    await db.destroy();
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

test("explicit canonical handler envelopes preserve offers and resources without shape guessing", async () => {
  const operation: OperationContract = { ...restOperation,
    auth: { mode: "public" }, tenancy: { mode: "none" }, idempotency: { mode: "none" },
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    transports: { ...restOperation.transports, rest: { ...restOperation.transports.rest, response: { kind: "json", status: 200 } } },
  };
  const envelope = { data: { status: "waiting" }, operations: [{
    operation: { id: "example.respond", intent: "invoke" }, available: true as const,
    interaction: { kind: "userInput" as const, offerId: "server-issued", expiresAt: "2026-09-12T13:15:00Z",
      bindTo: { tenant: "tenant-a", subject: "user-a", instance: "instance-a" }, choices: [{ value: "yes", label: "Ja" }] },
  }], resources: [{ uri: "osf://example/result", name: "result" }] };
  for (const explicit of [true, false]) {
    const modules: RuntimeModule[] = [{ name: "demo", operationHandlers: {
      publishQuote: async () => ({ value: envelope, ...(explicit ? { resultKind: "operation-envelope" as const } : {}) }),
    } }];
    const registration = runtimeStaticOperationRegistrations(modules, {}, [operation])[0]!;
    const result = await registration.execute(session, { operation: { id: operation.key, intent: "invoke" }, input: {} }, {});
    expect(result).toEqual(explicit ? envelope : { data: envelope, operations: [] });
  }
  for (const value of [{ data: {} }, { data: {}, operations: "invalid" }, { data: {}, operations: [], error: {} },
    { data: {}, operations: [{ available: true }] }, { data: {}, operations: [], resources: [{ uri: "x" }] }]) {
    const modules: RuntimeModule[] = [{ name: "demo", operationHandlers: {
      publishQuote: async () => ({ value, resultKind: "operation-envelope" }),
    } }];
    const registration = runtimeStaticOperationRegistrations(modules, {}, [operation])[0]!;
    expect(await registration.execute(session, { operation: { id: operation.key, intent: "invoke" }, input: {} }, {}))
      .toMatchObject({ error: { code: "HANDLER_CONTRACT_VIOLATION" } });
  }
});

test("the generic runtime Operation route parses JSON inside a raw-buffer parent", async () => {
  const previousSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  const secret = "runtime-operation-rest-json-test-secret";
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
  __resetSessionResolverForTests();
  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const seen: unknown[] = [];
  const module: RuntimeModule = {
    name: "demo",
    operationHandlers: {
      publishQuote: async (input, context) => {
        seen.push(input);
        return {
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
  platform.registerStaticOperations(runtimeStaticOperationRegistrations(
    [module],
    { db, platform: platform.services },
    [restOperation],
  ));
  const app = Fastify();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerRuntimeOperationRestRoutes(app, { db, platform: platform.services });
  const headers = new Headers({
    "content-type": "application/json",
    "idempotency-key": "request-raw-buffer",
  });
  applyTrustedContextHeaders(headers, {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["quote-publisher"],
    groups: [],
  }, { secret });
  try {
    const discovered = await app.inject({
      method: "GET",
      url: `/api/operations/${restOperation.key}`,
      headers: Object.fromEntries(headers),
    });
    expect(discovered.statusCode).toBe(200);
    const definition = discovered.json() as RuntimeOperationDefinition;
    const expectedContractFingerprint = operationContractFingerprint(definition);
    const response = await app.inject({
      method: "POST",
      url: `/api/operations/${restOperation.key}/execute`,
      headers: Object.fromEntries(headers),
      payload: {
        intent: "invoke",
        input: { quoteId: "quote-raw-buffer" },
        expectedContractFingerprint,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        quoteId: "quote-raw-buffer",
        idempotencyKey: "request-raw-buffer",
        tenantId: "tenant-a",
        userId: "user-a",
      },
    });
    expect(seen).toEqual([{
      quoteId: "quote-raw-buffer",
      idempotencyKey: "request-raw-buffer",
    }]);

    platform.registerStaticOperations([{
      definition: {
        ...definition,
        reliability: { idempotency: { mode: "none" } },
      },
      available: () => true,
      execute: async () => {
        seen.push("changed-contract-executed");
        return { data: {}, operations: [] };
      },
    }]);
    const changed = await app.inject({
      method: "POST",
      url: `/api/operations/${restOperation.key}/execute`,
      headers: Object.fromEntries(headers),
      payload: {
        intent: "invoke",
        input: { quoteId: "must-not-run" },
        expectedContractFingerprint,
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      error: { code: "OPERATION_CONTRACT_CHANGED", retryable: false },
    });
    expect(seen).toHaveLength(1);

    const malformed = await app.inject({
      method: "POST",
      url: `/api/operations/${restOperation.key}/execute`,
      headers: Object.fromEntries(headers),
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "BAD_USER_INPUT", message: "Request body is not valid JSON." },
    });
  } finally {
    await app.close();
    await db.destroy();
    if (previousSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = previousSecret;
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
      error: {
        code: "FORBIDDEN",
        message: "Handler failure.",
        retryable: false,
      },
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
    name: "notebook",
    operationHandlers: {
      importNotebook: () => ({
        ok: false,
        status: 409,
        code: "CONFLICT",
        body,
      }),
    },
  };
  const input = {
    notebookId: "22222222-2222-4222-8222-222222222222",
    body: "imported",
    idempotencyKey: "declared-error",
  };

  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const contribution = operationGraphqlContribution(
    withDocuments([module]),
    { db, platform: platform.services },
  )?.graphql?.({});
  const resolver = contribution?.resolvers?.Mutation?.notebookImport as
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

  const server = __buildGeneratedMcpServerForTests({
    db,
    session,
    modules: withDocuments([module]),
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
      name: "notebook_import",
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

test("MCP projects a handler's content blocks next to the canonical value", async () => {
  const value = {
    status: "accepted",
    importId: "11111111-1111-4111-8111-111111111111",
    notebookId: "22222222-2222-4222-8222-222222222222",
  };
  const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  const module: RuntimeModule = {
    name: "notebook",
    operationHandlers: {
      importNotebook: () => ({
        value,
        mcp: { content: [{ type: "text", text: "one image" }, image] },
      }),
    },
  };
  const input = { notebookId: value.notebookId, body: "imported", idempotencyKey: "content-blocks" };

  // Other transports keep the canonical value; the projection is not validated
  // against the output schema and does not leak into it.
  const bound = bindOperationHandlers([module]).get("notebook.import")!;
  const direct = await invokeOperation(bound, input, { transport: "graphql", session });
  expect(direct.value).toEqual(value);

  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session,
    modules: withDocuments([module]),
    modulePlatform: platform,
  });
  const client = new Client({ name: "content-blocks-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "notebook_import", arguments: input });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "one image" }, image]);
    expect(result.structuredContent).toEqual(value);
  } finally {
    await client.close();
    await server.close();
    await db.destroy();
  }
});

test("MCP searchable projection bounds tools/list while search, generic execute, and named calls stay canonical", async () => {
  const value = {
    status: "accepted",
    importId: "11111111-1111-4111-8111-111111111111",
    notebookId: "22222222-2222-4222-8222-222222222222",
  };
  const calls: unknown[] = [];
  const module: RuntimeModule = {
    name: "notebook",
    operationHandlers: {
      importNotebook: (input, context) => {
        calls.push({ input, userId: context.session?.userId });
        return { value };
      },
    },
  };
  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  platform.registerStaticOperations(runtimeStaticOperationRegistrations(
    withDocuments([module]),
    { db, platform: platform.services },
  ));
  const server = __buildGeneratedMcpServerForTests({
    db,
    session,
    modules: withDocuments([module]),
    modulePlatform: platform,
    operationToolProjection: {
      mode: "searchable",
      search: "osf_search_operations",
      execute: "osf_execute_operation",
    },
  });
  const client = new Client(
    { name: "searchable-operation-test", version: "1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("osf_search_operations");
    expect(listed.tools.map((tool) => tool.name)).toContain("osf_execute_operation");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("notebook_import");

    const searched = await client.callTool({
      name: "osf_search_operations",
      arguments: { query: "import a notebook body", limit: 20 },
    });
    expect(searched.isError).not.toBe(true);
    expect(searched.structuredContent).toMatchObject({
      operations: [{
        operation: { id: "notebook.import", intent: "invoke" },
        inputSchema: expect.objectContaining({
          required: ["notebookId", "body", "idempotencyKey"],
        }),
      }],
    });

    const generic = await client.callTool({
      name: "osf_execute_operation",
      arguments: {
        operationId: "notebook.import",
        input: { notebookId: value.notebookId, body: "imported" },
        idempotencyKey: "generic-attempt",
      },
    });
    expect(generic.isError).not.toBe(true);
    expect(generic.structuredContent).toEqual({ data: value, operations: [] });

    const named = await client.callTool({
      name: "notebook_import",
      arguments: {
        notebookId: value.notebookId,
        body: "imported",
        idempotencyKey: "named-attempt",
      },
    });
    expect(named.isError).not.toBe(true);
    expect(named.structuredContent).toEqual(value);
    expect(calls).toEqual([
      {
        input: {
          notebookId: value.notebookId,
          body: "imported",
          idempotencyKey: "generic-attempt",
        },
        userId: session.userId,
      },
      {
        input: {
          notebookId: value.notebookId,
          body: "imported",
          idempotencyKey: "named-attempt",
        },
        userId: session.userId,
      },
    ]);

    const deniedSession = { ...session, userId: "user-denied", roles: [] };
    const deniedServer = __buildGeneratedMcpServerForTests({
      db,
      session: deniedSession,
      modules: withDocuments([module]),
      modulePlatform: platform,
      operationToolProjection: {
        mode: "searchable",
        search: "osf_search_operations",
        execute: "osf_execute_operation",
      },
    });
    const deniedClient = new Client(
      { name: "searchable-operation-denied-test", version: "1" },
      { capabilities: {} },
    );
    const [deniedClientTransport, deniedServerTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await deniedServer.connect(deniedServerTransport);
      await deniedClient.connect(deniedClientTransport);
      const hidden = await deniedClient.callTool({
        name: "osf_search_operations",
        arguments: { query: "import a notebook body" },
      });
      expect(hidden.structuredContent).toEqual({ operations: [] });
      const deniedGeneric = await deniedClient.callTool({
        name: "osf_execute_operation",
        arguments: {
          operationId: "notebook.import",
          input: { notebookId: value.notebookId, body: "imported" },
          idempotencyKey: "denied-attempt",
        },
      });
      expect(deniedGeneric).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "NOT_FOUND" } },
      });
      const deniedNamed = await deniedClient.callTool({
        name: "notebook_import",
        arguments: {
          notebookId: value.notebookId,
          idempotencyKey: "denied-named-attempt",
        },
      });
      expect(deniedNamed).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "NOT_FOUND" } },
      });
      expect(calls).toHaveLength(2);
    } finally {
      await deniedClient.close();
      await deniedServer.close();
    }
  } finally {
    await client.close();
    await server.close();
    await db.destroy();
  }
});

test("MCP projects and dispatches live runtime provider Operations canonically", async () => {
  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const definition = {
    id: "example.service.invoke:service-one@1",
    intent: "invoke",
    key: "find-tickets",
    entityId: "service-one",
    entityName: "Service",
    name: "Find tickets",
    description: "Find the tickets visible to this person.",
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    output: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { found: { type: "number" } },
        required: ["found"],
        additionalProperties: false,
      },
    },
    effects: { data: "read" as const, external: "read" as const },
    reliability: { idempotency: { mode: "natural" as const } },
  };
  const calls: unknown[] = [];
  const providerModule: RuntimeModule = {
    name: "example",
    operationProviders: [{
      id: "example.services",
      list: async (active) => active.userId === session.userId ? [definition] : [],
      get: async (active, operationId) =>
        active.userId === session.userId && operationId === definition.id
          ? definition
          : undefined,
      execute: async (context, request) => {
        calls.push({ session: context.session, request });
        return {
          data: { found: request.input?.query === "open" ? 2 : 0 },
          operations: [],
          resources: [{
            uri: "osf://tickets/result-one",
            name: "ticket-result",
            mimeType: "application/json",
          }],
        };
      },
    }],
  };
  platform.registerOperationProviders([providerModule]);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session,
    modules: withDocuments([notebookRuntime, providerModule]),
    modulePlatform: platform,
  });
  const client = new Client(
    { name: "runtime-operation-provider-test", version: "1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools).toContainEqual(expect.objectContaining({
      name: "find_tickets",
      title: "Find tickets",
      description: "Find the tickets visible to this person.",
      inputSchema: definition.input.schema,
      outputSchema: expect.objectContaining({
        required: ["data", "operations"],
        properties: expect.objectContaining({ data: definition.output.schema }),
      }),
      annotations: expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      }),
    }));

    const result = await client.callTool({
      name: "find_tickets",
      arguments: { query: "open" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      data: { found: 2 },
      operations: [],
      resources: [{
        uri: "osf://tickets/result-one",
        name: "ticket-result",
        mimeType: "application/json",
      }],
    });
    expect(result.content).toContainEqual({
      type: "resource_link",
      uri: "osf://tickets/result-one",
      name: "ticket-result",
      mimeType: "application/json",
    });
    expect(calls).toEqual([{
      session: expect.objectContaining({
        tenantId: session.tenantId,
        userId: session.userId,
      }),
      request: {
        operation: { id: definition.id, intent: definition.intent },
        input: { query: "open" },
      },
    }]);
  } finally {
    await client.close();
    await server.close();
    await db.destroy();
  }
});

test("runtime provider keyed Operations replay through the same durable core boundary", async () => {
  const db = testDatabase();
  const platform = new ModulePlatformRuntime(db);
  const definition: RuntimeOperationDefinition = {
    id: "example.keyed.invoke:one",
    intent: "invoke",
    key: "keyed-example",
    name: "Keyed example",
    description: "Writes once.",
    input: { kind: "json-schema", schema: { type: "object" } },
    output: { kind: "json-schema", schema: { type: "object" } },
    effects: { data: "write", external: "none" },
    reliability: { idempotency: { mode: "keyed" } },
  };
  let calls = 0;
  platform.registerOperationProviders([{
    name: "example",
    operationProviders: [{
      id: "example.keyed",
      list: async () => [definition],
      get: async (_active, id) => id === definition.id ? definition : undefined,
      execute: async () => ({ data: { call: ++calls }, operations: [] }),
    }],
  }]);
  try {
    await platform.withActiveOperationSession(session, async (active) => {
      const request = {
        operation: { id: definition.id, intent: definition.intent },
        input: { value: "same" },
        idempotencyKey: "provider-key",
      };
      const first = await platform.services.operations.execute(active, request);
      const replay = await platform.services.operations.execute(active, request);
      expect(replay).toEqual(first);
      expect(calls).toBe(1);
      expect(await platform.services.operations.execute(active, {
        ...request,
        input: { value: "changed" },
      })).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED", retryable: false } });
    });
  } finally {
    await db.destroy();
  }
});

test("MCP refuses unusable or colliding runtime provider tool keys", async () => {
  for (const key of ["Find Tickets", "whoami"]) {
    const db = testDatabase();
    const platform = new ModulePlatformRuntime(db);
    const providerModule: RuntimeModule = {
      name: "example",
      operationProviders: [{
        id: `example.${key}`,
        list: async () => [{
          id: `example.invoke:${key}`,
          intent: "invoke",
          key,
          name: key,
          description: key,
          input: { kind: "json-schema", schema: { type: "object" } },
          output: { kind: "json-schema", schema: { type: "object" } },
          effects: { data: "read", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
        }],
        get: async () => undefined,
        execute: async () => ({ data: {}, operations: [] }),
      }],
    };
    platform.registerOperationProviders([providerModule]);
    const server = __buildGeneratedMcpServerForTests({
      db,
      session,
      modules: withDocuments([notebookRuntime, providerModule]),
      modulePlatform: platform,
    });
    const client = new Client(
      { name: "runtime-operation-collision-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await expect(client.listTools()).rejects.toThrow(
        key === "whoami" ? /contributed more than once/ : /no usable MCP key/,
      );
    } finally {
      await client.close();
      await server.close();
      await db.destroy();
    }
  }
});

test("rejects an MCP projection that is not well-formed content", async () => {
  const value = {
    status: "accepted",
    importId: "11111111-1111-4111-8111-111111111111",
    notebookId: "22222222-2222-4222-8222-222222222222",
  };
  const input = { notebookId: value.notebookId, body: "imported", idempotencyKey: "bad-blocks" };
  for (const mcp of [
    { content: [] },
    { content: [{ type: "image", mimeType: "image/png" }] },
    { content: [{ type: "image", data: "not base64!", mimeType: "image/png" }] },
    { content: [{ type: "video", data: "AAAA", mimeType: "video/mp4" }] },
    { content: [{ type: "text", text: "ok" }], structuredContent: ["not", "a", "record"] },
  ]) {
    const module: RuntimeModule = {
      name: "notebook",
      operationHandlers: { importNotebook: () => ({ value, mcp }) as ModuleOperationResult },
    };
    const bound = bindOperationHandlers([module]).get("notebook.import")!;
    await expect(invokeOperation(bound, input, { transport: "mcp", session })).rejects.toMatchObject({
      status: 500,
      code: "HANDLER_CONTRACT_VIOLATION",
    });
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
