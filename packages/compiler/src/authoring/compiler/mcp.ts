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
import type { CrudSection, McpConfig, McpOperationKey, McpSection } from "../types.js";
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

  const requestedOperations = Object.fromEntries(
    MCP_OPERATION_KEYS.map((key) => [key, config.operations?.[key] !== false]),
  ) as Record<McpOperationKey, boolean>;
  const operations = crud
    ? limitCrudOperations(requestedOperations, crud)
    : requestedOperations;

  return {
    toolPrefix,
    tools: config.tools ?? "dedicated",
    operations,
  };
}
