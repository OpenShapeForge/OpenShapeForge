// SPDX-License-Identifier: BUSL-1.1
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const DISCOVERY_NAMES = ["osf_search_tools", "osf_read_tool", "osf_call_tool"] as const;
const names = new Set<string>(DISCOVERY_NAMES);

/** Absent preserves existing deployments; an explicit empty array pins only discovery. */
export function readToolPins(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MCP pinned tools must be a JSON array of tool names."); }
  if (!Array.isArray(parsed) || parsed.length > 60 || parsed.some(name =>
    typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(name))) {
    throw new Error("MCP pinned tools must contain at most 60 valid tool names.");
  }
  return new Set(parsed);
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const discoveryTools: Tool[] = [
  {
    name: DISCOVERY_NAMES[0], title: "Find available tools",
    description: "Search tools available to you by intent or name. Results are summaries; use osf_read_tool for the full input contract, then osf_call_tool to execute. No result grants additional permissions.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", maxLength: 500 },
      after: { type: "string", maxLength: 128, description: "Continue after the last tool name returned in nextCursor." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    } }, annotations: readAnnotations,
  },
  {
    name: DISCOVERY_NAMES[1], title: "Read a tool contract",
    description: "Get the complete description, input schema, output schema and safety annotations of an available tool before calling it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 128 } } }, annotations: readAnnotations,
  },
  {
    name: DISCOVERY_NAMES[2], title: "Call a discovered tool",
    description: "Execute an available tool by name using its exact input contract. Read the tool first. This may modify or delete data: follow the target tool's description, annotations and the user's authorization. The normal permission, validation, audit and execution checks still apply.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      arguments: { type: "object", additionalProperties: true },
    } }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message: string): CallToolResult => ({ ...result({ error: message }), isError: true });

/** The supplied catalog must already be tenant-, audience- and publication-filtered. */
export function createToolDiscovery(input: {
  pins: Set<string>;
  available: () => Promise<Tool[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}) {
  const available = async () => {
    const tools = await input.available();
    if (tools.some(tool => names.has(tool.name))) throw new Error("Reserved discovery tool name collision.");
    return tools;
  };
  return {
    async listed(): Promise<Tool[]> {
      return [...discoveryTools, ...(await available()).filter(tool => input.pins.has(tool.name))];
    },
    async handle(name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
      if (!names.has(name)) return undefined;
      if (name === DISCOVERY_NAMES[0]) {
        if (Object.keys(args).some(key => !["query", "after", "limit"].includes(key)) ||
          (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 500)) ||
          (args.after !== undefined && (typeof args.after !== "string" || args.after.length > 128)) ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50))) return error("Invalid search arguments.");
        const terms = String(args.query ?? "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const limit = Number(args.limit ?? 20);
        const tools = (await available()).filter(tool => {
          const text = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLocaleLowerCase();
          return terms.every(term => text.includes(term)) && (!args.after || tool.name > String(args.after));
        }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const page = tools.slice(0, limit);
        return result({ tools: page.map(tool => ({ name: tool.name, title: tool.title, description: tool.description?.slice(0, 240), annotations: tool.annotations })), nextCursor: tools.length > limit ? page.at(-1)!.name : null });
      }
      const allowed = name === DISCOVERY_NAMES[1] ? ["name"] : ["name", "arguments"];
      if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.name !== "string" || args.name.length === 0 || args.name.length > 128 || names.has(args.name)) return error("Invalid tool name or arguments.");
      const tool = (await available()).find(tool => tool.name === args.name);
      if (!tool) return error("Tool not found.");
      if (name === DISCOVERY_NAMES[1]) return result(tool);
      if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) return error("Tool arguments must be an object.");
      // Re-enter the normal external dispatch path, never privileged internal invocation.
      return input.call(tool.name, args.arguments as Record<string, unknown>);
    },
  };
}
