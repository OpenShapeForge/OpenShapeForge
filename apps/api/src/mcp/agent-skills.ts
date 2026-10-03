// SPDX-License-Identifier: BUSL-1.1
/** Static plugin-owned Agent Skills, using the released MCP Skills extension. */
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { RuntimeAgentSkill } from "@openshapeforge/plugin-runtime";
import { fromJsonSchema, ProtocolError, ProtocolErrorCode, type Resource, type Server } from "@modelcontextprotocol/server";
import type { RuntimeModule } from "../modules/contract.js";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
type SkillEntry = {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: Array<{ uri: string; digest: string; size: number }>;
};
type ProjectedSkill = {
  entry: SkillEntry;
  contribution: RuntimeAgentSkill;
  resources: Resource[];
  contents: Map<string, { uri: string; text: string; mimeType: string }>;
};

function safePath(path: string): boolean {
  return path.length > 0 && path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && /^[a-zA-Z0-9_.-]+$/.test(part));
}

/** Validate every contribution, including hidden skills, so ownership never depends on a role. */
export function projectAgentSkills(modules: readonly RuntimeModule[]): ProjectedSkill[] {
  const claimed = new Set<string>();
  return modules.flatMap((module) => (module.agentSkills ?? []).map((contribution) => {
    if (!safePath(contribution.path)) throw new Error("Invalid Agent Skill path.");
    const markdown = contribution.files["SKILL.md"]?.text;
    const match = markdown?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const frontmatter = match ? parse(match[1]!) : undefined;
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter) ||
        typeof frontmatter.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name) ||
        frontmatter.name.length > 64 || contribution.path.split("/").at(-1) !== frontmatter.name ||
        typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
      throw new Error("An Agent Skill needs valid, matching SKILL.md name and description frontmatter.");
    }
    const uri = `skill://${contribution.path}/SKILL.md`;
    const contents = new Map<string, { uri: string; text: string; mimeType: string }>();
    const resources: Resource[] = [];
    const manifest = Object.entries(contribution.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => {
      if (!safePath(path)) throw new Error("Invalid Agent Skill file path.");
      const fileUri = `skill://${contribution.path}/${path}`;
      if (claimed.has(fileUri)) throw new Error(`Agent Skill resource ${fileUri} is contributed more than once.`);
      claimed.add(fileUri);
      const bytes = Buffer.from(file.text, "utf8");
      contents.set(fileUri, { uri: fileUri, text: file.text, mimeType: file.mimeType });
      resources.push({ uri: fileUri, name: path === "SKILL.md" ? frontmatter.name : path,
        ...(path === "SKILL.md" ? { description: frontmatter.description } : {}), mimeType: file.mimeType });
      return { uri: fileUri, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length };
    });
    if (manifest.length > 512 || manifest.reduce((total, file) => total + file.size, 0) > 16_777_216) {
      throw new Error("Agent Skill exceeds the MCP extension file or byte limit.");
    }
    return { entry: { uri, frontmatter, resources: manifest }, contribution, resources, contents };
  }));
}

export function visibleAgentSkills(skills: readonly ProjectedSkill[], roles: readonly string[]): ProjectedSkill[] {
  return skills.filter(({ contribution }) => !contribution.roles || contribution.roles.some((role) => roles.includes(role)));
}

const cache = { ttlMs: 300_000, cacheScope: "private" as const, resultType: "complete" as const };
export function registerAgentSkillHandlers(server: Server, skillsForSession: () => readonly ProjectedSkill[]): void {
  server.setRequestHandler("skills/list", { params: fromJsonSchema<{ cursor?: string }>({
    type: "object", properties: { cursor: { type: "string" } }, additionalProperties: true,
  }) }, async (params) => {
    if (params.cursor !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown skill cursor.");
    return { ...cache, skills: skillsForSession().map(({ entry }) => entry) };
  });
  server.setRequestHandler("skills/get", { params: fromJsonSchema<{ uri: string }>({
    type: "object", required: ["uri"], properties: { uri: { type: "string" } }, additionalProperties: true,
  }) }, async ({ uri }) => {
    const skill = skillsForSession().find(({ entry }) => entry.uri === uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Skill not found.");
    return { ...cache, skill: skill.entry };
  });
}

export function readAgentSkillResource(skills: readonly ProjectedSkill[], uri: string) {
  const content = skills.flatMap((skill) => [...skill.contents.values()]).find((file) => file.uri === uri);
  return content ? { ...cache, contents: [content] } : undefined;
}
