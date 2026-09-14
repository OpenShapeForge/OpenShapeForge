// SPDX-License-Identifier: BUSL-1.1
/** Concrete JSON Schemas for the canonical entity Operation executor. */
import type {
  CompiledColumn,
  CompiledEntityContract,
  CompiledEntityOperation,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchemaWithoutDefinitions,
  compiledObjectSchema,
  localizedText,
  splitBundledDefinitions,
} from "./field-json-schema.js";
import type { JsonSchema } from "./plugins.js";

type JsonObject = Record<string, unknown>;

const SERVER_MANAGED_FIELDS = new Set([
  "id",
  "tenantId",
  "createdAt",
  "updatedAt",
]);

export type EntityRelationshipTarget = { label: string; listTool?: string };
export type EntityRelationshipKey = {
  key: string;
  relationship: string;
  target: string;
  required: boolean;
  schema: JsonObject;
};

function entityLabel(contract: CompiledEntityContract): string {
  return localizedText(contract.entity.labels) ??
    contract.entity.title ??
    contract.entity.name;
}

function storageValueSchema(type: CompiledColumn["type"]): JsonObject {
  switch (type) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "boolean":
      return { type: "boolean" };
    case "integer":
    case "bigint":
      return { type: "integer" };
    case "numeric":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "timestamptz":
      return { type: "string", format: "date-time" };
    case "jsonb":
      return {};
    default:
      return { type: "string" };
  }
}

function nullableSchema(schema: JsonObject): JsonObject {
  return { anyOf: [schema, { type: "null" }] };
}

/** Persisted record shape returned by every canonical entity read/write. */
export function entityRecordOutputSchema(
  contract: CompiledEntityContract,
  generic = false,
): JsonObject {
  if (generic) return { type: "object", additionalProperties: true };

  const fields = new Map(contract.model.fields.map((field) => [field.key, field]));
  const properties: JsonObject = {};
  const required: string[] = [];
  const add = (key: string, schema: JsonObject, isRequired: boolean): void => {
    properties[key] = schema;
    if (isRequired) required.push(key);
  };
  for (const column of contract.storage.columns) {
    const field = fields.get(column.field);
    const title = field ? localizedText(field.label) : undefined;
    const schema = {
      ...storageValueSchema(column.type),
      ...(title ? { title } : {}),
    };
    add(
      column.field,
      {
        ...(column.nullable ? nullableSchema(schema) : schema),
        ...(field?.label && typeof field.label === "object"
          ? { "x-osf-i18n": { title: field.label } } : {}),
      },
      !column.nullable,
    );
  }
  for (const [key, schema] of [
    ["id", { type: "string", format: "uuid" }],
    ["tenantId", { type: "string", format: "uuid" }],
    ["createdAt", { type: "string", format: "date-time" }],
    ["updatedAt", { type: "string", format: "date-time" }],
  ] as const) {
    if (!(key in properties)) {
      const labels = {
        id: { en: "ID", nl: "ID" }, tenantId: { en: "Organization ID", nl: "Organisatie-ID" },
        createdAt: { en: "Created at", nl: "Aangemaakt op" }, updatedAt: { en: "Updated at", nl: "Bijgewerkt op" },
      };
      add(key, { ...schema, "x-osf-i18n": { title: labels[key] } }, true);
    }
  }
  return { type: "object", properties, required, additionalProperties: true };
}

/** Fields accepted by generated create/update, shared with interface schemas. */
export function writableEntityFields(
  fields: readonly CompiledField[],
  operation: "create" | "update",
): CompiledField[] {
  return fields.filter(
    (field) =>
      !SERVER_MANAGED_FIELDS.has(field.key) &&
      field.computed === undefined &&
      !(field.writtenBy !== undefined && field.writtenBy.length > 0) &&
      !(operation === "update" && field.immutable === true),
  );
}

/** Resolve one authored belongsTo relation to its implicit writable FK field. */
export function entityRelationshipColumn(
  contract: CompiledEntityContract,
  relationship: CompiledRelationship,
): { key: string; nullable: boolean } | undefined {
  if (relationship.kind !== "belongsTo" || !relationship.foreignKey) return undefined;
  const column = contract.storage.columns.find(
    (candidate) => candidate.column === relationship.foreignKey,
  );
  return {
    key: column?.field ?? `${relationship.key}Id`,
    nullable: column ? column.nullable : true,
  };
}

export function entityRelationshipKeys(
  contract: CompiledEntityContract,
  targets: ReadonlyMap<string, EntityRelationshipTarget>,
): EntityRelationshipKey[] {
  const ownedByField = new Set(contract.model.fields.map((field) => field.key));
  const keys: EntityRelationshipKey[] = [];
  for (const relationship of contract.model.relationships) {
    const column = entityRelationshipColumn(contract, relationship);
    if (!column || ownedByField.has(column.key)) continue;
    const target = targets.get(relationship.target);
    const targetLabel = target?.label ?? relationship.target;
    keys.push({
      key: column.key,
      relationship: relationship.key,
      target: relationship.target,
      required: !column.nullable,
      schema: {
        type: "string",
        format: "uuid",
        description:
          `Identifier of the ${targetLabel} this ${entityLabel(contract)} belongs to` +
          (target?.listTool ? `, as returned by \`${target.listTool}\`.` : "."),
      },
    });
  }
  return keys;
}

export function withEntityRelationshipKeys(
  schema: JsonObject,
  keys: readonly EntityRelationshipKey[],
  requireRequired: boolean,
): JsonObject {
  if (keys.length === 0) return schema;
  const properties = { ...((schema.properties as JsonObject | undefined) ?? {}) };
  const required = [...((schema.required as string[] | undefined) ?? [])];
  for (const entry of keys) {
    properties[entry.key] = entry.schema;
    if (requireRequired && entry.required) required.push(entry.key);
  }
  return {
    ...schema,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Platform-owned controls attached to the executor input, never business values. */
export function entityOperationControlSchema(
  operation: CompiledEntityOperation | undefined,
): {
  properties: JsonObject;
  required: string[];
  dependentRequired?: Record<string, string[]>;
} {
  const properties: JsonObject = {};
  const required: string[] = [];
  let dependentRequired: Record<string, string[]> | undefined;
  if (operation?.concurrency?.version) {
    properties.expectedVersion = {
      type: "string",
      format: "date-time",
      description: `Version from the record's ${operation.concurrency.version.field} field.`,
    };
    required.push("expectedVersion");
  }
  if (operation?.concurrency?.editLease) {
    properties.leaseToken = {
      type: "string",
      minLength: 1,
      description: "Opaque edit-lease token issued by the server for this operation and record.",
    };
    required.push("leaseToken");
  }
  if (operation?.interaction.confirmation.mode === "acknowledgement") {
    properties.confirmed = {
      type: "boolean",
      description: "Only true lets the operation continue after user acknowledgement.",
    };
  }
  if (operation?.interaction.confirmation.mode === "challenge") {
    properties.confirmationToken = {
      type: "string",
      minLength: 1,
      description: "Opaque, single-use confirmation challenge token issued by the server.",
    };
    properties.confirmationAnswer = {
      type: "string",
      minLength: 1,
      description:
        `Exact current value requested for ${operation.interaction.confirmation.challenge.field}.`,
    };
    dependentRequired = {
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    };
  }
  return {
    properties,
    required,
    ...(dependentRequired ? { dependentRequired } : {}),
  };
}

function relationshipTargets(
  contracts: readonly CompiledEntityContract[],
): ReadonlyMap<string, EntityRelationshipTarget> {
  return new Map(
    contracts.map((contract) => [
      contract.entity.name,
      { label: entityLabel(contract) },
    ]),
  );
}

function openOperationOffers(): JsonObject {
  return { type: "array", items: { type: "object", additionalProperties: true } };
}

/**
 * Materialize the canonical `platform.operations.execute` input and data
 * output for one entity Operation. Interface adapters may flatten this shape,
 * but workflow/runtime consumers use this envelope verbatim.
 */
export function entityOperationJsonSchemas(
  contract: CompiledEntityContract,
  operation: CompiledEntityOperation,
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
): { inputSchema: JsonSchema; outputSchema: JsonSchema } {
  const id = {
    type: "string",
    format: "uuid",
    description: `Identifier of the ${entityLabel(contract)}.`,
  };
  const controls = entityOperationControlSchema(operation);
  const secureInputTarget = contract.entityOperations.create
    ?.interaction.secureInput?.into;
  const controlled = (properties: JsonObject, required: string[]): JsonSchema => ({
    type: "object",
    properties: { ...properties, ...controls.properties },
    required: [...required, ...controls.required],
    additionalProperties: false,
    ...(controls.dependentRequired
      ? { dependentRequired: controls.dependentRequired }
      : {}),
  });
  if (operation.input.kind === "json-schema") {
    if (operation.output.kind !== "json-schema") {
      throw new Error(
        `Entity Operation "${operation.id}" has mismatched plugin-backed input/output contracts.`,
      );
    }
    const authored = operation.input.schema;
    const properties = authored.properties;
    const required = authored.required;
    if (
      authored.type !== "object" || !properties || typeof properties !== "object" ||
      Array.isArray(properties) || (required !== undefined && !Array.isArray(required))
    ) {
      throw new Error(
        `Plugin-backed entity Operation "${operation.id}" input must be an object JSON Schema.`,
      );
    }
    return {
      inputSchema: {
        ...authored,
        properties: { ...properties, ...controls.properties },
        required: [...((required as string[] | undefined) ?? []), ...controls.required],
        ...(controls.dependentRequired
          ? {
              dependentRequired: {
                ...((authored.dependentRequired as Record<string, string[]> | undefined) ?? {}),
                ...controls.dependentRequired,
              },
            }
          : {}),
      },
      outputSchema: operation.output.schema,
    };
  }

  const relationships = entityRelationshipKeys(
    contract,
    relationshipTargets(contracts),
  );
  const record = entityRecordOutputSchema(contract);
  const nullableRecord = { anyOf: [record, { type: "null" }] };

  switch (operation.intent) {
    case "list": {
      if (operation.input.kind !== "collection-query") {
        throw new Error(`Entity Operation "${operation.id}" has an invalid list input contract.`);
      }
      const filterProperties: JsonObject = {};
      for (const field of contract.model.fields) {
        if (
          field.key === secureInputTarget ||
          field.cardinality === "collection" ||
          field.valueType === "object"
        ) continue;
        const schema = compiledFieldSchemaWithoutDefinitions(field, referentiedata);
        delete schema.default;
        filterProperties[field.key] = schema;
      }
      for (const relationship of relationships) {
        filterProperties[relationship.key] = relationship.schema;
      }
      const sortable = contract.model.fields
        .filter((field) =>
          field.key !== secureInputTarget &&
          field.cardinality !== "collection" &&
          field.valueType !== "object"
        )
        .map((field) => field.key);
      return {
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: operation.input.pagination.maxLimit,
              default: operation.input.pagination.defaultLimit,
            },
            cursor: { type: "string", description: "Opaque cursor from a previous page." },
            filter: {
              type: "object",
              properties: filterProperties,
              additionalProperties: false,
            },
            sort: {
              type: "object",
              properties: {
                field: { type: "string", ...(sortable.length > 0 ? { enum: sortable } : {}) },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
              additionalProperties: false,
            },
            includeTotalCount: { type: "boolean" },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { data: record, operations: openOperationOffers() },
                required: ["data", "operations"],
                additionalProperties: false,
              },
            },
            totalCount: { anyOf: [{ type: "integer" }, { type: "null" }] },
            nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["items", "totalCount", "nextCursor"],
          additionalProperties: false,
        },
      };
    }
    case "get":
      return {
        inputSchema: controlled({ id }, ["id"]),
        outputSchema: nullableRecord,
      };
    case "create": {
      const fields = writableEntityFields(contract.model.fields, "create")
        .filter((field) => field.key !== secureInputTarget);
      const compiledValues = withEntityRelationshipKeys(
        compiledObjectSchema(fields, referentiedata, {
          requireRequired: true,
          defaultsAreMaterialized: true,
        }),
        relationships,
        true,
      );
      const { schema: values, definitions } = splitBundledDefinitions(compiledValues);
      const blueprint = contract.blueprint;
      const requiredValues = Array.isArray(values.required) ? values.required as string[] : [];
      const copyValues = blueprint ? { ...values, required: requiredValues.filter((key) => !blueprint.fields.includes(key)) } : values;
      const inputSchema = controlled(
        { values: copyValues, ...(blueprint ? { blueprintId: { type: "string", minLength: 1 } } : {}) },
        ["values"],
      );
      if (blueprint) {
        inputSchema.allOf = [{
          if: { not: { required: ["blueprintId"] } },
          then: { properties: { values: { required: requiredValues } } },
        }];
      }
      return {
        inputSchema: {
          ...inputSchema,
          ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
        },
        outputSchema: record,
      };
    }
    case "update": {
      const compiledValues = withEntityRelationshipKeys(
        compiledObjectSchema(
          writableEntityFields(contract.model.fields, "update")
            .filter((field) => field.key !== secureInputTarget),
          referentiedata,
          { requireRequired: false, includeDefault: false },
        ),
        relationships,
        false,
      );
      const { schema: values, definitions } = splitBundledDefinitions(compiledValues);
      const inputSchema = controlled({ id, values }, ["id", "values"]);
      return {
        inputSchema: {
          ...inputSchema,
          ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
        },
        outputSchema: nullableRecord,
      };
    }
    case "delete":
      return {
        inputSchema: controlled({ id }, ["id"]),
        outputSchema: {
          type: "object",
          properties: { deleted: { type: "boolean" } },
          required: ["deleted"],
          additionalProperties: false,
        },
      };
  }
}
