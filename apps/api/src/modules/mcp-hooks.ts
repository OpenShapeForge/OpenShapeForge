// SPDX-License-Identifier: BUSL-1.1
/** Deterministic composition of runtime-module MCP hooks. */
import type {
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type {
  McpInvocationContext,
  McpProjectionContext,
  McpToolCallSource,
  ModuleToolExecutionOptions,
  ModuleToolExecutionResult,
  RuntimeModule,
} from "./contract.js";

export type SourcedTool = {
  tool: Tool;
  source: McpToolCallSource;
  owner?: RuntimeModule;
};

export type CoreResourceOwnership = {
  exact: readonly string[];
  templates: readonly string[];
};

type ProjectedModuleResources = {
  resources: Resource[];
  templates: ResourceTemplate[];
  ownerFor(uri: string): RuntimeModule | "core" | undefined;
};

async function projectModuleResources(
  modules: readonly RuntimeModule[],
  context: McpProjectionContext,
  core: CoreResourceOwnership = { exact: [], templates: [] },
): Promise<ProjectedModuleResources> {
  const resources: Resource[] = [];
  const templates: ResourceTemplate[] = [];
  const exactClaims = new Map<string, RuntimeModule | "core">();
  const templateClaims = new Map<string, RuntimeModule | "core">();
  for (const uri of core.exact) exactClaims.set(uri, "core");
  for (const uriTemplate of core.templates) templateClaims.set(uriTemplate, "core");

  for (const module of modules) {
    for (const resource of (await module.mcp?.resources?.(context)) ?? []) {
      if (exactClaims.has(resource.uri)) {
        throw new Error(`MCP resource URI ${JSON.stringify(resource.uri)} is contributed more than once.`);
      }
      exactClaims.set(resource.uri, module);
      resources.push(resource);
    }
    for (const template of (await module.mcp?.resourceTemplates?.(context)) ?? []) {
      if (templateClaims.has(template.uriTemplate)) {
        throw new Error(`MCP resource template ${JSON.stringify(template.uriTemplate)} is contributed more than once.`);
      }
      templateClaims.set(template.uriTemplate, module);
      templates.push(template);
    }
  }

  const compiledTemplates = [...templateClaims].map(([template, owner]) => ({
    template,
    owner,
    matcher: new UriTemplate(template),
  }));
  for (const [uri, exactOwner] of exactClaims) {
    for (const template of compiledTemplates) {
      if (template.owner !== exactOwner && template.matcher.match(uri) !== null) {
        throw new Error(
          `MCP resource URI ${JSON.stringify(uri)} has ambiguous exact/template ownership.`,
        );
      }
    }
  }

  return {
    resources,
    templates,
    ownerFor: (uri) => {
      const owners = new Set<RuntimeModule | "core">();
      const exact = exactClaims.get(uri);
      if (exact) owners.add(exact);
      for (const template of compiledTemplates) {
        if (template.matcher.match(uri) !== null) owners.add(template.owner);
      }
      if (owners.size > 1) {
        throw new Error(`MCP resource URI ${JSON.stringify(uri)} has more than one owner.`);
      }
      return owners.values().next().value;
    },
  };
}

export async function moduleTools(
  modules: readonly RuntimeModule[],
  context: McpProjectionContext,
): Promise<SourcedTool[]> {
  const result: SourcedTool[] = [];
  for (const module of modules) {
    for (const tool of (await module.mcp?.tools?.(context)) ?? []) {
      result.push({ tool, source: "module", owner: module });
    }
  }
  return result;
}

export function decorateMcpTools(
  tools: readonly SourcedTool[],
  modules: readonly RuntimeModule[],
  context: McpProjectionContext,
): SourcedTool[] {
  return tools.map((entry) => {
    const originalName = entry.tool.name;
    let tool = { ...entry.tool };
    for (const module of modules) {
      const input = { ...tool };
      tool = module.mcp?.decorateTool?.(input, entry.source, context) ?? input;
      if (tool.name !== originalName) {
        throw new Error(
          `MCP decorators must preserve tool name ${JSON.stringify(originalName)}.`,
        );
      }
    }
    return { ...entry, tool };
  });
}

/** Duplicate dynamic names are a boot-state error, never first/last-wins. */
export function assertUniqueToolNames(tools: readonly SourcedTool[]): void {
  const seen = new Set<string>();
  for (const { tool } of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`MCP tool name ${JSON.stringify(tool.name)} is contributed more than once.`);
    }
    seen.add(tool.name);
  }
}

export async function moduleResources(
  modules: readonly RuntimeModule[],
  context: McpProjectionContext,
  core?: CoreResourceOwnership,
): Promise<Resource[]> {
  return (await projectModuleResources(modules, context, core)).resources;
}

export async function moduleResourceTemplates(
  modules: readonly RuntimeModule[],
  context: McpProjectionContext,
  core?: CoreResourceOwnership,
): Promise<ResourceTemplate[]> {
  return (await projectModuleResources(modules, context, core)).templates;
}

export async function readModuleResource(
  modules: readonly RuntimeModule[],
  uri: string,
  context: McpInvocationContext,
  core?: CoreResourceOwnership,
) {
  const read = await prepareModuleResourceRead(
    modules,
    uri,
    context,
    context,
    core,
  );
  return read?.();
}

/** Resolve and validate ownership once, before any core or module read runs. */
export async function prepareModuleResourceRead(
  modules: readonly RuntimeModule[],
  uri: string,
  projectionContext: McpProjectionContext,
  invocationContext: McpInvocationContext,
  core?: CoreResourceOwnership,
): Promise<(() => Promise<ReadResourceResult | undefined>) | undefined> {
  const projection = await projectModuleResources(
    modules,
    projectionContext,
    core,
  );
  const owner = projection.ownerFor(uri);
  if (!owner || owner === "core") return undefined;
  const hook = owner.mcp?.readResource;
  return hook ? () => hook(uri, invocationContext) : undefined;
}

export async function invokeModuleTool(
  entry: SourcedTool,
  name: string,
  args: Record<string, unknown>,
  context: McpInvocationContext,
): Promise<ModuleToolExecutionResult> {
  const call = entry.owner?.mcp?.callTool;
  if (!call) {
    throw new Error(
      `Runtime module ${JSON.stringify(entry.owner?.name)} lists tool ${JSON.stringify(name)} without a callTool hook.`,
    );
  }
  return { result: await call(name, args, context) };
}

/** Registration order is outer-to-inner and therefore observable and stable. */
export async function interceptMcpToolCall(
  modules: readonly RuntimeModule[],
  call: {
    name: string;
    source: McpToolCallSource;
    arguments: Record<string, unknown>;
    ctx: McpInvocationContext;
  },
  invoke: (
    options?: ModuleToolExecutionOptions,
    assertActive?: () => void,
  ) => Promise<ModuleToolExecutionResult>,
): Promise<ModuleToolExecutionResult> {
  const deepFreeze = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested, seen);
    }
    return Object.freeze(value);
  };
  const immutableCall = Object.freeze({
    ...call,
    arguments: deepFreeze(structuredClone(call.arguments)) as Record<
      string,
      unknown
    >,
  });
  const interceptors = modules
    .map((module) => module.mcp?.interceptToolCall)
    .filter((hook): hook is NonNullable<typeof hook> => hook !== undefined);
  const invocationKey = (options?: ModuleToolExecutionOptions): string => {
    const unsafe = options as
      | { sourceHandle?: unknown; sourceReference?: unknown }
      | undefined;
    if (typeof unsafe?.sourceHandle === "string") {
      return `handle:${unsafe.sourceHandle}`;
    }
    if (typeof unsafe?.sourceReference === "string") {
      return `reference:${unsafe.sourceReference}`;
    }
    return "default";
  };
  const invoked = new Set<string>();
  const pendingExecutions = new Set<Promise<unknown>>();
  let acceptingNext = true;
  let executionActive = true;
  const assertNext = () => {
    if (!acceptingNext) {
      throw new Error("An MCP interceptor next capability is no longer active.");
    }
  };
  const assertExecutionActive = () => {
    if (!executionActive) {
      throw new Error("The MCP interceptor invocation is no longer active.");
    }
  };
  let next = (options?: ModuleToolExecutionOptions) => {
    assertNext();
    const key = invocationKey(options);
    if (invoked.has(key)) {
      throw new Error("An MCP interceptor may call next at most once.");
    }
    invoked.add(key);
    const promise = invoke(options, assertExecutionActive);
    pendingExecutions.add(promise);
    // A hostile interceptor may intentionally discard the promise. Keep the
    // rejection observed while the execution path's liveness guard prevents
    // it from crossing the invocation boundary after an async wait.
    void promise.catch(() => undefined);
    void promise.finally(() => pendingExecutions.delete(promise)).catch(
      () => undefined,
    );
    return promise;
  };
  for (let index = interceptors.length - 1; index >= 0; index -= 1) {
    const interceptor = interceptors[index]!;
    const downstream = next;
    const called = new Set<string>();
    next = (options) => {
      assertNext();
      return interceptor(immutableCall, (innerOptions = options) => {
        assertNext();
        const key = invocationKey(innerOptions);
        if (called.has(key)) {
          throw new Error("An MCP interceptor may call next at most once.");
        }
        called.add(key);
        return downstream(innerOptions);
      });
    };
  }
  let result: ModuleToolExecutionResult | undefined;
  let failure: unknown;
  let rejected = false;
  try {
    result = await next();
  } catch (error) {
    rejected = true;
    failure = error;
  }
  acceptingNext = false;
  while (pendingExecutions.size > 0) {
    await Promise.allSettled([...pendingExecutions]);
  }
  executionActive = false;
  if (rejected) throw failure;
  return result!;
}
