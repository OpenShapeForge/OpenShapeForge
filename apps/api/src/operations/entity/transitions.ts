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

/** A precondition that reads a field of the record named by `via`. */
export type TransitionReferencedPrecondition = {
  via: string;
  viaColumn: GeneratedCrudColumn;
  field: string;
  fieldColumn: GeneratedCrudColumn;
  target: GeneratedCrudTable;
  present?: boolean;
  in?: Array<string | number | boolean>;
};

export type TransitionBinding = {
  table: GeneratedCrudTable;
  status: TransitionStatus;
  statusColumn: GeneratedCrudColumn;
  rule: TransitionRule;
  agreements: TransitionAgreement[];
  referenced: TransitionReferencedPrecondition[];
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
      const local = columnForField(table, field);
      const remote = target.columns.find((candidate) => fieldNameForColumn(candidate) === field);
      if (!remote) throw new Error(`Transition ${rule.operation} agreesOn "${field}", which ${target.source?.authoringEntityName ?? target.name} does not have.`);
      // The comparison is issued in SQL between the two columns, so they must
      // be of one type: a text against a uuid, or a numeric against an
      // integer, is a build defect, not a runtime coercion.
      if (local.type !== remote.type) {
        throw new Error(`Transition ${rule.operation} agreesOn "${field}", but ${table.name}.${local.name} is ${local.type} and ${target.name}.${remote.name} is ${remote.type}.`);
      }
      return { field, local, remote };
    });
    return { field: write.field, column: columnForField(table, write.field), target, pairs };
  });
}

/**
 * Bind every referenced precondition against the generated manifest: `via`
 * must be a single reference whose target entity carries `field`. The
 * compiler sees one entity at a time, so a field the target does not have
 * is refused here at boot.
 */
function referencedBindings(table: GeneratedCrudTable, rule: TransitionRule): TransitionReferencedPrecondition[] {
  const tables = getGeneratedCrudTables();
  return (rule.preconditions ?? []).filter((precondition) => precondition.via).map((precondition) => {
    const via = precondition.via!;
    const relationship = table.source?.graphql?.relationships?.find((candidate) => candidate.fieldKey === via && candidate.resolve === "belongsTo");
    const target = relationship && tables.find((candidate) => candidate.source?.graphql?.typeName === relationship.target);
    if (!target) throw new Error(`Transition ${rule.operation} precondition via "${via}" is not a reference to a generated entity.`);
    const fieldColumn = target.columns.find((candidate) => fieldNameForColumn(candidate) === precondition.field);
    if (!fieldColumn) {
      throw new Error(`Transition ${rule.operation} precondition "${via}.${precondition.field}", which ${target.source?.authoringEntityName ?? target.name} does not have.`);
    }
    return {
      via,
      viaColumn: columnForField(table, via),
      field: precondition.field,
      fieldColumn,
      target,
      ...(precondition.present !== undefined ? { present: precondition.present } : {}),
      ...(precondition.in ? { in: [...precondition.in] } : {}),
    };
  });
}

/** Resolve the rule an Operation key stands for; a key no manifest rule answers to is a build defect. */
export function transitionBinding(operation: { key: string; target?: { entityName: string } }): TransitionBinding {
  const table = getGeneratedCrudTables().find(
    (candidate) => candidate.source?.authoringEntityName === operation.target?.entityName,
  );
  for (const status of table?.source?.transitions ?? []) {
    const rule = status.rules.find((candidate) => candidate.operation === operation.key);
    if (rule) {
      return {
        table: table!,
        status,
        statusColumn: columnForField(table!, status.field),
        rule,
        agreements: agreementBindings(table!, rule),
        referenced: referencedBindings(table!, rule),
      };
    }
  }
  throw new Error(`Operation "${operation.key}" is not a status transition of a generated entity.`);
}

/** The record a `via` names, plus SQL-evaluated `in` membership per field. */
export type TransitionReferencedRow = {
  row: GeneratedEntityRow;
  inHolds: ReadonlyMap<string, boolean>;
};

/** Strictly nullish: a stored empty string is a present value, as the contract says. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Authored `in` value as a typed SQL literal of the column's type. */
function typedInLiteral(column: GeneratedCrudColumn, value: string | number | boolean) {
  return sql`cast(${String(value)} as ${sql.raw(column.type)})`;
}

/**
 * `in` membership the way `agreesOn` compares: one expression, typed literals,
 * `IS NOT DISTINCT FROM` against `= ANY` of the authored set.
 */
function inHoldsSql(alias: string, column: GeneratedCrudColumn, values: readonly (string | number | boolean)[]) {
  return sql`exists (
    select 1 from unnest(array[${sql.join(values.map((value) => typedInLiteral(column, value)))}]) as allowed(value)
    where ${sql.id(alias, column.name)} is not distinct from allowed.value
  )`;
}

function invalidState(message: string): OperationError {
  return { code: "INVALID_STATE", message, retryable: false };
}

/**
 * Why the rule cannot fire on this row, or undefined when it can. The same
 * decision serves the offer list and the execution, so what a caller is
 * shown is what the write checks. `referenced` is the record each `via`
 * names in this tenant; a missing entry is a refusal, never a skip. `in`
 * membership is the SQL result, not a JavaScript `===` against `to_jsonb`.
 */
export function transitionRefusal(
  binding: TransitionBinding,
  row: Readonly<GeneratedEntityRow>,
  referenced: ReadonlyMap<string, TransitionReferencedRow | undefined> = new Map(),
): OperationError | undefined {
  const entity = binding.table.source?.authoringEntityName ?? binding.table.name;
  const current = row[binding.statusColumn.name];
  if (!binding.rule.from.includes(String(current))) {
    return invalidState(
      `${entity} is ${String(current)}; ${binding.rule.key} moves ${binding.status.field} from ${binding.rule.from.join(" or ")} to ${binding.rule.to}.`,
    );
  }
  for (const precondition of binding.rule.preconditions ?? []) {
    if (precondition.via) continue;
    const column = columnForField(binding.table, precondition.field);
    if (precondition.present !== undefined && present(row[column.name]) !== precondition.present) {
      return invalidState(`${binding.rule.key} requires ${precondition.field} to be ${precondition.present ? "set" : "empty"}.`);
    }
  }
  for (const precondition of binding.referenced) {
    const remote = referenced.get(precondition.via);
    const named = `${precondition.via}.${precondition.field}`;
    if (!remote) {
      const target = precondition.target.source?.authoringEntityName ?? precondition.target.name;
      return invalidState(`${binding.rule.key} requires ${named} on a ${target} in this tenant.`);
    }
    const value = remote.row[precondition.fieldColumn.name];
    if (precondition.present !== undefined && present(value) !== precondition.present) {
      return invalidState(`${binding.rule.key} requires ${named} to be ${precondition.present ? "set" : "empty"}.`);
    }
    if (precondition.in && remote.inHolds.get(precondition.field) !== true) {
      return invalidState(`${binding.rule.key} requires ${named} to be one of ${precondition.in.join(", ")}.`);
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

type ReferencedFetchRow = { id: string; row: GeneratedEntityRow } & Record<string, unknown>;

/** One read of a target table: the rows, and `in` membership against the typed column. */
async function fetchReferenced(
  trx: Transaction<DB>,
  session: DbSessionInput,
  target: GeneratedCrudTable,
  ids: readonly string[],
  inChecks: readonly TransitionReferencedPrecondition[],
  lock: boolean,
): Promise<Map<string, TransitionReferencedRow>> {
  if (ids.length === 0) return new Map();
  const tenantWhere = target.tenantScoped
    ? sql`and ${sql.id("remote", "tenant_id")} = ${session.tenantId}::uuid`
    : sql``;
  const inSelects = inChecks.map((precondition, index) =>
    sql`${inHoldsSql("remote", precondition.fieldColumn, precondition.in!)} as ${sql.raw(`in_${index}`)}`,
  );
  const result = await sql<ReferencedFetchRow>`
    select ${sql.id("remote", target.primaryKey!)}::text as id, to_jsonb(remote.*) as row
      ${inSelects.length ? sql`, ${sql.join(inSelects)}` : sql``}
    from ${sql.id(target.schema, target.table)} as remote
    where ${sql.id("remote", target.primaryKey!)}::text in (${sql.join([...ids])})
      ${tenantWhere}
    ${lock ? sql`for share of remote` : sql``}
  `.execute(trx);
  return new Map(result.rows.map((entry) => {
    const inHolds = new Map<string, boolean>();
    inChecks.forEach((precondition, index) => {
      inHolds.set(precondition.field, entry[`in_${index}`] === true);
    });
    return [entry.id, { row: entry.row, inHolds }];
  }));
}

async function referencedRecords(
  trx: Transaction<DB>,
  session: DbSessionInput,
  binding: TransitionBinding,
  row: Readonly<GeneratedEntityRow>,
  lock: boolean,
): Promise<Map<string, TransitionReferencedRow | undefined>> {
  const found = new Map<string, TransitionReferencedRow | undefined>();
  for (const precondition of binding.referenced) {
    if (found.has(precondition.via)) continue;
    const viaValue = row[precondition.viaColumn.name];
    if (!present(viaValue)) {
      found.set(precondition.via, undefined);
      continue;
    }
    const inChecks = binding.referenced.filter((candidate) => candidate.via === precondition.via && candidate.in?.length);
    const fetched = await fetchReferenced(trx, session, precondition.target, [String(viaValue)], inChecks, lock);
    found.set(precondition.via, fetched.get(String(viaValue)));
  }
  return found;
}

/** Offer policy: a rule is offered only while the row's status is in `from` and its preconditions hold. */
export function transitionAvailabilityHandler(
  operation: { key: string; target?: { entityName: string } },
): ModuleOperationAvailabilityHandler {
  const binding = transitionBinding(operation);
  return async (targetIds, context) => {
    const rows = await lockedRows(context.db, context.session, binding.table, targetIds, false);
    const decisions: Array<[string, { available: true } | { available: false; error: OperationError }]> = [];
    for (const id of targetIds) {
      const row = rows.get(id);
      if (!row) {
        decisions.push([id, { available: false, error: { code: "NOT_FOUND", message: "Resource not found.", retryable: false } }]);
        continue;
      }
      const referenced = await referencedRecords(context.db, context.session, binding, row, false);
      const error = transitionRefusal(binding, row, referenced);
      decisions.push([id, error ? { available: false, error } : { available: true }]);
    }
    return Object.fromEntries(decisions);
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
 * row on every paired field. The comparison is the database's, column
 * against column with IS NOT DISTINCT FROM in the query that share-locks the
 * referenced record — typed, exact, and null-aware (a null on either side
 * disagrees with everything but null) — never a JavaScript coercion.
 */
async function writtenValues(
  trx: Transaction<DB>,
  session: DbSessionInput,
  binding: TransitionBinding,
  id: string,
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
    const referenced = values[agreement.field];
    if (referenced === undefined) continue;
    const entity = agreement.target.source?.authoringEntityName ?? agreement.target.name;
    const tenantWhere = agreement.target.tenantScoped ? sql`and ${sql.id("remote", "tenant_id")} = ${session.tenantId}::uuid` : sql``;
    const result = await sql<{ disagrees: string | null }>`
      select coalesce(${sql.join(agreement.pairs.map((pair) =>
        sql`case when ${sql.id("remote", pair.remote.name)} is distinct from ${sql.id("local", pair.local.name)} then ${pair.field}::text end`))}) as disagrees
      from ${sql.id(agreement.target.schema, agreement.target.table)} as remote,
           ${sql.id(binding.table.schema, binding.table.table)} as local
      where ${sql.id("remote", agreement.target.primaryKey!)}::text = ${String(referenced)} ${tenantWhere}
        and ${sql.id("local", binding.table.primaryKey!)}::text = ${id}
      for share of remote
    `.execute(trx);
    if (result.rows.length === 0) validation(agreement.field, `${agreement.field} names no ${entity} in this tenant.`);
    const disagrees = result.rows[0]!.disagrees;
    if (disagrees !== null) {
      validation(agreement.field, `${agreement.field} must name ${entity} that agrees with this ${binding.table.source?.authoringEntityName ?? binding.table.name} on ${disagrees}.`);
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
    const referenced = await referencedRecords(trx, session, binding, current, true);
    const refusal = transitionRefusal(binding, current, referenced);
    if (refusal) throw operationFailure(refusal);
    const values: Record<string, unknown> = {
      [binding.status.field]: binding.rule.to,
      ...(await writtenValues(trx, session, binding, id, input)),
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
