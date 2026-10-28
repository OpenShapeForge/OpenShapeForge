import { filterFieldNames } from "./filter-groups.js";
// SPDX-License-Identifier: BUSL-1.1
import { generatedCrudTables, isGeneratedCrudTableEligible } from "./table-registry.js";
export { getGeneratedCrudTables, isGeneratedCrudTableEligible, recordActionTable } from "./table-registry.js";
import { operationFailure } from "@openshapeforge/operations";
import { notAuthorizedRefusal } from "./authorization-refusal-text.js";
import { assertEntityAdmitsPrincipal } from "./principal-classes.js";
import { redactElicitedValues } from "../../connectors/secrets.js";
import type { DbSessionInput } from "../../db/session.js";
import {
  classifyDatabaseError,
  type DatabaseErrorTableContext,
} from "../../db/database-refusals.js";
import {
  assertClassifiedQueryFieldsAllowed,
  redactRow,
} from "../../graphql/generated-authz.js";
import { fieldNameForColumn, tableColumnMap } from "./columns.js";
import { normalizeEntityStorageRow } from "./serialize-result.js";
import { entityValueCarriers, projectEntityValueRow } from "./entity-value-io.js";
import { assertStoredTypedValuesSupported, projectTypedValues } from "./typed-values.js";
import { projectVisibleFieldBindings } from "./field-binding-policy.js";
import { withoutHiddenColumns } from "./subtype-scope.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import type {
  GeneratedCrudColumn,
  GeneratedCrudExposureOperation,
  GeneratedCrudOperation,
  GeneratedCrudTable,
  GeneratedEntityRow,
  ListPageInput,
} from "./types.js";

/**
 * Whether every row of `table` is its own tenant: the compiler stamps
 * CHECK (id = tenant_id) on a tenant registry (packages/compiler/src/
 * tenant-bound-references.ts, `hasTenantIdentityCheck`), and this reads the
 * same mark back from the manifest, with the same whitespace normalisation.
 * Such a row has one write path, provisioning; nothing creates a second.
 */
export function isTenantRegistryTable(table: GeneratedCrudTable): boolean {
  return (table.constraints ?? []).some(
    (constraint) =>
      constraint.kind === "check" &&
      constraint.expression?.replace(/\s+/g, " ").trim() === "id = tenant_id",
  );
}

export function isGeneratedCrudOperationEnabled(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
): boolean {
  return (
    isGeneratedCrudTableEligible(table) &&
    table.source?.crud?.operations?.[operation] === true
  );
}


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
    // A CRUD-eligible table without role metadata means the manifest predates
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
    throw operationFailure(notAuthorizedRefusal(table, operation));
  }
  // After the roles, never instead of them: the entity's principal-class
  // policy narrows who may use the generic routes at all. This is the one
  // gate every generated CRUD call passes — the GraphQL resolvers, the REST
  // routes, the MCP write guard, the change stream and the Operation-backed
  // reads the derived application search executes — so declaring the policy
  // on the entity covers every one of them.
  assertEntityAdmitsPrincipal(table, session);
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
  entityValues = generatedEntityValues,
): GeneratedEntityRow[] {
  const hasClassification = table.columns.some(
    (column) => column.classification || column.fieldPolicy,
  );
  const hasElicitedOutput =
    table.source?.secureInputOnCreate !== undefined ||
    table.source?.mcp?.elicitOnCreate !== undefined;
  const hasBigint = table.columns.some((column) => column.type === "bigint");
  const hasTypedValue = table.columns.some((column) => column.typedBy);
  const hasBindings = table.columns.some((column) => column.fieldBindings);
  const hasHidden = (table.subtype?.hiddenColumns.length ?? 0) > 0;
  if (!hasClassification && !hasElicitedOutput && !hasBigint && !hasTypedValue && !hasBindings && !hasHidden && !entityValueCarriers(table, entityValues).length) {
    return rows;
  }
  return rows.map((row) => projectGeneratedEntityRow(table, session, row, entityValues));
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
  entityValues = generatedEntityValues,
): GeneratedEntityRow {
  // A subtype's hidden columns leave first: nothing below, redaction
  // included, may hand them to a reader of this projection.
  const normalized = projectTypedValues(table, normalizeEntityStorageRow(table, projectEntityValueRow(table, withoutHiddenColumns(table, row), entityValues)));
  const classified = redactRow(
    normalized,
    table.columns,
    table.source?.authorization,
    session,
  );
  // A value typed by a stored FieldDefinition is carried by one json column,
  // so the column-shaped redaction above cannot reach inside it. Whether this
  // runtime can protect that definition at all is therefore decided here, on
  // the one projection every read goes through — including the binding
  // runtime's own source reads.
  assertStoredTypedValuesSupported(table, classified);
  const column = elicitedOutputColumn(table);
  const output = column
    ? redactElicitedValues(classified, column.name)
    : classified;
  return projectVisibleFieldBindings(table, session, output);
}

/** Elicited values cannot be used as list membership or ordering oracles. */
export function assertElicitedQueryAllowed(
  table: GeneratedCrudTable,
  input: Pick<ListPageInput, "filter" | "sort">,
  exactFilterFields = false,
): void {
  const columns = [elicitedOutputColumn(table), ...table.columns.filter(column => column.typedBy?.encrypted)].filter((column): column is GeneratedCrudColumn => !!column);
  for (const column of columns) {
  const field = fieldNameForColumn(column);
  const filtered = filterFieldNames(input.filter).some(
    (candidate) => candidate === field || (!exactFilterFields && candidate === `${field}In`),
  );
  if (filtered || input.sort?.field === field) {
    throw generatedCrudError(
      "Filtering or sorting by an elicited-output field is not permitted.",
      "FORBIDDEN",
    );
  }
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
  exactFilterFields = false,
): void {
  assertClassifiedQueryFieldsAllowed(
    table.columns,
    table.source?.authorization,
    session,
    entityLabel(table),
    input.filter,
    input.sort,
    exactFilterFields,
  );
}

export function isGeneratedCrudTableReadable(name: string) {
  const table = generatedCrudTables.get(name);
  return table !== undefined && (
    isGeneratedCrudOperationEnabled(table, "list") ||
    isGeneratedCrudOperationEnabled(table, "get")
  );
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
