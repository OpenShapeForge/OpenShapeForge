// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type {
  McpInvocationContext,
  McpProjectionContext,
  ModuleToolExecutionResult,
  RuntimeModule,
} from "../contract.js";
import {
  assertUniqueToolNames,
  decorateMcpTools,
  interceptMcpToolCall,
  invokeModuleTool,
  moduleResourceTemplates,
  moduleResources,
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
