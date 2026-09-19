// SPDX-License-Identifier: BUSL-1.1
/**
 * The one runtime behind every status transition Operation the compiler
 * lowers from a field's `transitions` block. There is no per-entity code: the
 * rule table travels in the generated manifest (`source.transitions`) and the
 * Operation's key names the rule. Authorization, version, lease and
 * confirmation controls are consumed by the guarded custom-Operation path
 * before this handler runs, inside the transaction it joins.
 */
import { sql, type Transaction } from "kysely";
import { operationFailure, type OperationError } from "@openshapeforge/operations";
import type { DB } from "../../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { ModuleOperationAvailabilityHandler, ModuleOperationHandler } from "../../modules/contract.js";
import { generatedCrudError, getGeneratedCrudTables } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { updateGeneratedEntityForTable } from "./mutations.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export const TRANSITIONS_PLUGIN = "osf-transitions";

type TransitionStatus = NonNullable<NonNullable<GeneratedCrudTable["source"]>["transitions"]>[number];
type TransitionRule = TransitionStatus["rules"][number];

export type TransitionBinding = {
  table: GeneratedCrudTable;
  status: TransitionStatus;
  statusColumn: GeneratedCrudColumn;
  rule: TransitionRule;
};

function columnForField(table: GeneratedCrudTable, field: string): GeneratedCrudColumn {
  const column = table.columns.find((candidate) => fieldNameForColumn(candidate) === field);
  if (!column) {
    throw generatedCrudError(`Transition field "${field}" has no column on ${table.name}.`, "INTERNAL_SERVER_ERROR");
  }
  return column;
}

/** Resolve the rule an Operation key stands for; a key no manifest rule answers to is a build defect. */
export function transitionBinding(operation: { key: string; target?: { entityName: string } }): TransitionBinding {
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === operation.target?.entityName,
  );
  for (const status of table?.source?.transitions ?? []) {
    const rule = status.rules.find((candidate) => candidate.operation === operation.key);
    if (rule) return { table: table!, status, statusColumn: columnForField(table!, status.field), rule };
  }
  throw new Error(`Operation "${operation.key}" is not a status transition of a generated entity.`);
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/**
 * Why the rule cannot fire on this row, or undefined when it can. The same
 * decision serves the offer list and the execution, so what a caller is
 * shown is what the write checks.
 */
export function transitionRefusal(binding: TransitionBinding, row: Readonly<GeneratedEntityRow>): OperationError | undefined {
  const entity = binding.table.source?.authoringEntityName ?? binding.table.name;
  const current = row[binding.statusColumn.name];
  if (!binding.rule.from.includes(String(current))) {
    return {
      code: "INVALID_STATE",
      message: `${entity} is ${String(current)}; ${binding.rule.key} moves ${binding.status.field} from ${binding.rule.from.join(" or ")} to ${binding.rule.to}.`,
      retryable: false,
    };
  }
  for (const precondition of binding.rule.preconditions ?? []) {
    const column = columnForField(binding.table, precondition.field);
    if (present(row[column.name]) !== precondition.present) {
      return {
        code: "INVALID_STATE",
        message: `${binding.rule.key} requires ${precondition.field} to be ${precondition.present ? "set" : "empty"}.`,
        retryable: false,
      };
    }
  }
  return undefined;
}

async function lockedRows(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  ids: readonly string[],
  lock: boolean,
): Promise<Map<string, GeneratedEntityRow>> {
  const tenantWhere = table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid` : sql``;
  const result = await sql<{ id: string; row: GeneratedEntityRow }>`
    select ${sql.id(table.primaryKey!)}::text as id, to_jsonb(${sql.id(table.table)}.*) as row
    from ${sql.id(table.schema, table.table)}
    where ${sql.id(table.primaryKey!)}::text in (${sql.join([...ids])})
      ${tenantWhere}
    ${lock ? sql`for update` : sql``}
  `.execute(trx);
  return new Map(result.rows.map(({ id, row }) => [id, row]));
}

/** Offer policy: a rule is offered only while the row's status is in `from` and its preconditions hold. */
export function transitionAvailabilityHandler(
  operation: { key: string; target?: { entityName: string } },
): ModuleOperationAvailabilityHandler {
  const binding = transitionBinding(operation);
  return async (targetIds, context) => {
    const rows = await lockedRows(context.db, context.session, binding.table, targetIds, false);
    return Object.fromEntries(targetIds.map((id) => {
      const row = rows.get(id);
      const error: OperationError | undefined = row
        ? transitionRefusal(binding, row)
        : { code: "NOT_FOUND", message: "Resource not found.", retryable: false };
      return [id, error ? { available: false as const, error } : { available: true as const }];
    }));
  };
}

/** Execute one rule: lock the row, recheck the decision, write `to` plus the rule's `writes`, journal the update. */
export function transitionOperationHandler(
  operation: { key: string; target?: { entityName: string } },
): ModuleOperationHandler {
  const binding = transitionBinding(operation);
  return async (raw, context) => {
    if (!context.db || !context.session) {
      throw generatedCrudError("Authenticated database session required.", "FORBIDDEN");
    }
    const db = context.db;
    const session = context.session;
    const input = raw as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id : "";
    const value = await withDbSession(db, session, async (trx) => {
      const current = (await lockedRows(trx, session, binding.table, [id], true)).get(id);
      if (!current) throw operationFailure({ code: "NOT_FOUND", message: "Resource not found.", retryable: false });
      const refusal = transitionRefusal(binding, current);
      if (refusal) throw operationFailure(refusal);
      const values: Record<string, unknown> = { [binding.status.field]: binding.rule.to };
      for (const field of binding.rule.writes ?? []) {
        if (input[field] !== undefined) values[field] = input[field];
      }
      const row = await updateGeneratedEntityForTable(db, session, binding.table, id, values);
      if (!row) throw operationFailure({ code: "NOT_FOUND", message: "Resource not found.", retryable: false });
      return serializeEntityRow(binding.table, row);
    });
    return { value, status: 200 };
  };
}
