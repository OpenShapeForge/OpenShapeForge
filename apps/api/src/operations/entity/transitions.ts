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
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import type { ModuleOperationAvailabilityHandler, ModuleOperationHandler } from "../../modules/contract.js";
import { sessionRelation } from "../../auth/identity-link.js";
import { generatedCrudError, getGeneratedCrudTables } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { updateGeneratedEntityForTable } from "./mutations.js";
import { assertRecordPermissionInTransaction } from "./record-permissions.js";
import { serializeEntityRow } from "./serialize-result.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

export const TRANSITIONS_PLUGIN = "osf-transitions";

type TransitionStatus = NonNullable<NonNullable<GeneratedCrudTable["source"]>["transitions"]>[number];
type TransitionRule = TransitionStatus["rules"][number];

/** A write the rule constrains: the referenced record must equal this one on the paired columns. */
export type TransitionAgreement = {
  field: string;
  column: GeneratedCrudColumn;
  target: GeneratedCrudTable;
  pairs: Array<{ field: string; local: GeneratedCrudColumn; remote: GeneratedCrudColumn }>;
};

export type TransitionBinding = {
  table: GeneratedCrudTable;
  status: TransitionStatus;
  statusColumn: GeneratedCrudColumn;
  rule: TransitionRule;
  agreements: TransitionAgreement[];
};

function columnForField(table: GeneratedCrudTable, field: string): GeneratedCrudColumn {
  const column = table.columns.find((candidate) => fieldNameForColumn(candidate) === field);
  if (!column) {
    throw generatedCrudError(`Transition field "${field}" has no column on ${table.name}.`, "INTERNAL_SERVER_ERROR");
  }
  return column;
}

/**
 * Bind every `agreesOn` of the rule against the generated manifest: the
 * written column must be a single reference whose target entity carries each
 * named field. The compiler sees one entity at a time, so this is where a
 * field the target does not have is refused — at boot, not on the first call.
 */
function agreementBindings(table: GeneratedCrudTable, rule: TransitionRule): TransitionAgreement[] {
  const tables = getGeneratedCrudTables();
  return (rule.writes ?? []).filter((write) => write.agreesOn?.length).map((write) => {
    const relationship = table.source?.graphql?.relationships?.find((candidate) => candidate.fieldKey === write.field && candidate.resolve === "belongsTo");
    const target = relationship && tables.find((candidate) => candidate.source?.graphql?.typeName === relationship.target);
    if (!target) throw new Error(`Transition ${rule.operation} constrains "${write.field}" with agreesOn, but it is not a reference to a generated entity.`);
    const pairs = write.agreesOn!.map((field) => {
      const remote = target.columns.find((candidate) => fieldNameForColumn(candidate) === field);
      if (!remote) throw new Error(`Transition ${rule.operation} agreesOn "${field}", which ${target.source?.authoringEntityName ?? target.name} does not have.`);
      return { field, local: columnForField(table, field), remote };
    });
    return { field: write.field, column: columnForField(table, write.field), target, pairs };
  });
}

/** Resolve the rule an Operation key stands for; a key no manifest rule answers to is a build defect. */
export function transitionBinding(operation: { key: string; target?: { entityName: string } }): TransitionBinding {
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === operation.target?.entityName,
  );
  for (const status of table?.source?.transitions ?? []) {
    const rule = status.rules.find((candidate) => candidate.operation === operation.key);
    if (rule) return { table: table!, status, statusColumn: columnForField(table!, status.field), rule, agreements: agreementBindings(table!, rule) };
  }
  throw new Error(`Operation "${operation.key}" is not a status transition of a generated entity.`);
}

/** Strictly nullish: a stored empty string is a present value, as the contract says. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
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

/**
 * Server-derived values the rule stamps: the transaction time, or the actor —
 * the session's linked Relation where the field references one, the user id
 * where it is a string. Neither is ever read from the input.
 */
function stampValues(binding: TransitionBinding, session: DbSessionInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const stamp of binding.rule.stamps ?? []) {
    if (stamp.value === "now") {
      values[stamp.field] = sql`now()`;
      continue;
    }
    if (stamp.actor === "relation") {
      const relation = sessionRelation(session as Parameters<typeof sessionRelation>[0]);
      if (!relation) {
        throw operationFailure({
          code: "FORBIDDEN",
          message: `${binding.rule.key} records the acting Relation, and this session is not linked to one.`,
          retryable: false,
        });
      }
      values[stamp.field] = relation.relationId;
      continue;
    }
    values[stamp.field] = session.userId;
  }
  return values;
}

function validation(field: string, message: string): never {
  throw operationFailure({ code: "VALIDATION", message, retryable: false, violations: [{ field, code: "INVALID_VALUE", message }] });
}

/**
 * The caller's writes: a required one must be present, and a constrained
 * reference must name a record of this tenant that agrees with the current
 * row on every paired field — read under a share lock so it cannot change
 * under the transition.
 */
async function writtenValues(
  trx: Transaction<DB>,
  session: DbSessionInput,
  binding: TransitionBinding,
  current: Readonly<GeneratedEntityRow>,
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const write of binding.rule.writes ?? []) {
    const value = input[write.field];
    if (value === undefined || value === null) {
      if (write.required) validation(write.field, `${binding.rule.key} requires ${write.field}.`);
      continue;
    }
    values[write.field] = value;
  }
  for (const agreement of binding.agreements) {
    const id = values[agreement.field];
    if (id === undefined) continue;
    const entity = agreement.target.source?.authoringEntityName ?? agreement.target.name;
    const tenantWhere = agreement.target.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid` : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      select to_jsonb(${sql.id(agreement.target.table)}.*) as row
      from ${sql.id(agreement.target.schema, agreement.target.table)}
      where ${sql.id(agreement.target.primaryKey!)}::text = ${String(id)} ${tenantWhere}
      for share
    `.execute(trx);
    const remote = result.rows[0]?.row;
    if (!remote) validation(agreement.field, `${agreement.field} names no ${entity} in this tenant.`);
    for (const pair of agreement.pairs) {
      if (String(remote[pair.remote.name] ?? "") !== String(current[pair.local.name] ?? "")) {
        validation(agreement.field, `${agreement.field} must name ${entity} that agrees with this ${binding.table.source?.authoringEntityName ?? binding.table.name} on ${pair.field}.`);
      }
    }
  }
  return values;
}

/**
 * Execute one rule: lock the row, check the record permission the rule
 * carries, recheck the decision, write `to`, the caller's `writes` and the
 * server's `stamps`, journal the update.
 */
export async function executeTransition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  binding: TransitionBinding,
  input: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const id = typeof input.id === "string" ? input.id : "";
  return withDbSession(db, session, async (trx) => {
    if (binding.rule.recordPermission) {
      await assertRecordPermissionInTransaction(trx, session, binding.table, id, binding.rule.recordPermission);
    }
    const current = (await lockedRows(trx, session, binding.table, [id], true)).get(id);
    if (!current) throw operationFailure({ code: "NOT_FOUND", message: "Resource not found.", retryable: false });
    const refusal = transitionRefusal(binding, current);
    if (refusal) throw operationFailure(refusal);
    const values: Record<string, unknown> = {
      [binding.status.field]: binding.rule.to,
      ...(await writtenValues(trx, session, binding, current, input)),
      ...stampValues(binding, session),
    };
    const row = await updateGeneratedEntityForTable(db, session, binding.table, id, values);
    if (!row) throw operationFailure({ code: "NOT_FOUND", message: "Resource not found.", retryable: false });
    return serializeEntityRow(binding.table, row);
  });
}

export function transitionOperationHandler(
  operation: { key: string; target?: { entityName: string } },
): ModuleOperationHandler {
  const binding = transitionBinding(operation);
  return async (raw, context) => {
    if (!context.db || !context.session) {
      throw generatedCrudError("Authenticated database session required.", "FORBIDDEN");
    }
    const value = await executeTransition(context.db, context.session, binding, raw as Record<string, unknown>);
    return { value, status: 200 };
  };
}
