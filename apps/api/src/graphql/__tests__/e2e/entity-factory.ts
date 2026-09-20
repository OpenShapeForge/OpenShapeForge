// SPDX-License-Identifier: BUSL-1.1
/**
 * Manifest-driven entity derivation for the e2e suite: which entities exist,
 * how their GraphQL fields map to columns, and how to create valid rows
 * (recursively satisfying required foreign keys). Mirrors the engine's own
 * column rules so the suite can never drift from the API.
 */
import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  createGeneratedEntity,
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  isOperationWrittenColumn,
  isTenantRegistryTable,
  isWritableColumn,
} from "../../generated-crud.js";
import fieldAuthoringRegistry from "../../../generated/compiler/field-authoring-registry.json" with { type: "json" };
import { createGeneratedEntityForTable } from "../../../operations/entity/mutations.js";
import { createDoc, expectOperationData } from "./gql-shapes.js";
import {
  createdRows,
  getRuntime,
  getSeedRuntime,
  gql,
  seed,
  type GeneratedTable,
  type Identity,
} from "./harness.js";
import { isEntityBackedCreate, operationContractFor } from "./operations.js";

export type Column = GeneratedTable["columns"][number];

export const eligibleTables = getGeneratedCrudTables().filter((table) => table.source?.graphql);
export const tables = eligibleTables.filter((table) =>
  (["list", "get", "create", "update", "delete"] as const).every((operation) =>
    isGeneratedCrudOperationEnabled(table, operation),
  ),
);
export const graphqlTables = tables.filter((table) =>
  (["list", "get", "create", "update", "delete"] as const).every(
    (operation) => table.source?.graphql?.operations?.[operation] !== false,
  ),
);
export const partialPolicyTables = eligibleTables.filter(
  (table) => !graphqlTables.includes(table),
);
export const tablesByTypeName = new Map(
  graphqlTables.map((table) => [table.source!.graphql!.typeName, table]),
);
export const tablesByName = new Map(tables.map((table) => [table.name, table]));
/**
 * Every GraphQL-exposed table by name, partial-policy ones included: a
 * foreign key may point at an entity that is not fully CRUD-exposed (a
 * document's current version, say), and a fixture for it must still be
 * creatable — through the engine when no transport create applies.
 */
export const eligibleTablesByName = new Map(
  eligibleTables.map((table) => [table.name, table]),
);
/** By authored entity name — the key contracts use to reference other entities. */
export const eligibleTablesByEntityName = new Map(
  eligibleTables.map((table) => [table.source!.authoringEntityName, table]),
);

export function fieldName(column: Column): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

/**
 * Delegates to the engine's own predicates rather than restating them, so the
 * suite cannot drift from the API. `create` is the right default here: the
 * factory's job is building rows, and a column authored `immutable` is settable
 * exactly then (#177). Tests that build an update body ask for "update". A
 * column written by a named Operation (a versioned head's lifecycle status)
 * is never a caller's to set, whatever the intent.
 */
export function isMutableColumn(
  column: Column,
  operation: "create" | "update" = "create",
): boolean {
  return isWritableColumn(column, operation) && !isOperationWrittenColumn(column);
}

/**
 * The rows that reference `id` through a schema foreign key, as
 * `table.column` names — what the database's on-delete rules will weigh when
 * the record is deleted. Read from the database itself, so a sweep learns
 * what a create actually left behind (a document's first version) rather
 * than inferring it from the create's contract.
 */
export async function referencingRows(table: GeneratedTable, id: string, identity: Identity): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of getGeneratedCrudTables()) {
    for (const [column, target] of foreignKeyTargets(candidate)) {
      if (target !== table.name) continue;
      const tenantWhere = candidate.tenantScoped ? sql`and tenant_id = ${identity.tenantId}::uuid` : sql``;
      const rows = await sql<{ count: string }>`
        select count(*)::text as count from ${sql.id(candidate.schema, candidate.table)}
        where ${sql.id(column)}::text = ${id} ${tenantWhere}
      `.execute(getSeedRuntime().db);
      if (Number(rows.rows[0]?.count ?? 0) > 0) found.push(`${candidate.name}.${column}`);
    }
  }
  return found;
}

/** FK column name -> target table name (e.g. relation_group_id -> erp.relation_groups). */
export function foreignKeyTargets(table: GeneratedTable): Map<string, string> {
  // relationshipStatus is present in manifest.json but not in the engine's
  // narrowed source type — it only declares the graphql block it needs.
  const source = table.source as
    | { relationshipStatus?: { emittedReferences?: string[] } }
    | undefined;
  const emitted = source?.relationshipStatus?.emittedReferences ?? [];
  const map = new Map<string, string>();
  for (const reference of emitted) {
    const match = /^(.+?)->(.+?)\.(.+?)\.(.+)$/.exec(reference);
    if (match) {
      map.set(match[1]!, `${match[2]}.${match[3]}`);
    }
  }
  return map;
}

export function sampleValue(column: Column, marker: string): unknown {
  switch (column.type) {
    case "text":
      return `e2e-${marker}-${fieldName(column)}`;
    case "integer":
    case "bigint":
      return 7;
    case "numeric":
      return 7.5;
    case "boolean":
      return true;
    case "uuid":
      return randomUUID();
    case "date":
      return "2026-01-02";
    case "timestamptz":
      return "2026-01-02T03:04:05.000Z";
    case "jsonb":
      return {};
    default:
      return `e2e-${marker}`;
  }
}

// Distinct per created row, because the ERP catalog carries per-tenant unique
// columns (cases.code, chips.key, document_types.code, the idempotency keys).
// A constant marker made the SECOND row of such an entity in the same tenant
// a duplicate-key error, which surfaced as hundreds of unrelated failures the
// first time the suite ran against the full catalog in CI — and again as
// ALREADY_EXISTS in the REST and MCP sweeps, which had kept a run-constant
// marker of their own. Every builder that plants sample values takes its
// marker from here.
let rowSequence = 0;

/** A marker unique to one created row within this run. */
export function nextMarker(): string {
  return `${seed}-${++rowSequence}`;
}

/** A JSON-schema property as the compiler projects it into an Operation contract. */
type FieldSchema = {
  type?: string;
  format?: string;
  enum?: unknown[];
  maxLength?: number;
  pattern?: string;
  required?: string[];
  properties?: Record<string, FieldSchema>;
  "x-osf-reference"?: { entity: string; valueField?: string };
};

/**
 * The projected create-input schema for `field` on a canonical entity, which
 * carries what the column manifest cannot: an entity-valued option
 * (`x-osf-reference`) whose value must be another record's field.
 */
function createFieldSchema(table: GeneratedTable, field: string): FieldSchema | undefined {
  const contract = operationContractFor(table, "create");
  const values = (contract?.inputSchema as FieldSchema | undefined)?.properties?.values;
  return values?.properties?.[field];
}

/**
 * A sample the compiled write contract accepts: an allowed enum value, else the
 * column sample made to fit the advertised pattern and length (a three-letter
 * currency code cannot carry a marker). The runtime enforces what the contract
 * advertises, on every interface, so a marker in an options field is refused.
 */
export function schemaSample(
  column: Column,
  schema: Pick<FieldSchema, "enum" | "maxLength" | "pattern"> | undefined,
  marker: string,
): unknown {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  const rawSample = sampleValue(column, marker);
  if (typeof rawSample !== "string") return rawSample;
  let sample: string = rawSample;
  if (schema?.pattern && !new RegExp(schema.pattern).test(sample)) {
    // An identifier-shaped candidate first; then the marker's digest, which
    // is what a checksum column (a content hash) is authored to hold.
    const candidates = [
      `e2e${marker.replace(/[^a-zA-Z0-9]/g, "")}${fieldName(column)}`,
      createHash("sha256").update(`${marker}:${fieldName(column)}`).digest("hex"),
    ];
    const fitting = candidates.find((candidate) => new RegExp(schema.pattern!).test(candidate));
    if (fitting === undefined) {
      throw new Error(`No deterministic sample satisfies ${fieldName(column)} pattern ${schema.pattern}.`);
    }
    sample = fitting;
  }
  return schema?.maxLength !== undefined ? sample.slice(0, schema.maxLength) : sample;
}

/**
 * The authored value contract of a field on a table with no create of its
 * own (a template's versions are made by its publish): the static options
 * and pattern the compiler also turns into the column's CHECK, read from the
 * compiled field registry the engine ships, so the runtime-owned seed of such
 * a row satisfies the same rules a create would.
 */
function authoredFieldSchema(table: GeneratedTable, field: string): Pick<FieldSchema, "enum" | "maxLength" | "pattern"> | undefined {
  const shape = (fieldAuthoringRegistry as { osfTypes?: Record<string, { shape?: Array<{ key: string; validation?: { pattern?: string; maxLength?: number }; options?: { type?: string; items?: Array<{ value: string }> } }> }> })
    .osfTypes?.[table.source?.authoringEntityName ?? ""]?.shape?.find((entry) => entry.key === field);
  if (!shape) return undefined;
  const items = shape.options?.type === "static" ? shape.options.items?.map((item) => item.value) : undefined;
  return {
    ...(items?.length ? { enum: items } : {}),
    ...(shape.validation?.pattern ? { pattern: shape.validation.pattern } : {}),
    ...(shape.validation?.maxLength !== undefined ? { maxLength: shape.validation.maxLength } : {}),
  };
}

/** `schemaSample` against the field's projected create schema on `table`, or its authored contract when there is no create. */
export function contractSample(table: GeneratedTable, column: Column, marker: string): unknown {
  const field = fieldName(column);
  return schemaSample(column, createFieldSchema(table, field) ?? authoredFieldSchema(table, field), marker);
}

/**
 * A value satisfying a reference to another entity: the referenced row's
 * `valueField` (a code the row is created with) or, without one, its id.
 */
async function referencedValue(
  reference: NonNullable<FieldSchema["x-osf-reference"]>,
  identity: Identity,
  depth: number,
): Promise<unknown> {
  const target = eligibleTablesByEntityName.get(reference.entity);
  if (!target) {
    throw new Error(`Reference targets unknown entity ${reference.entity}`);
  }
  if (!reference.valueField) return createRow(target, identity, {}, depth + 1);
  const value = `e2e-${nextMarker()}-${reference.valueField}`;
  await createRow(target, identity, { [reference.valueField]: value }, depth + 1);
  return value;
}

/**
 * Creates a row for `table`, recursively creating rows for any REQUIRED
 * foreign-key columns first. Returns the new row's id and tracks it for
 * cleanup.
 */
export async function createRow(
  table: GeneratedTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<string> {
  if (depth > 5) {
    throw new Error(`FK dependency chain too deep while creating ${table.name}`);
  }
  const graphql = table.source?.graphql;

  // A tenant registry (CHECK (id = tenant_id)) has one write path,
  // provisioning, and the harness provisions each run's tenant row once
  // (ensureTenantRows). The fixture for it IS that row: a second insert
  // would collide on the tenant's own id.
  if (isTenantRegistryTable(table)) {
    return identity.tenantId;
  }

  // A plugin-backed create has an input contract of its own, and its
  // database may refuse a direct insert outright (a document must be created
  // atomically with its first version), so the fixture goes through the
  // Operation like any client's would.
  if (graphql && graphql.operations?.create !== false && !isEntityBackedCreate(table)) {
    const input = await pluginCreateInput(table, identity, overrides, depth);
    const created = await gql(identity, createDoc(table), { input });
    const id = expectOperationData(table, created, graphql.createMutationName)?.id as string;
    expect(id).toBeTruthy();
    createdRows.push({ table, id, identity });
    return id;
  }

  const input = await columnInput(table, identity, overrides, depth);

  if (!graphql || graphql.operations?.create === false || !isGeneratedCrudOperationEnabled(table, "create")) {
    // A table without a caller-facing create (a template's versions are made
    // by its publish) is seeded through the runtime-owned path the engine's
    // own Operations use: the same validation, tenant column and journal
    // event, without the operation gate a caller would meet.
    const row = isGeneratedCrudOperationEnabled(table, "create")
      ? await createGeneratedEntity(getRuntime().db, identity, { table: table.name, values: input })
      : await createGeneratedEntityForTable(getRuntime().db, identity, table, input);
    const id = String(row[table.primaryKey!]);
    expect(id).toBeTruthy();
    createdRows.push({ table, id, identity });
    return id;
  }

  const created = await gql(identity, createDoc(table), { input });
  const id = expectOperationData(table, created, graphql.createMutationName)?.id as string;
  expect(id).toBeTruthy();
  createdRows.push({ table, id, identity });
  return id;
}

/**
 * A complete create input for `table` built as `identity`: the column values
 * of an entity-backed create, or the plugin's authored input. Lets a test
 * provision every dependency as one identity and then submit the create as
 * another — the parents of a row need roles the row's own create role need
 * not carry.
 */
export function createInput(
  table: GeneratedTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return isEntityBackedCreate(table)
    ? columnInput(table, identity, overrides)
    : pluginCreateInput(table, identity, overrides);
}

/**
 * The column values an entity-backed create needs: sample values for required
 * scalars, freshly created rows for required foreign keys and entity-valued
 * references, `overrides` verbatim.
 */
export async function columnInput(
  table: GeneratedTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  const fkTargets = foreignKeyTargets(table);
  const input: Record<string, unknown> = {};
  const marker = nextMarker();

  for (const column of table.columns) {
    if (!isMutableColumn(column)) continue;
    const field = fieldName(column);
    if (field in overrides) {
      input[field] = overrides[field];
      continue;
    }
    const fkTarget = fkTargets.get(column.name);
    if (fkTarget) {
      if (column.required) {
        const targetTable = eligibleTablesByName.get(fkTarget);
        if (!targetTable) {
          throw new Error(
            `Required FK ${table.name}.${column.name} targets unknown table ${fkTarget}`,
          );
        }
        input[field] = await createRow(targetTable, identity, {}, depth + 1);
      }
      continue; // optional FKs stay unset unless overridden
    }
    if (!column.required) continue;
    const reference = createFieldSchema(table, field)?.["x-osf-reference"];
    input[field] = reference
      ? await referencedValue(reference, identity, depth)
      : contractSample(table, column, marker);
  }
  return input;
}

/**
 * An input satisfying a plugin-backed create's authored contract, walked from
 * its projected JSON schema: required scalars get samples, references get
 * real rows, the idempotency field a fresh key, nested objects recurse. Each
 * override lands at the first level that declares its key, so `{ title }`
 * reaches a nested `document` block the way a caller would place it.
 */
export async function pluginCreateInput(
  table: GeneratedTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  const contract = operationContractFor(table, "create");
  const schema = (contract?.input as { schema?: FieldSchema } | undefined)?.schema;
  if (!contract || !schema?.properties) {
    throw new Error(`${table.name} has no plugin create contract to build an input from.`);
  }
  const idempotencyField = contract.reliability.idempotency.inputField;
  const pending = { ...overrides };

  const build = async (node: FieldSchema): Promise<Record<string, unknown>> => {
    const input: Record<string, unknown> = {};
    // A contract that offers alternatives ("a fixed amount, or a basis with a
    // percentage") states them as an anyOf of required lists; the first
    // alternative is the one the factory satisfies.
    const alternative = (node as { anyOf?: Array<{ required?: string[] }> }).anyOf?.[0]?.required ?? [];
    for (const [key, property] of Object.entries(node.properties ?? {})) {
      if (key in pending) {
        input[key] = pending[key];
        delete pending[key];
        continue;
      }
      const required = node.required?.includes(key) === true || alternative.includes(key);
      if (property.type === "object" && property.properties) {
        // An optional block (an artifact handle, say) is left out entirely:
        // its own required members only apply once the block is present.
        const wanted = required ||
          Object.keys(pending).some((override) => override in property.properties!);
        if (wanted) input[key] = await build(property);
        continue;
      }
      if (!required) continue;
      input[key] = key === idempotencyField
        ? randomUUID()
        : property["x-osf-reference"]
          ? await referencedValue(property["x-osf-reference"], identity, depth)
          : sampleForSchema(key, property);
    }
    return input;
  };

  const input = await build(schema);
  const unplaced = Object.keys(pending);
  if (unplaced.length > 0) {
    throw new Error(`${table.name} create input declares no field for ${unplaced.join(", ")}`);
  }
  return input;
}

function sampleForSchema(key: string, property: FieldSchema): unknown {
  if (Array.isArray(property.enum) && property.enum.length > 0) return property.enum[0];
  switch (property.type) {
    case "integer":
      return 7;
    case "number":
      return 7.5;
    case "boolean":
      return true;
    default:
      if (property.format === "uuid") return randomUUID();
      if (property.format === "date") return "2026-01-02";
      if (property.format === "date-time") return "2026-01-02T03:04:05.000Z";
      return `e2e-${nextMarker()}-${key}`;
  }
}

/** Stop tracking a row the test already deleted itself. */
export function untrackRow(id: string) {
  const index = createdRows.findIndex((row) => row.id === id);
  if (index >= 0) {
    createdRows.splice(index, 1);
  }
}

/**
 * Whether a create can set `field`. Every mutable column for an entity-backed
 * create; for a plugin-backed create only the fields its authored input
 * declares (at any nesting), since the plugin owns the rest of the row.
 */
export function isCreatableField(table: GeneratedTable, field: string): boolean {
  if (isEntityBackedCreate(table)) return true;
  const contract = operationContractFor(table, "create");
  const schema = (contract?.input as { schema?: FieldSchema } | undefined)?.schema;
  const declares = (node: FieldSchema | undefined): boolean =>
    Object.entries(node?.properties ?? {}).some(
      ([key, property]) => key === field || (property.type === "object" && declares(property)),
    );
  return declares(schema);
}

export function textColumnFor(
  table: GeneratedTable,
  preferredField?: string,
): Column | undefined {
  // "update": callers plant a value at create and then change it, so the
  // column has to be writable in both directions — and settable by the
  // create the factory drives. Free text only: callers plant markers, and a
  // column whose contract is an options list, a pattern or a short code
  // refuses one.
  const mutableText = table.columns.filter((column) => {
    const schema = createFieldSchema(table, fieldName(column));
    return isMutableColumn(column, "update") &&
      column.type === "text" &&
      isCreatableField(table, fieldName(column)) &&
      !schema?.enum && !schema?.pattern && (schema?.maxLength ?? Infinity) >= 80;
  });
  return mutableText.find((column) => fieldName(column) === preferredField) ?? mutableText[0];
}

/**
 * A column a redaction test can drive end to end: writable (so a value can be
 * planted at create time) and OPTIONAL.
 *
 * The optional restriction is an artefact of how these tests arm a
 * classification, not of the schema rule. Since #168 a classified column
 * renders nullable however it is authored — but `generatedEntityTypeDefs` is
 * built once, at import, from the manifest as shipped, and withClassifiedColumn
 * tags a column afterwards. The SDL a test runs against therefore still says
 * `String!` for a required column, and a redacted null would surface as a
 * non-null execution error here even though it would not in a deployment whose
 * manifest declares the classification.
 *
 * classified-nullability.unit.test.ts covers the required case by rendering the
 * schema directly.
 */
export function redactableColumnFor(table: GeneratedTable): Column | undefined {
  return table.columns.find(
    (column) =>
      isMutableColumn(column, "update") &&
      column.type === "text" &&
      !column.required &&
      isCreatableField(table, fieldName(column)),
  );
}

/**
 * Runs `fn` with `column` carrying a restricting data classification.
 *
 * No entity shipped in this repo declares one, so the manifest has no
 * classified column for the field-level controls (#96/#101/#164) to act on and
 * every assertion about them would be vacuous. The CRUD core reads
 * `column.classification` per request, so tagging a column for the duration of
 * one test exercises the real transport → CRUD → Postgres path with a
 * classified column present. Restored in `finally`; bun runs tests within a
 * file sequentially, so no other test observes the tag.
 *
 * In-process transports only — a server behind E2E_API_URL has its own
 * manifest and is unaffected, so callers must skip when remoteUrl is set.
 */
export async function withClassifiedColumn<T>(
  column: Column,
  sensitivity: NonNullable<Column["classification"]>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = column.classification;
  column.classification = sensitivity;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete column.classification;
    } else {
      column.classification = previous;
    }
  }
}
