// SPDX-License-Identifier: BUSL-1.1
/**
 * MCP exposure compiler — normalizes the authored opt-in `mcp:` block into an
 * McpSection (tool prefix + style + per-operation flags).
 *
 * Pipeline position: called by the main compiler alongside buildRest. The
 * section is carried on the compiled contract and bridged into
 * TableDefinition.source.mcp by the backend manifest, which is where the
 * fail-closed interaction with generatedCrud is enforced.
 *
 * This module decides only WHICH tools exist. Their input schemas — the part
 * that carries the authored labels, validation, and enumerations — are built
 * later by generate-mcp.ts from the compiled model fields.
 *
 * Input:  Core entity definition (authored `mcp` block).
 * Output: McpSection | undefined — undefined means "no MCP exposure".
 */
import type { CrudSection, McpConfig, McpOperationConfig, McpOperationKey, McpResourceConfig, McpSection } from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { limitCrudOperations } from "./crud.js";

export const MCP_OPERATION_KEYS: readonly McpOperationKey[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

// Same fail-closed pattern the loader enforces; re-checked here so the
// invariant holds even for callers that bypass the YAML loader (tests,
// programmatic authoring).
const MCP_TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

// Emitted verbatim into the MCP resource listing; the runtime appends "/{id}"
// for the template and matches read URIs against both, so the shape is locked
// down to scheme://path with safe path characters and no trailing slash.
const MCP_RESOURCE_URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9\/_-]*[A-Za-z0-9]$/;

/**
 * `ContactDetail` → `contact_detail`. Distinct from deriveTableName: a tool
 * prefix is singular, because the operation suffix already carries the
 * plurality (`contact_detail_list` reads better than `contact_details_list`).
 */
export function deriveToolPrefix(entityName: string): string {
  return entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

export function buildMcp(
  coreEntity: LoadedArtifacts["coreEntity"],
  crud?: CrudSection,
): McpSection | undefined {
  const authored = coreEntity.mcp;
  if (authored === undefined || authored === false) return undefined;

  const config: McpConfig = authored === true ? {} : authored;
  if (config.enabled === false) return undefined;

  const toolPrefix = config.toolPrefix ?? deriveToolPrefix(coreEntity.entity);
  if (!MCP_TOOL_PREFIX_PATTERN.test(toolPrefix)) {
    throw new Error(
      `Unsafe mcp toolPrefix ${JSON.stringify(toolPrefix)} on entity "${coreEntity.entity}" ` +
        `— must match ${MCP_TOOL_PREFIX_PATTERN}. The prefix is emitted verbatim into ` +
        `MCP tool names, which the protocol constrains and the runtime dispatches on.`,
    );
  }

  const style = config.tools ?? "dedicated";

  const requestedOperations = Object.fromEntries(
    MCP_OPERATION_KEYS.map((key) => {
      const authoredOperation = config.operations?.[key];
      const enabled =
        typeof authoredOperation === "object"
          ? authoredOperation.enabled !== false
          : authoredOperation !== false;
      return [key, enabled];
    }),
  ) as Record<McpOperationKey, boolean>;
  const operations = crud
    ? limitCrudOperations(requestedOperations, crud)
    : requestedOperations;

  const toolOverrides: Partial<
    Record<McpOperationKey, { name?: string; description?: string }>
  > = {};
  for (const key of MCP_OPERATION_KEYS) {
    const authoredOperation = config.operations?.[key];
    if (typeof authoredOperation !== "object") continue;
    const { name, description } = authoredOperation as McpOperationConfig;
    if (name === undefined && description === undefined) continue;
    // Overrides only make sense on tools this entity owns. The shared osf_*
    // tools serve every generic-style entity at once, so a per-entity rename
    // or description there would silently win for whichever entity compiled
    // last — refuse instead.
    if (style === "generic") {
      throw new Error(
        `mcp operation "${key}" on entity "${coreEntity.entity}" carries a name/description ` +
          `override, but the entity uses the generic tool style. Overrides apply only to ` +
          "dedicated tools; switch to `tools: dedicated` or drop the override.",
      );
    }
    if (name !== undefined && !MCP_TOOL_PREFIX_PATTERN.test(name)) {
      throw new Error(
        `Unsafe mcp tool name ${JSON.stringify(name)} for operation "${key}" on entity ` +
          `"${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}. The name is ` +
          `emitted verbatim into MCP tool names, which the protocol constrains and the ` +
          `runtime dispatches on.`,
      );
    }
    toolOverrides[key] = {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  let resource: McpResourceConfig | undefined;
  if (config.resource) {
    const { uri } = config.resource;
    if (!MCP_RESOURCE_URI_PATTERN.test(uri)) {
      throw new Error(
        `Unsafe mcp resource uri ${JSON.stringify(uri)} on entity "${coreEntity.entity}" ` +
          `— must match ${MCP_RESOURCE_URI_PATTERN} (scheme://path, no trailing slash, ` +
          `no template placeholders). The uri is emitted verbatim into the MCP resource ` +
          `listing and the runtime dispatches on it.`,
      );
    }
    resource = config.resource;
  }

  return {
    toolPrefix,
    tools: style,
    operations,
    ...(Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
    ...(resource ? { resource } : {}),
  };
}
