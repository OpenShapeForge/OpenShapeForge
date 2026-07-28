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
import type { LocalizedText } from "./authoring/types/common.js";
import { getReferentieItemsForGroep } from "./authoring/referentiedata/resolve-referentiedata-options.js";

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

function text(value: LocalizedText | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return (value.en ?? value.nl ?? value.fr)?.trim() || undefined;
}

/**
 * Compose a parameter description from every authored source, in a fixed
 * order so output stays byte-stable. `hints.aiInstructions` goes last because
 * it is the most specific — an author writing it is correcting whatever the
 * generic label implied.
 */
function describeField(field: CompiledField): string | undefined {
  const parts: string[] = [];
  const label = text(field.label);
  const description = text(field.description);
  const help = text(field.help);

  if (description) {
    parts.push(description);
  } else if (label) {
    parts.push(label);
  }
  if (help) parts.push(help);
  if (field.unit) parts.push(`Unit: ${field.unit}.`);
  if (field.readOnly) parts.push("Read-only; set by the server.");
  if (field.relationship?.entity) {
    parts.push(
      `References the ${field.relationship.entity} entity — resolve an id with that entity's list tool.`,
    );
  }
  if (field.computed?.expression) {
    parts.push("Derived server-side; any supplied value is ignored.");
  }
  const aiInstructions = field.hints?.aiInstructions?.trim();
  if (aiInstructions) parts.push(aiInstructions);

  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Resolve a field's closed vocabulary, if it has one.
 *
 * Two authoring spellings reach the same place. `options:` is the documented
 * one. But entities in the wild put the group under `render.props.referentieGroep`
 * (the shape the UI select component consumes), and the shared
 * resolveFieldOptions() does not look there. Reading the render fallback HERE
 * rather than fixing the shared resolver keeps this generator additive:
 * changing resolveFieldOptions would move CompiledField.options into the
 * GraphQL profile types and the web form generators, producing byte-diffs in
 * host repos for no benefit to them.
 */
function resolveEnum(
  field: CompiledField,
): { values: string[]; labels: Map<string, string> } | undefined {
  const options = field.options;
  const renderGroep = field.render?.props?.referentieGroep;

  if (options?.type === "static" && options.items && options.items.length > 0) {
    return {
      values: options.items.map((item) => item.value),
      labels: new Map(
        options.items.flatMap((item) => {
          const label = text(item.label);
          return label ? [[item.value, label] as const] : [];
        }),
      ),
    };
  }

  const groep =
    options?.type === "referentiedata" && options.referentieGroep
      ? options.referentieGroep
      : typeof renderGroep === "string"
        ? renderGroep
        : undefined;
  if (!groep) return undefined;

  const items = getReferentieItemsForGroep(groep);
  if (items.length === 0) return undefined;
  return {
    values: items.map((item) => item.value),
    labels: new Map(
      items.flatMap((item) => {
        const label = text(item.label);
        return label ? [[item.value, label] as const] : [];
      }),
    ),
  };
}

function baseTypeFor(field: CompiledField): JsonObject {
  switch (field.valueType) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "object":
      return { type: "object" };
    case "string":
    default:
      return { type: "string" };
  }
}

/** Unwrap `x` or `{ value: x }` — validation rules carry either. */
function ruleValue(rule: unknown): number | string | boolean | undefined {
  if (rule === undefined || rule === null) return undefined;
  if (typeof rule === "object" && "value" in (rule as JsonObject)) {
    const inner = (rule as { value: unknown }).value;
    return typeof inner === "number" || typeof inner === "string" || typeof inner === "boolean"
      ? inner
      : undefined;
  }
  return typeof rule === "number" || typeof rule === "string" || typeof rule === "boolean"
    ? rule
    : undefined;
}

function numericRule(rule: unknown): number | undefined {
  const value = ruleValue(rule);
  return typeof value === "number" ? value : undefined;
}

function stringRule(rule: unknown): string | undefined {
  const value = ruleValue(rule);
  return typeof value === "string" ? value : undefined;
}

/**
 * The authored field → JSON Schema mapping. This is the whole point of the
 * artifact: every constraint the author already wrote becomes a constraint the
 * model is told about up front, instead of one it discovers through a 400.
 */
function schemaForField(field: CompiledField): JsonObject {
  const scalar: JsonObject = baseTypeFor(field);
  const validation = field.validation;

  if (validation) {
    const minLength = numericRule(validation.minLength);
    const maxLength = numericRule(validation.maxLength);
    const min = numericRule(validation.min);
    const max = numericRule(validation.max);
    const pattern = stringRule(validation.pattern);

    if (minLength !== undefined) scalar.minLength = minLength;
    if (maxLength !== undefined) scalar.maxLength = maxLength;
    if (min !== undefined) scalar.minimum = min;
    if (max !== undefined) scalar.maximum = max;
    if (pattern !== undefined) scalar.pattern = pattern;
    // `format: uuid` is both a JSON Schema format and the signal the storage
    // layer uses to pick a uuid column, so it carries through unchanged.
    if (validation.format !== undefined) scalar.format = validation.format;
  }

  const enumeration = resolveEnum(field);
  if (enumeration) {
    scalar.enum = enumeration.values;
  }

  const descriptionParts: string[] = [];
  const fieldDescription = describeField(field);
  if (fieldDescription) descriptionParts.push(fieldDescription);
  if (enumeration && enumeration.labels.size > 0) {
    const rendered = enumeration.values
      .map((value) => {
        const label = enumeration.labels.get(value);
        return label ? `${value} (${label})` : value;
      })
      .join(", ");
    descriptionParts.push(`Allowed values: ${rendered}.`);
  }
  if (descriptionParts.length > 0) {
    scalar.description = descriptionParts.join(" ");
  }

  if (field.defaultValue !== undefined) {
    scalar.default = field.defaultValue;
  }

  if (field.cardinality !== "collection") {
    return scalar;
  }

  // Collections: the scalar shape becomes the item shape. A description on the
  // array itself is more useful to a model than one buried in `items`.
  const { description, ...items } = scalar;
  const array: JsonObject = { type: "array", items };
  if (description !== undefined) array.description = description;
  const minItems = numericRule(field.validation?.minItems);
  if (minItems !== undefined) array.minItems = minItems;
  return array;
}

/**
 * Fields a caller may write. Read-only and server-managed fields are omitted
 * entirely rather than marked, so they cannot be supplied at all — the CRUD
 * layer would reject them, and an absent property is a clearer instruction to
 * a model than a present-but-forbidden one.
 */
function writableFields(fields: CompiledField[]): CompiledField[] {
  return fields.filter(
    (field) =>
      !field.readOnly &&
      !SERVER_MANAGED_FIELDS.has(field.key) &&
      field.computed === undefined,
  );
}

function objectSchema(
  fields: CompiledField[],
  options: { requireRequired: boolean },
): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.key] = schemaForField(field);
    if (options.requireRequired && field.required) {
      required.push(field.key);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
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
  return text(contract.entity.labels) ?? contract.entity.title ?? contract.entity.name;
}

function entityDescription(contract: CompiledEntityContract): string {
  return text(contract.entity.description) ?? `The ${entityLabel(contract)} entity.`;
}

function buildToolsForEntity(
  contract: CompiledEntityContract,
  table: string,
): McpToolDefinition[] {
  const mcp = contract.mcp;
  if (!mcp) return [];

  const fields = contract.model.fields;
  const writable = writableFields(fields);
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
      const schema = schemaForField(field);
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
      inputSchema: objectSchema(writable, { requireRequired: true }),
      annotations: annotationsFor("create"),
    });
  }

  if (mcp.operations.update) {
    // Update is a partial: nothing is required beyond the id, because omitting
    // a field means "leave it alone", not "clear it".
    const patch = objectSchema(writable, { requireRequired: false });
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
        const label = text(field.label);
        const description = describeField(field);
        return {
          key: field.key,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          required: field.required === true,
          readOnly: field.readOnly === true,
          schema: schemaForField(field),
          ...(field.classification?.sensitivity
            ? { classification: field.classification.sensitivity }
            : {}),
        };
      }),
    });

    tools.push(...buildToolsForEntity(contract, input.table));
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

export function renderMcpCatalog(inputs: McpCatalogInput[], source: string): string {
  return `${JSON.stringify(buildMcpCatalog(inputs, source), null, 2)}\n`;
}
