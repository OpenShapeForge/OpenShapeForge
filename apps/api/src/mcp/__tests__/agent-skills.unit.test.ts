// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, fromJsonSchema } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { RuntimeModule } from "../../modules/contract.js";
import { projectAgentSkills, visibleAgentSkills, readAgentSkillResource, registerAgentSkillHandlers, SKILLS_EXTENSION } from "../agent-skills.js";
import { handleModernMcpRequest } from "../modern-http.js";

const markdown = "---\nname: sync-records\ndescription: Sync records from a source.\nmetadata:\n  audience: author\n---\n# Sync\nUse the source identity. Één bron.\n";
const module: RuntimeModule = {
  name: "test-plugin",
  agentSkills: [{ path: "sync-records", roles: ["Workflow.All.Manage"], files: {
    "SKILL.md": { text: markdown, mimeType: "text/markdown" },
    "references/input.md": { text: "Inspect the live input contract.", mimeType: "text/markdown" },
  } }],
};

function serverFor(roles: string[]) {
  const allSkills = projectAgentSkills([module]);
  const skillsForSession = () => visibleAgentSkills(allSkills, roles);
  const server = new Server({ name: "skill-test", version: "1" }, {
    capabilities: { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION]: {} } },
  });
  registerAgentSkillHandlers(server, skillsForSession);
  server.setRequestHandler("resources/list", async () => ({ resources: skillsForSession().flatMap((skill) => skill.resources) }));
  server.setRequestHandler("resources/read", async (request) => {
    const result = readAgentSkillResource(skillsForSession(), request.params.uri);
    if (!result) throw new Error("Resource not found.");
    return result;
  });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  return server;
}

async function withClient(roles: string[], work: (client: Client) => Promise<void>) {
  const server = serverFor(roles);
  const client = new Client({ name: "skill-reader", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const anyResult = fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true });
describe("MCP Agent Skills", () => {
  it("publishes complete manifests whose digest and byte size match the readable content", async () => {
    await withClient(["Workflow.All.Manage"], async (client) => {
      const result = await client.request({ method: "skills/list", params: {} }, anyResult);
      const skills = result.skills as Array<{ uri: string; frontmatter: Record<string, unknown>; resources: Array<{ uri: string; size: number; digest: string }> }>;
      expect(skills).toHaveLength(1);
      expect(skills[0]!.frontmatter.metadata).toEqual({ audience: "author" });
      expect(skills[0]!.resources).toHaveLength(2);
      const listed = await client.listResources();
      expect(listed.resources.map((entry) => entry.uri).sort()).toEqual(skills[0]!.resources.map((entry) => entry.uri).sort());
      for (const resource of skills[0]!.resources) {
        const read = await client.readResource({ uri: resource.uri });
        const content = read.contents[0]!;
        expect("text" in content).toBe(true);
        const bytes = Buffer.from("text" in content ? content.text : "", "utf8");
        expect(bytes.length).toBe(resource.size);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(resource.digest);
      }
      const single = await client.request({ method: "skills/get", params: { uri: skills[0]!.uri } }, anyResult);
      expect(single.skill).toEqual(skills[0]);
    });
  });

  it("hides restricted skills from discovery and direct reads for an unrelated role", async () => {
    await withClient(["Workflow.All.Read"], async (client) => {
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.request({ method: "skills/list", params: {} }, anyResult)).skills).toEqual([]);
      await expect(client.request({ method: "skills/get", params: { uri: "skill://sync-records/SKILL.md" } }, anyResult)).rejects.toThrow("Skill not found");
      await expect(client.readResource({ uri: "skill://sync-records/SKILL.md" })).rejects.toThrow("Resource not found");
    });
  });

  it("rejects traversal, mismatched frontmatter, and duplicate skill ownership", () => {
    const contribution = module.agentSkills![0]!;
    expect(() => projectAgentSkills([{ name: "bad", agentSkills: [{ ...contribution, path: "../sync-records" }] }])).toThrow("Invalid Agent Skill path");
    expect(() => projectAgentSkills([{ name: "bad", agentSkills: [{ ...contribution, path: "wrong-name" }] }])).toThrow("frontmatter");
    expect(() => projectAgentSkills([{ name: "bad", agentSkills: [{ ...contribution, files: { ...contribution.files, "../secret": { text: "private", mimeType: "text/plain" } } }] }])).toThrow("file path");
    expect(() => projectAgentSkills([module, module])).toThrow("more than once");
  });

  it("applies role revocation and restoration to discovery and reads on the same connected client", async () => {
    const roles = ["Workflow.All.Manage"];
    await withClient(roles, async (client) => {
      expect((await client.listResources()).resources).toHaveLength(2);
      roles.splice(0, roles.length, "Workflow.All.Read");
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.request({ method: "skills/list", params: {} }, anyResult)).skills).toEqual([]);
      await expect(client.request({ method: "skills/get", params: { uri: "skill://sync-records/SKILL.md" } }, anyResult)).rejects.toThrow("Skill not found");
      await expect(client.readResource({ uri: "skill://sync-records/SKILL.md" })).rejects.toThrow("Resource not found");
      roles.splice(0, roles.length, "Workflow.All.Manage");
      expect((await client.listResources()).resources).toHaveLength(2);
      expect((await client.request({ method: "skills/list", params: {} }, anyResult)).skills).toHaveLength(1);
      expect((await client.request({ method: "skills/get", params: { uri: "skill://sync-records/SKILL.md" } }, anyResult)).skill).toBeDefined();
      expect((await client.readResource({ uri: "skill://sync-records/SKILL.md" })).contents[0]).toMatchObject({ text: markdown });
    });
  });

  it("serves the latest protocol and the existing initialize protocol over real HTTP", async () => {
    const app = Fastify();
    app.all("/mcp", async (request, reply) => {
      const build = () => serverFor(request.headers["x-test-role"] === "manager" ? ["Workflow.All.Manage"] : []);
      if (await handleModernMcpRequest(request, reply, build)) return;
      const server = build();
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.raw.on("close", () => { void server.close(); void transport.close(); });
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      for (const modern of [true, false]) {
        const client = new Client({ name: "workflow-http", version: "1" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
        await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { "x-test-role": "manager" } } }));
        try {
          expect(client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
          const result = await client.request({ method: "skills/get", params: { uri: "skill://sync-records/SKILL.md" } }, anyResult);
          expect(result.skill).toBeDefined();
          const resource = await client.readResource({ uri: "skill://sync-records/SKILL.md" });
          expect(resource.contents[0]).toMatchObject({ text: markdown });
        } finally { await client.close(); }
      }
      const denied = new Client({ name: "reader", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await denied.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
      try { expect((await denied.listResources()).resources).toEqual([]); }
      finally { await denied.close(); }
    } finally { await app.close(); }
  });
});
