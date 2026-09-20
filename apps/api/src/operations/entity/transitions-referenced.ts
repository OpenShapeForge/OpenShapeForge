// SPDX-License-Identifier: BUSL-1.1
/**
 * Fetching and batching of referenced transition preconditions. The handler
 * in transitions.ts decides; this module reads the records a `via` names
 * and evaluates `in` membership in SQL against the typed column.
 */
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";
import type { TransitionBinding, TransitionReferencedPrecondition } from "./transitions.js";

/**
 * Identity of one referenced `in` check. Two vias can read the same field of
 * one target with different sets; keying the SQL result by field name alone
 * would let the later set overwrite the earlier.
 */
export function referencedInHoldsKey(precondition: {
  via: string;
  field: string;
  in?: readonly (string | number | boolean)[];
}): string {
  return `${precondition.via}\0${precondition.field}\0${JSON.stringify(precondition.in ?? [])}`;
}

/** The record a `via` names, plus SQL-evaluated `in` membership per precondition. */
export type TransitionReferencedRow = {
  row: GeneratedEntityRow;
  inHolds: ReadonlyMap<string, boolean>;
};

/** Strictly nullish: a stored empty string is a present value, as the contract says. */
export function present(value: unknown): boolean {
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
    ${lock ? sql`order by ${sql.id("remote", target.primaryKey!)}::text for share of remote` : sql``}
  `.execute(trx);
  return new Map(result.rows.map((entry) => {
    const inHolds = new Map<string, boolean>();
    inChecks.forEach((precondition, index) => {
      inHolds.set(referencedInHoldsKey(precondition), entry[`in_${index}`] === true);
    });
    return [entry.id, { row: entry.row, inHolds }];
  }));
}

type LockParticipant = {
  schema: string;
  table: string;
  pk: string;
  mode: "update" | "share";
  target: GeneratedCrudTable;
};

function participantKey(schema: string, table: string, pk: string): string {
  return `${schema}.${table}\0${pk}`;
}

/** The via values this row would share-lock; a change after the exclusive lock means retry. */
export function referencedViaSignature(
  binding: TransitionBinding,
  row: Readonly<GeneratedEntityRow>,
): string {
  return binding.referenced
    .map((precondition) => {
      const value = row[precondition.viaColumn.name];
      return `${precondition.via}\0${present(value) ? String(value) : ""}`;
    })
    .join("\n");
}

/**
 * Local exclusive lock plus every referenced share-lock, in (schema, table, pk)
 * order. Two transitions over a cycle otherwise take opposite orders and
 * deadlock. A row that is both local and referenced takes the exclusive lock.
 */
export async function lockTransitionParticipants(
  trx: Transaction<DB>,
  session: DbSessionInput,
  binding: TransitionBinding,
  id: string,
  row: Readonly<GeneratedEntityRow>,
): Promise<void> {
  const byKey = new Map<string, LockParticipant>();
  const add = (item: LockParticipant) => {
    const key = participantKey(item.schema, item.table, item.pk);
    const existing = byKey.get(key);
    if (!existing || (item.mode === "update" && existing.mode !== "update")) byKey.set(key, item);
  };
  add({
    schema: binding.table.schema,
    table: binding.table.table,
    pk: id,
    mode: "update",
    target: binding.table,
  });
  for (const precondition of binding.referenced) {
    const viaValue = row[precondition.viaColumn.name];
    if (!present(viaValue) || !precondition.target.primaryKey) continue;
    add({
      schema: precondition.target.schema,
      table: precondition.target.table,
      pk: String(viaValue),
      mode: "share",
      target: precondition.target,
    });
  }
  const ordered = [...byKey.values()].sort(
    (left, right) =>
      left.schema.localeCompare(right.schema) ||
      left.table.localeCompare(right.table) ||
      left.pk.localeCompare(right.pk),
  );
  for (const item of ordered) {
    const tenantWhere = item.target.tenantScoped
      ? sql`and ${sql.id("target", "tenant_id")} = ${session.tenantId}::uuid`
      : sql``;
    const lock = item.mode === "update" ? sql`for update of target` : sql`for share of target`;
    await sql`
      select 1
      from ${sql.id(item.schema, item.table)} as target
      where ${sql.id("target", item.target.primaryKey!)}::text = ${item.pk}
        ${tenantWhere}
      ${lock}
    `.execute(trx);
  }
}

/** One row per via of this record. Execution share-locks first, then reads. */
export async function referencedRecords(
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

/**
 * Offer path: gather every `via` value across the page and read each target
 * table once. Execution locks participants in (table, pk) order, then reads.
 */
export async function referencedRecordsByRow(
  trx: Transaction<DB>,
  session: DbSessionInput,
  binding: TransitionBinding,
  rows: ReadonlyMap<string, GeneratedEntityRow>,
): Promise<Map<string, Map<string, TransitionReferencedRow | undefined>>> {
  const groups = new Map<string, { target: GeneratedCrudTable; vias: TransitionReferencedPrecondition[] }>();
  for (const precondition of binding.referenced) {
    const key = `${precondition.target.schema}.${precondition.target.table}`;
    const group = groups.get(key) ?? { target: precondition.target, vias: [] };
    group.vias.push(precondition);
    groups.set(key, group);
  }
  const fetched = new Map<string, Map<string, TransitionReferencedRow>>();
  for (const [key, group] of groups) {
    const ids = new Set<string>();
    for (const row of rows.values()) {
      for (const precondition of group.vias) {
        const viaValue = row[precondition.viaColumn.name];
        if (present(viaValue)) ids.add(String(viaValue));
      }
    }
    const inChecks = group.vias.filter((precondition) => precondition.in?.length);
    fetched.set(key, await fetchReferenced(trx, session, group.target, [...ids], inChecks, false));
  }
  const byRow = new Map<string, Map<string, TransitionReferencedRow | undefined>>();
  for (const [id, row] of rows) {
    const found = new Map<string, TransitionReferencedRow | undefined>();
    for (const precondition of binding.referenced) {
      if (found.has(precondition.via)) continue;
      const viaValue = row[precondition.viaColumn.name];
      if (!present(viaValue)) {
        found.set(precondition.via, undefined);
        continue;
      }
      const key = `${precondition.target.schema}.${precondition.target.table}`;
      found.set(precondition.via, fetched.get(key)?.get(String(viaValue)));
    }
    byRow.set(id, found);
  }
  return byRow;
}
