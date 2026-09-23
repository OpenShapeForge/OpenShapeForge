// SPDX-License-Identifier: BUSL-1.1
import {
  elicitedOutputColumn,
  generatedCrudError,
  isElicitedOutputColumn,
  getGeneratedCrudTables,
} from "./catalog.js";
import { collectionManagedFields } from "./collection-policy.js";
import { fieldNameForColumn } from "./columns.js";
import { assertEntityValueInput, entityValuePhysicalColumns } from "./entity-value-io.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";
import { assertNoDerivedOnCreateValues } from "./derive-on-create.js";

/**
 * The single storage-writability rule shared by generated CRUD. Caller-facing
 * surfaces additionally apply isCallerWritableColumn so the secure
 * elicitation target remains server-owned.
 *
 * Two rules, deliberately not merged:
 *
 * - The **column-shaped** clauses are absolute. `id` (primary key), identity
 *   columns, `tenant_id`, `created_at` and `updated_at` are server-managed at
 *   create AND update. They cannot be folded into the authored flag below:
 *   `tenant_id` is injected by the manifest compiler and has no authoring field
 *   at all (no `sourceField`), so no YAML property could ever cover it, and the
 *   `_base.yaml` timestamps must stay unsettable on create, which an
 *   update-only flag does not achieve.
 * - The **authored** clause carries `immutable: true` from the field YAML. It
 *   bites on update only: the value is a caller's to set once and the server's
 *   to protect thereafter.
 *
 * Authored `readOnly` is NOT consulted here — in this vocabulary it selects a
 * display component over an input one (docs/mcp.md, #180).
 */
export function isWritableColumn(
  column: GeneratedCrudColumn,
  operation: "create" | "update",
) {
  return (
    !column.primaryKey &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at" &&
    column.deriveOnCreate === undefined &&
    !(operation === "update" && column.immutable === true)
  );
}

/**
 * Caller-facing transports must never accept the field populated by secure
 * create-time elicitation. Runtime-owned writes keep using isWritableColumn
 * directly because OAuth and configuration handoffs legitimately persist it.
 */
export function isCallerWritableColumn(
  table: GeneratedCrudTable,
  column: GeneratedCrudColumn,
  operation: "create" | "update",
) {
  return (
    isWritableColumn(column, operation) &&
    !isElicitedOutputColumn(table, column) &&
    !entityValuePhysicalColumns(table).has(column.name) &&
    !collectionManagedFields(table, getGeneratedCrudTables()).has(column.name) &&
    !isOperationWrittenColumn(column)
  );
}

/**
 * Authored `writtenBy: [...]`: the column records that a process took place —
 * a finding reviewed, a scope approved, a retest concluded — and the named
 * operation is the one place the preconditions for saying so are checked.
 * `review_finding` refuses a reviewer who is the finding's own assignee; a
 * writable `reviewedAt` hands that check straight back to the caller, and the
 * four-eyes rule becomes decoration.
 *
 * Caller-facing only, exactly like the elicitation target above: the operations
 * themselves write through the runtime-owned path, which uses
 * isWritableColumn. Both create and update, because "reviewed" is no more
 * settable at insert than it is afterwards.
 */
export function isOperationWrittenColumn(column: GeneratedCrudColumn): boolean {
  return column.writtenBy !== undefined && column.writtenBy.length > 0;
}

/** The refusal, phrased so the caller knows what to call instead. */
export function operationWrittenRefusal(
  field: string,
  writers: NonNullable<GeneratedCrudColumn["writtenBy"]>,
): string {
  const routes = writers
    .map((writer) =>
      writer.mcp
        ? `${writer.operation} (MCP tool ${writer.mcp}, REST ${writer.rest})`
        : `${writer.operation} (REST ${writer.rest})`,
    )
    .join("; ");
  return (
    `"${field}" records that a process took place and cannot be set through ` +
    `create or update. Use ${routes}, which checks what may be checked before ` +
    `writing it.`
  );
}

/**
 * Refuse a body that carries a `writtenBy` field. normalizeWritableValues would
 * otherwise drop it silently, and a silently dropped review reads as a review
 * that happened.
 */
export function assertNoOperationWrittenValues(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
): void {
  for (const column of table.columns) {
    if (!isOperationWrittenColumn(column)) continue;
    const field = fieldNameForColumn(column);
    if (
      !Object.prototype.hasOwnProperty.call(input, field) &&
      !Object.prototype.hasOwnProperty.call(input, column.name)
    ) {
      continue;
    }
    throw generatedCrudError(
      operationWrittenRefusal(field, column.writtenBy!),
      "BAD_USER_INPUT",
    );
  }
}

export function assertNoCallerElicitedOutput(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
): void {
  const column = elicitedOutputColumn(table);
  if (!column) return;
  const field = fieldNameForColumn(column);
  if (
    Object.prototype.hasOwnProperty.call(input, field) ||
    Object.prototype.hasOwnProperty.call(input, column.name)
  ) {
    throw generatedCrudError(
      "Securely collected values cannot be supplied through generated CRUD.",
      "BAD_USER_INPUT",
    );
  }
}

export function writableColumnMap(
  table: GeneratedCrudTable,
  operation: "create" | "update",
) {
  return new Map(
    table.columns
      .filter((column) => isWritableColumn(column, operation))
      .map((column) => [fieldNameForColumn(column), column]),
  );
}

export function normalizeWritableValues(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
  operation: "create" | "update",
  entityValues = generatedEntityValues,
) {
  assertNoDerivedOnCreateValues(table, input);
  assertEntityValueInput(table, input, operation, entityValues);
  const writable = writableColumnMap(table, operation);
  const values = new Map<GeneratedCrudColumn, unknown>();
  for (const [field, value] of Object.entries(input)) {
    if (field === "id") {
      continue;
    }
    const column = writable.get(field);
    if (!column || value === undefined) {
      continue;
    }
    values.set(column, value);
  }
  return values;
}

/**
 * Add values which the canonical Operation, not its caller, owns. The
 * compiler must have named that same Operation in the column's `writtenBy`
 * contract; stale or forged runtime metadata therefore fails closed.
 */
export function addTrustedOperationValues(
  table: GeneratedCrudTable,
  values: ReturnType<typeof normalizeWritableValues>,
  operation: string,
  trusted: Readonly<Record<string, unknown>>,
) {
  for (const [field, value] of Object.entries(trusted)) {
    const column = table.columns.find((candidate) => fieldNameForColumn(candidate) === field);
    if (!column?.writtenBy?.some((writer) => writer.operation === operation)) {
      throw generatedCrudError(
        `Canonical Operation ${operation} cannot stamp ${field}; generated writer metadata is missing.`,
        "INTERNAL_SERVER_ERROR",
      );
    }
    values.set(column, value);
  }
  return values;
}
