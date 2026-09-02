// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { McpInvocationContext } from "../contract.js";
import type { ModuleMcpServerBinding } from "../platform.js";
import {
  __assertSecretFreeModuleEventForTests,
  __isSensitiveModuleEventKeyForTests,
  ModulePlatformRuntime,
  createModuleSessionCapability,
} from "../platform.js";

const claims = (tenantId = "tenant-a"): TrustedSessionContext => ({
  tenantId,
  userId: "actor-a",
  roles: ["reader"],
  groups: ["/team"],
  oauthScopes: ["items:read"],
  scope: "self",
  credential: "bearer",
});

const binding = (
  session: TrustedSessionContext,
  overrides: Partial<ModuleMcpServerBinding> = {},
): ModuleMcpServerBinding => ({
  server: {} as Server,
  session,
  liveNotifications: true,
  notifyToolsChanged: async () => undefined,
  notifyResourcesChanged: async () => undefined,
  authorize: async () => ({ allowed: true }),
  resolveInvocationSources: async () => [],
  callTool: async () => ({ result: { content: [] } }),
  ...overrides,
});

describe("runtime module platform session authority", () => {
  it("accepts only the exact active deeply-frozen session capability", async () => {
    const runtime = new ModulePlatformRuntime({} as OpenShapeForgeDatabase);
    const active = createModuleSessionCapability(claims());
    const registered = binding(active);
    runtime.registerServer(registered);

    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.roles)).toBe(true);
    expect(Object.isFrozen(active.groups)).toBe(true);
    expect(Object.isFrozen(active.oauthScopes)).toBe(true);
    expect(() => active.roles.push("admin")).toThrow();
    await expect(runtime.services.mcp.authorize(active, {
      action: "read",
      subject: { kind: "tool", name: "read_item" },
    })).resolves.toEqual({ allowed: true });

    const clone = { ...active, roles: [...active.roles], groups: [...active.groups] };
    await expect(runtime.services.mcp.authorize(clone, {
      action: "read",
      subject: { kind: "tool", name: "read_item" },
    })).resolves.toEqual({ allowed: false, code: "NOT_FOUND" });
    expect(() => runtime.services.db.withSession(clone, async () => undefined)).toThrow(
      /live verified session/,
    );
    await expect(runtime.services.events.append(clone, {
      aggregateType: "item",
      aggregateId: "item-1",
      eventType: "item.read",
      payload: {},
    })).rejects.toThrow(/live verified session/);
  });

  it("accepts callTool only for the exact currently-running invocation context", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    const registered = binding(active);
    runtime.registerServer(registered);
    const context = Object.freeze({
      db,
      session: active,
      server: registered.server,
      requestId: "request-a",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    const call = (ctx: McpInvocationContext) =>
      runtime.services.mcp.callTool(ctx, "read_item", {}, undefined);

    await expect(call(context)).rejects.toThrow(/not active/);
    await runtime.withActiveInvocation(context, async () => {
      await expect(call(context)).resolves.toMatchObject({ result: { content: [] } });
      await expect(call({ ...context })).rejects.toThrow(/not active/);
      await expect(call({ ...context, requestId: "fabricated" })).rejects.toThrow(/not active/);
      await runtime.withActiveInvocation(context, async () => {
        await expect(call(context)).resolves.toMatchObject({ result: { content: [] } });
      });
    });
    await expect(call(context)).rejects.toThrow(/not active/);
  });

  it("rejects a different still-live context while another context is current", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    const firstBinding = binding(active);
    const secondBinding = binding(active);
    runtime.registerServer(firstBinding);
    runtime.registerServer(secondBinding);
    const makeContext = (server: Server, requestId: string) => Object.freeze({
      db,
      session: active,
      server,
      requestId,
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    const first = makeContext(firstBinding.server, "first");
    const second = makeContext(secondBinding.server, "second");
    await runtime.withActiveInvocation(first, async () => {
      await runtime.withActiveInvocation(second, async () => {
        await expect(
          runtime.services.mcp.callTool(first, "read_item", {}, undefined),
        ).rejects.toThrow(/not active/);
        await expect(
          runtime.services.mcp.callTool(second, "read_item", {}, undefined),
        ).resolves.toMatchObject({ result: { content: [] } });
      });
    });
  });

  it("rejects same-tool and indirect platform call cycles", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    let context!: McpInvocationContext;
    const registered = binding(active, {
      callTool: async (name) => {
        const next = name === "a" ? "b" : "a";
        return runtime.services.mcp.callTool(context, next, {}, undefined);
      },
    });
    runtime.registerServer(registered);
    context = Object.freeze({
      db,
      session: active,
      server: registered.server,
      requestId: "cycle",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    await runtime.withActiveInvocation(context, async () => {
      await expect(
        runtime.services.mcp.callTool(context, "a", {}, undefined),
      ).rejects.toThrow(/Recursive MCP platform tool calls/);
    });

    const same = binding(active, {
      callTool: async (name) =>
        runtime.services.mcp.callTool(context, name, {}, undefined),
    });
    runtime.unregisterServer(registered.server);
    runtime.registerServer(same);
    context = Object.freeze({
      db,
      session: active,
      server: same.server,
      requestId: "same-cycle",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    await runtime.withActiveInvocation(context, async () => {
      await expect(
        runtime.services.mcp.callTool(context, "a", {}, undefined),
      ).rejects.toThrow(/Recursive MCP platform tool calls/);
    });
  });

  it("drains a fire-and-forget child before ending the parent invocation", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    const registered = binding(active, {
      callTool: async (
        _name,
        _args,
        _options,
        _requestId,
        _token,
        assertActive,
      ) => {
        await blocked;
        assertActive();
        providerCalls += 1;
        return { result: { content: [] } };
      },
    });
    runtime.registerServer(registered);
    const context = Object.freeze({
      db,
      session: active,
      server: registered.server,
      requestId: "delayed",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    let child!: Promise<unknown>;
    let parentSettled = false;
    const parent = runtime.withActiveInvocation(context, async () => {
      child = runtime.services.mcp.callTool(context, "read_item", {}, undefined);
    });
    void parent.then(() => { parentSettled = true; });
    await Promise.resolve();
    expect(parentSettled).toBe(false);
    release();
    await expect(parent).resolves.toBeUndefined();
    await expect(child).resolves.toMatchObject({ result: { content: [] } });
    expect(providerCalls).toBe(1);
  });

  it("snapshots and freezes module-owned arguments before async dispatch", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let executedId: unknown;
    const registered = binding(active, {
      callTool: async (_name, args) => {
        await barrier;
        expect(Object.isFrozen(args)).toBe(true);
        executedId = args.id;
        return { result: { content: [] } };
      },
    });
    runtime.registerServer(registered);
    const context = Object.freeze({
      db,
      session: active,
      server: registered.server,
      requestId: "argument-snapshot",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    const args = { id: "approved" };
    const parent = runtime.withActiveInvocation(context, async () => {
      void runtime.services.mcp.callTool(context, "read_item", args, undefined);
      args.id = "other";
    });
    release();
    await parent;
    expect(executedId).toBe("approved");
  });

  it("drains children added while an earlier child is still pending", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const runtime = new ModulePlatformRuntime(db);
    const active = createModuleSessionCapability(claims());
    let releaseA!: () => void;
    let releaseB!: () => void;
    let enteredB!: () => void;
    const barrierA = new Promise<void>((resolve) => { releaseA = resolve; });
    const barrierB = new Promise<void>((resolve) => { releaseB = resolve; });
    const startedB = new Promise<void>((resolve) => { enteredB = resolve; });
    const effects: string[] = [];
    const registered = binding(active, {
      callTool: async (name) => {
        if (name === "a") await barrierA;
        else {
          enteredB();
          await barrierB;
        }
        effects.push(name);
        return { result: { content: [] } };
      },
    });
    runtime.registerServer(registered);
    const context = Object.freeze({
      db,
      session: active,
      server: registered.server,
      requestId: "fixed-point",
      clientCapabilities: Object.freeze({ elicitation: false, mcpApp: false }),
    }) as McpInvocationContext;
    const parent = runtime.withActiveInvocation(context, async () => {
      void runtime.services.mcp.callTool(context, "a", {}, undefined);
      setTimeout(() => {
        void runtime.services.mcp.callTool(context, "b", {}, undefined);
      }, 0);
    });
    await startedB;
    releaseA();
    expect(await Promise.race([
      parent.then(() => "parent" as const),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 20);
      }),
    ])).toBe("still-pending");
    expect(effects).toEqual(["a"]);
    releaseB();
    await parent;
    expect(effects.sort()).toEqual(["a", "b"]);
  });

  it("invalidates a stale capability across unregister and reconnect", async () => {
    const runtime = new ModulePlatformRuntime({} as OpenShapeForgeDatabase);
    const oldSession = createModuleSessionCapability(claims());
    const oldBinding = binding(oldSession);
    runtime.registerServer(oldBinding);
    runtime.unregisterServer(oldBinding.server);

    const newSession = createModuleSessionCapability(claims());
    runtime.registerServer(binding(newSession));
    const request = { action: "read", subject: { kind: "tool" as const, name: "read_item" } };
    await expect(runtime.services.mcp.authorize(oldSession, request)).resolves.toEqual({
      allowed: false,
      code: "NOT_FOUND",
    });
    await expect(runtime.services.mcp.authorize(newSession, request)).resolves.toEqual({ allowed: true });
  });
});

describe("runtime module list-change notifications", () => {
  it("fans out by tenant or globally and excludes closed/non-live sessions", async () => {
    const runtime = new ModulePlatformRuntime({} as OpenShapeForgeDatabase);
    const calls: string[] = [];
    const add = (name: string, tenant: string, liveNotifications = true) => {
      const value = binding(createModuleSessionCapability(claims(tenant)), {
        liveNotifications,
        notifyToolsChanged: async () => { calls.push(`${name}:tools`); },
        notifyResourcesChanged: async () => { calls.push(`${name}:resources`); },
      });
      runtime.registerServer(value);
      return value;
    };
    add("a", "tenant-a");
    add("b", "tenant-b");
    add("stateless", "tenant-a", false);
    const closed = add("closed", "tenant-a");
    runtime.unregisterServer(closed.server);

    runtime.services.mcp.notifyToolsChanged({ tenantId: "tenant-a" });
    runtime.services.mcp.notifyResourcesChanged({ tenantId: null });
    await Promise.resolve();
    expect(calls.sort()).toEqual(["a:resources", "a:tools", "b:resources"]);
  });
});

describe("module event redaction boundary", () => {
  it("rejects common separated, camelCase and concatenated secret keys recursively", () => {
    for (const key of [
      "accessToken",
      "refresh_token",
      "client-secret",
      "apiKey",
      "apikey",
      "authorizationCode",
      "authCode",
      "cookie",
      "password",
      "credential",
    ]) {
      expect(__isSensitiveModuleEventKeyForTests(key)).toBe(true);
      expect(() => __assertSecretFreeModuleEventForTests({
        safe: [{ nested: { [key]: "fake" } }],
      })).toThrow(/sensitive field name/);
    }
    expect(() => __assertSecretFreeModuleEventForTests({
      status: "complete",
      authorizationDecision: "allowed",
      apiCalls: 2,
    })).not.toThrow();
  });
});
