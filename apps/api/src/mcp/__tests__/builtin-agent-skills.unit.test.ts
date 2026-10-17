// SPDX-License-Identifier: BUSL-1.1
/**
 * The server's own Agent Skill, over a real MCP client.
 *
 * It travels the same projection, manifest and visibility path a plugin's
 * skill does (agent-skills.unit.test.ts covers that path's refusals), so what
 * is asserted here is what is specific to a BUILT-IN contribution: that it
 * reaches a session which holds no roles at all without carrying a role-gated
 * plugin skill with it, that every pointer in its entry resolves to something
 * this server actually serves, and that it names nothing deployment-specific.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, fromJsonSchema } from "@modelcontextprotocol/server";
import type { RuntimeModule } from "../../modules/contract.js";
import {
  projectAgentSkills,
  visibleAgentSkills,
  readAgentSkillResource,
  registerAgentSkillHandlers,
  SKILLS_EXTENSION,
} from "../agent-skills.js";
import { BUILTIN_AGENT_SKILL_MODULE, BUILTIN_AGENT_SKILL_PATH } from "../builtin-agent-skills.js";
import { buildServerInstructions, ENTITY_CATALOG_URI } from "../server-instructions.js";
import { resolveLocale } from "../locale.js";
import { SESSION_RESOURCE_URI } from "../session-info.js";

const BUILTIN_URI = `skill://${BUILTIN_AGENT_SKILL_PATH}/SKILL.md`;

/** A role-gated plugin skill, so visibility is tested against a real neighbour. */
const PLUGIN_SKILL_URI = "skill://sync-records/SKILL.md";
const pluginModule: RuntimeModule = {
  name: "test-plugin",
  agentSkills: [{
    path: "sync-records",
    roles: ["Workflow.All.Manage"],
    files: { "SKILL.md": { text: "---\nname: sync-records\ndescription: Sync records from a source.\n---\n# Sync\n", mimeType: "text/markdown" } },
  }],
};

type ManifestFile = { uri: string; digest: string; size: number };
type SkillEntry = { uri: string; frontmatter: Record<string, unknown>; resources: ManifestFile[] };

/** The server as server-scope.ts composes it: the built-in first, then plugins. */
function serverFor(roles: readonly string[]) {
  const all = projectAgentSkills([BUILTIN_AGENT_SKILL_MODULE, pluginModule]);
  const skillsForSession = () => visibleAgentSkills(all, roles);
  const server = new Server({ name: "builtin-skill-test", version: "1" }, {
    capabilities: { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION]: {} } },
  });
  registerAgentSkillHandlers(server, skillsForSession);
  server.setRequestHandler("resources/list", async () => ({
    resources: skillsForSession().flatMap((skill) => skill.resources),
  }));
  server.setRequestHandler("resources/read", async (request) => {
    const result = readAgentSkillResource(skillsForSession(), request.params.uri);
    if (!result) throw new Error("Resource not found.");
    return result;
  });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  return server;
}

async function withClient(roles: readonly string[], work: (client: Client) => Promise<void>) {
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
const listSkills = async (client: Client) =>
  (await client.request({ method: "skills/list", params: {} }, anyResult)).skills as SkillEntry[];

describe("the server's built-in Agent Skill", () => {
  it("publishes a complete manifest whose digest and size match the readable bytes", async () => {
    await withClient(["Workflow.All.Manage"], async (client) => {
      const skills = await listSkills(client);
      const builtin = skills.find((skill) => skill.uri === BUILTIN_URI);
      expect(builtin).toBeDefined();
      expect(builtin!.frontmatter.name).toBe("coordinating-capabilities");
      // Listed beside the plugin's, not instead of it, and every file it
      // claims is both listed as a resource and readable as the exact bytes.
      expect(skills.map((skill) => skill.uri).sort()).toEqual([BUILTIN_URI, PLUGIN_SKILL_URI].sort());
      const listed = (await client.listResources()).resources.map((entry) => entry.uri);
      for (const file of builtin!.resources) {
        expect(listed).toContain(file.uri);
        const content = (await client.readResource({ uri: file.uri })).contents[0]!;
        expect("text" in content).toBe(true);
        const bytes = Buffer.from("text" in content ? content.text : "", "utf8");
        expect(bytes.length).toBe(file.size);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(file.digest);
      }
      const single = await client.request({ method: "skills/get", params: { uri: BUILTIN_URI } }, anyResult);
      expect(single.skill).toEqual(builtin);
    });
  });

  it("reaches a session holding no roles without carrying a role-gated plugin skill with it", async () => {
    // A guest or server-to-server session: authenticated, but no roles.
    await withClient([], async (client) => {
      const skills = await listSkills(client);
      expect(skills.map((skill) => skill.uri)).toEqual([BUILTIN_URI]);
      expect((await client.listResources()).resources.map((entry) => entry.uri))
        .toEqual(skills[0]!.resources.map((file) => file.uri));
      await expect(client.request({ method: "skills/get", params: { uri: PLUGIN_SKILL_URI } }, anyResult))
        .rejects.toThrow("Skill not found");
      await expect(client.readResource({ uri: PLUGIN_SKILL_URI })).rejects.toThrow("Resource not found");
      // Its own files stay readable for that same session.
      await expect(client.readResource({ uri: BUILTIN_URI })).resolves.toBeDefined();
    });
  });

  it("points only at files and resources this server actually serves", async () => {
    await withClient([], async (client) => {
      const [builtin] = await listSkills(client);
      const published = new Set(builtin!.resources.map((file) => file.uri));
      const bodies = await Promise.all([...published].map(async (uri) => {
        const content = (await client.readResource({ uri })).contents[0]!;
        return "text" in content ? content.text : "";
      }));
      const text = bodies.join("\n");

      // Every `references/<file>` the skill mentions is a file it published.
      const referenced = [...text.matchAll(/references\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+/g)].map((match) => match[0]);
      expect(referenced.length).toBeGreaterThan(0);
      for (const reference of referenced) {
        expect(published).toContain(`skill://${BUILTIN_AGENT_SKILL_PATH}/${reference}`);
      }
      // No published file is dead weight the entry never reaches.
      for (const uri of published) {
        const relative = uri.slice(`skill://${BUILTIN_AGENT_SKILL_PATH}/`.length);
        if (relative !== "SKILL.md") expect(referenced).toContain(relative);
      }

      // Every resource URI it names is a core resource every session is
      // listed (session-surface.ts), never a plugin's or a derived one.
      const always = new Set([SESSION_RESOURCE_URI, ENTITY_CATALOG_URI]);
      const named = [...text.matchAll(/osf:\/\/[A-Za-z0-9/_.:-]+/g)].map((match) => match[0]);
      expect(named.length).toBeGreaterThan(0);
      for (const uri of named) expect(always).toContain(uri);

      // And no other skill's URI: a cross-reference could dangle per session.
      expect([...text.matchAll(/skill:\/\/[A-Za-z0-9/_.-]+/g)]).toHaveLength(0);
    });
  });

  it("names no tool, so a deployment projecting other tool names keeps a correct entry", async () => {
    const [builtin] = projectAgentSkills([BUILTIN_AGENT_SKILL_MODULE]);
    const text = [...builtin!.contents.values()].map((file) => file.text).join("\n");
    // `osf_*` is the shared-tool prefix; a dedicated or searchable projection
    // offers different names, so naming one here would be wrong somewhere.
    expect(text).not.toInclude("osf_");
  });

  it("is announced in the session instructions, so a client knows to fetch it", () => {
    const [builtin] = projectAgentSkills([BUILTIN_AGENT_SKILL_MODULE]);
    const instructions = buildServerInstructions({
      opening: null,
      hasConnectors: false,
      oauthCallbackUrl: null,
      locale: resolveLocale({ user: "en" }),
      client: null,
      skills: [{ uri: builtin!.entry.uri, description: builtin!.entry.frontmatter.description }],
    });
    expect(instructions).toInclude(builtin!.entry.uri);
    expect(instructions).toInclude(builtin!.entry.frontmatter.description);
  });

  it("leaves the projection contract itself unchanged for a plugin-only server", () => {
    // The built-in is composed at the call site (server-scope.ts), so the
    // shared projection still returns exactly what it is handed.
    const projected = projectAgentSkills([pluginModule]);
    expect(projected.map(({ entry }) => entry.uri)).toEqual([PLUGIN_SKILL_URI]);
    // Claiming a built-in path from a plugin is an ownership failure, not a
    // silent override of the server's own skill.
    expect(() => projectAgentSkills([
      BUILTIN_AGENT_SKILL_MODULE,
      { name: "impostor", agentSkills: BUILTIN_AGENT_SKILL_MODULE.agentSkills ?? [] },
    ])).toThrow("more than once");
  });
});
