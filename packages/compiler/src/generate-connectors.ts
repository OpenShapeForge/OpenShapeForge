// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector catalog generator.
 *
 * Emits `apps/api/src/generated/connectors/catalog.json` — the compiled
 * contracts the API reads at module load to build the connector surfaces and
 * the configuration catalog. Emitted on every run, with an empty `connectors`
 * array when none are authored, so the runtime can import it unconditionally
 * (the same pattern `rest/openapi.json` follows).
 *
 * It is a separate artifact rather than part of `manifest.json` on purpose: the
 * manifest checksum drives migrations and drift detection and must not move
 * because a connector's help text changed.
 *
 * This module also owns the audits that only make sense across the whole
 * catalog — name collisions against entities and against other connectors, and
 * the shared MCP tool budget.
 *
 * Determinism: pure function of the compiled contracts; connectors sorted by
 * slug, no timestamps, no package resolution.
 */
import { createHash } from "node:crypto";
import type { CompiledConnectorContract } from "./authoring/types/connector.js";
import { MAX_DEDICATED_TOOLS } from "./generate-mcp.js";
import type { PlatformSchemaManifest } from "./schema.js";

export type ConnectorCatalog = {
  version: number;
  /** Hash over every contract, so the runtime can detect a stale build. */
  checksum: string;
  connectors: CompiledConnectorContract[];
};

/**
 * Names the entity surfaces already occupy. A connector namespace that collided
 * with a generated entity query would produce a GraphQL schema that fails to
 * build at API start — a runtime surprise from an authoring mistake, which is
 * exactly what the compiler exists to prevent.
 */
function entityReservedNames(manifest: PlatformSchemaManifest): {
  graphqlFields: Set<string>;
  graphqlTypes: Set<string>;
  mcpToolPrefixes: Set<string>;
  dedicatedToolCount: number;
} {
  const graphqlFields = new Set<string>();
  const graphqlTypes = new Set<string>();
  const mcpToolPrefixes = new Set<string>();
  let dedicatedToolCount = 0;

  for (const table of manifest.tables) {
    const graphql = table.source?.graphql;
    if (graphql) {
      graphqlFields.add(graphql.singleQueryName);
      graphqlFields.add(graphql.listQueryName);
      graphqlFields.add(graphql.createMutationName);
      graphqlFields.add(graphql.updateMutationName);
      graphqlFields.add(graphql.deleteMutationName);
      graphqlTypes.add(graphql.typeName);
    }
    const mcp = table.source?.mcp;
    if (mcp) {
      mcpToolPrefixes.add(mcp.toolPrefix);
      if (mcp.tools === "dedicated") {
        dedicatedToolCount += Object.values(mcp.operations).filter(Boolean).length;
      }
    }
  }

  return { graphqlFields, graphqlTypes, mcpToolPrefixes, dedicatedToolCount };
}

export function buildConnectorCatalog(
  connectors: CompiledConnectorContract[],
  manifest: PlatformSchemaManifest,
): ConnectorCatalog {
  const sorted = [...connectors].sort((a, b) => a.slug.localeCompare(b.slug));
  const reserved = entityReservedNames(manifest);

  const seenNamespaces = new Map<string, string>();
  const seenBasePaths = new Map<string, string>();
  const seenToolPrefixes = new Map<string, string>();
  const seenToolNames = new Map<string, string>();
  let connectorToolCount = 0;

  for (const connector of sorted) {
    if (reserved.graphqlFields.has(connector.namespace)) {
      throw new Error(
        `Connector "${connector.slug}" claims the GraphQL root field "${connector.namespace}", ` +
          "which a generated entity operation already uses. Rename the connector.",
      );
    }
    const previousNamespace = seenNamespaces.get(connector.namespace);
    if (previousNamespace) {
      throw new Error(
        `Connectors "${previousNamespace}" and "${connector.slug}" both claim the GraphQL ` +
          `root field "${connector.namespace}".`,
      );
    }
    seenNamespaces.set(connector.namespace, connector.slug);

    for (const operation of connector.operations) {
      for (const typeName of [operation.graphql.inputType, operation.graphql.resultType]) {
        if (reserved.graphqlTypes.has(typeName)) {
          throw new Error(
            `Connector "${connector.slug}" generates the GraphQL type "${typeName}", which a ` +
              "generated entity type already uses. Rename the connector or the operation.",
          );
        }
      }
    }

    if (connector.exposure.rest) {
      const basePath = connector.exposure.rest.basePath;
      const previousBasePath = seenBasePaths.get(basePath);
      if (previousBasePath) {
        throw new Error(
          `Connectors "${previousBasePath}" and "${connector.slug}" both claim the REST base ` +
            `path "${basePath}".`,
        );
      }
      seenBasePaths.set(basePath, connector.slug);
    }

    if (connector.exposure.mcp) {
      const toolPrefix = connector.exposure.mcp.toolPrefix;
      if (reserved.mcpToolPrefixes.has(toolPrefix)) {
        throw new Error(
          `Connector "${connector.slug}" claims the MCP tool prefix "${toolPrefix}", which an ` +
            "entity already uses. Tool names are a flat namespace the runtime dispatches on.",
        );
      }
      const previousPrefix = seenToolPrefixes.get(toolPrefix);
      if (previousPrefix) {
        throw new Error(
          `Connectors "${previousPrefix}" and "${connector.slug}" both claim the MCP tool ` +
            `prefix "${toolPrefix}".`,
        );
      }
      seenToolPrefixes.set(toolPrefix, connector.slug);

      for (const operation of connector.operations) {
        if (!operation.mcp) continue;
        const previousTool = seenToolNames.get(operation.mcp.toolName);
        if (previousTool) {
          throw new Error(
            `MCP tool name "${operation.mcp.toolName}" is claimed twice ` +
              `(${previousTool} and ${connector.slug}.${operation.key}).`,
          );
        }
        seenToolNames.set(operation.mcp.toolName, `${connector.slug}.${operation.key}`);
        connectorToolCount += 1;
      }
    }
  }

  // Connector tools share the catalog a model has to choose from, so they share
  // the budget. Counting them separately would let the two surfaces each stay
  // "within limits" while the advertised catalog blows past what a model can
  // select from reliably.
  const totalTools = reserved.dedicatedToolCount + connectorToolCount;
  if (totalTools > MAX_DEDICATED_TOOLS) {
    throw new Error(
      `The MCP catalog would advertise ${totalTools} dedicated tools ` +
        `(${reserved.dedicatedToolCount} from entities, ${connectorToolCount} from connectors), ` +
        `over the ${MAX_DEDICATED_TOOLS} limit. Switch entities to \`tools: generic\` or ` +
        "disable connector operations for MCP.",
    );
  }

  const checksum = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return { version: 1, checksum, connectors: sorted };
}

export function renderConnectorCatalog(
  connectors: CompiledConnectorContract[],
  manifest: PlatformSchemaManifest,
): string {
  return `${JSON.stringify(buildConnectorCatalog(connectors, manifest), null, 2)}\n`;
}
