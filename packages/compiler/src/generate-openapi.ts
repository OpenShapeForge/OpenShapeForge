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
import { withBlueprintCreate } from "./blueprint-create-schema.js";
import type {
  CompiledEntityContract,
  CompiledEntityOperation,
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
  CAPABILITY_GRANT_SECURITY_SCHEME,
  operationOpenApiPaths,
  type CompiledPluginOperation,
} from "./generate-operations.js";
import { entityOperationJsonSchemas } from "./entity-operation-json-schema.js";

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
  "   session-authenticated entity or operation, the caller must satisfy any declared role",
  "   and scope restrictions, so a contract-valid request can still receive",
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
    case "text[]":
      return { type: "array", items: { type: "string" } };
    case "text":
    default:
      return { type: "string" };
  }
}

// Mirrors the storage-writable predicate of generated CRUD. Request schema
// construction additionally removes the secure elicitation target, matching
// isCallerWritableColumn in the API runtime.
//
// `writtenBy` bites on create AND update: the column records that a process
// took place, and the operation named on it is the only place the preconditions
// for that are checked.
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
    (column.writtenBy === undefined || column.writtenBy.length === 0) &&
    column.deriveOnCreate === undefined &&
    !(operation === "update" && column.immutable === true)
  );
}

/**
 * One sentence naming the columns a body may not carry and the operations that
 * write them, appended to the Input/Update schema descriptions so a reader of
 * the spec never has to discover the rule by being refused.
 */
function operationWrittenNote(table: TableDefinition): string {
  const written = table.columns.filter(
    (column) => column.writtenBy !== undefined && column.writtenBy.length > 0,
  );
  if (written.length === 0) return "";
  const parts = written.map(
    (column) => `${fieldNameForColumn(column)} (${column.writtenBy!.join(", ")})`,
  );
  return (
    ` Fields that record that a process took place are absent here and are ` +
    `written only by the operation named: ${parts.join("; ")}. A body carrying ` +
    `one is rejected with 400.`
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
  operation: CompiledEntityOperation | undefined,
): JsonObject[] {
  const pagination = operation?.input?.kind === "collection-query"
    ? operation.input.pagination
    : { defaultLimit: 50, maxLimit: 200 };
  const elicitedOutputField = table.source?.secureInputOnCreate?.into ??
    table.source?.mcp?.elicitOnCreate?.into;
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
        `Number of records to return. When absent it defaults to ${pagination.defaultLimit}; ` +
        `supplied values are clamped to 1-${pagination.maxLimit}.`,
      schema: {
        type: "integer",
        minimum: 1,
        maximum: pagination.maxLimit,
        default: pagination.defaultLimit,
      },
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
      compiled?.baseType === "object"
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

function errorResponse(
  description: string,
  canonical: boolean,
): JsonObject {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          $ref: canonical
            ? "#/components/schemas/OperationFailure"
            : "#/components/schemas/Error",
        },
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

function operationControlSchema(
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
      description:
        `Version from the record's ${operation.concurrency.version.field} field.`,
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
  if (operation?.interaction?.confirmation.mode === "acknowledgement") {
    properties.confirmed = {
      type: "boolean",
      description:
        "Only true lets the operation continue after caller acknowledgement; this is not a server-issued security proof.",
    };
  }
  if (operation?.interaction?.confirmation.mode === "challenge") {
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
  const hasCanonicalEntity = [...contractsByEntityName.values()].some(
    (contract) => contract.authoringVersion >= 2,
  );
  const restEditLeaseOperationIds = [...new Set(
    restTables.flatMap((table) => {
      const contract = contractsByEntityName.get(entitySchemaName(table));
      if (!contract || contract.authoringVersion < 2) return [];
      return (["list", "get", "create", "update", "delete"] as const).flatMap(
        (intent) => {
          const operation = contract.entityOperations[intent];
          return table.source!.rest!.operations[intent] === true &&
            operation?.concurrency?.editLease?.mode === "required"
            ? [operation.id]
            : [];
        },
      );
    }),
  )].sort();
  const hasCanonicalEditLease = restEditLeaseOperationIds.length > 0;
  // The transport is documented where the document entities that bind files
  // through it are compiled in; any canonical record may own a file at runtime.
  const hasArtifactTransport = contractsByEntityName.has("Document") &&
    contractsByEntityName.has("DocumentVersion");

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
    ...(hasCanonicalEntity
      ? {
          OperationReference: {
            type: "object",
            additionalProperties: false,
            required: ["id", "intent"],
            properties: {
              id: { type: "string" },
              intent: {
                type: "string",
                enum: ["list", "get", "create", "update", "delete"],
              },
            },
          },
          OperationError: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "retryable"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              detail: { type: "string" },
              retryable: { type: "boolean" },
              retryAt: { type: "string", format: "date-time" },
              violations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["code", "message"],
                  properties: {
                    field: { type: "string" },
                    code: { type: "string" },
                    message: { type: "string" },
                    detail: { type: "string" },
                  },
                },
              },
              data: { type: "object", additionalProperties: true },
            },
          },
          OperationOffer: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["operation", "available"],
                properties: {
                  operation: { $ref: "#/components/schemas/OperationReference" },
                  available: { const: true },
                  concurrency: { $ref: "#/components/schemas/OperationConcurrency" },
                  binding: { $ref: "#/components/schemas/OperationTargetBinding" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["operation", "available", "error"],
                properties: {
                  operation: { $ref: "#/components/schemas/OperationReference" },
                  available: { const: false },
                  error: { $ref: "#/components/schemas/OperationError" },
                },
              },
            ],
          },
          OperationTargetBinding: {
            type: "object",
            additionalProperties: false,
            required: ["target", "input"],
            properties: {
              target: {
                type: "object",
                additionalProperties: false,
                required: ["entityId", "id"],
                properties: {
                  entityId: { type: "string" },
                  id: { type: "string" },
                  version: { type: "string" },
                },
              },
              input: { type: "object", additionalProperties: true },
            },
          },
          OperationConcurrency: {
            type: "object",
            additionalProperties: false,
            properties: {
              version: {
                type: "object",
                additionalProperties: false,
                required: ["mode", "field"],
                properties: {
                  mode: { const: "required" },
                  field: { const: "updatedAt" },
                },
              },
              editLease: {
                type: "object",
                additionalProperties: false,
                required: ["mode", "expiresAfterInactivity"],
                properties: {
                  mode: { const: "required" },
                  expiresAfterInactivity: { type: "string" },
                },
              },
            },
          },
          OperationFailure: {
            type: "object",
            required: ["error"],
            properties: {
              error: { $ref: "#/components/schemas/OperationError" },
            },
          },
          DeletionData: {
            type: "object",
            additionalProperties: false,
            required: ["deleted"],
            properties: { deleted: { type: "boolean", const: true } },
          },
          DeletionResult: {
            type: "object",
            additionalProperties: false,
            required: ["data", "operations"],
            properties: {
              data: { $ref: "#/components/schemas/DeletionData" },
              operations: {
                type: "array",
                items: { $ref: "#/components/schemas/OperationOffer" },
              },
            },
          },
          ...(hasCanonicalEditLease
            ? {
                EditLeaseAcquireInput: {
                  type: "object",
                  additionalProperties: false,
                  required: ["operationId", "targetId"],
                  properties: {
                    operationId: {
                      type: "string",
                      enum: restEditLeaseOperationIds,
                      description: "Canonical lease-protected Operation id.",
                    },
                    targetId: { type: "string", format: "uuid" },
                  },
                },
                EditLeaseTokenInput: {
                  type: "object",
                  additionalProperties: false,
                  required: ["leaseToken"],
                  properties: {
                    leaseToken: {
                      type: "string",
                      minLength: 20,
                      description: "Opaque edit-lease token issued by the server.",
                    },
                  },
                },
                EditLeaseAcquireData: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "leaseToken",
                    "operationId",
                    "entityId",
                    "targetId",
                    "targetVersion",
                    "expiresAt",
                  ],
                  properties: {
                    leaseToken: { type: "string", minLength: 20 },
                    operationId: { type: "string" },
                    entityId: { type: "string" },
                    targetId: { type: "string", format: "uuid" },
                    targetVersion: { type: "string", format: "date-time" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
                EditLeaseAcquireResult: {
                  type: "object",
                  additionalProperties: false,
                  required: ["data", "operations"],
                  properties: {
                    data: { $ref: "#/components/schemas/EditLeaseAcquireData" },
                    operations: {
                      type: "array",
                      maxItems: 0,
                      items: { $ref: "#/components/schemas/OperationOffer" },
                    },
                  },
                },
                EditLeaseRenewData: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "operationId",
                    "entityId",
                    "targetId",
                    "targetVersion",
                    "expiresAt",
                  ],
                  properties: {
                    operationId: { type: "string" },
                    entityId: { type: "string" },
                    targetId: { type: "string", format: "uuid" },
                    targetVersion: { type: "string", format: "date-time" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
                EditLeaseRenewResult: {
                  type: "object",
                  additionalProperties: false,
                  required: ["data", "operations"],
                  properties: {
                    data: { $ref: "#/components/schemas/EditLeaseRenewData" },
                    operations: {
                      type: "array",
                      maxItems: 0,
                      items: { $ref: "#/components/schemas/OperationOffer" },
                    },
                  },
                },
                EditLeaseReleaseData: {
                  type: "object",
                  additionalProperties: false,
                  required: ["released"],
                  properties: { released: { type: "boolean" } },
                },
                EditLeaseReleaseResult: {
                  type: "object",
                  additionalProperties: false,
                  required: ["data", "operations"],
                  properties: {
                    data: { $ref: "#/components/schemas/EditLeaseReleaseData" },
                    operations: {
                      type: "array",
                      maxItems: 0,
                      items: { $ref: "#/components/schemas/OperationOffer" },
                    },
                  },
                },
              }
            : {}),
        }
      : {}),
  };
  const paths: JsonObject = {};
  const tags: JsonObject[] = [];

  if (hasArtifactTransport) {
  tags.push({
    name: "Files",
    description: "Authenticated streaming transport for temporary and record-bound files. Storage policy and authorization remain server-side.",
  });
  paths["/api/artifacts"] = {
    post: {
      operationId: "stageArtifact",
      summary: "Upload a temporary document file",
      description: "Streams bytes into the configured storage provider. Use the returned opaque handle in the Operation that binds it to its owning record — Document.create or DocumentVersion.create for a document file — before it expires.",
      tags: ["Files"],
      parameters: [{
        name: "x-file-name",
        in: "header",
        required: true,
        description: "Percent-encoded UTF-8 file name.",
        schema: { type: "string", minLength: 1, maxLength: 765 },
      }],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      responses: {
        "201": {
          description: "File staged and inspected",
          content: { "application/json": { schema: {
            type: "object", additionalProperties: false, required: ["data", "operations"],
            properties: {
              data: {
                type: "object", additionalProperties: false,
                required: ["artifactId", "version", "fileName", "mediaType", "sha256", "byteSize"],
                properties: {
                  artifactId: { type: "string", format: "uuid" },
                  version: { type: "integer", minimum: 1 },
                  fileName: { type: "string" },
                  mediaType: { type: "string" },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  byteSize: { type: "integer", minimum: 0 },
                },
              },
              operations: { type: "array", maxItems: 0, items: { $ref: "#/components/schemas/OperationOffer" } },
            },
          } } },
        },
        "400": errorResponse("Invalid file request", true),
        "401": errorResponse("Missing or invalid credentials", true),
        "413": errorResponse("File exceeds the configured size limit", true),
        "415": errorResponse("File type is not permitted", true),
        "503": errorResponse("Storage is unavailable", true),
      },
    },
  };
  paths["/api/artifacts/{artifactId}/contents"] = {
    get: {
      operationId: "downloadArtifact",
      summary: "Download a record's file",
      description: "Returns bytes only when this exact artifact is bound to the named owning record and the session may read that record (its `get` Operation). A document file is owned by its Document.",
      tags: ["Files"],
      parameters: [
        { name: "artifactId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "ownerEntity", in: "query", required: true, description: "Canonical Entity name of the owning record.", schema: { type: "string", minLength: 1, maxLength: 200 } },
        { name: "ownerId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": { description: "Authorized file contents", headers: {
          "Content-Disposition": { schema: { type: "string" } },
        }, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        "400": errorResponse("Invalid file or owner identity", true),
        "401": errorResponse("Missing or invalid credentials", true),
        "403": errorResponse("File access is not authorized", true),
        "404": errorResponse("File is not available", true),
        "503": errorResponse("Storage is unavailable", true),
      },
    },
  };
  }

  if (hasCanonicalEditLease) {
    tags.push({
      name: "Edit leases",
      description: "Central leases for long-running record write modes.",
    });
    paths["/api/operation-leases"] = {
      post: {
        operationId: "acquireEditLease",
        summary: "Acquire an edit lease",
        tags: ["Edit leases"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EditLeaseAcquireInput" },
            },
          },
        },
        responses: {
          "201": entityResponse("EditLeaseAcquireResult", "Edit lease acquired"),
          "400": errorResponse("Invalid or unsupported operation", true),
          "401": errorResponse("Missing or invalid credentials", true),
          "403": errorResponse("Session lacks the operation role", true),
          "404": errorResponse("Target not found", true),
          "423": errorResponse("Target is already being edited", true),
        },
      },
    };
    paths["/api/operation-leases/renew"] = {
      post: {
        operationId: "renewEditLease",
        summary: "Renew an active edit lease",
        tags: ["Edit leases"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EditLeaseTokenInput" },
            },
          },
        },
        responses: {
          "200": entityResponse("EditLeaseRenewResult", "Edit lease renewed"),
          "400": errorResponse("Invalid request", true),
          "401": errorResponse("Missing or invalid credentials", true),
          "409": errorResponse("Lease expired or invalid", true),
        },
      },
    };
    paths["/api/operation-leases/release"] = {
      post: {
        operationId: "releaseEditLease",
        summary: "Release an edit lease",
        tags: ["Edit leases"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EditLeaseTokenInput" },
            },
          },
        },
        responses: {
          "200": entityResponse("EditLeaseReleaseResult", "Edit lease released"),
          "400": errorResponse("Invalid request", true),
          "401": errorResponse("Missing or invalid credentials", true),
        },
      },
    };
  }

  for (const table of restTables) {
    const rest = table.source!.rest!;
    const name = entitySchemaName(table);
    const contract = contractsByEntityName.get(name);
    const canonical = !!contract && contract.authoringVersion >= 2;
    const canonicalOperationId = (
      intent: "list" | "get" | "create" | "update" | "delete",
    ): string => {
      const operationId = contract?.entityOperations[intent]?.id;
      if (!operationId) {
        throw new Error(
          `REST operation "${name}.${intent}" has no canonical entity operation contract.`,
        );
      }
      return operationId;
    };
    const fieldsByKey = new Map(
      (contract?.model.fields ?? []).map((field) => [field.key, field]),
    );
    const label = entityLabel(contract, name);
    const description = entityDescription(contract);
    const elicitedOutputField = table.source?.secureInputOnCreate?.into ??
      table.source?.mcp?.elicitOnCreate?.into;
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
    const deleteSchemaName = `${name}DeleteInput`;
    const createControls = canonical
      ? operationControlSchema(contract?.entityOperations.create)
      : { properties: {}, required: [] };
    const updateControls = canonical
      ? operationControlSchema(contract?.entityOperations.update)
      : { properties: {}, required: [] };
    const deleteControls = canonical
      ? operationControlSchema(contract?.entityOperations.delete)
      : { properties: {}, required: [] };
    const hasDeleteControls = Object.keys(deleteControls.properties).length > 0;
    const createOperation = contract?.entityOperations.create;
    const updateOperation = contract?.entityOperations.update;
    const deleteOperation = contract?.entityOperations.delete;
    const compiledContracts = [...contractsByEntityName.values()];
    const createPluginSchemas = canonical && contract &&
        createOperation?.implementation?.type === "plugin"
      ? entityOperationJsonSchemas(
          contract,
          createOperation,
          compiledContracts,
          referentiedata,
        )
      : undefined;
    const updatePluginSchemas = canonical && contract &&
        updateOperation?.implementation?.type === "plugin"
      ? entityOperationJsonSchemas(
          contract,
          updateOperation,
          compiledContracts,
          referentiedata,
        )
      : undefined;
    const createRequiresConfirmation =
      createOperation?.interaction?.confirmation.mode !== undefined &&
      createOperation.interaction.confirmation.mode !== "none";
    const updateRequiresConfirmation =
      updateOperation?.interaction?.confirmation.mode !== undefined &&
      updateOperation.interaction.confirmation.mode !== "none";
    const deleteRequiresChallenge =
      deleteOperation?.interaction?.confirmation.mode === "challenge";
    const deleteRequiresConfirmation =
      deleteOperation?.interaction?.confirmation.mode !== undefined &&
      deleteOperation.interaction.confirmation.mode !== "none";
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
    if (canonical) {
      schemas[`${name}Result`] = {
        type: "object",
        additionalProperties: false,
        required: ["data", "operations"],
        properties: {
          data: { $ref: `#/components/schemas/${name}` },
          operations: {
            type: "array",
            items: { $ref: "#/components/schemas/OperationOffer" },
          },
        },
      };
      for (const [intent, pluginSchemas] of [
        ["Create", createPluginSchemas],
        ["Update", updatePluginSchemas],
      ] as const) {
        if (!pluginSchemas) continue;
        schemas[`${name}${intent}Result`] = {
          type: "object",
          additionalProperties: false,
          required: ["data", "operations"],
          properties: {
            data: pluginSchemas.outputSchema,
            operations: {
              type: "array",
              items: { $ref: "#/components/schemas/OperationOffer" },
            },
          },
        };
      }
    }
    const writerNote = operationWrittenNote(table);
    schemas[`${name}Input`] = createPluginSchemas?.inputSchema ?? {
      type: "object",
      description: `Create body for ${label}.${writerNote}`,
      additionalProperties: false,
      properties: { ...creatable.properties, ...createControls.properties },
      ...(creatable.required.length + createControls.required.length > 0
        ? { required: [...creatable.required, ...createControls.required] }
        : {}),
    };
    if (!createPluginSchemas) schemas[`${name}Input`] = withBlueprintCreate(schemas[`${name}Input`] as JsonObject, table.source?.blueprint);
    schemas[updateSchemaName] = updatePluginSchemas?.inputSchema ?? {
      type: "object",
      additionalProperties: false,
      properties: { ...updatable.properties, ...updateControls.properties },
      ...(updateControls.required.length > 0
        ? { required: updateControls.required }
        : {}),
      ...(updateControls.dependentRequired
        ? { dependentRequired: updateControls.dependentRequired }
        : {}),
      description:
        "PATCH body; omitted fields are left unchanged. Fields authored " +
        "immutable are settable at create only and are rejected here." +
        writerNote,
    };
    if (hasDeleteControls) {
      schemas[deleteSchemaName] = {
        type: "object",
        additionalProperties: false,
        properties: deleteControls.properties,
        ...(deleteControls.required.length > 0
          ? { required: deleteControls.required }
          : {}),
        ...(deleteControls.dependentRequired
          ? { dependentRequired: deleteControls.dependentRequired }
          : {}),
        description: deleteRequiresChallenge
          ? `Submit ${deleteControls.required.join(" and ")} first to receive a server-issued ` +
            "confirmation challenge. Retry with the same controls plus both " +
            "confirmationToken and confirmationAnswer."
          : deleteRequiresConfirmation
            ? "Set confirmed to true to continue; omitting it or sending false returns CONFIRMATION_REQUIRED."
            : "Required concurrency controls for this deletion.",
      };
    }
    schemas[canonical ? `${name}ListData` : `${name}List`] = {
      type: "object",
      description: `A page of ${label} records.`,
      required: ["items", "totalCount", "nextCursor"],
      properties: {
        items: {
          type: "array",
          items: {
            $ref: canonical
              ? `#/components/schemas/${name}Result`
              : `#/components/schemas/${name}`,
          },
        },
        totalCount: { type: "integer" },
        nextCursor: { type: ["string", "null"] },
      },
    };
    if (canonical) {
      schemas[`${name}ListResult`] = {
        type: "object",
        additionalProperties: false,
        required: ["data", "operations"],
        properties: {
          data: { $ref: `#/components/schemas/${name}ListData` },
          operations: {
            type: "array",
            items: { $ref: "#/components/schemas/OperationOffer" },
          },
        },
      };
    }

    const collectionPath: JsonObject = {};
    if (rest.operations.list) {
      collectionPath.get = {
        operationId: `list${name}`,
        ...(canonical
          ? { "x-osf-operation-id": canonicalOperationId("list") }
          : {}),
        summary: `List ${label} records`,
        tags: [name],
        description:
          (description ? `${description} ` : "") +
          "Pagination, sorting, and every supported scalar field filter are " +
          "documented below. Unknown filter fields are rejected.",
        parameters: listParameters(table, fieldsByKey, contract?.entityOperations.list),
        responses: {
          "200": entityResponse(
            canonical ? `${name}ListResult` : `${name}List`,
            canonical ? `${name} page and available operations` : `${name} page`,
          ),
          "400": errorResponse("Invalid filter, sort, or pagination input", canonical),
          "401": errorResponse("Missing or invalid credentials", canonical),
          "403": errorResponse("Session lacks a required entity role", canonical),
        },
      };
    }
    if (rest.operations.create) {
      const projection = createOperation?.implementation?.type === "plugin"
        ? createOperation.interfaces?.rest
        : undefined;
      const successStatus = projection ? projection.response?.status ?? 201 : 201;
      const createRoute: JsonObject = {
        operationId: `create${name}`,
        ...(canonical
          ? { "x-osf-operation-id": canonicalOperationId("create") }
          : {}),
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
          [String(successStatus)]: entityResponse(
            createPluginSchemas
              ? `${name}CreateResult`
              : canonical ? `${name}Result` : name,
            canonical ? `Created ${label} and available operations` : `Created ${label}`,
          ),
          "400": errorResponse("Invalid request body", canonical),
          "401": errorResponse("Missing or invalid credentials", canonical),
          "403": errorResponse("Session lacks a required entity role", canonical),
          ...(canonical && createRequiresConfirmation
            ? {
                "428": errorResponse(
                  "CONFIRMATION_REQUIRED — this operation requires confirmation controls",
                  true,
                ),
              }
            : {}),
        },
      };
      if (projection && projection.path) {
        const method = (projection.method ?? "POST").toLowerCase();
        const openApiPath = projection.path.replace(
          /:([_A-Za-z][_0-9A-Za-z]*)/g,
          "{$1}",
        );
        const existing = (paths[openApiPath] ?? {}) as JsonObject;
        if (method in existing) {
          throw new Error(
            `Duplicate canonical entity OpenAPI route "${method.toUpperCase()} ${openApiPath}".`,
          );
        }
        paths[openApiPath] = {
          ...existing,
          [method]: createRoute,
        };
      } else {
        collectionPath.post = createRoute;
      }
    }
    if (Object.keys(collectionPath).length > 0) {
      const basePath = `${REST_MOUNT}/${rest.basePath}`;
      paths[basePath] = {
        ...((paths[basePath] ?? {}) as JsonObject),
        ...collectionPath,
      };
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
        ...(canonical
          ? { "x-osf-operation-id": canonicalOperationId("get") }
          : {}),
        summary: `Fetch ${label} by id`,
        tags: [name],
        ...(description ? { description } : {}),
        responses: {
          "200": entityResponse(
            canonical ? `${name}Result` : name,
            canonical ? `${label} record and available operations` : `${label} record`,
          ),
          "401": errorResponse("Missing or invalid credentials", canonical),
          "403": errorResponse("Session lacks a required entity role", canonical),
          "404": errorResponse("Not found", canonical),
        },
      };
    }
    if (rest.operations.update) {
      const projection = updateOperation?.implementation?.type === "plugin"
        ? updateOperation.interfaces?.rest
        : undefined;
      const successStatus = projection ? projection.response?.status ?? 200 : 200;
      const updateRoute: JsonObject = {
        operationId: `update${name}`,
        ...(canonical
          ? { "x-osf-operation-id": canonicalOperationId("update") }
          : {}),
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
          [String(successStatus)]: entityResponse(
            updatePluginSchemas
              ? `${name}UpdateResult`
              : canonical ? `${name}Result` : name,
            canonical ? `Updated ${label} and available operations` : `Updated ${label}`,
          ),
          "400": errorResponse("Invalid request body", canonical),
          "401": errorResponse("Missing or invalid credentials", canonical),
          "403": errorResponse("Session lacks a required entity role", canonical),
          "404": errorResponse("Not found", canonical),
          ...(canonical && updateOperation?.concurrency?.version
            ? {
                "409": errorResponse(
                  "VERSION_CONFLICT — expectedVersion does not match the current record version",
                  true,
                ),
                "422": errorResponse(
                  "VALIDATION — expectedVersion is not a semantically valid record version",
                  true,
                ),
              }
            : {}),
          ...(canonical && updateOperation?.concurrency?.editLease
            ? {
                "423": errorResponse(
                  "LOCKED — another identity currently holds the record edit lease",
                  true,
                ),
              }
            : {}),
          ...(canonical && updateRequiresConfirmation
            ? {
                "428": errorResponse(
                  "CONFIRMATION_REQUIRED — this operation requires confirmation controls",
                  true,
                ),
              }
            : {}),
        },
      };
      if (projection && projection.path) {
        const method = (projection.method ?? "PATCH").toLowerCase();
        const openApiPath = projection.path.replace(
          /:([_A-Za-z][_0-9A-Za-z]*)/g,
          "{$1}",
        );
        const target = updateOperation?.target;
        const existing = (paths[openApiPath] ?? {}) as JsonObject;
        if (method in existing) {
          throw new Error(
            `Duplicate canonical entity OpenAPI route "${method.toUpperCase()} ${openApiPath}".`,
          );
        }
        paths[openApiPath] = {
          ...existing,
          ...("parameters" in existing
            ? {}
            : {
                parameters: target?.scope === "record"
                  ? [{
                      name: target.inputField,
                      in: "path",
                      required: true,
                      description: `Unique identifier of the ${label} record.`,
                      schema: { type: "string", format: "uuid" },
                    }]
                  : [],
              }),
          [method]: updateRoute,
        };
      } else {
        itemPath.patch = updateRoute;
      }
    }
    if (rest.operations.delete) {
      itemPath.delete = {
        operationId: `delete${name}`,
        ...(canonical
          ? { "x-osf-operation-id": canonicalOperationId("delete") }
          : {}),
        summary: `Delete ${label}`,
        tags: [name],
        ...(description ? { description } : {}),
        ...(hasDeleteControls
          ? {
              requestBody: {
                required: deleteControls.required.length > 0,
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${deleteSchemaName}` },
                  },
                },
              },
            }
          : {}),
        responses: {
          ...(canonical
            ? { "200": entityResponse("DeletionResult", `${label} deleted`) }
            : { "204": { description: `${label} deleted` } }),
          ...(canonical
            ? {
                "400": errorResponse(
                  "BAD_USER_INPUT — invalid request body or mutation controls",
                  true,
                ),
              }
            : {}),
          "401": errorResponse("Missing or invalid credentials", canonical),
          "403": errorResponse("Session lacks a required entity role", canonical),
          "404": errorResponse("Not found", canonical),
          ...(canonical && deleteOperation?.concurrency?.version
            ? {
                "409": errorResponse(
                  "VERSION_CONFLICT — expectedVersion does not match the current record version",
                  true,
                ),
                "422": errorResponse(
                  "VALIDATION — expectedVersion is not a semantically valid record version",
                  true,
                ),
              }
            : {}),
          ...(canonical && deleteOperation?.concurrency?.editLease
            ? {
                "423": errorResponse(
                  "LOCKED — another identity currently holds the record edit lease",
                  true,
                ),
              }
            : {}),
          ...(canonical && deleteRequiresConfirmation
            ? {
                "428": errorResponse(
                  "CONFIRMATION_REQUIRED — this operation requires confirmation controls",
                  true,
                ),
              }
            : {}),
        },
      };
    }
    if (Object.keys(itemPath).some((key) => key !== "parameters")) {
      const baseItemPath = `${REST_MOUNT}/${rest.basePath}/{id}`;
      paths[baseItemPath] = {
        ...((paths[baseItemPath] ?? {}) as JsonObject),
        ...itemPath,
      };
    }
  }

  const oauth2 = options.documentation?.oauth2;
  if (oauth2) {
    const declaredScopes = new Set(Object.keys(oauth2.scopes));
    const missingScopes = [...new Set(
      (options.operations ?? []).flatMap((operation) =>
        operation.auth.mode === "session"
          ? (operation.auth.scopes ?? []).filter((scope) => !declaredScopes.has(scope))
          : []
      ),
    )].sort();
    if (missingScopes.length > 0) {
      throw new Error(
        `REST API OAuth 2.0 scopes do not describe required operation scope(s): ${missingScopes.join(", ")}.`,
      );
    }
  }
  const sessionSecuritySchemes = oauth2
    ? ["bearerAuth", "oauth2Auth"]
    : ["bearerAuth"];
  const operationPaths = operationOpenApiPaths(
    options.operations ?? [],
    sessionSecuritySchemes,
  ) as JsonObject;
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

  // One platform-owned scheme for every capability Operation: the token is
  // resolved by core, so the description is the same everywhere it appears.
  const capabilitySecuritySchemes = (options.operations ?? []).some((operation) => operation.auth.mode === "capability")
    ? {
        [CAPABILITY_GRANT_SECURITY_SCHEME]: {
          type: "http",
          scheme: "grant",
          description:
            "Capability grant token (`Authorization: Grant <grantId>.<secret>`): a hashed, expiring, " +
            "recipient-bound token that authorizes listed Operations on one record for someone without an account.",
        },
      }
    : {};
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
  if (oauth2 && Object.hasOwn(customSecuritySchemes, "oauth2Auth")) {
    throw new Error(
      'Custom authentication scheme "oauth2Auth" collides with the REST API OAuth 2.0 scheme.',
    );
  }

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
    security: sessionSecuritySchemes.map((scheme) => ({ [scheme]: [] })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          ...(documentation?.bearerDescription
            ? { description: documentation.bearerDescription }
            : {}),
        },
        // Control-realm operators: a bearer the platform's control realm issued,
        // carried by Operations with `auth.mode: control`. Distinct from the
        // tenant session bearer above; the two realms never vouch for each other.
        controlBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Control-realm operator token (platform administration).",
        },
        ...(oauth2
          ? {
              oauth2Auth: {
                type: "oauth2",
                description: oauth2.description,
                flows: {
                  authorizationCode: {
                    authorizationUrl: oauth2.authorizationUrl,
                    tokenUrl: oauth2.tokenUrl,
                    scopes: oauth2.scopes,
                  },
                },
                "x-swagger-ui-client-id": oauth2.clientId,
                ...(oauth2.redirectUrl
                  ? { "x-swagger-ui-redirect-url": oauth2.redirectUrl }
                  : {}),
              },
            }
          : {}),
        ...capabilitySecuritySchemes,
        ...customSecuritySchemes,
      },
      schemas,
    },
    tags,
    paths,
  };

  return `${JSON.stringify(spec, null, 2)}\n`;
}
