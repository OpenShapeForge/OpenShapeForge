// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { catalog } from "./catalog.js";
import { generatedCrudTools, matchNativeCrudTool } from "./native-crud-tool.js";
import { describeTool } from "./entity-tool-projection.js";
import { toolsForSession } from "./session-projection.js";
import type { ServerScope } from "./server-scope.js";

/** One live MCP projection over canonical entity, static and provider Operations. */
export async function searchableSessionOperations(scope: ServerScope) {
  if (!scope.modulePlatform) throw new Error("Canonical Operation runtime is unavailable.");
  // One snapshot: the providers are enumerated once, and the definitions and
  // the provider ids among them cannot disagree.
  const { definitions, providerIds } = await scope.modulePlatform.listOperationSnapshot(scope.moduleSession);
  const entities = new Map(toolsForSession(scope.session, scope.tables).map((entry) => [entry.tool.operationId, entry]));
  const allowedIds = new Set([
    ...scope.searchableStaticOperationIds,
    ...entities.keys(),
    ...providerIds,
  ]);
  // A covered CRUD Operation shows its tool's title and description in the
  // session's language; search still matches the canonical name and
  // description in every authored language as well (operation-search.ts).
  const canonicalText = new Map<string, Pick<RuntimeOperationDefinition, "name" | "description">>();
  const entityLabels = new Map(catalog.entities.flatMap((entity) => entity.labels ? [[entity.entity, entity.labels] as const] : []));
  // An exact generated name answers like its canonical id, matched exactly as
  // native execution matches it (a name several entities share resolves to
  // nothing); the search answers it only when that id is available here.
  const resolveName = (name: string): string | undefined => {
    const generated = matchNativeCrudTool(generatedCrudTools, name);
    if (generated.kind === "tool") return generated.tool.operationId;
    const named = catalog.operationTools.filter((tool) => tool.name === name);
    return named.length === 1 ? named[0]!.key : undefined;
  };
  return {
    allowedIds,
    entities,
    canonicalText,
    entityLabels,
    resolveName,
    definitions: definitions.filter((definition) => allowedIds.has(definition.id)).map((definition): RuntimeOperationDefinition => {
      const entry = entities.get(definition.id);
      if (!entry) return definition;
      // Exact interface schema: preserve classified-field withholding and the
      // existing secure-input adapter rather than exposing the raw core input.
      const tool = describeTool(entry.tool, entry.entity, scope.tables.get(entry.tool.table), scope.session, scope.locale);
      canonicalText.set(definition.id, { name: definition.name, description: definition.description });
      const schema = tool.outputSchema;
      if (!schema) throw new Error(`CRUD Operation ${definition.id} has no output schema.`);
      const branches = [schema, ...((schema.oneOf ?? []) as Record<string, unknown>[])];
      const data = branches.map((branch) => (branch.properties as Record<string, Record<string, unknown>> | undefined)?.data).find(Boolean);
      if (!data) throw new Error(`CRUD Operation ${definition.id} has no data output schema.`);
      const output = { ...data, ...(schema.$defs ? { $defs: schema.$defs } : {}) };
      return { ...definition, name: tool.title ?? definition.name, description: tool.description, input: { kind: "json-schema", schema: tool.inputSchema }, output: { kind: "json-schema", schema: output } };
    }),
  };
}

/** Hide only tools whose complete behavior remains available by canonical id. */
export function searchableCoveredToolNames(scope: ServerScope, definitions: readonly RuntimeOperationDefinition[]): Set<string> {
  const ids = new Set(definitions.map((definition) => definition.id));
  const names = new Set<string>();
  const entries = toolsForSession(scope.session, scope.tables);
  const uncovered = new Set(entries.filter(({ tool }) => !ids.has(tool.operationId)).map(({ tool }) => tool.name));
  for (const { tool } of entries) if (!uncovered.has(tool.name)) names.add(tool.name);
  for (const tool of catalog.operationTools) if (ids.has(tool.key)) names.add(tool.name);
  return names;
}
