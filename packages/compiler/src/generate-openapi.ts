// SPDX-License-Identifier: BUSL-1.1
/**
 * OpenAPI 3.1 spec generator for entities that opt into generated REST
 * exposure (`rest:` block in the entity YAML → `TableDefinition.source.rest`).
 *
 * The manifest remains authoritative for route exposure, physical fields, and
 * writability. Request schemas join rich JSON Schema semantics from the
 * already-compiled entity contracts, so descriptions and validation never
 * have to be rebuilt from storage columns. Response schemas remain
 * storage-derived until the same constraints are enforced by every write
 * transport. A manifest-only scalar fallback also covers synthetic columns
 * such as relationship foreign keys. Classified request fields deliberately
 * use that thin storage projection rather than publishing semantic metadata.
 *
 * The file is emitted on every generate run — with an empty `paths` object when
 * no entity opts in — so the API runtime can statically import it
 * unconditionally. Determinism: no timestamps; entities sorted by base path.
 */
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchema,
  describeCompiledField,
  localizedText,
} from "./field-json-schema.js";
import type {
  PlatformSchemaManifest,
  ScalarType,
  TableDefinition,
} from "./schema.js";

const REST_MOUNT = "/api/rest/v1";
const RESERVED_LIST_PARAMETER_NAMES = new Set([
  "first",
  "after",
  "sortField",
  "sortDirection",
]);

type JsonObject = Record<string, unknown>;

export type OpenApiEntityInput = {
  contract: CompiledEntityContract;
};

export type OpenApiSpecOptions = {
  entities?: OpenApiEntityInput[];
  referentiedata?: CoreReferentiedataSnapshot;
};

function fieldNameForColumn(column: TableDefinition["columns"][number]): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

function schemaForScalar(type: ScalarType): JsonObject {
  switch (type) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "bigint":
    case "numeric":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "timestamptz":
      return { type: "string", format: "date-time" };
    case "jsonb":
      return {};
    case "text":
    default:
      return { type: "string" };
  }
}

// Mirrors the writable-column predicate of the API's generated CRUD layer
// (isWritableColumn in apps/api/src/graphql/generated-crud.ts): server-managed
// columns are never accepted in request bodies, and a column authored
// `immutable` is accepted on create only (#177).
function isWritableColumn(
  column: TableDefinition["columns"][number],
  operation: "create" | "update",
): boolean {
  return (
    column.primaryKey !== true &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at" &&
    !(operation === "update" && column.immutable === true)
  );
}

function entitySchemaName(table: TableDefinition): string {
  return table.source?.authoringEntityName ?? table.name;
}

function fieldSchemaForColumn(
  column: TableDefinition["columns"][number],
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
  mode: "storage" | "create" | "update",
): { fieldName: string; compiled?: CompiledField; schema: JsonObject } {
  const fieldName = fieldNameForColumn(column);
  const compiled = fieldsByKey.get(fieldName);
  const sensitivity = compiled?.classification?.sensitivity;
  const classified =
    sensitivity === "confidential" || sensitivity === "pii" || sensitivity === "bsn";
  if (!compiled || mode === "storage" || classified) {
    return { fieldName, schema: schemaForScalar(column.type) };
  }

  const schema = compiledFieldSchema(compiled, referentiedata, {
    includeDefault: mode === "create",
    requireNestedRequired: true,
  });
  return { fieldName, compiled, schema };
}

function columnProperties(
  columns: TableDefinition["columns"],
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
  mode: "storage" | "create" | "update",
): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const column of columns) {
    const { fieldName, compiled, schema } = fieldSchemaForColumn(
      column,
      fieldsByKey,
      referentiedata,
      mode,
    );
    properties[fieldName] = schema;
    const isRequired =
      mode === "storage"
        ? column.required === true || column.primaryKey === true
        : mode === "create"
          ? compiled?.required ?? column.required === true
          : false;
    if (isRequired) {
      required.push(fieldName);
    }
  }
  return { properties, required };
}

function entityLabel(contract: CompiledEntityContract | undefined, fallback: string): string {
  if (!contract) return fallback;
  return localizedText(contract.entity.labels) ?? contract.entity.title ?? fallback;
}

function entityDescription(contract: CompiledEntityContract | undefined): string | undefined {
  return localizedText(contract?.entity.description);
}

function withoutPresentationMetadata(schema: JsonObject): JsonObject {
  const { title: _title, description: _description, default: _default, ...rest } = schema;
  return rest;
}

function listParameters(
  table: TableDefinition,
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
): JsonObject[] {
  const sortableFields = table.columns.map(fieldNameForColumn);
  const fieldNames = new Set(sortableFields);
  const primaryKey = table.columns.find((column) => column.primaryKey === true);
  const primaryKeyField = primaryKey ? fieldNameForColumn(primaryKey) : undefined;
  const parameters: JsonObject[] = [
    {
      name: "first",
      in: "query",
      description: "Number of records to return. Defaults to 50 and is limited to 1-200.",
      schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
    {
      name: "after",
      in: "query",
      description: "Opaque cursor returned as nextCursor by a previous list response.",
      schema: { type: "string" },
    },
    {
      name: "sortField",
      in: "query",
      description: "Entity field to sort by. Defaults to the primary key.",
      schema: {
        type: "string",
        ...(sortableFields.length > 0 ? { enum: sortableFields } : {}),
        ...(primaryKeyField ? { default: primaryKeyField } : {}),
      },
    },
    {
      name: "sortDirection",
      in: "query",
      description: "Sort direction. Defaults to ascending.",
      schema: { type: "string", enum: ["asc", "desc"], default: "asc" },
    },
  ];

  for (const column of table.columns) {
    const fieldName = fieldNameForColumn(column);
    const compiled = fieldsByKey.get(fieldName);
    if (
      column.type === "jsonb" ||
      compiled?.cardinality === "collection" ||
      compiled?.valueType === "object"
    ) {
      continue;
    }

    const projected = fieldSchemaForColumn(
      column,
      fieldsByKey,
      referentiedata,
      "update",
    ).schema;
    const authoredDescription =
      typeof projected.description === "string" ? projected.description : undefined;
    const scalarSchema = withoutPresentationMetadata(projected);
    const inParameterName = `${fieldName}In`;
    // The CRUD condition builder interprets every key ending in `In` as an
    // array-filter alias. Such a field therefore cannot be addressed through
    // a direct scalar query parameter; only its unambiguous `<field>In` alias
    // is documented below.
    if (!RESERVED_LIST_PARAMETER_NAMES.has(fieldName) && !fieldName.endsWith("In")) {
      const substringDescription =
        column.type === "text" && authoredDescription && compiled
          ? describeCompiledField(compiled)
          : authoredDescription;
      parameters.push({
        name: fieldName,
        in: "query",
        description: [
          substringDescription,
          column.type === "text"
            ? "Matches a case-insensitive substring."
            : "Matches exactly.",
        ]
          .filter(Boolean)
          .join(" "),
        // Text equality constraints describe complete stored values, not the
        // substring search term accepted by the runtime.
        schema: column.type === "text" ? { type: "string" } : scalarSchema,
      });
    }
    // A real field with the same name wins in the REST parser. Omitting this
    // alias mirrors that precedence and preserves unique OpenAPI parameters.
    if (!fieldNames.has(inParameterName)) {
      parameters.push({
        name: inParameterName,
        in: "query",
        description: [
          authoredDescription,
          "Matches exactly against any supplied value. Repeat this parameter to supply multiple values.",
        ]
          .filter(Boolean)
          .join(" "),
        style: "form",
        explode: true,
        schema: { type: "array", items: scalarSchema },
      });
    }
  }

  return parameters;
}

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  };
}

function entityResponse(name: string, description: string): JsonObject {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${name}` },
      },
    },
  };
}

export function renderOpenApiSpec(
  manifest: PlatformSchemaManifest,
  source: string,
  options: OpenApiSpecOptions = {},
): string {
  const referentiedata = options.referentiedata ?? {};
  const contractsByEntityName = new Map(
    (options.entities ?? []).map((entity) => [entity.contract.entity.name, entity.contract]),
  );
  const restTables = manifest.tables
    .filter(
      (table) =>
        table.generatedCrud === true &&
        table.domainInternal !== true &&
        table.source?.rest !== undefined,
    )
    .sort((a, b) =>
      a.source!.rest!.basePath.localeCompare(b.source!.rest!.basePath),
    );

  const schemas: JsonObject = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
        },
      },
    },
  };
  const paths: JsonObject = {};
  const tags: JsonObject[] = [];

  for (const table of restTables) {
    const rest = table.source!.rest!;
    const name = entitySchemaName(table);
    const contract = contractsByEntityName.get(name);
    const fieldsByKey = new Map(
      (contract?.model.fields ?? []).map((field) => [field.key, field]),
    );
    const label = entityLabel(contract, name);
    const description = entityDescription(contract);
    tags.push({ name, ...(description ? { description } : {}) });

    const read = columnProperties(table.columns, fieldsByKey, referentiedata, "storage");
    const creatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "create"),
    );
    const updatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "update"),
    );
    const creatable = columnProperties(
      creatableColumns,
      fieldsByKey,
      referentiedata,
      "create",
    );
    const updatable = columnProperties(
      updatableColumns,
      fieldsByKey,
      referentiedata,
      "update",
    );
    const updateSchemaName = `${name}UpdateInput`;

    schemas[name] = {
      type: "object",
      ...(description ? { description } : {}),
      properties: read.properties,
      ...(read.required.length > 0 ? { required: read.required } : {}),
    };
    schemas[`${name}Input`] = {
      type: "object",
      description: `Create body for ${label}.`,
      additionalProperties: false,
      properties: creatable.properties,
      ...(creatable.required.length > 0 ? { required: creatable.required } : {}),
    };
    schemas[updateSchemaName] = {
      type: "object",
      additionalProperties: false,
      properties: updatable.properties,
      description:
        "PATCH body; omitted fields are left unchanged. Fields authored " +
        "immutable are settable at create only and are rejected here.",
    };
    schemas[`${name}List`] = {
      type: "object",
      description: `A page of ${label} records.`,
      required: ["items", "totalCount", "nextCursor"],
      properties: {
        items: {
          type: "array",
          items: { $ref: `#/components/schemas/${name}` },
        },
        totalCount: { type: "integer" },
        nextCursor: { type: ["string", "null"] },
      },
    };

    const collectionPath: JsonObject = {};
    if (rest.operations.list) {
      collectionPath.get = {
        operationId: `list${name}`,
        summary: `List ${label} records`,
        tags: [name],
        description:
          (description ? `${description} ` : "") +
          "Pagination, sorting, and every supported scalar field filter are " +
          "documented below. Unknown filter fields are rejected.",
        parameters: listParameters(table, fieldsByKey, referentiedata),
        responses: {
          "200": entityResponse(`${name}List`, `${name} page`),
          "400": errorResponse("Invalid filter, sort, or pagination input"),
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
        },
      };
    }
    if (rest.operations.create) {
      collectionPath.post = {
        operationId: `create${name}`,
        summary: `Create ${label}`,
        tags: [name],
        ...(description ? { description } : {}),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${name}Input` },
            },
          },
        },
        responses: {
          "201": entityResponse(name, `Created ${label}`),
          "400": errorResponse("Invalid request body"),
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
        },
      };
    }
    if (Object.keys(collectionPath).length > 0) {
      paths[`${REST_MOUNT}/${rest.basePath}`] = collectionPath;
    }

    const itemPath: JsonObject = {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: `Unique identifier of the ${label} record.`,
          schema: { type: "string", format: "uuid" },
        },
      ],
    };
    if (rest.operations.get) {
      itemPath.get = {
        operationId: `get${name}`,
        summary: `Fetch ${label} by id`,
        tags: [name],
        ...(description ? { description } : {}),
        responses: {
          "200": entityResponse(name, `${label} record`),
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
          "404": errorResponse("Not found"),
        },
      };
    }
    if (rest.operations.update) {
      itemPath.patch = {
        operationId: `update${name}`,
        summary: `Partially update ${label}`,
        tags: [name],
        ...(description ? { description } : {}),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${updateSchemaName}` },
            },
          },
        },
        responses: {
          "200": entityResponse(name, `Updated ${label}`),
          "400": errorResponse("Invalid request body"),
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
          "404": errorResponse("Not found"),
        },
      };
    }
    if (rest.operations.delete) {
      itemPath.delete = {
        operationId: `delete${name}`,
        summary: `Delete ${label}`,
        tags: [name],
        ...(description ? { description } : {}),
        responses: {
          "204": { description: `${label} deleted` },
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
          "404": errorResponse("Not found"),
        },
      };
    }
    if (Object.keys(itemPath).some((key) => key !== "parameters")) {
      paths[`${REST_MOUNT}/${rest.basePath}/{id}`] = itemPath;
    }
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "OpenShapeForge generated REST API",
      description: `Generated by @openshapeforge/compiler. Source: ${source}. Do not edit by hand.`,
      version: "1",
    },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas,
    },
    tags,
    paths,
  };

  return `${JSON.stringify(spec, null, 2)}\n`;
}
