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
import type {
  CompiledEntityContract,
  CompiledField,
} from "./authoring/types.js";
import type { RestApiDocumentation } from "./authoring/layers.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchema,
  describeCompiledField,
  localizedText,
  rebaseJsonSchemaReferences,
  splitBundledDefinitions,
} from "./field-json-schema.js";
import type {
  PlatformSchemaManifest,
  ScalarType,
  TableDefinition,
} from "./schema.js";
import { isGeneratedCrudEligible } from "./schema.js";
import {
  operationOpenApiPaths,
  type CompiledPluginOperation,
} from "./generate-operations.js";

const REST_MOUNT = "/api/rest/v1";
const FIELD_DEFINITION_COMPONENT = "OpenShapeForgeFieldDefinition";
const FIELD_DEFINITION_DEFS_BASE =
  `#/components/schemas/${FIELD_DEFINITION_COMPONENT}/$defs/`;
const RESERVED_LIST_PARAMETER_NAMES = new Set([
  "first",
  "after",
  "sortField",
  "sortDirection",
]);

type JsonObject = Record<string, unknown>;

/**
 * The common developer guidance rendered in the OpenAPI `info.description`.
 * It deliberately names no deployment, entity, or local endpoint: generated
 * contracts may be served before authentication, while tags and schemas below
 * describe the particular host's API.
 */
const GENERIC_DEVELOPER_ONBOARDING = [
  "OpenShapeForge compiles authored entities into tenant-aware REST contracts and the",
  "runtime behind them. **This document is generated, and it is the contract.** The",
  "paths, schemas, required fields, enum values, pagination, filtering, and sorting",
  "below are the ones the running server implements. Treat anything absent here as",
  "absent from the API.",
  "",
  "## Start here",
  "",
  "1. **Check security.** Follow the security requirement documented for the operation.",
  "   Most host operations use a bearer token through the **Authorize** button, while",
  "   a contract can deliberately declare public or custom authentication. For a",
  "   session-authenticated entity or operation, the caller's roles still decide which",
  "   documented data may be read or written, so a contract-valid request can receive",
  "   `401` or `403`.",
  "2. **Choose a documented operation.** Tags group the available entity or plugin",
  "   operations. Do not assume an operation exists if it is absent below.",
  "3. **Prefer a documented GET while exploring.** Start with the smallest read-only",
  "   operation the contract actually exposes and inspect its response before",
  "   following identifiers or cursors.",
  "4. **Read the input schema before writing.** Use its required fields, validation,",
  "   formats, and enum values exactly as documented. A host can deliberately omit",
  "   create, update, or delete operations.",
  "",
  "## Starter prompt",
  "",
  "Copy this when pointing an API client or coding assistant at this API:",
  "",
  "```text",
  "You are working against an OpenShapeForge generated REST API, described by the",
  "OpenAPI document provided to you. That document is the single source of truth.",
  "",
  "- Use only the paths, methods, parameters, and fields it defines. Do not invent",
  "  endpoints, fields, query parameters, or authorization behavior.",
  "- Copy enum values exactly as the schema spells them. Do not guess, translate,",
  "  or normalise them.",
  "- Take required fields, lengths, patterns, and formats from the request schemas.",
  "  Send nothing a schema does not allow.",
  "- Follow each operation's documented security requirement. A protected request",
  "  that matches its payload schema may still be refused with 401 or 403. Report",
  "  that answer; do not try to work around it.",
  "- Stay on read-only requests (GET) while exploring, and confirm before any POST,",
  "  PATCH, or DELETE.",
  "- If something needed is not in the document, say so rather than assuming it",
  "  exists.",
  "```",
].join("\n");

export type OpenApiEntityInput = {
  contract: CompiledEntityContract;
};

export type OpenApiSpecOptions = {
  entities?: OpenApiEntityInput[];
  referentiedata?: CoreReferentiedataSnapshot;
  operations?: CompiledPluginOperation[];
  documentation?: RestApiDocumentation;
};

function fieldNameForColumn(
  column: TableDefinition["columns"][number],
): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) =>
      char.toUpperCase(),
    )
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

// Mirrors the storage-writable predicate of generated CRUD. Request schema
// construction additionally removes the secure elicitation target, matching
// isCallerWritableColumn in the API runtime.
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

function isRestrictedSensitivity(sensitivity: string | undefined): boolean {
  return (
    sensitivity === "confidential" ||
    sensitivity === "pii" ||
    sensitivity === "bsn"
  );
}

function isRestrictedColumn(
  column: TableDefinition["columns"][number],
): boolean {
  return isRestrictedSensitivity(column.classification);
}

function isRestrictedField(field: CompiledField | undefined): boolean {
  return isRestrictedSensitivity(field?.classification?.sensitivity);
}

function fieldSchemaForColumn(
  column: TableDefinition["columns"][number],
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
  mode: "storage" | "create" | "update",
): { fieldName: string; compiled?: CompiledField; schema: JsonObject } {
  const fieldName = fieldNameForColumn(column);
  const compiled = fieldsByKey.get(fieldName);
  const classified = isRestrictedField(compiled) || isRestrictedColumn(column);
  if (!compiled || mode === "storage" || classified) {
    return { fieldName, schema: schemaForScalar(column.type) };
  }

  const schema = compiledFieldSchema(compiled, referentiedata, {
    includeDefault: mode === "create",
    requireNestedRequired: true,
    defaultsAreMaterialized: mode === "create",
  });
  return { fieldName, compiled, schema };
}

function columnProperties(
  columns: TableDefinition["columns"],
  fieldsByKey: Map<string, CompiledField>,
  referentiedata: CoreReferentiedataSnapshot,
  mode: "storage" | "create" | "update",
): { properties: JsonObject; required: string[]; definitions: JsonObject } {
  const properties: JsonObject = {};
  const required: string[] = [];
  const definitions: JsonObject = {};
  for (const column of columns) {
    const { fieldName, compiled, schema: bundledSchema } = fieldSchemaForColumn(
      column,
      fieldsByKey,
      referentiedata,
      mode,
    );
    const { schema: unbundledSchema, definitions: bundledDefinitions } =
      splitBundledDefinitions(bundledSchema);
    const hasDefinitions = Object.keys(bundledDefinitions).length > 0;
    const schema = hasDefinitions
      ? (rebaseJsonSchemaReferences(
          unbundledSchema,
          "#/$defs/",
          FIELD_DEFINITION_DEFS_BASE,
        ) as JsonObject)
      : unbundledSchema;
    if (hasDefinitions) {
      Object.assign(
        definitions,
        rebaseJsonSchemaReferences(
          bundledDefinitions,
          "#/$defs/",
          FIELD_DEFINITION_DEFS_BASE,
        ) as JsonObject,
      );
    }
    properties[fieldName] = schema;
    const isRequired =
      mode === "storage"
        ? column.required === true || column.primaryKey === true
        : mode === "create"
          ? (compiled?.required ?? column.required === true) &&
            compiled?.defaultValue === undefined
          : false;
    if (isRequired) {
      required.push(fieldName);
    }
  }
  return { properties, required, definitions };
}

function entityLabel(
  contract: CompiledEntityContract | undefined,
  fallback: string,
): string {
  if (!contract) return fallback;
  return (
    localizedText(contract.entity.labels) ?? contract.entity.title ?? fallback
  );
}

function entityDescription(
  contract: CompiledEntityContract | undefined,
): string | undefined {
  return localizedText(contract?.entity.description);
}

/** Only constraints the REST query parser actually validates. */
function filterSchemaForColumn(
  column: TableDefinition["columns"][number],
): JsonObject {
  switch (column.type) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "date":
      return { type: "string", format: "date" };
    case "timestamptz":
      return { type: "string", format: "date-time" };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "bigint":
      return { type: "integer" };
    case "numeric":
      return { type: "number" };
    default:
      // Authored enum/length/pattern rules are not validated by
      // coerceFilterValue; publishing them would overstate the request
      // contract. UUID/date/date-time have explicit runtime validation above.
      return { type: "string" };
  }
}

function listParameters(
  table: TableDefinition,
  fieldsByKey: Map<string, CompiledField>,
): JsonObject[] {
  const elicitedOutputField = table.source?.mcp?.elicitOnCreate?.into;
  const sortableFields = table.columns
    .filter(
      (column) =>
        column.name !== "tenant_id" &&
        fieldNameForColumn(column) !== elicitedOutputField &&
        !isRestrictedColumn(column) &&
        !isRestrictedField(fieldsByKey.get(fieldNameForColumn(column))),
    )
    .map(fieldNameForColumn);
  // Collision detection must include hidden fields too: the runtime resolves
  // a real `xIn` column before it considers the generated alias for `x`.
  const fieldNames = new Set(table.columns.map(fieldNameForColumn));
  const primaryKey = table.columns.find((column) => column.primaryKey === true);
  const primaryKeyField = primaryKey
    ? fieldNameForColumn(primaryKey)
    : undefined;
  const parameters: JsonObject[] = [
    {
      name: "first",
      in: "query",
      description:
        "Number of records to return. When absent it defaults to 50; supplied values are clamped to 1-200.",
      schema: { type: "integer", default: 50 },
    },
    {
      name: "after",
      in: "query",
      description:
        "Opaque cursor returned as nextCursor by a previous list response.",
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
      column.name === "tenant_id" ||
      fieldName === elicitedOutputField ||
      isRestrictedColumn(column) ||
      isRestrictedField(compiled) ||
      column.type === "jsonb" ||
      compiled?.cardinality === "collection" ||
      compiled?.valueType === "object"
    ) {
      continue;
    }

    const authoredDescription = compiled
      ? describeCompiledField(compiled)
      : undefined;
    const scalarSchema = filterSchemaForColumn(column);
    const inParameterName = `${fieldName}In`;
    // The CRUD condition builder interprets every key ending in `In` as an
    // array-filter alias. Such a field therefore cannot be addressed through
    // a direct scalar query parameter; only its unambiguous `<field>In` alias
    // is documented below.
    if (
      !RESERVED_LIST_PARAMETER_NAMES.has(fieldName) &&
      !fieldName.endsWith("In")
    ) {
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
            ? "Matches a case-insensitive substring. Repeat this parameter to instead match exactly against any supplied value."
            : "Matches exactly. Repeat this parameter to match against any supplied value.",
        ]
          .filter(Boolean)
          .join(" "),
        schema: scalarSchema,
      });
    }
    // A real field with the same name makes this transport spelling
    // ambiguous. Omitting the alias preserves unique parameters; callers can
    // still repeat the documented plain parameter for exact-any matching.
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
    (options.entities ?? []).map((entity) => [
      entity.contract.entity.name,
      entity.contract,
    ]),
  );
  const restTables = manifest.tables
    .filter(
      (table) =>
        isGeneratedCrudEligible(table) && table.source?.rest !== undefined,
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
    const elicitedOutputField = table.source?.mcp?.elicitOnCreate?.into;
    tags.push({ name, ...(description ? { description } : {}) });

    const read = columnProperties(
      table.columns,
      fieldsByKey,
      referentiedata,
      "storage",
    );
    const creatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "create") &&
      fieldNameForColumn(column) !== elicitedOutputField,
    );
    const updatableColumns = table.columns.filter((column) =>
      isWritableColumn(column, "update") &&
      fieldNameForColumn(column) !== elicitedOutputField,
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
    const fieldDefinitionDefinitions = {
      ...read.definitions,
      ...creatable.definitions,
      ...updatable.definitions,
    };
    if (Object.keys(fieldDefinitionDefinitions).length > 0) {
      schemas[FIELD_DEFINITION_COMPONENT] = {
        $ref: `${FIELD_DEFINITION_DEFS_BASE}fieldDefinition`,
        $defs: fieldDefinitionDefinitions,
      };
    }

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
      ...(creatable.required.length > 0
        ? { required: creatable.required }
        : {}),
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
        parameters: listParameters(table, fieldsByKey),
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

  const operationPaths = operationOpenApiPaths(options.operations ?? []) as JsonObject;
  for (const [path, rawMethods] of Object.entries(operationPaths)) {
    const methods = rawMethods as JsonObject;
    const existing = (paths[path] ?? {}) as JsonObject;
    for (const method of Object.keys(methods)) {
      if (method in existing) {
        throw new Error(`Plugin operation collides with generated REST route ${method.toUpperCase()} ${path}.`);
      }
    }
    paths[path] = { ...existing, ...methods };
  }

  const customSecuritySchemes = Object.fromEntries(
    (options.operations ?? [])
      .filter((operation) => operation.auth.mode === "custom")
      .map((operation) => {
        const auth = operation.auth as Extract<typeof operation.auth, { mode: "custom" }>;
        return [auth.scheme, {
          description: auth.description,
          ...auth.securityScheme,
        }];
      }),
  );

  const generatedNotice = `Generated by @openshapeforge/compiler. Source: ${source}. Do not edit by hand.`;
  const documentation = options.documentation;
  const descriptionSections = [
    ...(documentation ? [documentation.description] : []),
    GENERIC_DEVELOPER_ONBOARDING,
    "---",
    generatedNotice,
  ];
  const spec = {
    openapi: "3.1.0",
    info: {
      title: documentation?.title ?? "OpenShapeForge generated REST API",
      description: descriptionSections.join("\n\n"),
      version: documentation?.version ?? "1",
    },
    ...(documentation?.externalDocs ? { externalDocs: documentation.externalDocs } : {}),
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        ...customSecuritySchemes,
      },
      schemas,
    },
    tags,
    paths,
  };

  return `${JSON.stringify(spec, null, 2)}\n`;
}
