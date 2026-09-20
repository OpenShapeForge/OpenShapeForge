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
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import rawCatalog from "../generated/mcp/tools.json" with { type: "json" };
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { type DerivedToolsCatalogEntry } from "./derived-tools.js";
import { type ElicitOnCreateEntry } from "./elicitation.js";
import { listConnectorContracts } from "../connectors/catalog.js";

export type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

export type McpOperation = "list" | "get" | "create" | "update" | "delete";


export type CatalogTool = {
  name: string;
  /** The id of the canonical Operation this tool invokes (`<Entity>.<operation>`). */
  operationId: string;
  operation: McpOperation;
  entity: string;
  table: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool's output envelope: `{ data, operations }` as the Operation answers it. */
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  /**
   * The failures the canonical Operation declares. Not part of the listed
   * tool — the listing is budgeted by the byte — but answered by osf_describe,
   * where a model asks for one entity's exact contract.
   */
  errors: readonly { status: number; code: string; description: string }[];
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


export function entityForTable(table: string): CatalogEntity | undefined {
  return catalog.entities.find((entity) => entity.table === table);
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


export const catalogResources: CatalogResource[] = catalog.resources ?? [];


export const catalogDerivedTools: DerivedToolsCatalogEntry[] =
  catalog.derivedTools ?? [];
export const projectedDerivedTools = catalogDerivedTools.filter(
  (entry) => !entry.compatibility,
);
export const catalogDiscoveryTools: CatalogDiscoveryTool[] =
  catalog.discoveryTools ?? [];
export const catalogTestTools: CatalogTestTool[] = catalog.testTools ?? [];
export const catalogGuideTools: CatalogGuideTool[] = catalog.guideTools ?? [];

/**
 * The public names of the derived-tool helpers (connect, dry run, set
 * preferences). A plugin's own Operation of the same name is implemented BY
 * the helper (the execution compatibility bridge), so a call under such a
 * name — direct, or the bridge's own dispatch — goes to the helper, never to
 * the Operation handler that would only bridge back here.
 */
export function isDerivedHelperToolName(name: string): boolean {
  return catalogDerivedTools.some(
    (entry) =>
      entry.connect?.name === name ||
      entry.dryRun?.name === name ||
      entry.personalization?.set.name === name,
  );
}

export const compatibilityOperations = catalog.executionCompatibility ?? [];
export const compatibilityOperationByKey = new Map(
  compatibilityOperations.map((entry) => [entry.operation, entry]),
);
export const compatibilityToolNames = new Set(
  compatibilityOperations.map((entry) => entry.toolName),
);

/** Test-only: register one execution compatibility bridge the way the catalogue would carry it. */
export function __registerExecutionCompatibilityForTests(
  entry: NonNullable<Catalog["executionCompatibility"]>[number],
): () => void {
  compatibilityOperationByKey.set(entry.operation, entry);
  compatibilityToolNames.add(entry.toolName);
  return () => {
    compatibilityOperationByKey.delete(entry.operation);
    compatibilityToolNames.delete(entry.toolName);
  };
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
