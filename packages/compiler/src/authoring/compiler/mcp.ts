// SPDX-License-Identifier: BUSL-1.1
/**
 * MCP exposure compiler for the supported `interfaces.mcp` contract.
 *
 * Canonical Operations own behaviour. This compiler only lowers their MCP
 * projection: tool style, per-Operation inclusion/name/instructions, an
 * optional entity resource, and secure-input handoff metadata.
 */
import type {
  CrudOperationKey,
  CrudSection,
  McpOperationKey,
  McpSection,
} from "../types.js";
import type { LoadedArtifacts } from "../loader.js";
import { limitCrudOperations } from "./crud.js";
import { operationByAction, projectedActions } from "../entity-model.js";

export const MCP_OPERATION_KEYS: readonly McpOperationKey[] = [
  "list",
  "get",
  "create",
  "update",
  "delete",
];

const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const MCP_RESOURCE_URI_PATTERN =
  /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9\/_-]*[A-Za-z0-9]$/;

/** `ContactDetail` -> `contact_detail`. */
export function deriveToolPrefix(entityName: string): string {
  return entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function completeProjectedActions(
  coreEntity: LoadedArtifacts["coreEntity"],
): Record<CrudOperationKey, boolean> {
  const projected = projectedActions(coreEntity, "mcp");
  return Object.fromEntries(
    MCP_OPERATION_KEYS.map((action) => [action, projected[action] === true]),
  ) as Record<CrudOperationKey, boolean>;
}

/** The entity's MCP exposure, projected only from `interfaces.mcp`. */
export function buildMcp(
  coreEntity: LoadedArtifacts["coreEntity"],
  crud?: CrudSection,
): McpSection | undefined {
  const authored = coreEntity.interfaces?.mcp;
  if (!authored) return undefined;

  const tools = authored.tools ?? "dedicated";
  const requestedOperations = completeProjectedActions(coreEntity);
  const operations = crud
    ? limitCrudOperations(requestedOperations, crud)
    : requestedOperations;
  const toolOverrides: NonNullable<McpSection["toolOverrides"]> = {};
  const operationInstructions: NonNullable<McpSection["operationInstructions"]> = {};

  for (const action of MCP_OPERATION_KEYS) {
    const operationKey = operationByAction(coreEntity)[action]?.[0];
    if (!operationKey) continue;
    const projection = authored.operations?.[operationKey];
    if (!projection) continue;
    if (projection.name !== undefined) {
      if (tools === "generic") {
        throw new Error(
          `interfaces.mcp operation "${operationKey}" on entity "${coreEntity.entity}" ` +
            "carries a name override, but the entity uses the generic tool style. " +
            "Overrides apply only to dedicated tools.",
        );
      }
      if (!MCP_TOOL_NAME_PATTERN.test(projection.name)) {
        throw new Error(
          `Unsafe interfaces.mcp tool name ${JSON.stringify(projection.name)} for ` +
            `operation "${operationKey}" on entity "${coreEntity.entity}" - must match ` +
            `${MCP_TOOL_NAME_PATTERN}.`,
        );
      }
      toolOverrides[action] = { name: projection.name };
    }
    if (projection.instructions !== undefined) {
      operationInstructions[action] = projection.instructions;
    }
  }

  const resource = authored.resource;
  if (resource && !MCP_RESOURCE_URI_PATTERN.test(resource.uri)) {
    throw new Error(
      `Unsafe interfaces.mcp resource uri ${JSON.stringify(resource.uri)} on entity ` +
        `"${coreEntity.entity}" - must match ${MCP_RESOURCE_URI_PATTERN}.`,
    );
  }

  const secureInput = operationByAction(coreEntity).create?.[1].interaction;
  const elicitOnCreate = secureInput
    ? (({ type: _type, ...value }) => value)(secureInput)
    : undefined;

  return {
    toolPrefix: deriveToolPrefix(coreEntity.entity),
    tools,
    operations,
    ...(Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
    ...(Object.keys(operationInstructions).length > 0
      ? { operationInstructions }
      : {}),
    ...(resource ? { resource } : {}),
    ...(elicitOnCreate ? { elicitOnCreate } : {}),
  };
}
