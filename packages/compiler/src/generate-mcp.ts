// SPDX-License-Identifier: BUSL-1.1
/**
 * MCP tool-catalog generator for entities that opt into generated MCP exposure
 * (`mcp:` block in the entity YAML → `TableDefinition.source.mcp`).
 *
 * This is the one generator fed by the compiled CONTRACTS rather than the
 * manifest, and deliberately so. `manifest.json` carries storage columns —
 * name, type, required, classification — which is everything the SQL layer
 * needs and almost nothing a language model needs. The authored labels,
 * descriptions, validation bounds, and enumerations that make a tool schema
 * usable live on `CompiledEntityContract.model.fields`, so that is the input.
 *
 * Emitting a separate artifact (rather than fattening the manifest) also keeps
 * the manifest checksum stable: it drives migrations and drift detection, and
 * must not move because a field's help text changed. `rest/openapi.json` is
 * the same pattern.
 *
 * Determinism: pure function of the compiled contracts; no timestamps,
 * entities sorted by tool prefix, fields in authored order.
 */
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchema,
  compiledObjectSchema,
  describeCompiledField,
  localizedText,
} from "./field-json-schema.js";

type JsonObject = Record<string, unknown>;

/** Operations whose tools accept no entity fields, only identifiers/paging. */
const READ_OPERATIONS = new Set(["list", "get"]);

/**
 * Server-managed columns. A model must never be invited to set these: the id
 * is generated, the tenant comes from the session, and the timestamps are
 * maintained by the database. Mirrors writableColumnMap in the API's CRUD
 * layer and isWritableColumn in the OpenAPI generator.
 */
const SERVER_MANAGED_FIELDS = new Set(["id", "tenantId", "createdAt", "updatedAt"]);

/**
 * Fields a caller may write, mirroring the CRUD layer's writability rule so the
 * advertised schema matches what the server will actually accept.
 *
 * Authored `readOnly` is deliberately NOT consulted. In this vocabulary it is a
 * presentation flag — resolveRender uses it to pick a display component instead
 * of an input one — not an API contract, and no transport enforces it. Treating
 * it as one here omitted PaymentDetail.relationId, the only link between a
 * payment detail and its relation, so an agent could not create the attached
 * record that REST and GraphQL create happily.
 *
 * Authored `immutable` IS consulted, and only on update: it means "settable at
 * create, fixed afterwards" (#177). The CRUD layer reads the same flag off the
 * manifest column, so the advertised update schema and the server's refusal
 * come from one authored fact.
 */
function writableFields(
  fields: CompiledField[],
  operation: "create" | "update",
): CompiledField[] {
  return fields.filter(
    (field) =>
      !SERVER_MANAGED_FIELDS.has(field.key) &&
      field.computed === undefined &&
      !(operation === "update" && field.immutable === true),
  );
}

function sortableFieldKeys(fields: CompiledField[]): string[] {
  return fields
    .filter((field) => field.cardinality !== "collection" && field.valueType !== "object")
    .map((field) => field.key);
}

/** Fields carrying a restricting classification, for the runtime to withhold. */
function classifiedFieldKeys(fields: CompiledField[]): string[] {
  return fields
    .filter((field) => {
      const sensitivity = field.classification?.sensitivity;
      return (
        sensitivity === "confidential" || sensitivity === "pii" || sensitivity === "bsn"
      );
    })
    .map((field) => field.key);
}

export type McpToolDefinition = {
  name: string;
  operation: "list" | "get" | "create" | "update" | "delete";
  entity: string;
  table: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

function annotationsFor(operation: McpToolDefinition["operation"]) {
  switch (operation) {
    case "list":
    case "get":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    case "create":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    case "update":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
    case "delete":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  }
}

function entityLabel(contract: CompiledEntityContract): string {
  return localizedText(contract.entity.labels) ?? contract.entity.title ?? contract.entity.name;
}

function entityDescription(contract: CompiledEntityContract): string {
  return localizedText(contract.entity.description) ?? `The ${entityLabel(contract)} entity.`;
}

function buildToolsForEntity(
  contract: CompiledEntityContract,
  table: string,
  referentiedata: CoreReferentiedataSnapshot,
): McpToolDefinition[] {
  const mcp = contract.mcp;
  if (!mcp) return [];

  const fields = contract.model.fields;
  const creatable = writableFields(fields, "create");
  const updatable = writableFields(fields, "update");
  const label = entityLabel(contract);
  const description = entityDescription(contract);
  const sortable = sortableFieldKeys(fields);
  const filterField = contract.entity.filterField;
  const tools: McpToolDefinition[] = [];

  const idSchema: JsonObject = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid", description: `Identifier of the ${label}.` },
    },
    required: ["id"],
    additionalProperties: false,
  };

  const named = (operation: McpToolDefinition["operation"]) =>
    mcp.tools === "dedicated" ? `${mcp.toolPrefix}_${operation}` : `osf_${operation}`;

  if (mcp.operations.list) {
    const filterProperties: JsonObject = {};
    for (const field of fields) {
      if (field.cardinality === "collection" || field.valueType === "object") continue;
      const schema = compiledFieldSchema(field, referentiedata);
      // Filters are always optional and never defaulted — a default here would
      // silently narrow a caller's result set.
      delete schema.default;
      filterProperties[field.key] = schema;
    }
    tools.push({
      name: named("list"),
      operation: "list",
      entity: contract.entity.name,
      table,
      title: `List ${label}`,
      description:
        `${description} Returns a page of records. Text filters match on substring; ` +
        `other types match exactly.` +
        (filterField ? ` Free-text search is usually best against "${filterField}".` : ""),
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: filterProperties,
            additionalProperties: false,
            description: "Field equality/substring filters. Omit for no filtering.",
          },
          sortField: {
            type: "string",
            ...(sortable.length > 0 ? { enum: sortable } : {}),
            description: "Field to sort by. Defaults to the primary key.",
          },
          sortDirection: { type: "string", enum: ["asc", "desc"] },
          first: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Page size (1-200, default 50).",
          },
          after: {
            type: "string",
            description: "Opaque cursor from a previous call's nextCursor.",
          },
        },
        additionalProperties: false,
      },
      annotations: annotationsFor("list"),
    });
  }

  if (mcp.operations.get) {
    tools.push({
      name: named("get"),
      operation: "get",
      entity: contract.entity.name,
      table,
      title: `Get ${label}`,
      description: `${description} Fetches a single record by id.`,
      inputSchema: idSchema,
      annotations: annotationsFor("get"),
    });
  }

  if (mcp.operations.create) {
    tools.push({
      name: named("create"),
      operation: "create",
      entity: contract.entity.name,
      table,
      title: `Create ${label}`,
      description: `${description} Creates a new record.`,
      inputSchema: compiledObjectSchema(creatable, referentiedata, { requireRequired: true }),
      annotations: annotationsFor("create"),
    });
  }

  if (mcp.operations.update) {
    // Update is a partial: nothing is required beyond the id, because omitting
    // a field means "leave it alone", not "clear it".
    const patch = compiledObjectSchema(updatable, referentiedata, { requireRequired: false });
    tools.push({
      name: named("update"),
      operation: "update",
      entity: contract.entity.name,
      table,
      title: `Update ${label}`,
      description: `${description} Partially updates a record; omitted fields are left unchanged.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", description: `Identifier of the ${label}.` },
          values: patch,
        },
        required: ["id", "values"],
        additionalProperties: false,
      },
      annotations: annotationsFor("update"),
    });
  }

  if (mcp.operations.delete) {
    tools.push({
      name: named("delete"),
      operation: "delete",
      entity: contract.entity.name,
      table,
      title: `Delete ${label}`,
      description: `${description} Permanently deletes a record by id.`,
      inputSchema: idSchema,
      annotations: annotationsFor("delete"),
    });
  }

  return tools;
}

export type McpEntityCatalogEntry = {
  entity: string;
  slug: string;
  table: string;
  toolPrefix: string;
  tools: "dedicated" | "generic";
  title: string;
  description: string;
  domains: string[];
  displayTemplate?: string;
  filterField?: string;
  /**
   * Field keys carrying a restricting data classification. The runtime uses
   * this to withhold them from schema descriptions for callers who may not
   * read them, so the schema itself is not an enumeration oracle.
   */
  classifiedFields: string[];
  fields: {
    key: string;
    label?: string;
    description?: string;
    required: boolean;
    readOnly: boolean;
    schema: JsonObject;
    classification?: string;
  }[];
};

export type McpCatalog = {
  generatedBy: string;
  source: string;
  entities: McpEntityCatalogEntry[];
  tools: McpToolDefinition[];
};

export type McpCatalogInput = {
  slug: string;
  contract: CompiledEntityContract;
  /** Physical table name, `schema.table`, matching the runtime manifest. */
  table: string;
};

/**
 * Guard against a tool catalog too large to be usable. Tool-selection quality
 * degrades well before a model runs out of context, so an entity count that
 * would flood the list is a build failure with a named remedy, not a runtime
 * surprise. Mirrors how the rest of this compiler fails closed.
 */
export const MAX_DEDICATED_TOOLS = 60;

export function buildMcpCatalog(
  inputs: McpCatalogInput[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
): McpCatalog {
  const opted = inputs
    .filter((input) => input.contract.mcp !== undefined)
    .sort((a, b) => a.contract.mcp!.toolPrefix.localeCompare(b.contract.mcp!.toolPrefix));

  const entities: McpEntityCatalogEntry[] = [];
  const tools: McpToolDefinition[] = [];

  for (const input of opted) {
    const { contract } = input;
    const mcp = contract.mcp!;
    const fields = contract.model.fields;

    entities.push({
      entity: contract.entity.name,
      slug: input.slug,
      table: input.table,
      toolPrefix: mcp.toolPrefix,
      tools: mcp.tools,
      title: entityLabel(contract),
      description: entityDescription(contract),
      domains: [...contract.entity.domains],
      ...(contract.entity.displayTemplate
        ? { displayTemplate: contract.entity.displayTemplate }
        : {}),
      ...(contract.entity.filterField ? { filterField: contract.entity.filterField } : {}),
      classifiedFields: classifiedFieldKeys(fields),
      fields: fields.map((field) => {
        const label = localizedText(field.label);
        const description = describeCompiledField(field);
        return {
          key: field.key,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          required: field.required === true,
          readOnly: field.readOnly === true,
          schema: compiledFieldSchema(field, referentiedata),
          ...(field.classification?.sensitivity
            ? { classification: field.classification.sensitivity }
            : {}),
        };
      }),
    });

    tools.push(...buildToolsForEntity(contract, input.table, referentiedata));
  }

  const dedicatedCount = tools.filter((tool) => !tool.name.startsWith("osf_")).length;
  if (dedicatedCount > MAX_DEDICATED_TOOLS) {
    const offenders = opted
      .filter((input) => input.contract.mcp!.tools === "dedicated")
      .map((input) => input.slug)
      .join(", ");
    throw new Error(
      `MCP tool catalog would advertise ${dedicatedCount} dedicated tools, over the ` +
        `${MAX_DEDICATED_TOOLS} limit. A model's tool selection degrades badly at that ` +
        `size. Set \`mcp: { tools: generic }\` on some of these entities so they share ` +
        `the osf_* tools instead: ${offenders}.`,
    );
  }

  return {
    generatedBy: "@openshapeforge/compiler",
    source,
    entities,
    tools,
  };
}

export function renderMcpCatalog(
  inputs: McpCatalogInput[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
): string {
  return `${JSON.stringify(buildMcpCatalog(inputs, source, referentiedata), null, 2)}\n`;
}
