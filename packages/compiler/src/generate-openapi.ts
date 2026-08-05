// SPDX-License-Identifier: BUSL-1.1
/**
 * OpenAPI 3.1 spec generator for entities that opt into generated REST
 * exposure (`rest:` block in the entity YAML → `TableDefinition.source.rest`).
 *
 * The spec is derived from the same manifest column metadata the GraphQL
 * runtime uses (`sourceField` camelCase names, scalar column types), so both
 * API styles present identical field names and types. The file is emitted on
 * every generate run — with an empty `paths` object when no entity opts in —
 * so the API runtime can statically import it unconditionally.
 *
 * Determinism: pure function of the manifest; no timestamps, entities sorted
 * by base path.
 */
import type {
  PlatformSchemaManifest,
  ScalarType,
  TableDefinition,
} from "./schema.js";

const REST_MOUNT = "/api/rest/v1";

type JsonObject = Record<string, unknown>;

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

function columnProperties(
  columns: TableDefinition["columns"],
): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const column of columns) {
    const field = fieldNameForColumn(column);
    properties[field] = schemaForScalar(column.type);
    if (column.required === true || column.primaryKey === true) {
      required.push(field);
    }
  }
  return { properties, required };
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
): string {
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

  for (const table of restTables) {
    const rest = table.source!.rest!;
    const name = entitySchemaName(table);
    const read = columnProperties(table.columns);
    const creatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "create"),
    );
    const updatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "update"),
    );
    const writable = columnProperties(creatableColumns);
    // A second body schema only where the two differ, so an entity with no
    // immutable column keeps exactly the spec it had.
    const hasImmutable = updatableColumns.length !== creatableColumns.length;
    const updateSchemaName = hasImmutable ? `${name}UpdateInput` : `${name}Input`;

    schemas[name] = {
      type: "object",
      properties: read.properties,
      ...(read.required.length > 0 ? { required: read.required } : {}),
    };
    schemas[`${name}Input`] = {
      type: "object",
      additionalProperties: false,
      properties: writable.properties,
    };
    if (hasImmutable) {
      schemas[updateSchemaName] = {
        type: "object",
        additionalProperties: false,
        properties: columnProperties(updatableColumns).properties,
        description:
          "PATCH body. Fields authored immutable are settable at create only " +
          "and are rejected here.",
      };
    }
    schemas[`${name}List`] = {
      type: "object",
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
        summary: `List ${name} records`,
        description:
          "Reserved query parameters: first (page size), after (cursor), " +
          "sortField, sortDirection. Any other query parameter is treated as " +
          "an equality filter on the entity field of that name; repeat a " +
          "parameter, or use the explicit <field>In name (single or " +
          "repeated), for an IN filter. Unknown filter fields are rejected.",
        parameters: [
          {
            name: "first",
            in: "query",
            schema: { type: "integer", minimum: 1 },
          },
          { name: "after", in: "query", schema: { type: "string" } },
          { name: "sortField", in: "query", schema: { type: "string" } },
          {
            name: "sortDirection",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"] },
          },
        ],
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
        summary: `Create a ${name}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${name}Input` },
            },
          },
        },
        responses: {
          "201": entityResponse(name, `Created ${name}`),
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
          schema: { type: "string", format: "uuid" },
        },
      ],
    };
    if (rest.operations.get) {
      itemPath.get = {
        operationId: `get${name}`,
        summary: `Fetch a ${name} by id`,
        responses: {
          "200": entityResponse(name, `${name} record`),
          "401": errorResponse("Missing or invalid credentials"),
          "403": errorResponse("Session lacks a required entity role"),
          "404": errorResponse("Not found"),
        },
      };
    }
    if (rest.operations.update) {
      itemPath.patch = {
        operationId: `update${name}`,
        summary: `Partially update a ${name}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${updateSchemaName}` },
            },
          },
        },
        responses: {
          "200": entityResponse(name, `Updated ${name}`),
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
        summary: `Delete a ${name}`,
        responses: {
          "204": { description: `${name} deleted` },
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
    paths,
  };

  return `${JSON.stringify(spec, null, 2)}\n`;
}
