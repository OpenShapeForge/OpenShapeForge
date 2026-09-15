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
import { pluralize } from "./authoring/compiler/helpers.js";
import type {
  CompiledColumn,
  CompiledEntityContract,
  CompiledEntityOperation,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import type { CompiledPluginOperation } from "./generate-operations.js";
import type { PluginExecutionCompatibility } from "./plugins.js";
import {
  compiledFieldSchema,
  compiledFieldSchemaWithoutDefinitions,
  compiledObjectSchema,
  describeCompiledField,
  localizedText,
  splitBundledDefinitions,
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

const ENTITY_OPERATION_INTENTS = [
  "list",
  "get",
  "create",
  "update",
  "delete",
] as const;

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

/**
 * The record shape returned by generated CRUD. It follows persisted storage,
 * not the create schema: server-managed values and relationship foreign keys
 * are present in reads too. `additionalProperties` stays open because the MCP
 * runtime may add a safe, server-derived projection such as oauthRedirectUrl.
 */
function entityRecordOutputSchema(
  contract: CompiledEntityContract,
  generic: boolean,
): JsonObject {
  if (generic) {
    return { type: "object", additionalProperties: true };
  }

  const fields = new Map(
    contract.model.fields.map((field) => [field.key, field]),
  );
  const properties: JsonObject = {};
  const required: string[] = [];

  const add = (
    key: string,
    schema: JsonObject,
    isRequired: boolean,
  ): void => {
    properties[key] = schema;
    if (isRequired) required.push(key);
  };

  for (const column of contract.storage.columns) {
    const field = fields.get(column.field);
    const label = field ? localizedText(field.label) : undefined;
    const description = field ? describeMcpField(field) : undefined;
    // Responses describe what storage can actually contain. Create/update
    // validation bounds and enums constrain new input, but older/imported rows
    // are not rewritten by those rules and must remain valid output.
    const schema = {
      ...storageValueSchema(column.type),
      ...(label ? { title: label } : {}),
      ...(description ? { description } : {}),
    };
    add(
      column.field,
      column.nullable ? nullableSchema(schema) : schema,
      !column.nullable,
    );
  }

  // Generated CRUD requires id and injects tenant/timestamps into its storage
  // manifest even when a compact compiled fixture omits the platform fields.
  if (!("id" in properties)) {
    add("id", { type: "string", format: "uuid" }, true);
  }
  if (!("tenantId" in properties)) {
    add("tenantId", { type: "string", format: "uuid" }, true);
  }
  if (!("createdAt" in properties)) {
    add("createdAt", { type: "string", format: "date-time" }, true);
  }
  if (!("updatedAt" in properties)) {
    add("updatedAt", { type: "string", format: "date-time" }, true);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

function canonicalOutputDefinitions(): JsonObject {
  return {
    OperationReference: {
      type: "object",
      additionalProperties: false,
      required: ["id", "intent"],
      properties: {
        id: { type: "string" },
        intent: { type: "string", enum: [...ENTITY_OPERATION_INTENTS] },
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
    OperationOffer: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["operation", "available"],
          properties: {
            operation: { $ref: "#/$defs/OperationReference" },
            available: { const: true },
            concurrency: { $ref: "#/$defs/OperationConcurrency" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["operation", "available", "error"],
          properties: {
            operation: { $ref: "#/$defs/OperationReference" },
            available: { const: false },
            error: { $ref: "#/$defs/OperationError" },
          },
        },
      ],
    },
  };
}

function offersSchema(): JsonObject {
  return {
    type: "array",
    items: { $ref: "#/$defs/OperationOffer" },
  };
}

function recordEnvelopeSchema(record: JsonObject): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data", "operations"],
    properties: {
      data: record,
      operations: offersSchema(),
    },
  };
}

function entityToolOutputSchema(
  operation: McpToolDefinition["operation"],
  record: JsonObject,
): JsonObject {
  let success: JsonObject;
  if (operation === "list") {
    success = {
      type: "object",
      additionalProperties: false,
      required: ["data", "operations"],
      properties: {
        data: {
          type: "object",
          additionalProperties: false,
          required: ["items", "totalCount", "nextCursor"],
          properties: {
            items: {
              type: "array",
              items: recordEnvelopeSchema(record),
            },
            totalCount: { type: "integer" },
            nextCursor: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
        },
        operations: offersSchema(),
      },
    };
  } else if (operation === "delete") {
    success = {
      type: "object",
      additionalProperties: false,
      required: ["data", "operations"],
      properties: {
        data: {
          type: "object",
          additionalProperties: false,
          required: ["deleted"],
          properties: { deleted: { type: "boolean", const: true } },
        },
        operations: offersSchema(),
      },
    };
  } else {
    success = recordEnvelopeSchema(record);
  }

  return {
    type: "object",
    oneOf: [
      success,
      {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: {
          error: { $ref: "#/$defs/OperationError" },
        },
      },
    ],
    $defs: {
      ...canonicalOutputDefinitions(),
    },
  };
}

/** Operations whose tools accept no entity fields, only identifiers/paging. */
const READ_OPERATIONS = new Set(["list", "get"]);

/**
 * Server-managed columns. A model must never be invited to set these: the id
 * is generated, the tenant comes from the session, and the timestamps are
 * maintained by the database. Mirrors writableColumnMap in the API's CRUD
 * layer and isWritableColumn in the OpenAPI generator.
 */
const SERVER_MANAGED_FIELDS = new Set([
  "id",
  "tenantId",
  "createdAt",
  "updatedAt",
]);

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
        "Only true lets the operation continue after user acknowledgement; this is not a server-issued security proof.",
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
 *
 * Authored `writtenBy` IS consulted, on create AND update: it means "written
 * only by these operations". A field that records that a process took place —
 * a review signed off, a scope approved — is worth exactly as much as the
 * check the operation runs before writing it, so create/update must not offer
 * a way around that check. Same shape as `immutable`: the advertised schema
 * and the server's refusal both come from the one authored fact.
 */
function writableFields(
  fields: CompiledField[],
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

/**
 * What a `belongsTo` relationship contributes to the tool schemas.
 *
 * A `belongsTo` with a `foreignKey` is stored as a uuid column that the
 * storage layer names `<key>Id` (authoring/compiler/storage.ts), and REST and
 * GraphQL already accept that key on create, update and list filters. Before
 * this the MCP schemas were built from `model.fields` alone, so
 * `finding_create` advertised `additionalProperties: false` without
 * `assessmentId` — no MCP client could attach a finding to its assessment,
 * while the same body succeeded over REST. The key is derived from the
 * compiled storage column so all three transports agree on one name.
 */
type RelationshipKey = {
  key: string;
  relationship: string;
  target: string;
  required: boolean;
  schema: JsonObject;
};

/** How a relationship target is named and listed, resolved catalog-wide. */
type RelationshipTarget = { label: string; listTool?: string };

/**
 * The storage column a `belongsTo` foreign key lands in, and the field key
 * every transport addresses it by. Undefined for relationships that carry no
 * foreign key (`hasMany`, `manyToMany`, or a `belongsTo` resolved elsewhere).
 */
function relationshipColumn(
  contract: CompiledEntityContract,
  relationship: CompiledRelationship,
): { key: string; nullable: boolean } | undefined {
  if (relationship.kind !== "belongsTo" || !relationship.foreignKey)
    return undefined;
  const column = contract.storage.columns.find(
    (candidate) => candidate.column === relationship.foreignKey,
  );
  return {
    key: column?.field ?? `${relationship.key}Id`,
    nullable: column ? column.nullable : true,
  };
}

function relationshipKeys(
  contract: CompiledEntityContract,
  targets: ReadonlyMap<string, RelationshipTarget>,
): RelationshipKey[] {
  const ownedByField = new Set(contract.model.fields.map((field) => field.key));
  const keys: RelationshipKey[] = [];
  for (const relationship of contract.model.relationships) {
    const column = relationshipColumn(contract, relationship);
    if (!column) continue;
    // An authored field may own the foreign-key column itself
    // (PaymentDetail.relationId persists at relation_id). Its own schema is
    // already in the tool; a second property for the same column would be a
    // lie about what the server accepts.
    if (ownedByField.has(column.key)) continue;
    // A target outside the catalog has no tool to point at: naming a list tool
    // that does not exist would send the model on a fruitless call.
    const target = targets.get(relationship.target);
    const targetLabel = target?.label ?? relationship.target;
    const description =
      `Identifier of the ${targetLabel} this ${entityLabel(contract)} belongs to` +
      (target?.listTool ? `, as returned by \`${target.listTool}\`.` : ".");
    keys.push({
      key: column.key,
      relationship: relationship.key,
      target: relationship.target,
      // The storage column decides: it is nullable unless something made it
      // NOT NULL, so this is "required iff the column refuses null" — the
      // same fact the database enforces on the insert.
      required: !column.nullable,
      schema: { type: "string", format: "uuid", description },
    });
  }
  return keys;
}

/** Add relationship keys to an object schema, after the authored fields. */
function withRelationshipKeys(
  schema: JsonObject,
  keys: RelationshipKey[],
  requireRequired: boolean,
): JsonObject {
  if (keys.length === 0) return schema;
  const properties = {
    ...((schema.properties as JsonObject | undefined) ?? {}),
  };
  const required = [
    ...((schema.required as string[] | undefined) ?? []),
  ];
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

function sortableFieldKeys(
  fields: CompiledField[],
  excludedField?: string,
): string[] {
  return fields
    .filter(
      (field) =>
        field.key !== excludedField &&
        field.cardinality !== "collection" &&
        field.valueType !== "object",
    )
    .map((field) => field.key);
}

/** Fields carrying a restricting classification, for the runtime to withhold. */
function classifiedFieldKeys(fields: CompiledField[]): string[] {
  return fields
    .filter((field) => {
      const sensitivity = field.classification?.sensitivity;
      return (
        sensitivity === "confidential" ||
        sensitivity === "pii" ||
        sensitivity === "bsn"
      );
    })
    .map((field) => field.key);
}

export type McpToolDefinition = {
  name: string;
  /** Stable interface-neutral operation id, published only by strict v2 authoring. */
  operationId?: string;
  operation: "list" | "get" | "create" | "update" | "delete";
  entity: string;
  table: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
  /** Canonical success/error envelope returned by strict v2 tools. */
  outputSchema?: JsonObject;
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
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      };
    case "create":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      };
    case "update":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        // The current runtime appends an event and advances updated_at on each
        // execution; retrying the same request is therefore not idempotent.
        idempotentHint: false,
      };
    case "delete":
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      };
  }
}

function entityLabel(contract: CompiledEntityContract): string {
  return (
    localizedText(contract.entity.labels) ??
    contract.entity.title ??
    contract.entity.name
  );
}

function entityDescription(contract: CompiledEntityContract): string {
  return (
    localizedText(contract.entity.description) ??
    `The ${entityLabel(contract)} entity.`
  );
}

/**
 * One sentence listing the fields this entity keeps out of create/update and
 * the operations that do write them, or "" when the entity has none.
 */
function operationWrittenNote(fields: CompiledField[]): string {
  const written = fields.filter(
    (field) => field.writtenBy !== undefined && field.writtenBy.length > 0,
  );
  if (written.length === 0) return "";
  const parts = written.map(
    (field) => `${field.key} (${field.writtenBy!.join(", ")})`,
  );
  return (
    ` Not settable here — these record that a process took place and are written ` +
    `only by the operation named: ${parts.join("; ")}. Sending one anyway is refused.`
  );
}

function buildToolsForEntity(
  contract: CompiledEntityContract,
  table: string,
  referentiedata: CoreReferentiedataSnapshot,
  relationshipTargets: ReadonlyMap<string, RelationshipTarget>,
): McpToolDefinition[] {
  const mcp = contract.mcp;
  if (!mcp) return [];

  const fields = contract.model.fields;
  const relationships = relationshipKeys(contract, relationshipTargets);
  // The elicited target field never appears in the create schema: its values
  // come from the person at the client via elicitation, not from the model.
  const creatable = writableFields(fields, "create").filter(
    (field) => field.key !== mcp.elicitOnCreate?.into,
  );
  const updatable = writableFields(fields, "update").filter(
    (field) => field.key !== mcp.elicitOnCreate?.into,
  );
  const label = entityLabel(contract);
  const description = entityDescription(contract);
  // Fields that create/update deliberately do not offer, and who does write
  // them. A model that reads "reviewedAt is missing" concludes the schema is
  // incomplete and tries anyway; a model that reads "reviewedAt is written by
  // pentest.finding.review" calls that instead. The sentence is worth more
  // than the refusal it prevents.
  const writerNote = operationWrittenNote(fields);
  const sortable = sortableFieldKeys(fields, mcp.elicitOnCreate?.into);
  const filterField = contract.entity.filterField;
  const tools: McpToolDefinition[] = [];
  const output = entityRecordOutputSchema(
    contract,
    mcp.tools === "generic",
  );
  const outputSchema = (operation: McpToolDefinition["operation"]) => {
    const canonicalOutput = contract.entityOperations[operation]?.output;
    return entityToolOutputSchema(
      operation,
      canonicalOutput?.kind === "json-schema" ? canonicalOutput.schema : output,
    );
  };
  const v2Contract = contract.authoringVersion >= 2;

  const idSchema: JsonObject = {
    type: "object",
    properties: {
      id: {
        type: "string",
        format: "uuid",
        description: `Identifier of the ${label}.`,
      },
    },
    required: ["id"],
    additionalProperties: false,
  };

  const named = (operation: McpToolDefinition["operation"]) =>
    mcp.tools === "dedicated"
      ? (mcp.toolOverrides?.[operation]?.name ??
        `${mcp.toolPrefix}_${operation}`)
      : `osf_${operation}`;
  const operationId = (intent: McpToolDefinition["operation"]): string => {
    const operation = contract.entityOperations[intent];
    if (!operation) {
      throw new Error(
        `mcp operation "${intent}" on entity "${contract.entity.name}" ` +
          "has no canonical entity operation contract.",
      );
    }
    return operation.id;
  };

  // Authored description wins outright: an author writing one is correcting
  // the composed default, so nothing is appended to it — except the writtenBy
  // note, which is not prose about the entity but a fact about the schema this
  // very tool advertises. An author who overrides the description has not
  // thereby decided that `reviewedAt` may be attempted.
  const described = (
    operation: McpToolDefinition["operation"],
    fallback: string,
  ) => {
    if (contract.authoringVersion >= 2) {
      const canonical = contract.entityOperations[operation];
      const parts = [
        localizedText(canonical?.description) ?? fallback,
        localizedText(canonical?.guidance?.assistant),
        localizedText(mcp.operationInstructions?.[operation]),
      ].filter((part): part is string => Boolean(part));
      const description = parts.join(" ");
      return operation === "create" || operation === "update"
        ? `${description}${writerNote}`
        : description;
    }
    const authored = mcp.toolOverrides?.[operation]?.description;
    if (authored === undefined) return fallback;
    return operation === "create" || operation === "update"
      ? `${authored}${writerNote}`
      : authored;
  };
  const titled = (
    operation: McpToolDefinition["operation"],
    fallback: string,
  ) => contract.authoringVersion >= 2
    ? (localizedText(contract.entityOperations[operation]?.name) ?? fallback)
    : fallback;
  const entityAnnotations = (operation: McpToolDefinition["operation"]) => ({
    ...annotationsFor(operation),
    ...(contract.entityOperations[operation]?.reliability.idempotency.mode === "keyed"
      ? { idempotentHint: true }
      : {}),
  });

  if (mcp.operations.list) {
    const filterProperties: JsonObject = {};
    for (const field of fields) {
      if (
        field.key === mcp.elicitOnCreate?.into ||
        field.cardinality === "collection" ||
        field.valueType === "object"
      )
        continue;
      const schema = compiledFieldSchemaWithoutDefinitions(
        field,
        referentiedata,
        MCP_FIELD_SCHEMA_OPTIONS,
      );
      // Filters are always optional and never defaulted — a default here would
      // silently narrow a caller's result set.
      delete schema.default;
      filterProperties[field.key] = schema;
    }
    // Relationship keys filter by exact uuid, like every non-text field.
    for (const entry of relationships) {
      filterProperties[entry.key] = entry.schema;
    }
    tools.push({
      name: named("list"),
      ...(v2Contract ? { operationId: operationId("list") } : {}),
      operation: "list",
      entity: contract.entity.name,
      table,
      title: titled("list", `List ${label}`),
      description: described(
        "list",
        `${description} Returns a page of records. Text filters match on substring; ` +
          `other types match exactly.` +
          (filterField
            ? ` Free-text search is usually best against "${filterField}".`
            : ""),
      ),
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: filterProperties,
            additionalProperties: false,
            description:
              "Field equality/substring filters. Omit for no filtering.",
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
      ...(v2Contract ? { outputSchema: outputSchema("list") } : {}),
      annotations: entityAnnotations("list"),
    });
  }

  if (mcp.operations.get) {
    tools.push({
      name: named("get"),
      ...(v2Contract ? { operationId: operationId("get") } : {}),
      operation: "get",
      entity: contract.entity.name,
      table,
      title: titled("get", `Get ${label}`),
      description: described(
        "get",
        `${description} Fetches a single record by id.`,
      ),
      inputSchema: idSchema,
      ...(v2Contract ? { outputSchema: outputSchema("get") } : {}),
      annotations: entityAnnotations("get"),
    });
  }

  if (mcp.operations.create) {
    const canonicalCreate = contract.entityOperations.create;
    const inputSchema = canonicalCreate?.input.kind === "json-schema"
      ? canonicalCreate.input.schema
      : withRelationshipKeys(
          compiledObjectSchema(creatable, referentiedata, {
            requireRequired: true,
            defaultsAreMaterialized: true,
            ...MCP_FIELD_SCHEMA_OPTIONS,
          }),
          relationships,
          true,
        );
    const controls = v2Contract
      ? operationControlSchema(contract.entityOperations.create)
      : { properties: {}, required: [] };
    tools.push({
      name: named("create"),
      ...(v2Contract ? { operationId: operationId("create") } : {}),
      operation: "create",
      entity: contract.entity.name,
      table,
      title: titled("create", `Create ${label}`),
      description: described(
        "create",
        `${description} Creates a new record.${writerNote}`,
      ),
      inputSchema: v2Contract
        ? {
            ...inputSchema,
            properties: {
              ...(inputSchema.properties as JsonObject),
              ...controls.properties,
            },
            required: [
              ...((inputSchema.required as string[] | undefined) ?? []),
              ...controls.required,
            ],
            ...(controls.dependentRequired
              ? { dependentRequired: controls.dependentRequired }
              : {}),
          }
        : inputSchema,
      ...(v2Contract ? { outputSchema: outputSchema("create") } : {}),
      annotations: entityAnnotations("create"),
    });
  }

  if (mcp.operations.update) {
    // Entity values are a partial: omitting one means "leave it alone", not
    // "clear it". Canonical concurrency controls remain required separately.
    const canonicalUpdate = contract.entityOperations.update;
    const { schema: patch, definitions } = splitBundledDefinitions(
      withRelationshipKeys(
        compiledObjectSchema(updatable, referentiedata, {
          requireRequired: false,
          ...MCP_FIELD_SCHEMA_OPTIONS,
          includeDefault: false,
        }),
        relationships,
        false,
      ),
    );
    const controls = v2Contract
      ? operationControlSchema(contract.entityOperations.update)
      : { properties: {}, required: [] };
    tools.push({
      name: named("update"),
      ...(v2Contract ? { operationId: operationId("update") } : {}),
      operation: "update",
      entity: contract.entity.name,
      table,
      title: titled("update", `Update ${label}`),
      description: described(
        "update",
        `${description} Partially updates a record; omitted fields are left unchanged.` +
          writerNote,
      ),
      inputSchema: canonicalUpdate?.input.kind === "json-schema"
        ? {
            ...canonicalUpdate.input.schema,
            properties: {
              ...((canonicalUpdate.input.schema.properties as JsonObject | undefined) ?? {}),
              ...controls.properties,
            },
            required: [
              ...((canonicalUpdate.input.schema.required as string[] | undefined) ?? []),
              ...controls.required,
            ],
            ...(controls.dependentRequired
              ? {
                  dependentRequired: {
                    ...((canonicalUpdate.input.schema.dependentRequired as
                      | Record<string, string[]>
                      | undefined) ?? {}),
                    ...controls.dependentRequired,
                  },
                }
              : {}),
          }
        : {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                description: `Identifier of the ${label}.`,
              },
              values: patch,
              ...controls.properties,
            },
            required: ["id", "values", ...controls.required],
            additionalProperties: false,
            ...(controls.dependentRequired
              ? { dependentRequired: controls.dependentRequired }
              : {}),
            ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
          },
      ...(v2Contract ? { outputSchema: outputSchema("update") } : {}),
      annotations: entityAnnotations("update"),
    });
  }

  if (mcp.operations.delete) {
    const controls = v2Contract
      ? operationControlSchema(contract.entityOperations.delete)
      : { properties: {}, required: [] };
    tools.push({
      name: named("delete"),
      ...(v2Contract ? { operationId: operationId("delete") } : {}),
      operation: "delete",
      entity: contract.entity.name,
      table,
      title: titled("delete", `Delete ${label}`),
      description: described(
        "delete",
        `${description} Permanently deletes a record by id.`,
      ),
      inputSchema: v2Contract
        ? {
            type: "object",
            properties: {
              ...(idSchema.properties as JsonObject),
              ...controls.properties,
            },
            required: ["id", ...controls.required],
            additionalProperties: false,
            ...(controls.dependentRequired
              ? { dependentRequired: controls.dependentRequired }
              : {}),
          }
        : idSchema,
      ...(v2Contract ? { outputSchema: outputSchema("delete") } : {}),
      annotations: entityAnnotations("delete"),
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
  /** The entity's name in the deployment's primary language (English first). */
  title: string;
  /**
   * The authored `{ en, nl, … }` label, carried through unresolved so the
   * runtime can show a person the name in THEIR language. `title` above is one
   * language chosen at build time, which is the right answer for a tool name
   * and the wrong one for a sentence addressed to a reader.
   */
  labels?: Record<string, string>;
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
    /**
     * The field key every transport addresses the foreign key by (`<key>Id`,
     * or the authored field that owns the column). Set for every `belongsTo`
     * with a `foreignKey`.
     */
    field?: string;
    via?: string;
    through?: { field: string; column: string; target: string };
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
  outputFieldsField?: string;
  versionField?: string;
  execution?: McpDerivedExecutionDefinition;
  visibleWhen?: { field: string; equals: string };
  /** Field holding a per-row role list restricting who sees the tool. */
  visibleToRolesField?: string;
  internalOnlyField?: string;
  connect?: { name: string; description: string; roles: string[] };
  dryRun?: { name: string; description: string; roles: string[] };
  personalization?: {
    entity: string;
    /** Physical table of the preference entity, resolved at catalog build. */
    table: string;
    serviceRef: string;
    instructionField: string;
    set: { name: string; description: string };
  };
  /** Internal removal seam; never projected by an interface adapter. */
  compatibility?: {
    plugin: string;
    providerId: string;
    connectOperation?: string;
    dryRunOperation?: string;
    setPreferenceOperation?: string;
  };
};

export type McpGuideToolDefinition = {
  name: string;
  description: string;
  roles: string[];
  content: string;
  entity: string;
  /** Physical table of the guide's own entity, for the create gate. */
  table: string;
  requireBeforeCreate?: boolean;
};

export type McpDiscoveryToolDefinition = {
  name: string;
  description: string;
  entity: string;
  table: string;
  compatibility?: { plugin: string; operation: string };
};

export type McpTestToolDefinition = {
  name: string;
  description: string;
  entity: string;
  table: string;
  compatibility?: { plugin: string; operation: string };
};

export type ExecutionCompatibilityContribution = {
  plugin: string;
  contribution: PluginExecutionCompatibility;
};

export const SEARCHABLE_OPERATION_TOOL_NAMES = {
  search: "osf_search_operations",
  execute: "osf_execute_operation",
} as const;

export type McpOperationToolProjection = "dedicated" | "searchable";

/**
 * Keep the fixed dedicated budget while retaining every canonical Operation.
 * Entity/connector tools cannot be collapsed here; static Operations can use
 * the two fixed searchable tools instead of an unstable truncated subset.
 */
export function selectOperationToolProjection(
  dedicatedWithoutOperations: number,
  operationCount: number,
  maximum = MAX_DEDICATED_TOOLS,
): McpOperationToolProjection {
  if (dedicatedWithoutOperations > maximum) {
    throw new Error(
      `MCP tool catalog would advertise ${dedicatedWithoutOperations} dedicated non-Operation tools, ` +
        `over the ${maximum} limit. Switch entities to \`mcp: { tools: generic }\` or disable ` +
        "connector operations for MCP.",
    );
  }
  return dedicatedWithoutOperations + operationCount > maximum
    ? "searchable"
    : "dedicated";
}

export type McpCatalog = {
  generatedBy: string;
  source: string;
  entities: McpEntityCatalogEntry[];
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  derivedTools: McpDerivedToolsDefinition[];
  discoveryTools: McpDiscoveryToolDefinition[];
  testTools: McpTestToolDefinition[];
  guideTools: McpGuideToolDefinition[];
  operationTools: {
    key: string;
    plugin: string;
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    auth: CompiledPluginOperation["auth"];
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  }[];
  operationToolProjection: {
    mode: McpOperationToolProjection;
    search: typeof SEARCHABLE_OPERATION_TOOL_NAMES.search;
    execute: typeof SEARCHABLE_OPERATION_TOOL_NAMES.execute;
  };
  /** Internal adapter-removal seam; never listed as an MCP tool. */
  executionCompatibility: {
    plugin: string;
    operation: string;
    toolName: string;
    auth: CompiledPluginOperation["auth"];
  }[];
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
  const source = inputs.find(
    (input) => input.contract.entity.name === elicit.sourceEntity,
  );
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
  const found = inputs.find(
    (input) => input.contract.entity.name === entityName,
  );
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
  operations: readonly CompiledPluginOperation[] = [],
  executionCompatibility: readonly ExecutionCompatibilityContribution[] = [],
  requestedOperationToolProjection?: McpOperationToolProjection,
): McpCatalog {
  const opted = inputs
    .filter((input) => input.contract.mcp !== undefined)
    .sort((a, b) =>
      a.contract.mcp!.toolPrefix.localeCompare(b.contract.mcp!.toolPrefix),
    );

  const entities: McpEntityCatalogEntry[] = [];
  const tools: McpToolDefinition[] = [];
  const resources: McpResourceDefinition[] = [];
  const derivedTools: McpDerivedToolsDefinition[] = [];
  const discoveryTools: McpDiscoveryToolDefinition[] = [];
  const testTools: McpTestToolDefinition[] = [];
  const guideTools: McpGuideToolDefinition[] = [];
  const executionCompatibilityOperations: McpCatalog["executionCompatibility"] = [];

  // Every entity in the input set is a possible relationship target, whether
  // or not it is MCP-exposed itself; only an exposed one has a list tool to
  // point the model at.
  const relationshipTargets = new Map<string, RelationshipTarget>();
  for (const input of inputs) {
    const targetMcp = input.contract.mcp;
    const listTool =
      targetMcp && targetMcp.operations.list
        ? targetMcp.tools === "dedicated"
          ? (targetMcp.toolOverrides?.list?.name ??
            `${targetMcp.toolPrefix}_list`)
          : "osf_list"
        : undefined;
    relationshipTargets.set(input.contract.entity.name, {
      label: entityLabel(input.contract),
      ...(listTool ? { listTool } : {}),
    });
  }

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
      ...(contract.entity.labels &&
      Object.keys(contract.entity.labels).length > 0
        ? { labels: { ...(contract.entity.labels as Record<string, string>) } }
        : {}),
      description: entityDescription(contract),
      domains: [...contract.entity.domains],
      ...(contract.entity.displayTemplate
        ? { displayTemplate: contract.entity.displayTemplate }
        : {}),
      ...(contract.entity.filterField
        ? { filterField: contract.entity.filterField }
        : {}),
      classifiedFields: classifiedFieldKeys(fields),
      ...(mcp.elicitOnCreate
        ? {
            elicitOnCreate: {
              sourceField: mcp.elicitOnCreate.sourceField,
              sourceEntity: mcp.elicitOnCreate.sourceEntity,
              sourceTable: resolveSourceTable(
                inputs,
                mcp.elicitOnCreate,
                contract.entity.name,
              ),
              definitionsField: mcp.elicitOnCreate.definitionsField,
              into: mcp.elicitOnCreate.into,
              ...(mcp.elicitOnCreate.message
                ? { message: mcp.elicitOnCreate.message }
                : {}),
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
          ...(field.writtenBy && field.writtenBy.length > 0
            ? { writtenBy: [...field.writtenBy] }
            : {}),
          schema: compiledFieldSchema(
            field,
            referentiedata,
            MCP_FIELD_SCHEMA_OPTIONS,
          ),
          ...(field.classification?.sensitivity
            ? { classification: field.classification.sensitivity }
            : {}),
          ...(field.relationship?.kind && field.relationship.entity
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
        const column = relationshipColumn(contract, relationship);
        return {
          key: relationship.key,
          kind: relationship.kind,
          target: relationship.target,
          ...(relationship.foreignKey
            ? { foreignKey: relationship.foreignKey }
            : {}),
          ...(column ? { field: column.key } : {}),
          ...(relationship.via ? { via: relationship.via } : {}),
          ...(relationship.through ? { through: relationship.through } : {}),
          ...(label ? { label } : {}),
        };
      }),
    });

    tools.push(
      ...buildToolsForEntity(
        contract,
        input.table,
        referentiedata,
        relationshipTargets,
      ),
    );

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

    if (mcp.guide) {
      guideTools.push({
        name: mcp.guide.name,
        description: mcp.guide.description,
        roles: [...mcp.guide.roles],
        content: mcp.guide.content,
        entity: contract.entity.name,
        table: input.table,
        ...(mcp.guide.requireBeforeCreate ? { requireBeforeCreate: true } : {}),
      });
    }

    if (mcp.discovery) {
      discoveryTools.push({
        name: mcp.discovery.name,
        description:
          mcp.discovery.description ??
          `Fetch and summarize the declared API schema of one ${entityLabel(contract)} by its identifier.`,
        entity: contract.entity.name,
        table: input.table,
      });
    }

    if (mcp.test) {
      testTools.push({
        name: mcp.test.name,
        description:
          mcp.test.description ??
          `Verify one ${entityLabel(contract)} by its identifier: checks its stored values ` +
            `and credentials, and exercises them against the provider when a probe request ` +
            `is declared. Reports what was and was not verified.`,
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
        ...(mcp.derivedTools.titleField
          ? { titleField: mcp.derivedTools.titleField }
          : {}),
        descriptionField: mcp.derivedTools.descriptionField,
        inputFieldsField: mcp.derivedTools.inputFieldsField,
        ...(mcp.derivedTools.outputFieldsField
          ? { outputFieldsField: mcp.derivedTools.outputFieldsField }
          : {}),
        ...(mcp.derivedTools.versionField
          ? { versionField: mcp.derivedTools.versionField }
          : {}),
        ...(mcp.derivedTools.visibleWhen
          ? { visibleWhen: { ...mcp.derivedTools.visibleWhen } }
          : {}),
        ...(mcp.derivedTools.visibleToRolesField
          ? { visibleToRolesField: mcp.derivedTools.visibleToRolesField }
          : {}),
        ...(mcp.derivedTools.internalOnlyField
          ? { internalOnlyField: mcp.derivedTools.internalOnlyField }
          : {}),
        ...(mcp.derivedTools.connect
          ? {
              connect: {
                name: mcp.derivedTools.connect.name,
                roles: [...mcp.derivedTools.connect.roles],
                description:
                  mcp.derivedTools.connect.description ??
                  `Start a provider connection for one ${entityLabel(contract)}: ` +
                    `validates the definition chain and returns an authorization URL for the ` +
                    `caller to open in a browser.`,
              },
            }
          : {}),
        ...(mcp.derivedTools.personalization
          ? {
              personalization: {
                entity: mcp.derivedTools.personalization.entity,
                table: resolveEntityTable(
                  inputs,
                  mcp.derivedTools.personalization.entity,
                  contract.entity.name,
                  "derivedTools.personalization.entity",
                ),
                serviceRef: mcp.derivedTools.personalization.serviceRef,
                instructionField:
                  mcp.derivedTools.personalization.instructionField,
                set: {
                  name: mcp.derivedTools.personalization.set.name,
                  description:
                    mcp.derivedTools.personalization.set.description ??
                    `Store YOUR standing instruction for one ${entityLabel(contract)} tool ` +
                      `(or for all of them): from then on, every assistant you use sees it ` +
                      `alongside the tool. An empty instruction clears it.`,
                },
              },
            }
          : {}),
        ...(mcp.derivedTools.dryRun
          ? {
              dryRun: {
                name: mcp.derivedTools.dryRun.name,
                description:
                  mcp.derivedTools.dryRun.description ??
                  `Compose the exact provider request(s) one ${entityLabel(contract)} tool ` +
                    `call would make — method, URL, headers with placeholder credentials, ` +
                    `body — without sending anything. Works on drafts, so a definition can ` +
                    `be verified before it is published.`,
                roles: [...mcp.derivedTools.dryRun.roles],
              },
            }
          : {}),
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

  const compatibilityNames = new Map<string, string>();
  type CompatibilityOperation = CompiledPluginOperation & {
    auth: Extract<CompiledPluginOperation["auth"], { mode: "session" }> & {
      roles: string[];
    };
  };
  const compatibilityOperation = (
    plugin: string,
    key: string,
  ): CompatibilityOperation => {
    const operation = operations.find(
      (candidate) => candidate.plugin === plugin && candidate.key === key,
    );
    if (!operation) {
      throw new Error(
        `Plugin "${plugin}" execution compatibility references unknown canonical ` +
          `Operation "${key}".`,
      );
    }
    if (operation.auth.mode !== "session") {
      throw new Error(
        `Plugin "${plugin}" compatibility Operation "${key}" must use session authorization.`,
      );
    }
    if (!operation.auth.roles?.length) {
      throw new Error(
        `Plugin "${plugin}" compatibility Operation "${key}" must declare at least one role.`,
      );
    }
    return operation as CompatibilityOperation;
  };
  const internalCompatibilityName = (
    plugin: string,
    operation: CompatibilityOperation,
  ) => {
    const existing = compatibilityNames.get(operation.key);
    if (existing) return existing;
    const key = operation.key;
    const name = `osf_internal_${plugin}_${key}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .slice(0, 128);
    if ([...compatibilityNames.values()].includes(name)) {
      throw new Error(
        `Execution compatibility name collision for canonical Operation "${key}".`,
      );
    }
    compatibilityNames.set(operation.key, name);
    executionCompatibilityOperations.push({
      plugin,
      operation: operation.key,
      toolName: name,
      auth: operation.auth,
    });
    return name;
  };
  const compatibilityEntity = (plugin: string, entityName: string) => {
    const found = inputs.find(
      (candidate) => candidate.contract.entity.name === entityName,
    );
    if (!found) {
      throw new Error(
        `Plugin "${plugin}" execution compatibility references unknown entity ` +
          `"${entityName}".`,
      );
    }
    return found;
  };
  const assertCompatibilityField = (
    plugin: string,
    entityName: string,
    field: string,
    option: string,
  ) => {
    const entity = compatibilityEntity(plugin, entityName);
    const fields = new Set(entity.contract.model.fields.map((candidate) => candidate.key));
    if (!fields.has(field)) {
      throw new Error(
        `Plugin "${plugin}" execution compatibility ${option} references unknown ` +
          `field "${entityName}.${field}".`,
      );
    }
  };

  for (const { plugin, contribution } of executionCompatibility) {
    if (contribution.version !== 1) {
      throw new Error(
        `Plugin "${plugin}" execution compatibility must declare version 1.`,
      );
    }
    for (const discovery of contribution.discovery ?? []) {
      const operation = compatibilityOperation(plugin, discovery.operation);
      const entity = compatibilityEntity(plugin, discovery.entity);
      discoveryTools.push({
        name: internalCompatibilityName(plugin, operation),
        description: operation.description,
        entity: discovery.entity,
        table: entity.table,
        compatibility: { plugin, operation: operation.key },
      });
    }
    for (const test of contribution.tests ?? []) {
      const operation = compatibilityOperation(plugin, test.operation);
      const entity = compatibilityEntity(plugin, test.entity);
      testTools.push({
        name: internalCompatibilityName(plugin, operation),
        description: operation.description,
        entity: test.entity,
        table: entity.table,
        compatibility: { plugin, operation: operation.key },
      });
    }
    for (const record of contribution.records ?? []) {
      const entity = compatibilityEntity(plugin, record.entity);
      const readOperation = entity.contract.entityOperations.get;
      if (!readOperation) {
        throw new Error(
          `Plugin "${plugin}" execution compatibility record entity ` +
            `"${record.entity}" must declare canonical get.`,
        );
      }
      for (const [option, field] of [
        ["keyField", record.keyField],
        ["descriptionField", record.descriptionField],
        ["inputFieldsField", record.inputFieldsField],
        ["versionField", record.versionField],
        ["bindingsField", record.execution.bindingsField],
      ] as const) {
        assertCompatibilityField(plugin, record.entity, field, option);
      }
      for (const field of [
        record.titleField,
        record.outputFieldsField,
        record.visibleWhen?.field,
        record.visibleToRolesField,
        record.internalOnlyField,
      ]) {
        if (field) assertCompatibilityField(plugin, record.entity, field, "record field");
      }
      assertCompatibilityField(
        plugin,
        record.execution.operationEntity,
        record.execution.providerRef,
        "execution.providerRef",
      );
      assertCompatibilityField(
        plugin,
        record.execution.connectionEntity,
        record.execution.connectionProviderRef,
        "execution.connectionProviderRef",
      );
      assertCompatibilityField(
        plugin,
        record.execution.connectionEntity,
        record.execution.connectionValuesField,
        "execution.connectionValuesField",
      );
      const connect = record.connectOperation
        ? compatibilityOperation(plugin, record.connectOperation)
        : undefined;
      const dryRun = record.dryRunOperation
        ? compatibilityOperation(plugin, record.dryRunOperation)
        : undefined;
      const personalization = record.personalization
        ? {
            authored: record.personalization,
            operation: compatibilityOperation(
              plugin,
              record.personalization.setOperation,
            ),
          }
        : undefined;
      if (personalization) {
        assertCompatibilityField(
          plugin,
          personalization.authored.entity,
          personalization.authored.serviceRef,
          "personalization.serviceRef",
        );
        assertCompatibilityField(
          plugin,
          personalization.authored.entity,
          personalization.authored.instructionField,
          "personalization.instructionField",
        );
      }
      derivedTools.push({
        entity: record.entity,
        table: entity.table,
        roles: [...readOperation.authorization.roles],
        keyField: record.keyField,
        ...(record.titleField ? { titleField: record.titleField } : {}),
        descriptionField: record.descriptionField,
        inputFieldsField: record.inputFieldsField,
        ...(record.outputFieldsField
          ? { outputFieldsField: record.outputFieldsField }
          : {}),
        versionField: record.versionField,
        ...(record.visibleWhen ? { visibleWhen: { ...record.visibleWhen } } : {}),
        ...(record.visibleToRolesField
          ? { visibleToRolesField: record.visibleToRolesField }
          : {}),
        ...(record.internalOnlyField
          ? { internalOnlyField: record.internalOnlyField }
          : {}),
        ...(connect
          ? {
              connect: {
                name: internalCompatibilityName(plugin, connect),
                description: connect.description,
                roles: [...connect.auth.roles],
              },
            }
          : {}),
        ...(dryRun
          ? {
              dryRun: {
                name: internalCompatibilityName(plugin, dryRun),
                description: dryRun.description,
                roles: [...dryRun.auth.roles],
              },
            }
          : {}),
        ...(personalization
          ? {
              personalization: {
                entity: personalization.authored.entity,
                table: compatibilityEntity(
                  plugin,
                  personalization.authored.entity,
                ).table,
                serviceRef: personalization.authored.serviceRef,
                instructionField: personalization.authored.instructionField,
                set: {
                  name: internalCompatibilityName(plugin, personalization.operation),
                  description: personalization.operation.description,
                },
              },
            }
          : {}),
        execution: {
          bindingsField: record.execution.bindingsField,
          operationRef: record.execution.operationRef,
          operationEntity: record.execution.operationEntity,
          operationTable: compatibilityEntity(
            plugin,
            record.execution.operationEntity,
          ).table,
          providerRef: record.execution.providerRef,
          providerEntity: record.execution.providerEntity,
          providerTable: compatibilityEntity(
            plugin,
            record.execution.providerEntity,
          ).table,
          connectionEntity: record.execution.connectionEntity,
          connectionTable: compatibilityEntity(
            plugin,
            record.execution.connectionEntity,
          ).table,
          connectionProviderRef: record.execution.connectionProviderRef,
          connectionValuesField: record.execution.connectionValuesField,
        },
        compatibility: {
          plugin,
          providerId: record.providerId,
          ...(connect ? { connectOperation: connect.key } : {}),
          ...(dryRun ? { dryRunOperation: dryRun.key } : {}),
          ...(personalization
            ? { setPreferenceOperation: personalization.operation.key }
            : {}),
        },
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
  const reserveName = (
    name: string,
    entity: string,
    operation: string,
    table: string,
  ): void => {
    const existing = seenNames.get(name);
    if (existing) {
      throw new Error(
        `Duplicate MCP tool name "${name}": emitted for both ` +
          `${existing.entity}.${existing.operation} and ${entity}.${operation}. ` +
          `Adjust the authored mcp name override or toolPrefix so every tool name is unique.`,
      );
    }
    seenNames.set(name, {
      name,
      operation: "get",
      entity,
      table,
    } as McpToolDefinition);
  };
  for (const entry of derivedTools) {
    for (const authored of [
      entry.connect,
      entry.dryRun,
      entry.personalization?.set,
    ]) {
      if (!authored) continue;
      reserveName(authored.name, entry.entity, "derived", entry.table);
    }
  }
  for (const guide of guideTools) {
    reserveName(guide.name, guide.entity, "guide", guide.table);
  }
  for (const discovery of discoveryTools) {
    reserveName(discovery.name, discovery.entity, "discovery", discovery.table);
  }
  for (const test of testTools) {
    reserveName(test.name, test.entity, "test", test.table);
  }
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

  const dedicatedCount = tools.filter(
    (tool) => !tool.name.startsWith("osf_"),
  ).length;
  const operationTools = operations
    .filter((operation) => operation.transports.mcp.enabled)
    .map((operation) => ({
      key: operation.key,
      plugin: operation.plugin,
      name: operation.transports.mcp.enabled ? operation.transports.mcp.name : "",
      title: operation.title,
      description: operation.description,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
      auth: operation.auth,
      annotations: {
        readOnlyHint:
          operation.effects?.data === "read" ||
          (!operation.effects && operation.transports.rest.method === "GET"),
        destructiveHint:
          operation.effects?.data === "delete" ||
          (!operation.effects && operation.transports.rest.method === "DELETE"),
        idempotentHint: operation.idempotency.mode !== "none",
      },
    }));
  const locallyRequiredProjection = selectOperationToolProjection(
    dedicatedCount,
    operationTools.length,
  );
  const operationToolProjection =
    locallyRequiredProjection === "searchable" ||
      requestedOperationToolProjection === "searchable"
      ? "searchable"
      : "dedicated";

  return {
    generatedBy: "@openshapeforge/compiler",
    source,
    entities,
    tools,
    resources,
    derivedTools,
    discoveryTools,
    testTools,
    guideTools,
    operationTools,
    operationToolProjection: {
      mode: operationToolProjection,
      ...SEARCHABLE_OPERATION_TOOL_NAMES,
    },
    executionCompatibility: executionCompatibilityOperations,
  };
}

export function renderMcpCatalog(
  inputs: McpCatalogInput[],
  source: string,
  referentiedata: CoreReferentiedataSnapshot = {},
  operations: readonly CompiledPluginOperation[] = [],
  executionCompatibility: readonly ExecutionCompatibilityContribution[] = [],
  operationToolProjection?: McpOperationToolProjection,
): string {
  return `${JSON.stringify(buildMcpCatalog(
    inputs,
    source,
    referentiedata,
    operations,
    executionCompatibility,
    operationToolProjection,
  ), null, 2)}\n`;
}
