// SPDX-License-Identifier: BUSL-1.1
/**
 * The document/template family's authored meaning, as the interfaces receive
 * it.
 *
 * These seven definitions were the only core entity files with no
 * `description:`, so every interface described them with the compiler's
 * synthesized fallback ("The <label> entity.") — the one string an assistant
 * learns nothing from. The assertions here are deliberately not about wording:
 * each compares the GENERATED artifact against the value the authoring
 * actually declares, so they fail when the wiring breaks or when a definition
 * drops back to the fallback, and they keep passing when the prose is edited.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectAllArtifacts } from "./index.js";
import { loadActivePlatformCompile } from "./active-manifest.js";
import type { CompiledEntityContract } from "./authoring/types/compiled.js";

type JsonObject = Record<string, unknown>;

const repoRoot = resolve(import.meta.dir, "../../..");

/**
 * The whole corpus compiles and emits once for this file. `collectAllArtifacts`
 * runs every generator, so calling it per test would pay that cost three times.
 */
let collected: Promise<Awaited<ReturnType<typeof collectAllArtifacts>>> | undefined;
function artifacts() {
  collected ??= collectAllArtifacts(repoRoot);
  return collected;
}

async function generated(path: string): Promise<JsonObject> {
  const artifact = (await artifacts()).all.find((candidate) => candidate.path === path);
  expect(artifact).toBeDefined();
  return JSON.parse(artifact!.contents) as JsonObject;
}

/** Long enough for one cold compile of the full corpus on a loaded machine. */
const COMPILE_TIMEOUT_MS = 120_000;

/** The definitions this change authored; three of them are identity-less. */
const FAMILY = [
  "Template",
  "TemplateVariant",
  "TemplateVersion",
  "TemplateBlock",
  "Block",
  "TextBlock",
  "YouTubeEmbed",
] as const;

function text(value: unknown, language = "en"): string {
  if (typeof value === "string") return value;
  expect(value).toBeObject();
  const localized = (value as Record<string, unknown>)[language];
  expect(localized).toBeString();
  return localized as string;
}

function object(value: unknown): JsonObject {
  expect(value).toBeObject();
  return value as JsonObject;
}

test("the document/template family carries authored meaning into every generated description", async () => {
  const { entities } = await loadActivePlatformCompile(repoRoot);
  const contracts = new Map<string, CompiledEntityContract>(
    entities.map(({ contract }) => [contract.entity.name, contract]),
  );
  const mcpEntities = (await generated("apps/api/src/generated/mcp/tools.json")).entities as JsonObject[];
  const graphqlTypes = (await generated("apps/api/src/generated/graphql/documentation.json"))
    .entities as JsonObject[];

  for (const name of FAMILY) {
    const contract = contracts.get(name);
    expect(contract).toBeDefined();
    const authored = contract!.entity.description;
    // Authored, not the fallback generate-mcp.ts would compose from the label.
    expect(authored).toBeDefined();
    const english = text(authored);
    expect(english).not.toInclude("entity.");
    expect(english.length).toBeGreaterThan(80);

    // Every definition reaches the GraphQL type documentation, including the
    // three identity-less ones that have no table and no MCP catalog entry.
    expect(graphqlTypes.find((type) => type.typeName === name)?.description).toBe(english);

    const catalogued = mcpEntities.find((entry) => entry.entity === name);
    if (contract!.entity.valueDefinition) {
      expect(catalogued).toBeUndefined();
    } else {
      expect(catalogued?.description).toBe(english);
    }
  }
}, COMPILE_TIMEOUT_MS);

test("authored Operation guidance reaches the generated tool description in every authored language", async () => {
  const { entities } = await loadActivePlatformCompile(repoRoot);
  const tools = (await generated("apps/api/src/generated/mcp/tools.json")).tools as JsonObject[];

  for (const name of ["Template", "Block"] as const) {
    const contract = entities.find(({ contract: candidate }) => candidate.entity.name === name)!.contract;
    const guidance = contract.entityOperations.update?.guidance?.assistant;
    expect(guidance).toBeDefined();
    const tool = tools.find((candidate) => candidate.operationId === `${name}.update`);
    expect(tool).toBeDefined();
    // The canonical description still leads; guidance is appended, not a
    // replacement, and the Dutch projection carries the Dutch guidance.
    expect(tool!.description as string).toInclude(text(contract.entityOperations.update!.description));
    expect(tool!.description as string).toInclude(text(guidance));
    expect(object(tool!.descriptionI18n).nl as string).toInclude(text(guidance, "nl"));
  }
}, COMPILE_TIMEOUT_MS);

test("authored block field descriptions reach the live typed value contract", async () => {
  const { entities } = await loadActivePlatformCompile(repoRoot);
  const textBlock = entities.find(({ contract }) => contract.entity.name === "TextBlock")!.contract;
  const authored = textBlock.model.fields.find((field) => field.key === "markdown")?.description;
  expect(authored).toBeDefined();

  const manifest = await generated("apps/api/src/generated/db/manifest.json");
  const carriers = object(manifest.entityValues).carriers as JsonObject[];
  const carrier = carriers.find((candidate) => "TextBlock" in object(candidate.definitions));
  expect(carrier).toBeDefined();
  const definition = object(object(carrier!.definitions).TextBlock);

  // The schema a write is validated against is what an assistant inspects, so
  // the authored description has to be on it, in both authored languages.
  const markdown = object(object(object(definition.valueSchema).properties).markdown);
  expect(markdown.description).toBe(text(authored));
  const i18n = object(object(markdown["x-osf-i18n"]).description);
  expect(i18n.en).toBe(text(authored));
  expect(i18n.nl).toBe(text(authored, "nl"));
}, COMPILE_TIMEOUT_MS);
