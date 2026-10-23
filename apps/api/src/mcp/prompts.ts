// SPDX-License-Identifier: BUSL-1.1
/** Static product-owned prompts, projected under the admitted session. */
import { ProtocolError, ProtocolErrorCode, type Server } from "@modelcontextprotocol/server";
import type { RuntimeMcpPrompt } from "@openshapeforge/plugin-runtime";

export function projectPrompts(modules: readonly { mcpPrompts?: readonly RuntimeMcpPrompt[] }[]): readonly RuntimeMcpPrompt[] {
  const names = new Set<string>();
  return modules.flatMap((module) => (module.mcpPrompts ?? []).map((prompt) => {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(prompt.name) ||
        !prompt.title.trim() || !prompt.description.trim() || !prompt.text.trim()) {
      throw new Error("MCP prompts require a valid name, title, description and text.");
    }
    // Check ownership before filtering: role changes cannot change the owner.
    if (names.has(prompt.name)) throw new Error(`Duplicate MCP prompt: ${prompt.name}`);
    names.add(prompt.name);
    return Object.freeze({ ...prompt, ...(prompt.roles ? { roles: Object.freeze([...prompt.roles]) } : {}) });
  }));
}

export function registerPromptHandlers(server: Server, prompts: readonly RuntimeMcpPrompt[], roles: readonly string[]): void {
  const visible = () => prompts.filter((prompt) => !prompt.roles || prompt.roles.some((role) => roles.includes(role)));
  server.setRequestHandler("prompts/list", async ({ params = {} }) => {
    if (params.cursor !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown prompt cursor.");
    return { prompts: visible().map(({ name, title, description }) => ({ name, title, description })) };
  });
  server.setRequestHandler("prompts/get", async ({ params }) => {
    const prompt = visible().find(({ name }) => name === params.name);
    if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown prompt.");
    if (Object.keys(params.arguments ?? {}).length > 0) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "This prompt does not accept arguments.");
    }
    return { description: prompt.description, messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text } }] };
  });
}
