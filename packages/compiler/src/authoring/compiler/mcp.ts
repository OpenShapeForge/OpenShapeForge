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
import type {
  CrudSection,
  McpConfig,
  McpDerivedToolsConfig,
  McpDiscoveryConfig,
  McpElicitOnCreateConfig,
  McpGuideConfig,
  McpOperationConfig,
  McpOperationKey,
  McpResourceConfig,
  McpSection,
  McpTestConfig,
} from "../types.js";
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
const MCP_RESOURCE_URI_PATTERN =
  /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9\/_-]*[A-Za-z0-9]$/;

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

  let derivedTools: McpDerivedToolsConfig | undefined;
  if (config.derivedTools) {
    const authored = config.derivedTools;
    if (!Array.isArray(authored.roles) || authored.roles.length === 0) {
      throw new Error(
        `mcp derivedTools on entity "${coreEntity.entity}" needs a non-empty roles list — ` +
          `an empty audience would advertise the derived tools to nobody, which is ` +
          `always a configuration mistake.`,
      );
    }
    const fieldKeys = new Set(
      (coreEntity.fields ?? []).map((field) => field.key),
    );
    for (const [option, fieldKey] of [
      ["keyField", authored.keyField],
      ["descriptionField", authored.descriptionField],
      ["inputFieldsField", authored.inputFieldsField],
      ...(authored.titleField !== undefined
        ? [["titleField", authored.titleField]]
        : []),
    ] as const) {
      if (!fieldKey || !fieldKeys.has(fieldKey)) {
        throw new Error(
          `mcp derivedTools ${option} ${JSON.stringify(fieldKey)} on entity ` +
            `"${coreEntity.entity}" does not name an authored field. The runtime reads ` +
            `these fields from stored rows to build each derived tool.`,
        );
      }
    }
    if (authored.visibleWhen) {
      if (
        !fieldKeys.has(authored.visibleWhen.field) ||
        !authored.visibleWhen.equals
      ) {
        throw new Error(
          `mcp derivedTools.visibleWhen on entity "${coreEntity.entity}" must name an ` +
            `authored field and a non-empty value.`,
        );
      }
    }
    if (
      authored.visibleToRolesField !== undefined &&
      !fieldKeys.has(authored.visibleToRolesField)
    ) {
      throw new Error(
        `mcp derivedTools.visibleToRolesField ${JSON.stringify(authored.visibleToRolesField)} ` +
          `on entity "${coreEntity.entity}" does not name an authored field.`,
      );
    }
    if (authored.connect) {
      if (!MCP_TOOL_PREFIX_PATTERN.test(authored.connect.name ?? "")) {
        throw new Error(
          `Unsafe mcp derivedTools.connect name ${JSON.stringify(authored.connect.name)} on ` +
            `entity "${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}.`,
        );
      }
      if (!authored.execution) {
        throw new Error(
          `mcp derivedTools.connect on entity "${coreEntity.entity}" requires an execution ` +
            `block — the handoff derives its provider chain from it.`,
        );
      }
      if (
        !Array.isArray(authored.connect.roles) ||
        authored.connect.roles.length === 0
      ) {
        throw new Error(
          `mcp derivedTools.connect on entity "${coreEntity.entity}" needs a non-empty roles list ` +
            `for tenant-scoped connection administration.`,
        );
      }
    }
    if (authored.dryRun) {
      if (!MCP_TOOL_PREFIX_PATTERN.test(authored.dryRun.name ?? "")) {
        throw new Error(
          `Unsafe mcp derivedTools.dryRun name ${JSON.stringify(authored.dryRun.name)} on ` +
            `entity "${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}.`,
        );
      }
      if (
        !Array.isArray(authored.dryRun.roles) ||
        authored.dryRun.roles.length === 0
      ) {
        throw new Error(
          `mcp derivedTools.dryRun on entity "${coreEntity.entity}" needs a non-empty roles list.`,
        );
      }
      if (!authored.execution) {
        throw new Error(
          `mcp derivedTools.dryRun on entity "${coreEntity.entity}" requires an execution ` +
            `block — it composes the requests that block describes.`,
        );
      }
    }
    if (authored.personalization) {
      const personalization = authored.personalization;
      if (!MCP_TOOL_PREFIX_PATTERN.test(personalization.set?.name ?? "")) {
        throw new Error(
          `Unsafe mcp derivedTools.personalization.set name ` +
            `${JSON.stringify(personalization.set?.name)} on entity "${coreEntity.entity}" ` +
            `— must match ${MCP_TOOL_PREFIX_PATTERN}.`,
        );
      }
      for (const [option, value] of [
        ["entity", personalization.entity],
        ["serviceRef", personalization.serviceRef],
        ["instructionField", personalization.instructionField],
      ] as const) {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(
            `mcp derivedTools.personalization ${option} on entity "${coreEntity.entity}" ` +
              `must be a non-empty string.`,
          );
        }
      }
    }
    if (authored.execution) {
      const execution = authored.execution;
      if (!fieldKeys.has(execution.bindingsField)) {
        throw new Error(
          `mcp derivedTools.execution bindingsField ${JSON.stringify(execution.bindingsField)} ` +
            `on entity "${coreEntity.entity}" does not name an authored field.`,
        );
      }
      for (const [option, value] of Object.entries(execution)) {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(
            `mcp derivedTools.execution ${option} on entity "${coreEntity.entity}" must be ` +
              `a non-empty string.`,
          );
        }
      }
    }
    derivedTools = authored;
  }

  let elicitOnCreate: McpElicitOnCreateConfig | undefined;
  if (config.elicitOnCreate) {
    const authored = config.elicitOnCreate;
    const fieldKeys = new Set(
      (coreEntity.fields ?? []).map((field) => field.key),
    );
    for (const [option, fieldKey] of [
      ["sourceField", authored.sourceField],
      ["into", authored.into],
    ] as const) {
      if (!fieldKey || !fieldKeys.has(fieldKey)) {
        throw new Error(
          `mcp elicitOnCreate ${option} ${JSON.stringify(fieldKey)} on entity ` +
            `"${coreEntity.entity}" does not name an authored field.`,
        );
      }
    }
    if (!authored.sourceEntity || !authored.definitionsField) {
      throw new Error(
        `mcp elicitOnCreate on entity "${coreEntity.entity}" needs sourceEntity and ` +
          `definitionsField naming where the elicitable field definitions live.`,
      );
    }
    elicitOnCreate = authored;
  }

  let guide: McpGuideConfig | undefined;
  if (config.guide) {
    const authored = config.guide;
    if (!MCP_TOOL_PREFIX_PATTERN.test(authored.name ?? "")) {
      throw new Error(
        `Unsafe mcp guide name ${JSON.stringify(authored.name)} on entity ` +
          `"${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}.`,
      );
    }
    if (!authored.description || !authored.content?.trim()) {
      throw new Error(
        `mcp guide on entity "${coreEntity.entity}" needs a description and non-empty content.`,
      );
    }
    if (!Array.isArray(authored.roles) || authored.roles.length === 0) {
      throw new Error(
        `mcp guide on entity "${coreEntity.entity}" needs a non-empty roles list.`,
      );
    }
    guide = authored;
  }

  let discovery: McpDiscoveryConfig | undefined;
  if (config.discovery) {
    if (!MCP_TOOL_PREFIX_PATTERN.test(config.discovery.name ?? "")) {
      throw new Error(
        `Unsafe mcp discovery name ${JSON.stringify(config.discovery.name)} on entity ` +
          `"${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}.`,
      );
    }
    discovery = config.discovery;
  }

  let test: McpTestConfig | undefined;
  if (config.test) {
    if (!MCP_TOOL_PREFIX_PATTERN.test(config.test.name ?? "")) {
      throw new Error(
        `Unsafe mcp test name ${JSON.stringify(config.test.name)} on entity ` +
          `"${coreEntity.entity}" — must match ${MCP_TOOL_PREFIX_PATTERN}.`,
      );
    }
    if (!elicitOnCreate) {
      throw new Error(
        `mcp test on entity "${coreEntity.entity}" requires an elicitOnCreate block — ` +
          `the test verifies the elicited values against the source row it names.`,
      );
    }
    test = config.test;
  }

  return {
    toolPrefix,
    tools: style,
    operations,
    ...(Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
    ...(resource ? { resource } : {}),
    ...(derivedTools ? { derivedTools } : {}),
    ...(elicitOnCreate ? { elicitOnCreate } : {}),
    ...(discovery ? { discovery } : {}),
    ...(test ? { test } : {}),
    ...(guide ? { guide } : {}),
  };
}
