// SPDX-License-Identifier: BUSL-1.1
/**
 * What one session is SHOWN of the catalogue: which entity tools it may
 * invoke, which classified fields are withheld from its schemas, which
 * resources, guides, discovery and test tools it sees. Read-only over the
 * catalogue and the manifest; the CRUD core remains the enforcement on the
 * call path. Split out of catalog.ts.
 */

/**
 * Whether the session holds a role permitting `operation` on this table.
 *
 * Read-only mirror of requireEntityOperation() used to decide what to
 * ADVERTISE. It deliberately never throws: a tool the caller cannot use is
 * omitted from the listing, not surfaced as an error.
 */
import { collectionMutationError } from "../operations/entity/collection-policy.js";
import { GENERIC_DESCRIBE_TOOL_NAME } from "@openshapeforge/operations";
import type { DbSessionInput } from "../db/session.js";
import { getEntityOperationContracts, isGeneratedCrudOperationEnabled } from "../operations/entity/index.js";
import { EDIT_LEASE_TOOL_NAMES } from "./edit-lease-tools.js";
import { ONBOARDING_TOOL_NAMES } from "./onboarding.js";
import { UPDATE_TOOL_NAMES } from "./update-notices.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { connectorMcpTools } from "../connectors/mcp-tools.js";
import { SESSION_INFO_TOOL_NAME } from "./session-info.js";
import {
  type CatalogDiscoveryTool,
  type CatalogEntity,
  type CatalogGuideTool,
  type CatalogResource,
  type CatalogTestTool,
  type CatalogTool,
  type GeneratedTable,
  type McpOperation,
  OPERATION_ROLE,
  type OperationToolProjection,
  catalog,
  catalogDerivedTools,
  catalogDiscoveryTools,
  catalogGuideTools,
  catalogResources,
  catalogTestTools,
  crudToolsNamed,
  generatedOperationToolProjection,
} from "./catalog.js";
export function sessionMayInvoke(
  table: GeneratedTable | undefined,
  operation: keyof typeof OPERATION_ROLE,
  session: DbSessionInput,
): boolean {
  if (!table || !isGeneratedCrudOperationEnabled(table, operation))
    return false;
  const required =
    table?.source?.authorization?.roles?.[OPERATION_ROLE[operation]];
  if (!required || required.length === 0) return false;
  const granted = new Set(session.roles ?? []);
  return required.some((role) => granted.has(role));
}

/**
 * The entries of `name` this session may invoke — exactly the set the tool
 * listing merged into one `osf_*` tool, so "may I call this name at all" has
 * the same answer here as the advertised catalogue gives.
 */
export function invocableCrudToolsNamed(
  name: string,
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogTool[] {
  return crudToolsNamed(name).filter((tool) =>
    sessionMayInvoke(tables.get(tool.table), tool.operation, session),
  );
}

/**
 * Strip classified entity fields from the root create schema and the two
 * wrappers that carry entity-field names (`filter` and `values`). Nested JSON
 * object children are a separate namespace and must not be matched against a
 * top-level classified field with the same name.
 */
export function withholdClassified(
  schema: Record<string, unknown>,
  classifiedFields: readonly string[],
): Record<string, unknown> {
  if (classifiedFields.length === 0) return schema;
  const withheld = new Set(classifiedFields);

  const pruneObjectLevel = (
    node: Record<string, unknown>,
  ): Record<string, unknown> => {
    const properties = node.properties;
    const result = { ...node };
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      result.properties = Object.fromEntries(
        Object.entries(properties as Record<string, unknown>).filter(
          ([name]) => !withheld.has(name),
        ),
      );
    }
    if (Array.isArray(node.required)) {
      result.required = node.required.filter(
        (name) => !withheld.has(name as string),
      );
    }
    return result;
  };

  const root = pruneObjectLevel(schema);
  const properties = root.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return root;

  const projected = { ...(properties as Record<string, unknown>) };
  for (const wrapper of ["filter", "values"]) {
    const nested = projected[wrapper];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      projected[wrapper] = pruneObjectLevel(nested as Record<string, unknown>);
    }
  }
  root.properties = projected;
  return root;
}

/**
 * Remove classified record properties from the advertised output without
 * changing the shared catalog. The record itself stays open to additional
 * properties because the database redaction layer currently returns withheld
 * columns as null and the schema must not reveal their names.
 */
export function withholdClassifiedOutput(
  schema: Record<string, unknown> | undefined,
  operation: McpOperation,
  classifiedFields: readonly string[],
): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  if (classifiedFields.length === 0 || operation === "delete") return schema;
  const copy = structuredClone(schema);
  const success = Array.isArray(copy.oneOf)
    ? (copy.oneOf[0] as Record<string, unknown> | undefined)
    : undefined;
  const successProperties = success?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  let record = successProperties?.data;
  if (operation === "list") {
    const listProperties = record?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const items = listProperties?.items;
    const item = items?.items as Record<string, unknown> | undefined;
    const itemProperties = item?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    record = itemProperties?.data;
  }
  if (!record) return copy;

  const withheld = new Set(classifiedFields);
  const properties = record.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    record.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>).filter(
        ([name]) => !withheld.has(name),
      ),
    );
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter(
      (name) => !withheld.has(name as string),
    );
  }
  return copy;
}

/**
 * Whether the generic CRUD path can ever succeed for this entry, regardless of
 * who asks. The collection policy refuses a generic create that must also
 * write an owned collection and a generic delete of an owned child outright
 * (collection-policy.ts); advertising either would disclose an action that
 * always fails. Update is not affected: the collection fields are removed
 * from its schema instead (withoutCollectionInputs in describeTool).
 */
export function crudToolCanSucceed(
  tool: CatalogTool,
  tables: Map<string, GeneratedTable>,
): boolean {
  if (tool.operation !== "create" && tool.operation !== "delete") return true;
  const table = tables.get(tool.table);
  if (!table) return false;
  const operation = getEntityOperationContracts().find(
    (entry) => entry.entityName === tool.entity && entry.intent === tool.operation,
  );
  if (operation?.implementation?.type === "plugin") return true;
  return !collectionMutationError(table, tool.operation, [...tables.values()]);
}

export function toolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): { tool: CatalogTool; entity: CatalogEntity | undefined }[] {
  const entitiesByName = new Map(
    catalog.entities.map((entity) => [entity.entity, entity]),
  );
  return catalog.tools
    .filter((tool) =>
      sessionMayInvoke(tables.get(tool.table), tool.operation, session),
    )
    .filter((tool) => crudToolCanSucceed(tool, tables))
    .map((tool) => ({ tool, entity: entitiesByName.get(tool.entity) }));
}

/**
 * A resource is a read surface, so visibility and reads are both gated on the
 * entity's read role — the same rule `get`/`list` tools follow. Like the tool
 * listing, an unauthorized resource is omitted rather than erroring.
 */
export function resourcesForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
  resources: CatalogResource[] = catalogResources,
): CatalogResource[] {
  return resources.filter((resource) =>
    sessionMayInvoke(tables.get(resource.table), "get", session),
  );
}

export function coreOwnsStaticToolName(
  name: string,
  projection: OperationToolProjection = generatedOperationToolProjection,
): boolean {
  return [
    ...catalog.tools.map((tool) => tool.name),
    ...catalog.operationTools.map((tool) => tool.name),
    ...catalogDerivedTools.flatMap((entry) => [
      ...(entry.connect ? [entry.connect.name] : []),
      ...(entry.dryRun ? [entry.dryRun.name] : []),
      ...(entry.personalization ? [entry.personalization.set.name] : []),
    ]),
    ...catalogGuideTools.map((tool) => tool.name),
    ...catalogDiscoveryTools.map((tool) => tool.name),
    ...catalogTestTools.map((tool) => tool.name),
    ...connectorMcpTools(listConnectorContracts()).map((tool) => tool.name),
    SESSION_INFO_TOOL_NAME, // session-info (whoami / osf://session)
    GENERIC_DESCRIBE_TOOL_NAME, // the second step of the generic osf_* projection
    ...ONBOARDING_TOOL_NAMES, // first-use onboarding (mcp/onboarding.ts)
    ...UPDATE_TOOL_NAMES, // update notices (mcp/update-notices.ts)
    ...EDIT_LEASE_TOOL_NAMES, // central entity edit leases
    ...(projection.mode === "searchable"
      ? [projection.search, projection.execute]
      : []),
  ].includes(name);
}

export function guideToolsForSession(session: DbSessionInput): CatalogGuideTool[] {
  const granted = new Set(session.roles ?? []);
  return catalogGuideTools.filter((tool) =>
    tool.roles.some((role) => granted.has(role)),
  );
}

/** Discovery follows the entity's read role, like the resource surface. */
export function discoveryToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogDiscoveryTool[] {
  return catalogDiscoveryTools.filter((tool) =>
    !tool.compatibility &&
    sessionMayInvoke(tables.get(tool.table), "get", session),
  );
}

/** A test reads the row and exercises it; visibility follows the read role. */
export function testToolsForSession(
  session: DbSessionInput,
  tables: Map<string, GeneratedTable>,
): CatalogTestTool[] {
  return catalogTestTools.filter((tool) =>
    !tool.compatibility &&
    sessionMayInvoke(tables.get(tool.table), "get", session),
  );
}
