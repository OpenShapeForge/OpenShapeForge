// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type {
  McpInvocationContext,
  McpProjectionContext,
  ModuleAuthorizationRequest,
  ModuleToolExecutionResult,
  RuntimeModule,
} from "../contract.js";
import {
  assertUniqueToolNames,
  authorizeMcpRequest,
  decorateMcpTools,
  interceptMcpToolCall,
  invokeModuleTool,
  moduleResourceAuthorizationOwner,
  moduleResourceTemplates,
  moduleResources,
  moduleToolAuthorizationOwner,
  moduleTools,
  readModuleResource,
} from "../mcp-hooks.js";

const projection = {
  db: {} as McpProjectionContext["db"],
  session: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles: ["reader"],
    groups: [],
    oauthScopes: [],
    scope: "self",
    credential: "bearer",
  },
  clientCapabilities: { elicitation: false, mcpApp: false },
} as McpProjectionContext;
const invocation = {
  ...projection,
  server: {} as McpInvocationContext["server"],
  requestId: "request-1",
} as McpInvocationContext;
const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object" as const },
});

describe("runtime module MCP composition", () => {
  it("lets a module claim a core-unknown resource handle", async () => {
    const request: ModuleAuthorizationRequest = {
      action: "read",
      subject: { kind: "resource-handle", uri: "app://artifacts/item-1" },
    };
    let receivedSession: unknown;
    let receivedRequest: unknown;
    const owner: RuntimeModule = {
      name: "artifacts",
      mcp: {
        authorize: async (session, candidate) => {
          receivedSession = session;
          receivedRequest = candidate;
          return candidate.subject.kind === "resource-handle" &&
              candidate.subject.uri === "app://artifacts/item-1"
            ? { allowed: true, fieldAllowlist: ["title", "id"] }
            : undefined;
        },
      },
    };
    const decision = await authorizeMcpRequest(
      [owner],
      projection.session,
      request,
      async () => ({ allowed: false, code: "NOT_FOUND" }),
      async () => owner,
    );

    expect(decision).toEqual({ allowed: true, fieldAllowlist: ["id", "title"] });
    expect(receivedSession).toBe(projection.session);
    expect(receivedRequest).not.toBe(request);
    expect(Object.isFrozen(receivedRequest)).toBe(true);
    expect(Object.isFrozen((receivedRequest as ModuleAuthorizationRequest).subject)).toBe(true);
  });

  it("resolves only registered module tool and exact or template resource owners", async () => {
    const owner: RuntimeModule = {
      name: "artifacts",
      mcp: {
        tools: async () => [tool("artifact_preview")],
        resources: async () => [{ uri: "app://artifacts/current", name: "current" }],
        resourceTemplates: async () => [{
          uriTemplate: "app://artifacts/{id}",
          name: "artifact",
        }],
        authorize: async () => ({ allowed: true }),
      },
    };
    const resolveOwner = async (request: ModuleAuthorizationRequest) =>
      request.subject.kind === "tool"
        ? moduleToolAuthorizationOwner(
            [owner],
            request.subject.name,
            projection,
          )
        : request.subject.kind === "resource-handle"
          ? moduleResourceAuthorizationOwner(
              [owner],
              request.subject.uri,
              projection,
            )
          : undefined;
    for (const subject of [
      { kind: "tool" as const, name: "artifact_preview" },
      { kind: "resource-handle" as const, uri: "app://artifacts/current" },
      { kind: "resource-handle" as const, uri: "app://artifacts/item-1" },
    ]) {
      await expect(authorizeMcpRequest(
        [owner],
        projection.session,
        { action: subject.kind === "tool" ? "call" : "read", subject },
        async () => ({ allowed: false, code: "NOT_FOUND" }),
        resolveOwner,
      )).resolves.toEqual({ allowed: true });
    }

    await expect(authorizeMcpRequest(
      [owner],
      projection.session,
      {
        action: "read",
        subject: { kind: "resource-handle", uri: "app://unknown/item-1" },
      },
      async () => ({ allowed: false, code: "NOT_FOUND" }),
      resolveOwner,
    )).resolves.toEqual({ allowed: false, code: "NOT_FOUND" });
  });

  it("intersects tool and resource field allowlists independent of field order", async () => {
    const modules: RuntimeModule[] = [
      {
        name: "first",
        mcp: {
          authorize: async () => ({
            allowed: true,
            fieldAllowlist: ["summary", "id", "title", "id"],
          }),
        },
      },
      {
        name: "second",
        mcp: {
          authorize: async () => ({
            allowed: true,
            fieldAllowlist: ["title", "id", "status"],
          }),
        },
      },
    ];
    for (const subject of [
      { kind: "tool" as const, name: "preview_item" },
      { kind: "resource-handle" as const, uri: "app://items/item-1" },
    ]) {
      const authorize = (ordered: RuntimeModule[]) => authorizeMcpRequest(
        ordered,
        projection.session,
        { action: "read", subject },
        async () => ({
          allowed: true,
          fieldAllowlist: ["title", "summary", "id"],
        }),
      );
      await expect(authorize(modules)).resolves.toEqual({
        allowed: true,
        fieldAllowlist: ["id", "title"],
      });
      await expect(authorize([...modules].reverse())).resolves.toEqual({
        allowed: true,
        fieldAllowlist: ["id", "title"],
      });
    }
  });

  it("makes a participating denial win while abstentions preserve core", async () => {
    const request: ModuleAuthorizationRequest = {
      action: "call",
      subject: { kind: "tool", name: "preview_item" },
    };
    const modules: RuntimeModule[] = [
      { name: "abstain", mcp: { authorize: async () => undefined } },
      { name: "allow", mcp: { authorize: async () => ({ allowed: true }) } },
      {
        name: "deny",
        mcp: {
          authorize: async () => ({ allowed: false, code: "FORBIDDEN" }),
        },
      },
    ];
    await expect(authorizeMcpRequest(
      modules,
      projection.session,
      request,
      async () => ({ allowed: true }),
    )).resolves.toEqual({ allowed: false, code: "FORBIDDEN" });

    const notFound = { allowed: false as const, code: "NOT_FOUND" as const };
    await expect(authorizeMcpRequest(
      [{ name: "abstain", mcp: { authorize: async () => undefined } }],
      projection.session,
      request,
      async () => notFound,
    )).resolves.toEqual(notFound);
    await expect(authorizeMcpRequest(
      [],
      projection.session,
      request,
      async () => notFound,
    )).resolves.toBe(notFound);

    const coreAllow = {
      allowed: true as const,
      fieldAllowlist: ["title", "id"] as const,
    };
    await expect(authorizeMcpRequest(
      [],
      projection.session,
      request,
      async () => coreAllow,
    )).resolves.toBe(coreAllow);
    await expect(authorizeMcpRequest(
      [{ name: "abstain", mcp: { authorize: async () => undefined } }],
      projection.session,
      request,
      async () => coreAllow,
    )).resolves.toBe(coreAllow);
  });

  it("keeps non-not-found core denials authoritative", async () => {
    await expect(authorizeMcpRequest(
      [{ name: "claim", mcp: { authorize: async () => ({ allowed: true }) } }],
      projection.session,
      { action: "read", subject: { kind: "tool", name: "core_tool" } },
      async () => ({ allowed: false, code: "REAUTHORIZATION_REQUIRED" }),
    )).resolves.toEqual({ allowed: false, code: "REAUTHORIZATION_REQUIRED" });
  });

  it("fails closed on malformed or rejected module decisions", async () => {
    const request: ModuleAuthorizationRequest = {
      action: "read",
      subject: { kind: "resource-handle", uri: "app://artifacts/item-1" },
    };
    for (const authorize of [
      async () => ({ allowed: true, fieldAllowlist: ["id", 1] }) as never,
      async () => ({ allowed: true, fieldAllowlist: [""] }) as never,
      async () => ({ allowed: true, extra: true }) as never,
      async () => ({ allowed: "yes" }) as never,
      async () => ({ allowed: false, code: "UNKNOWN" }) as never,
      async () => { throw new Error("private module failure"); },
    ]) {
      await expect(authorizeMcpRequest(
        [{ name: "invalid", mcp: { authorize } }],
        projection.session,
        request,
        async () => ({ allowed: true }),
      )).resolves.toEqual({ allowed: false, code: "FORBIDDEN" });
    }
  });

  it("refuses recursive platform authorization composition", async () => {
    const request: ModuleAuthorizationRequest = {
      action: "read",
      subject: { kind: "resource-handle", uri: "app://items/item-1" },
    };
    await expect(authorizeMcpRequest(
      [{
        name: "recursive",
        mcp: {
          authorize: async () => authorizeMcpRequest(
            [],
            projection.session,
            request,
            async () => ({ allowed: true }),
          ),
        },
      }],
      projection.session,
      request,
      async () => ({ allowed: true }),
    )).resolves.toEqual({ allowed: false, code: "FORBIDDEN" });
  });

  it("lists and decorates in registration order while preserving dispatch identity", async () => {
    const modules: RuntimeModule[] = [
      {
        name: "first",
        mcp: {
          tools: async () => [tool("first_tool")],
          decorateTool: (value) => ({ ...value, description: `${value.description}:first` }),
          callTool: async () => ({ content: [{ type: "text", text: "first" }] }),
        },
      },
      {
        name: "second",
        mcp: {
          tools: async () => [tool("second_tool")],
          decorateTool: (value) => ({ ...value, description: `${value.description}:second` }),
        },
      },
    ];
    const listed = await moduleTools(modules, projection);
    expect(listed.map(({ tool: value }) => value.name)).toEqual(["first_tool", "second_tool"]);
    expect(decorateMcpTools(listed, modules, projection).map(({ tool: value }) => value.description)).toEqual([
      "first_tool:first:second",
      "second_tool:first:second",
    ]);
    expect((await invokeModuleTool(listed[0]!, "first_tool", {}, invocation)).result.content[0]).toMatchObject({ text: "first" });
  });

  it("rejects duplicate and renamed tools", async () => {
    expect(() => assertUniqueToolNames([
      { tool: tool("same"), source: "crud" },
      { tool: tool("same"), source: "module" },
    ])).toThrow(/more than once/);
    expect(() => decorateMcpTools(
      [{ tool: tool("fixed"), source: "crud" }],
      [{ name: "renamer", mcp: { decorateTool: (value) => ({ ...value, name: "changed" }) } }],
      projection,
    )).toThrow(/must preserve tool name/);
    const original = tool("fixed");
    expect(() => decorateMcpTools(
      [{ tool: original, source: "crud" }],
      [{
        name: "in-place-renamer",
        mcp: {
          decorateTool: (value) => {
            value.name = "changed";
            return value;
          },
        },
      }],
      projection,
    )).toThrow(/must preserve tool name/);
    expect(original.name).toBe("fixed");
  });

  it("orders interceptors, supports short-circuiting, and refuses a second next", async () => {
    const order: string[] = [];
    const modules: RuntimeModule[] = ["outer", "inner"].map((name) => ({
      name,
      mcp: {
        interceptToolCall: async (_call, next) => {
          order.push(`${name}:before`);
          const result = await next();
          order.push(`${name}:after`);
          return result;
        },
      },
    }));
    await interceptMcpToolCall(
      modules,
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => {
        order.push("invoke");
        return { result: { content: [] } };
      },
    );
    expect(order).toEqual(["outer:before", "inner:before", "invoke", "inner:after", "outer:after"]);

    let invoked = 0;
    await expect(interceptMcpToolCall(
      [{
        name: "twice",
        mcp: {
          interceptToolCall: async (_call, next) => {
            await next();
            return next();
          },
        },
      }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => {
        invoked += 1;
        return { result: { content: [] } };
      },
    )).rejects.toThrow(/at most once/);
    expect(invoked).toBe(1);

    const short = await interceptMcpToolCall(
      [{ name: "stop", mcp: { interceptToolCall: async () => ({ result: { content: [{ type: "text", text: "stopped" }] } }) } }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => { throw new Error("must not run"); },
    );
    expect(short.result.content[0]).toMatchObject({ text: "stopped" });
  });

  it("permits each distinct source once while refusing replay and a second default", async () => {
    const invoked: string[] = [];
    const definitions = { kind: "definition", id: "definition-1", version: 1 };
    await expect(interceptMcpToolCall(
      [{
        name: "fanout",
        mcp: {
          interceptToolCall: async (_call, next) => {
            await Promise.all([
              next({ sourceHandle: "first", expectedDefinition: definitions }),
              next({ sourceHandle: "second", expectedDefinition: definitions }),
            ]);
            return next({ sourceHandle: "first", expectedDefinition: definitions });
          },
        },
      }],
      { name: "read", source: "derived", arguments: {}, ctx: invocation },
      async (options) => {
        invoked.push((options as { sourceHandle: string }).sourceHandle);
        return { result: { content: [] } };
      },
    )).rejects.toThrow(/at most once/);
    expect(invoked.sort()).toEqual(["first", "second"]);

    let defaults = 0;
    await expect(interceptMcpToolCall(
      [{
        name: "default-twice",
        mcp: { interceptToolCall: async (_call, next) => { await next(); return next(); } },
      }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => { defaults += 1; return { result: { content: [] } }; },
    )).rejects.toThrow(/at most once/);
    expect(defaults).toBe(1);
  });

  it("invalidates a retained next capability when the interceptor returns", async () => {
    let retained:
      | (() => Promise<ModuleToolExecutionResult>)
      | undefined;
    let invoked = 0;
    const short = await interceptMcpToolCall(
      [{
        name: "retainer",
        mcp: {
          interceptToolCall: async (_call, next) => {
            retained = () => next();
            return { result: { content: [] } };
          },
        },
      }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => {
        invoked += 1;
        return { result: { content: [] } };
      },
    );
    expect(short.result.isError).not.toBe(true);
    expect(() => retained!()).toThrow(/no longer active/);
    expect(invoked).toBe(0);
  });

  it("drains a started void-next execution before resolving the chain", async () => {
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let effect = false;
    let settled = false;
    const outcome = interceptMcpToolCall(
      [{
        name: "void-next",
        mcp: {
          interceptToolCall: async (_call, next) => {
            void next();
            await entered;
            return { result: { content: [] } };
          },
        },
      }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => {
        started();
        await barrier;
        effect = true;
        return { result: { content: [] } };
      },
    );
    void outcome.then(() => { settled = true; });
    await entered;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(effect).toBe(false);
    release();
    await outcome;
    expect(effect).toBe(true);
    expect(settled).toBe(true);
  });

  it("drains a started void-next execution before rejecting the chain", async () => {
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let effect = false;
    let settled = false;
    const outcome = interceptMcpToolCall(
      [{
        name: "throw-after-void-next",
        mcp: {
          interceptToolCall: async (_call, next) => {
            void next();
            await entered;
            throw new Error("policy failure");
          },
        },
      }],
      { name: "mutate", source: "crud", arguments: {}, ctx: invocation },
      async () => {
        started();
        await barrier;
        effect = true;
        return { result: { content: [] } };
      },
    );
    void outcome.catch(() => undefined).finally(() => { settled = true; });
    await entered;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(effect).toBe(false);
    release();
    await expect(outcome).rejects.toThrow("policy failure");
    expect(effect).toBe(true);
    expect(settled).toBe(true);
  });

  it("freezes a cloned call envelope before any interceptor sees it", async () => {
    const callerArguments = { nested: { value: "original" } };
    let innerValue: unknown;
    const modules: RuntimeModule[] = [
      {
        name: "outer",
        mcp: {
          interceptToolCall: async (call, next) => {
            expect(Object.isFrozen(call)).toBe(true);
            expect(Object.isFrozen(call.arguments)).toBe(true);
            expect(Object.isFrozen(call.arguments.nested)).toBe(true);
            expect(() => {
              (call.arguments.nested as { value: string }).value = "changed";
            }).toThrow();
            callerArguments.nested.value = "caller-changed";
            return next();
          },
        },
      },
      {
        name: "inner",
        mcp: {
          interceptToolCall: async (call, next) => {
            innerValue = (call.arguments.nested as { value: string }).value;
            return next();
          },
        },
      },
    ];
    await interceptMcpToolCall(
      modules,
      { name: "read", source: "derived", arguments: callerArguments, ctx: invocation },
      async () => ({ result: { content: [] } }),
    );
    expect(innerValue).toBe("original");
  });

  it("routes exact and RFC6570 template resources to one owner and runs no hook for unknown URIs", async () => {
    const calls: string[] = [];
    const exact: RuntimeModule = {
      name: "exact",
      mcp: {
        resources: async () => [{ uri: "app://items/current", name: "current" }],
        readResource: async (uri) => {
          calls.push(`exact:${uri}`);
          return { contents: [{ uri, text: "exact" }] };
        },
      },
    };
    const templated: RuntimeModule = {
      name: "template",
      mcp: {
        resourceTemplates: async () => [{ uriTemplate: "app://items/{id}", name: "item" }],
        readResource: async (uri) => {
          calls.push(`template:${uri}`);
          return { contents: [{ uri, text: "template" }] };
        },
      },
    };
    expect((await moduleResources([exact], projection)).map((entry) => entry.uri)).toEqual(["app://items/current"]);
    expect((await moduleResourceTemplates([templated], projection))[0]?.uriTemplate).toBe("app://items/{id}");
    expect((await readModuleResource([exact], "app://items/current", invocation))?.contents[0]).toMatchObject({ text: "exact" });
    expect((await readModuleResource([templated], "app://items/42", invocation))?.contents[0]).toMatchObject({ text: "template" });
    calls.length = 0;
    expect(await readModuleResource([exact], "app://unknown/random", invocation)).toBeUndefined();
    expect(calls).toEqual([]);
    await expect(readModuleResource([exact, templated], "app://items/current", invocation)).rejects.toThrow(/ambiguous exact\/template ownership/);

    await expect(moduleResources([exact], projection, {
      exact: ["app://items/current"],
      templates: [],
    })).rejects.toThrow(/more than once/);
    await expect(moduleResources([exact], projection, {
      exact: [],
      templates: ["app://items/{id}"],
    })).rejects.toThrow(/ambiguous exact\/template ownership/);
    await expect(moduleResourceTemplates([templated], projection, {
      exact: ["app://items/current"],
      templates: [],
    })).rejects.toThrow(/ambiguous exact\/template ownership/);
    calls.length = 0;
    await expect(readModuleResource([exact], "app://items/current", invocation, {
      exact: ["app://items/current"],
      templates: [],
    })).rejects.toThrow(/more than once/);
    expect(calls).toEqual([]);
  });
});
