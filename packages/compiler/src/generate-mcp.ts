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
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import { pluralize } from "./authoring/compiler/helpers.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchema,
  compiledObjectSchema,
  describeCompiledField,
  localizedText,
} from "./field-json-schema.js";

type JsonObject = Record<string, unknown>;

function describeMcpField(field: CompiledField): string | undefined {
  const parts: string[] = [];
  const semanticDescription = describeCompiledField(field, {
    relationshipInstruction: "resolve an id with that entity's list tool.",
  });
  if (semanticDescription) parts.push(semanticDescription);
  const aiInstructions = field.hints?.aiInstructions?.trim();
  if (aiInstructions) parts.push(aiInstructions);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const MCP_FIELD_SCHEMA_OPTIONS = { describeField: describeMcpField };

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
  // The elicited target field never appears in the create schema: its values
  // come from the person at the client via elicitation, not from the model.
  const creatable = writableFields(fields, "create").filter(
    (field) => field.key !== mcp.elicitOnCreate?.into,
  );
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
    mcp.tools === "dedicated"
      ? (mcp.toolOverrides?.[operation]?.name ?? `${mcp.toolPrefix}_${operation}`)
      : `osf_${operation}`;

  // Authored description wins outright: an author writing one is correcting
  // the composed default, so nothing is appended to it.
  const described = (operation: McpToolDefinition["operation"], fallback: string) =>
    mcp.toolOverrides?.[operation]?.description ?? fallback;

  if (mcp.operations.list) {
    const filterProperties: JsonObject = {};
    for (const field of fields) {
      if (field.cardinality === "collection" || field.valueType === "object") continue;
      const schema = compiledFieldSchema(field, referentiedata, MCP_FIELD_SCHEMA_OPTIONS);
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
      description: described(
        "list",
        `${description} Returns a page of records. Text filters match on substring; ` +
          `other types match exactly.` +
          (filterField ? ` Free-text search is usually best against "${filterField}".` : ""),
      ),
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
      description: described("get", `${description} Fetches a single record by id.`),
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
      description: described("create", `${description} Creates a new record.`),
      inputSchema: compiledObjectSchema(creatable, referentiedata, {
        requireRequired: true,
        ...MCP_FIELD_SCHEMA_OPTIONS,
      }),
      annotations: annotationsFor("create"),
    });
  }

  if (mcp.operations.update) {
    // Update is a partial: nothing is required beyond the id, because omitting
    // a field means "leave it alone", not "clear it".
    const patch = compiledObjectSchema(updatable, referentiedata, {
      requireRequired: false,
      ...MCP_FIELD_SCHEMA_OPTIONS,
      includeDefault: false,
    });
    tools.push({
      name: named("update"),
      operation: "update",
      entity: contract.entity.name,
      table,
      title: `Update ${label}`,
      description: described(
        "update",
        `${description} Partially updates a record; omitted fields are left unchanged.`,
      ),
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
      description: described("delete", `${description} Permanently deletes a record by id.`),
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
  elicitOnCreate?: McpElicitOnCreateDefinition;
  fields: {
    key: string;
    label?: string;
    description?: string;
    valueType: CompiledField["valueType"];
    cardinality: CompiledField["cardinality"];
    required: boolean;
    readOnly: boolean;
    immutable: boolean;
    schema: JsonObject;
    classification?: string;
    relationship?: {
      kind: NonNullable<CompiledField["relationship"]>["kind"];
      entity: string;
    };
  }[];
  relationships: {
    key: string;
    kind: CompiledRelationship["kind"];
    target: string;
    foreignKey?: string;
    via?: string;
    label?: string;
  }[];
};

export type McpResourceDefinition = {
  /** Direct catalogue resource URI, exactly as authored. */
  uri: string;
  name: string;
  description: string;
  /** Single-record template, derived as `<uri>/{id}`. */
  templateUri: string;
  templateName: string;
  templateDescription: string;
  entity: string;
  table: string;
};

export type McpElicitOnCreateDefinition = {
  sourceField: string;
  sourceEntity: string;
  /** Physical table of the source entity, resolved at catalog build. */
  sourceTable: string;
  definitionsField: string;
  into: string;
  message?: string;
};

export type McpDerivedExecutionDefinition = {
  bindingsField: string;
  operationRef: string;
  operationEntity: string;
  /** Physical table of the operation entity, resolved at catalog build. */
  operationTable: string;
  providerRef: string;
  providerEntity: string;
  providerTable: string;
  connectionEntity: string;
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

export type McpDerivedToolsDefinition = {
  entity: string;
  table: string;
  roles: string[];
  keyField: string;
  titleField?: string;
  descriptionField: string;
  inputFieldsField: string;
  execution?: McpDerivedExecutionDefinition;
};

export type McpCatalog = {
  generatedBy: string;
  source: string;
  entities: McpEntityCatalogEntry[];
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  derivedTools: McpDerivedToolsDefinition[];
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

/**
 * Resolve the elicitation source entity to its physical table, failing closed
 * at build time: a dangling source would otherwise surface as a runtime miss
 * on the first create call.
 */
function resolveSourceTable(
  inputs: McpCatalogInput[],
  elicit: { sourceEntity: string; definitionsField: string },
  owningEntity: string,
): string {
  const source = inputs.find((input) => input.contract.entity.name === elicit.sourceEntity);
  if (!source) {
    throw new Error(
      `mcp elicitOnCreate on entity "${owningEntity}" names source entity ` +
        `"${elicit.sourceEntity}", which is not part of this catalog.`,
    );
  }
  const hasField = source.contract.model.fields.some(
    (field) => field.key === elicit.definitionsField,
  );
  if (!hasField) {
    throw new Error(
      `mcp elicitOnCreate on entity "${owningEntity}": source entity ` +
        `"${elicit.sourceEntity}" has no field "${elicit.definitionsField}".`,
    );
  }
  return source.table;
}

/** Resolve an entity name to its physical table, failing closed at build. */
function resolveEntityTable(
  inputs: McpCatalogInput[],
  entityName: string,
  owningEntity: string,
  option: string,
): string {
  const found = inputs.find((input) => input.contract.entity.name === entityName);
  if (!found) {
    throw new Error(
      `mcp ${option} on entity "${owningEntity}" names entity "${entityName}", ` +
        `which is not part of this catalog.`,
    );
  }
  return found.table;
}

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
  const resources: McpResourceDefinition[] = [];
  const derivedTools: McpDerivedToolsDefinition[] = [];

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
      ...(mcp.elicitOnCreate
        ? {
            elicitOnCreate: {
              sourceField: mcp.elicitOnCreate.sourceField,
              sourceEntity: mcp.elicitOnCreate.sourceEntity,
              sourceTable: resolveSourceTable(inputs, mcp.elicitOnCreate, contract.entity.name),
              definitionsField: mcp.elicitOnCreate.definitionsField,
              into: mcp.elicitOnCreate.into,
              ...(mcp.elicitOnCreate.message ? { message: mcp.elicitOnCreate.message } : {}),
            },
          }
        : {}),
      fields: fields.map((field) => {
        const label = localizedText(field.label);
        const description = describeMcpField(field);
        return {
          key: field.key,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          valueType: field.valueType,
          cardinality: field.cardinality,
          required: field.required === true,
          readOnly: field.readOnly === true,
          immutable: field.immutable === true,
          schema: compiledFieldSchema(field, referentiedata, MCP_FIELD_SCHEMA_OPTIONS),
          ...(field.classification?.sensitivity
            ? { classification: field.classification.sensitivity }
            : {}),
          ...(field.relationship
            ? {
                relationship: {
                  kind: field.relationship.kind,
                  entity: field.relationship.entity,
                },
              }
            : {}),
        };
      }),
      relationships: contract.model.relationships.map((relationship) => {
        const label = localizedText(relationship.label);
        return {
          key: relationship.key,
          kind: relationship.kind,
          target: relationship.target,
          ...(relationship.foreignKey ? { foreignKey: relationship.foreignKey } : {}),
          ...(relationship.via ? { via: relationship.via } : {}),
          ...(label ? { label } : {}),
        };
      }),
    });

    tools.push(...buildToolsForEntity(contract, input.table, referentiedata));

    if (mcp.resource) {
      const pluralLabel = pluralize(entityLabel(contract));
      resources.push({
        uri: mcp.resource.uri,
        name: mcp.resource.name ?? pluralLabel,
        description:
          mcp.resource.description ??
          `Read the ${pluralLabel} currently available to the caller.`,
        templateUri: `${mcp.resource.uri}/{id}`,
        templateName: `Specific ${entityLabel(contract)}`,
        templateDescription:
          mcp.resource.templateDescription ??
          `Read one ${entityLabel(contract)} by its identifier.`,
        entity: contract.entity.name,
        table: input.table,
      });
    }

    if (mcp.derivedTools) {
      const execution = mcp.derivedTools.execution;
      derivedTools.push({
        entity: contract.entity.name,
        table: input.table,
        roles: [...mcp.derivedTools.roles],
        keyField: mcp.derivedTools.keyField,
        ...(mcp.derivedTools.titleField ? { titleField: mcp.derivedTools.titleField } : {}),
        descriptionField: mcp.derivedTools.descriptionField,
        inputFieldsField: mcp.derivedTools.inputFieldsField,
        ...(execution
          ? {
              execution: {
                bindingsField: execution.bindingsField,
                operationRef: execution.operationRef,
                operationEntity: execution.operationEntity,
                operationTable: resolveEntityTable(
                  inputs,
                  execution.operationEntity,
                  contract.entity.name,
                  "derivedTools.execution.operationEntity",
                ),
                providerRef: execution.providerRef,
                providerEntity: execution.providerEntity,
                providerTable: resolveEntityTable(
                  inputs,
                  execution.providerEntity,
                  contract.entity.name,
                  "derivedTools.execution.providerEntity",
                ),
                connectionEntity: execution.connectionEntity,
                connectionTable: resolveEntityTable(
                  inputs,
                  execution.connectionEntity,
                  contract.entity.name,
                  "derivedTools.execution.connectionEntity",
                ),
                connectionProviderRef: execution.connectionProviderRef,
                connectionValuesField: execution.connectionValuesField,
              },
            }
          : {}),
      });
    }
  }

  const seenResourceUris = new Map<string, McpResourceDefinition>();
  for (const resource of resources) {
    const existing = seenResourceUris.get(resource.uri);
    if (existing) {
      throw new Error(
        `Duplicate MCP resource uri "${resource.uri}": authored on both ` +
          `${existing.entity} and ${resource.entity}. Every entity resource needs its ` +
          `own uri because the runtime dispatches reads on it.`,
      );
    }
    seenResourceUris.set(resource.uri, resource);
  }

  // With authored name overrides in play, uniqueness is no longer guaranteed
  // by the prefix derivation — fail closed on any collision, since the runtime
  // dispatches on the name.
  const seenNames = new Map<string, McpToolDefinition>();
  for (const tool of tools) {
    if (tool.name.startsWith("osf_")) continue;
    const existing = seenNames.get(tool.name);
    if (existing) {
      throw new Error(
        `Duplicate MCP tool name "${tool.name}": emitted for both ` +
          `${existing.entity}.${existing.operation} and ${tool.entity}.${tool.operation}. ` +
          `Adjust the authored mcp name override or toolPrefix so every dedicated tool ` +
          `name is unique.`,
      );
    }
    seenNames.set(tool.name, tool);
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
    resources,
    derivedTools,
  };
}

export function renderMcpCatalog(
  inputs: McpCatalogInput[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
): string {
  return `${JSON.stringify(buildMcpCatalog(inputs, source, referentiedata), null, 2)}\n`;
}
