// SPDX-License-Identifier: BUSL-1.1
/**
 * OpenAPI 3.1 spec generator for entities that opt into generated REST
 * exposure (`rest:` block in the entity YAML → `TableDefinition.source.rest`).
 *
 * The manifest remains authoritative for route exposure, physical fields, and
 * writability. Rich JSON Schema semantics are joined from the already-compiled
 * entity contracts, so descriptions and validation never have to be rebuilt
 * from storage columns. A manifest-only scalar fallback covers synthetic
 * columns such as relationship foreign keys.
 *
 * The file is emitted on every generate run — with an empty `paths` object when
 * no entity opts in — so the API runtime can statically import it
 * unconditionally. Determinism: no timestamps; entities sorted by base path.
 */
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import { compiledFieldSchema, localizedText } from "./field-json-schema.js";
import type {
  PlatformSchemaManifest,
  ScalarType,
  TableDefinition,
} from "./schema.js";

const REST_MOUNT = "/api/rest/v1";

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
): { fieldName: string; compiled?: CompiledField; schema: JsonObject } {
  const fieldName = fieldNameForColumn(column);
  const compiled = fieldsByKey.get(fieldName);
  if (!compiled) {
    return { fieldName, schema: schemaForScalar(column.type) };
  }

  const schema = compiledFieldSchema(compiled, referentiedata);
  return { fieldName, compiled, schema };
}

function columnProperties(
  columns: TableDefinition["columns"],
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
  requiredMode: "storage" | "create" | "none",
): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const column of columns) {
    const { fieldName, compiled, schema } = fieldSchemaForColumn(
      column,
      fieldsByKey,
      referentiedata,
    );
    properties[fieldName] = schema;
    const isRequired =
      requiredMode === "storage"
        ? column.required === true || column.primaryKey === true
        : requiredMode === "create"
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
      "none",
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
