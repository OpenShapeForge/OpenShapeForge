// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiled MCP catalogue (`generated/mcp/tools.json`) as the runtime reads
 * it, and the per-session projection rules that decide what a caller is
 * SHOWN: which entity tools a session may invoke, which classified fields are
 * withheld from its schemas, which resources, guides, discovery and test
 * tools it sees. Everything here is read-only over the catalogue and the
 * manifest; the CRUD core remains the enforcement on the call path.
 *
 * Split out of generated-mcp-server.ts; the server imports these and adds
 * the transport.
 */
import type { RuntimeModule } from "../modules/contract.js";
import { createHash } from "node:crypto";
import { collectionMutationError } from "../operations/entity/collection-policy.js";
import { GENERIC_DESCRIBE_TOOL_NAME, compareCodeUnits } from "@openshapeforge/operations";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import rawCatalog from "../generated/mcp/tools.json" with { type: "json" };
import type { DbSessionInput } from "../db/session.js";
import {
  getEntityOperationContracts,
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
} from "../operations/entity/index.js";
import { deriveToolName, type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { type ElicitOnCreateEntry } from "./elicitation.js";
import { EDIT_LEASE_TOOL_NAMES } from "./edit-lease-tools.js";
import { ONBOARDING_TOOL_NAMES } from "./onboarding.js";
import { UPDATE_TOOL_NAMES } from "./update-notices.js";
import { listConnectorContracts } from "../connectors/catalog.js";
import { connectorMcpTools } from "../connectors/mcp-tools.js";
import { SESSION_INFO_TOOL_NAME } from "./session-info.js";
import { localizedText, type ResolvedLocale } from "./locale.js";
import {
  canonicalRuntimeOperationSchema,
  runtimeOperationEnvelopeSchema,
} from "./operation-search.js";
import { ENTITY_OAUTH_CALLBACK_PATH, callbackOrigin } from "./handoff-config.js";

export type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

export type McpOperation = "list" | "get" | "create" | "update" | "delete";

export function entityMutationControls(args: Record<string, unknown>) {
  return {
    ...(typeof args.blueprintId === "string" ? { blueprintId: args.blueprintId } : {}),
    ...(typeof args.expectedVersion === "string"
      ? { expectedVersion: args.expectedVersion }
      : {}),
    ...(typeof args.leaseToken === "string"
      ? { leaseToken: args.leaseToken }
      : {}),
    ...(typeof args.confirmed === "boolean"
      ? { confirmed: args.confirmed }
      : {}),
    ...(typeof args.confirmationToken === "string"
      ? { confirmationToken: args.confirmationToken }
      : {}),
    ...(typeof args.confirmationAnswer === "string"
      ? { confirmationAnswer: args.confirmationAnswer }
      : {}),
  };
}

export const __entityMutationControlsForTests = entityMutationControls;

export type CatalogTool = {
  name: string;
  /** Strict v2 catalogues publish the canonical id; v1 resolves it internally. */
  operationId?: string;
  operation: McpOperation;
  entity: string;
  table: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

export type CatalogEntity = {
  entity: string;
  slug: string;
  table: string;
  toolPrefix: string;
  /**
   * `generic` entities share one set of `osf_*` tools instead of spending a
   * slot of the dedicated-tool budget each — see MAX_DEDICATED_TOOLS in the
   * compiler. The catalog still carries ONE entry per entity per operation
   * (same name, entity-specific schema); projecting those into a session is
   * this file's job (see genericToolForSession).
   */
  tools?: "dedicated" | "generic";
  title: string;
  /**
   * The authored label per language, when the entity has one. The compiler
   * also collapses it into `title` for tool names; this keeps the map so a
   * session reading Dutch can be shown "Testdoel" where an English one reads
   * "Test target" (generate-mcp.ts).
   */
  labels?: Record<string, string>;
  description: string;
  domains: string[];
  displayTemplate?: string;
  filterField?: string;
  classifiedFields: string[];
  fields: CatalogField[];
  relationships: CatalogRelationship[];
  elicitOnCreate?: ElicitOnCreateEntry;
};

export type ProjectedRuntimeOperationTool = {
  definition: RuntimeOperationDefinition;
  tool: Tool;
};

export function projectRuntimeOperationTool(
  definition: RuntimeOperationDefinition,
  locale: ResolvedLocale,
): ProjectedRuntimeOperationTool {
  const name = deriveToolName(definition.key);
  if (!name) {
    throw new Error(
      `Runtime Operation ${JSON.stringify(definition.id)} has no usable MCP key.`,
    );
  }
  const title = localizedText(definition.name, locale) ?? definition.id;
  const description = localizedText(definition.description, locale) ?? title;
  return {
    definition,
    tool: {
      name,
      title,
      description,
      inputSchema: canonicalRuntimeOperationSchema(
        definition.input,
        definition.id,
        "input",
      ) as Tool["inputSchema"],
      outputSchema: runtimeOperationEnvelopeSchema(definition) as Tool["outputSchema"],
      annotations: {
        title,
        readOnlyHint:
          definition.effects.data === "read" &&
          definition.effects.external !== "write",
        destructiveHint: definition.effects.data === "delete",
        idempotentHint:
          definition.reliability.idempotency.mode !== "none",
      },
    },
  };
}

export type CatalogField = {
  key: string;
  label?: string;
  description?: string;
  baseType: string;
  cardinality: string;
  required: boolean;
  readOnly: boolean;
  immutable: boolean;
  schema: Record<string, unknown>;
  classification?: string;
  relationship?: { kind: string; entity: string };
};

export type CatalogRelationship = {
  key: string;
  kind: string;
  target: string;
  foreignKey?: string;
  via?: string;
  label?: string;
};

/**
 * The JSON import widens every string literal, so the catalog is re-typed once
 * here. The compiler is the authority on this shape (generate-mcp.ts); a
 * mismatch surfaces as a runtime miss on a tool name, which the CallTool
 * handler already treats as unknown.
 */
export type CatalogResource = {
  uri: string;
  name: string;
  description: string;
  templateUri: string;
  templateName: string;
  templateDescription: string;
  entity: string;
  table: string;
};

export type CatalogGuideTool = {
  name: string;
  description: string;
  roles: string[];
  content: string;
  entity?: string;
  table?: string;
  requireBeforeCreate?: boolean;
};

export type CapturedDerivedExecution = {
  entry: DerivedToolsCatalogEntry;
  serviceRow: Record<string, unknown>;
  binding: Record<string, unknown>;
  operationRow: Record<string, unknown>;
  providerRow: Record<string, unknown>;
  connectionRows: Record<string, unknown>[];
  selectedConnectionId: string;
};

export function stableSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSnapshotJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSnapshotJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function authorityFingerprint(capture: CapturedDerivedExecution): string {
  return createHash("sha256")
    .update(stableSnapshotJson(capture))
    .digest("base64url");
}

export type CatalogDiscoveryTool = {
  name: string;
  description: string;
  entity: string;
  table: string;
  compatibility?: { plugin: string; operation: string };
};

export type CatalogTestTool = {
  name: string;
  description: string;
  entity: string;
  table: string;
  compatibility?: { plugin: string; operation: string };
};

export type Catalog = {
  generatedBy: string;
  source: string;
  tools: CatalogTool[];
  operationTools: {
    key: string;
    plugin: string;
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    auth:
      | { mode: "public" }
      | { mode: "control"; roles: string[] }
      | { mode: "session"; roles?: string[]; roleGroups?: string[][]; scopes?: string[] };
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
    };
  }[];
  operationToolProjection?: {
    mode: "dedicated" | "searchable";
    search: string;
    execute: string;
  };
  entities: CatalogEntity[];
  resources?: CatalogResource[];
  derivedTools?: DerivedToolsCatalogEntry[];
  discoveryTools?: CatalogDiscoveryTool[];
  testTools?: CatalogTestTool[];
  guideTools?: CatalogGuideTool[];
  executionCompatibility?: Array<{
    plugin: string;
    operation: string;
    toolName: string;
    auth:
      | { mode: "public" }
      | { mode: "session"; roles: string[]; scopes?: string[] };
  }>;
};
export const catalog = rawCatalog as unknown as Catalog;
export type OperationToolProjection = NonNullable<Catalog["operationToolProjection"]>;
export const generatedOperationToolProjection: OperationToolProjection =
  catalog.operationToolProjection ?? {
    mode: "dedicated" as const,
    search: "osf_search_operations",
    execute: "osf_execute_operation",
  };

/** Which entity role an operation requires — mirrors the CRUD layer's gate. */
export const OPERATION_ROLE = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  delete: "delete",
} as const;

export const SERVER_INFO = {
  name: "openshapeforge",
  version: "1",
} as const;

// The fixed instruction texts (INSTRUCTIONS, the data acquisition order,
// the audience and presentation rules, the language sentence) live in
// mcp/server-instructions.ts, which assembles them per session below.
export const JSON_MIME_TYPE = "application/json";

export function tablesByName(): Map<string, GeneratedTable> {
  return new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
}

export function fieldNameForColumn(column: GeneratedTable["columns"][number]) {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    )
  );
}

export function serializeRow(table: GeneratedTable, row: Record<string, unknown>) {
  return Object.fromEntries(
    table.columns.map((column) => [
      fieldNameForColumn(column),
      row[column.name],
    ]),
  );
}

/**
 * Whether a provider's connections are per-employee. Explicit
 * auth.connectionScope wins; absent, personal sign-in implies "user" and
 * everything else "tenant".
 */
export function connectionScopeOf(
  auth: Record<string, unknown> | null | undefined,
): "user" | "tenant" | "both" {
  if (
    auth?.connectionScope === "user" ||
    auth?.connectionScope === "tenant" ||
    auth?.connectionScope === "both"
  ) {
    return auth.connectionScope;
  }
  return auth?.profile === "oauth2AuthorizationCode" ? "user" : "tenant";
}

export let oauthProviderTablesCache: Set<string> | undefined;
export function oauthProviderTables(): Set<string> {
  oauthProviderTablesCache ??= new Set(
    (catalog.derivedTools ?? [])
      .filter((entry) => entry.execution)
      .map((entry) => entry.execution!.providerTable),
  );
  return oauthProviderTablesCache;
}

export function serializeRowForEntity(
  _entity: CatalogEntity | undefined,
  table: GeneratedTable,
  row: Record<string, unknown>,
) {
  const serialized = serializeRow(table, row);
  // A provider declaring personal sign-in needs its OAuth client registered
  // with THIS server's redirect URL — a fact only this process knows, so it
  // rides along on the row instead of being asked of anyone.
  const auth = serialized.auth as Record<string, unknown> | null | undefined;
  if (
    oauthProviderTables().has(table.name) &&
    auth &&
    typeof auth === "object" &&
    auth.profile === "oauth2AuthorizationCode"
  ) {
    serialized.oauthRedirectUrl = `${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`;
  }
  return serialized;
}

export function entityForTable(table: string): CatalogEntity | undefined {
  return catalog.entities.find((entity) => entity.table === table);
}

/**
 * Whether the session holds a role permitting `operation` on this table.
 *
 * Read-only mirror of requireEntityOperation() used to decide what to
 * ADVERTISE. It deliberately never throws: a tool the caller cannot use is
 * omitted from the listing, not surfaced as an error.
 */
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
 * The catalog entries advertised under one tool name.
 *
 * A dedicated name has exactly one. A generic `osf_*` name has ONE PER ENTITY
 * that opted into `mcp: { tools: generic }`: the compiler emits a tool entry
 * per entity either way and skips `osf_`-prefixed names in its duplicate check
 * (packages/compiler/src/generate-mcp.ts), so `osf_list` legitimately appears
 * once for every generic entity in the deployment.
 *
 * That makes `catalog.tools.find((tool) => tool.name === name)` wrong for a
 * generic name: it answers with whichever entity sorts first in the catalog,
 * silently and regardless of who is asking. Every lookup by name goes through
 * one of these two instead, and then says which entity it means.
 */
export function crudToolsNamed(name: string): CatalogTool[] {
  return catalog.tools.filter((tool) => tool.name === name);
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

export const catalogResources: CatalogResource[] = catalog.resources ?? [];

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

export const catalogDerivedTools: DerivedToolsCatalogEntry[] =
  catalog.derivedTools ?? [];
export const projectedDerivedTools = catalogDerivedTools.filter(
  (entry) => !entry.compatibility,
);
export const catalogDiscoveryTools: CatalogDiscoveryTool[] =
  catalog.discoveryTools ?? [];
export const catalogTestTools: CatalogTestTool[] = catalog.testTools ?? [];
export const catalogGuideTools: CatalogGuideTool[] = catalog.guideTools ?? [];

export const compatibilityOperations = catalog.executionCompatibility ?? [];
export const compatibilityOperationByKey = new Map(
  compatibilityOperations.map((entry) => [entry.operation, entry]),
);
export const compatibilityToolNames = new Set(
  compatibilityOperations.map((entry) => entry.toolName),
);

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

export function hasMcpSurface(
  modules: readonly RuntimeModule[],
  core: {
    tools: number;
    operationTools: number;
    connectors: number;
  } = {
    tools: catalog.tools.length,
    operationTools: catalog.operationTools.length,
    connectors: listConnectorContracts().length,
  },
): boolean {
  return (
    core.tools > 0 ||
    core.operationTools > 0 ||
    core.connectors > 0 ||
    modules.some(
      (module) =>
        module.mcp !== undefined ||
        (module.operationProviders?.length ?? 0) > 0,
    )
  );
}

export function hasDynamicModuleToolProjection(
  modules: readonly RuntimeModule[],
): boolean {
  return modules.some(
    (module) =>
      module.mcp?.tools !== undefined ||
      module.mcp?.decorateTool !== undefined,
  );
}
