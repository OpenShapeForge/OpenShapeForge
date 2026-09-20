// SPDX-License-Identifier: BUSL-1.1
/**
 * How one session's entity tools and entity resources are described: the
 * dedicated tool with its withheld fields and localized text, the generic
 * `osf_*` tools in their two-step projection, the resolution of a call to
 * the catalogue entry it means, and the entity schema resources.
 *
 * Split out of generated-mcp-server.ts.
 */
import { collectionManagedFields, withoutCollectionInputs } from "../operations/entity/collection-policy.js";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DbSessionInput } from "../db/session.js";
import { getEntityOperationContracts, getGeneratedCrudTables } from "../operations/entity/index.js";
import type { EntityOperationContract } from "../operations/entity/types.js";
import { canReadClassifiedColumns } from "../graphql/generated-authz.js";
import { DATA_ACQUISITION_TOOL_FOOTER } from "./server-instructions.js";
import { localizedText, type ResolvedLocale } from "./locale.js";
import { type CatalogEntity, type CatalogTool, type GeneratedTable } from "./catalog.js";
import { withholdClassified, withholdClassifiedOutput } from "./session-projection.js";
import { ENTITY_CONFIGURATION_APP_URI, publicOriginIsHttps } from "./handoff-config.js";


/** The entity's authored label in the session's language, when it has one. */
export function entityTitle(
  entity: CatalogEntity | undefined,
  locale: ResolvedLocale | undefined,
): string | undefined {
  if (!entity) return undefined;
  return (locale && localizedText(entity.labels, locale)) || entity.title;
}

export let canonicalOperationsById: Map<string, EntityOperationContract> | undefined;

/**
 * The title and description of an entity CRUD tool in the session's language.
 *
 * The compiler collapses the canonical operation's `{ en, nl, … }` name and
 * description into English at build time and appends its own advice ("use get
 * for one known id", the edit-lease reminder). The canonical operation still
 * carries every language, so the localized sentence replaces the English one
 * it was composed from and the advice is kept; a tool without a canonical
 * operation (legacy v1) or a text the catalogue did not compose that way is
 * described as compiled.
 */
export function localizedToolText(
  tool: CatalogTool,
  locale: ResolvedLocale | undefined,
): { title: string | undefined; description: string } {
  const compiled = { title: tool.title, description: tool.description };
  if (!locale || !tool.operationId) return compiled;
  canonicalOperationsById ??= new Map(
    getEntityOperationContracts().map((operation) => [operation.id, operation]),
  );
  const canonical = canonicalOperationsById.get(tool.operationId);
  if (!canonical) return compiled;
  const english = localizedText(canonical.description, "en");
  const localized = localizedText(canonical.description, locale);
  return {
    title: localizedText(canonical.name, locale) ?? tool.title,
    description:
      english && localized && tool.description.startsWith(english)
        ? `${localized}${tool.description.slice(english.length)}`
        : tool.description,
  };
}

export function describeTool(
  tool: CatalogTool,
  entity: CatalogEntity | undefined,
  table: GeneratedTable | undefined,
  session: DbSessionInput,
  locale?: ResolvedLocale,
) {
  const classified =
    entity && !canReadClassifiedColumns(table?.source?.authorization, session)
      ? entity.classifiedFields
      : [];
  const text = localizedToolText(tool, locale);
  // Every generated create/update tool carries the same short reminder — see
  // DATA_ACQUISITION_TOOL_FOOTER and DATA_ACQUISITION_GUIDANCE in
  // mcp/server-instructions.ts. Read
  // and delete stay untouched: there is nothing to fill in.
  const description =
    tool.operation === "create" || tool.operation === "update"
      ? `${text.description}${DATA_ACQUISITION_TOOL_FOOTER}`
      : text.description;
  return {
    name: tool.name,
    title: text.title,
    description,
    inputSchema: withholdClassified(
      table && (tool.operation === "create" || tool.operation === "update")
        ? withoutCollectionInputs(tool.inputSchema as Record<string, unknown>, collectionManagedFields(table, getGeneratedCrudTables()))
        : tool.inputSchema as Record<string, unknown>,
      classified,
    ),
    ...(tool.outputSchema
      ? {
          outputSchema: withholdClassifiedOutput(
            tool.outputSchema,
            tool.operation,
            classified,
          ) as Tool["outputSchema"],
        }
      : {}),
    annotations: {
      title: text.title,
      ...tool.annotations,
    },
    // The MCP App is only advertised where it can render (https origin —
    // see publicOriginIsHttps); elsewhere the create tool answers with a
    // plain configuration URL instead.
    ...(tool.operation === "create" && entity?.elicitOnCreate && publicOriginIsHttps()
      ? { _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI } } }
      : {}),
  };
}
