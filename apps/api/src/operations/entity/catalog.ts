// SPDX-License-Identifier: BUSL-1.1
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import { operationFailure } from "@openshapeforge/operations";
import { redactElicitedValues } from "../../connectors/secrets.js";
import type { DbSessionInput } from "../../db/session.js";
import {
  classifyDatabaseError,
  type DatabaseErrorTableContext,
} from "../../db/database-refusals.js";
import { appendScopedEntityEventInTransaction } from "../../platform/entity-events.js";
import {
  assertClassifiedQueryFieldsAllowed,
  redactRow,
} from "../../graphql/generated-authz.js";
import { fieldNameForColumn, tableColumnMap } from "./columns.js";
import { normalizeEntityStorageRow } from "./serialize-result.js";
import type {
  GeneratedCrudColumn,
  GeneratedCrudExposureOperation,
  GeneratedCrudOperation,
  GeneratedCrudTable,
  GeneratedEntityRow,
  ListPageInput,
} from "./types.js";

export function isGeneratedCrudTableEligible(table: GeneratedCrudTable): boolean {
  if (table.domainInternal) return false;
  return table.generatedCrudEligible === undefined
    ? table.generatedCrud === true
    : table.generatedCrudEligible === true;
}

export function isGeneratedCrudOperationEnabled(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
): boolean {
  if (table.source?.crud !== undefined) {
    return table.source.crud.operations?.[operation] === true;
  }
  return table.generatedCrud === true;
}

const generatedCrudTables = new Map(
  (manifest.tables as GeneratedCrudTable[])
    .filter((table) => isGeneratedCrudTableEligible(table) && table.primaryKey)
    .map((table) => [table.name, table]),
);

// Precomputed per-table, per-operation role allow-sets from the manifest's
// source.authorization block. Membership checks are exact case-sensitive
// string matches — the compiler already emitted both the authored (Dutch)
// and Keycloak-normalized (English) spellings of every role.
const entityRoleSets = new Map<string, Partial<Record<GeneratedCrudOperation, ReadonlySet<string>>>>(
  [...generatedCrudTables.values()].map((table) => [
    table.name,
    Object.fromEntries(
      Object.entries(table.source?.authorization?.roles ?? {}).map(
        ([operation, roles]) => [operation, new Set(roles)],
      ),
    ) as Partial<Record<GeneratedCrudOperation, ReadonlySet<string>>>,
  ]),
);

const AUTHORIZATION_OPERATION: Record<GeneratedCrudExposureOperation, GeneratedCrudOperation> = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  delete: "delete",
};

/**
 * Fail-closed entity-level role gate, shared by every generated CRUD entry
 * point and therefore by both the GraphQL resolvers and the REST routes.
 * Runs before withDbSession — a forbidden operation opens no transaction and
 * journals no entity events. The error message deliberately names only the
 * entity and operation, never the allowed role list (no role enumeration).
 */
export function requireEntityOperation(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
  session: DbSessionInput,
): void {
  if (!isGeneratedCrudOperationEnabled(table, operation)) {
    throw operationFailure({
      code: "GENERATED_CRUD_OPERATION_NOT_ENABLED",
      message: `Generated CRUD operation ${operation} is not enabled for ${table.source?.authoringEntityName ?? table.name}.`,
    });
  }
  const authorizationOperation = AUTHORIZATION_OPERATION[operation];
  const allowed = entityRoleSets.get(table.name)?.[authorizationOperation];
  if (!allowed || allowed.size === 0) {
    // A generatedCrud table without role metadata means the manifest predates
    // the authorization bridge (stale artifacts) — deny with distinct wording
    // so operators recognize the regeneration bug instead of a policy denial.
    throw operationFailure({
      code: "FORBIDDEN",
      message:
        `Entity ${table.name} has no role metadata for ${authorizationOperation}; access denied. ` +
        `Regenerate artifacts with \`bun run generate\`.`,
    });
  }
  const sessionRoles = session.roles ?? [];
  if (!sessionRoles.some((role) => allowed.has(role))) {
    throw operationFailure({
      code: "FORBIDDEN",
      message: `Not authorized to ${operation} ${table.source?.authoringEntityName ?? table.name}.`,
    });
  }
}

/** Test-only direct handle on the guard (unit tests bypass the DB layer). */
export const __requireEntityOperationForTests = requireEntityOperation;

/**
 * Entity name used in authorization errors — the authored name when the
 * manifest carries one, never the physical table. Matches the wording
 * requireEntityOperation already produces.
 */
export function entityLabel(table: GeneratedCrudTable) {
  return table.source?.authoringEntityName ?? table.name;
}

/**
 * Field-level data protection (#96/#101), applied in the shared CRUD core
 * rather than per transport: every read reaches its rows through the functions
 * below, so GraphQL, the generated REST routes and any transport added later
 * inherit redaction by construction instead of having to remember it (#164).
 *
 * Classification and elicited-secret projection are composed here so every
 * generated CRUD return path has one output policy. A write grant can reveal
 * classified plain values, but encrypted elicited values always leave as the
 * existing set marker.
 */
export function projectRows(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  rows: GeneratedEntityRow[],
): GeneratedEntityRow[] {
  const hasClassification = table.columns.some(
    (column) => column.classification,
  );
  const hasElicitedOutput =
    table.source?.secureInputOnCreate !== undefined ||
    table.source?.mcp?.elicitOnCreate !== undefined;
  const hasBigint = table.columns.some((column) => column.type === "bigint");
  if (!hasClassification && !hasElicitedOutput && !hasBigint) {
    return rows;
  }
  return rows.map((row) => projectGeneratedEntityRow(table, session, row));
}

export function elicitedOutputColumn(
  table: GeneratedCrudTable,
): GeneratedCrudColumn | undefined {
  const target = table.source?.secureInputOnCreate?.into ??
    table.source?.mcp?.elicitOnCreate?.into;
  if (!target) return undefined;
  const column = table.columns.find(
    (candidate) => fieldNameForColumn(candidate) === target,
  );
  if (!column) {
    throw generatedCrudError(
      "Generated CRUD elicited-output metadata is invalid.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  return column;
}

export function isElicitedOutputColumn(
  table: GeneratedCrudTable,
  column: GeneratedCrudColumn,
): boolean {
  return elicitedOutputColumn(table)?.name === column.name;
}

export function projectGeneratedEntityRow(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  row: GeneratedEntityRow,
): GeneratedEntityRow {
  const normalized = normalizeEntityStorageRow(table, row);
  const classified = redactRow(
    normalized,
    table.columns,
    table.source?.authorization,
    session,
  );
  const column = elicitedOutputColumn(table);
  return column
    ? redactElicitedValues(classified, column.name)
    : classified;
}

/** Elicited values cannot be used as list membership or ordering oracles. */
export function assertElicitedQueryAllowed(
  table: GeneratedCrudTable,
  input: Pick<ListPageInput, "filter" | "sort">,
): void {
  const column = elicitedOutputColumn(table);
  if (!column) return;
  const field = fieldNameForColumn(column);
  const filtered = Object.keys(input.filter ?? {}).some(
    (candidate) => candidate === field || candidate === `${field}In`,
  );
  if (filtered || input.sort?.field === field) {
    throw generatedCrudError(
      "Filtering or sorting by an elicited-output field is not permitted.",
      "FORBIDDEN",
    );
  }
}

/** The oracle guard for caller-supplied list filters and ordering. */
export function assertClassifiedQueryAllowed(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  input: {
    filter?: Record<string, unknown> | null;
    sort?: { field?: string | null; direction?: string | null } | null;
  },
): void {
  assertClassifiedQueryFieldsAllowed(
    table.columns,
    table.source?.authorization,
    session,
    entityLabel(table),
    input.filter,
    input.sort,
  );
}

export function isGeneratedCrudTableReadable(name: string) {
  const table = generatedCrudTables.get(name);
  return table !== undefined && (
    isGeneratedCrudOperationEnabled(table, "list") ||
    isGeneratedCrudOperationEnabled(table, "get")
  );
}

export function getGeneratedCrudTables() {
  return [...generatedCrudTables.values()];
}

export function generatedCrudError(
  message: string,
  code: string,
  authored?: { detail?: string; hint?: string },
) {
  return operationFailure({
    code,
    message,
    ...(authored?.detail === undefined ? {} : { detail: authored.detail }),
    ...(authored?.hint === undefined ? {} : { data: { hint: authored.hint } }),
  });
}

/**
 * A database refusal on a generated write becomes an OperationFailure carrying
 * the public meaning, so every interface projects the same canonical error.
 * Anything the classifier declines stays the original driver error and is
 * redacted downstream exactly as before.
 */
export function translateDatabaseError(table: GeneratedCrudTable, error: unknown): unknown {
  const refusal = classifyDatabaseError(error, databaseErrorContext(table));
  return refusal
    ? generatedCrudError(refusal.message, refusal.code, {
        ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
        ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
      })
    : error;
}

function databaseErrorContext(table: GeneratedCrudTable): DatabaseErrorTableContext {
  const columns = tableColumnMap(table);
  const belongsTo = new Set<string>();
  for (const relationship of table.source?.graphql?.relationships ?? []) {
    if (relationship.resolve === "belongsTo" && relationship.foreignKey) {
      belongsTo.add(relationship.foreignKey);
    }
  }
  return {
    table: table.table,
    belongsTo,
    fieldName: (column) => {
      const known = columns.get(column);
      return known ? fieldNameForColumn(known) : undefined;
    },
  };
}

/**
 * Resolves a table by name AND enforces the entity role gate for the
 * requested operation. This is the only by-name table resolver, so every
 * public CRUD entry point is role-checked by construction.
 */
export function readGeneratedCrudTable(
  name: string,
  operation: GeneratedCrudExposureOperation,
  session: DbSessionInput,
) {
  const table = generatedCrudTables.get(name);
  if (!table || !table.primaryKey) {
    throw generatedCrudError(
      `Generated CRUD is not enabled for ${name}.`,
      "GENERATED_CRUD_NOT_ENABLED",
    );
  }
  requireEntityOperation(table, operation, session);
  return table;
}

function generatedCrudAggregateType(table: GeneratedCrudTable) {
  const aggregateType = table.source?.graphql?.singleQueryName?.trim();
  if (!aggregateType) {
    throw generatedCrudError(
      `Generated CRUD table ${table.name} is missing source.graphql.singleQueryName.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  return aggregateType;
}

export async function appendGeneratedCrudEvent(
  trx: Parameters<typeof appendScopedEntityEventInTransaction>[0],
  table: GeneratedCrudTable,
  input: {
    aggregateId: string;
    eventType: "created" | "updated" | "deleted";
  },
) {
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: generatedCrudAggregateType(table),
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: {
      table: table.name,
      schema: table.schema,
      operation: input.eventType,
    },
  });
}

export function generatedCrudAggregateId(table: GeneratedCrudTable, row: GeneratedEntityRow) {
  const id = row[table.primaryKey!];
  if (id === null || id === undefined || id === "") {
    throw generatedCrudError(
      `Generated CRUD event for ${table.name} is missing primary key ${table.primaryKey}.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  return String(id);
}
