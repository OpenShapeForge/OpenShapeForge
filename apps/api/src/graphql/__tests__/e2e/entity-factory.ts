// SPDX-License-Identifier: BUSL-1.1
/**
 * Manifest-driven entity derivation for the e2e suite: which entities exist,
 * how their GraphQL fields map to columns, and how to create valid rows
 * (recursively satisfying required foreign keys). Mirrors the engine's own
 * column rules so the suite can never drift from the API.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  isWritableColumn,
} from "../../generated-crud.js";
import {
  createdRows,
  expectData,
  seed,
  type GeneratedTable,
  type Identity,
} from "./harness.js";

export type Column = GeneratedTable["columns"][number];

export const eligibleTables = getGeneratedCrudTables().filter((table) => table.source?.graphql);
export const tables = eligibleTables.filter((table) =>
  (["list", "get", "create", "update", "delete"] as const).every((operation) =>
    isGeneratedCrudOperationEnabled(table, operation),
  ),
);
export const partialPolicyTables = eligibleTables.filter((table) => !tables.includes(table));
export const tablesByTypeName = new Map(
  tables.map((table) => [table.source!.graphql!.typeName, table]),
);
export const tablesByName = new Map(tables.map((table) => [table.name, table]));

export function fieldName(column: Column): string {
  return (
    column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
  );
}

/**
 * Delegates to the engine's own predicate rather than restating it, so the
 * suite cannot drift from the API. `create` is the right default here: the
 * factory's job is building rows, and a column authored `immutable` is settable
 * exactly then (#177). Tests that build an update body ask for "update".
 */
export function isMutableColumn(
  column: Column,
  operation: "create" | "update" = "create",
): boolean {
  return isWritableColumn(column, operation);
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
// columns (cases.code, chips.key, the idempotency keys). A constant marker
// made the SECOND row of such an entity in the same tenant a duplicate-key
// error, which surfaced as hundreds of unrelated failures the first time the
// suite ran against the full catalog in CI.
let rowSequence = 0;

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
  const graphql = table.source!.graphql!;
  const fkTargets = foreignKeyTargets(table);
  const input: Record<string, unknown> = {};
  const marker = `${seed}-${++rowSequence}`;

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
        const targetTable = tablesByName.get(fkTarget);
        if (!targetTable) {
          throw new Error(
            `Required FK ${table.name}.${column.name} targets unknown table ${fkTarget}`,
          );
        }
        input[field] = await createRow(targetTable, identity, {}, depth + 1);
      }
      continue; // optional FKs stay unset unless overridden
    }
    if (column.required) {
      input[field] = sampleValue(column, marker);
    }
  }

  const data = await expectData(
    identity,
    `mutation($input: Create${graphql.typeName}Input!) {
       ${graphql.createMutationName}(input: $input) { id }
     }`,
    { input },
  );
  const id = data[graphql.createMutationName]?.id as string;
  expect(id).toBeTruthy();
  createdRows.push({ table, id, identity });
  return id;
}

/** Stop tracking a row the test already deleted itself. */
export function untrackRow(id: string) {
  const index = createdRows.findIndex((row) => row.id === id);
  if (index >= 0) {
    createdRows.splice(index, 1);
  }
}

export function textColumnFor(
  table: GeneratedTable,
  preferredField?: string,
): Column | undefined {
  // "update": callers plant a value at create and then change it, so the
  // column has to be writable in both directions.
  const mutableText = table.columns.filter(
    (column) => isMutableColumn(column, "update") && column.type === "text",
  );
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
    (column) => isMutableColumn(column, "update") && column.type === "text" && !column.required,
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
