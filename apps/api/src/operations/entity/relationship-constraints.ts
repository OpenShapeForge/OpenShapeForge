// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import { fieldColumnMap } from "./columns.js";
import { getGeneratedCrudTables, requireEntityOperation } from "./catalog.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

type PreparedValues = ReadonlyMap<GeneratedCrudColumn, unknown>;

function constrainedTarget(table: GeneratedCrudTable, name: string) {
  return getGeneratedCrudTables().find((candidate) => candidate.source?.graphql?.typeName === name) ??
    (() => { throw new Error(`Constrained relationship target ${name} is not generated.`); })();
}

/** Enforce the same bounded eq/any predicate that interfaces use for choices. */
export async function assertRelationshipConstraintsInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: PreparedValues,
) {
  for (const relationship of table.source?.graphql?.relationships ?? []) {
    if (!relationship.constraints || relationship.resolve !== "belongsTo" || !relationship.foreignKey) continue;
    const sourceColumn = table.columns.find((column) => column.name === relationship.foreignKey);
    if (!sourceColumn || !values.has(sourceColumn)) continue;
    const selectedId = values.get(sourceColumn);
    if (selectedId == null) continue;
    const target = constrainedTarget(table, relationship.target);
    requireEntityOperation(target, "get", session);
    const conditions: RawBuilder<unknown>[] = [
      sql`${sql.id("candidate", target.primaryKey!)}::text = ${String(selectedId)}`,
    ];
    if (target.tenantScoped) conditions.push(sql`${sql.id("candidate", "tenant_id")} = ${session.tenantId}`);
    const targetFields = fieldColumnMap(target);
    for (const [key, constraint] of Object.entries(relationship.constraints)) {
      if ("eq" in constraint) {
        const column = targetFields.get(key);
        if (!column) throw new Error(`Constrained target field ${relationship.target}.${key} is not generated.`);
        conditions.push(sql`${sql.id("candidate", column.name)} = ${constraint.eq}`);
        continue;
      }
      const nested = target.source?.graphql?.relationships?.find((candidate) => candidate.name === key);
      if (!nested || nested.resolve !== "hasMany" || !nested.foreignKey || !target.primaryKey) {
        throw new Error(`Constrained collection ${relationship.target}.${key} is not generated.`);
      }
      const child = constrainedTarget(table, nested.target);
      requireEntityOperation(child, "list", session);
      const childFields = fieldColumnMap(child);
      const childConditions: RawBuilder<unknown>[] = [
        sql`${sql.id("related", nested.foreignKey)} = ${sql.id("candidate", target.primaryKey)}`,
      ];
      if (child.tenantScoped) childConditions.push(sql`${sql.id("related", "tenant_id")} = ${session.tenantId}`);
      for (const [childKey, childConstraint] of Object.entries(constraint.any)) {
        const column = childFields.get(childKey);
        if (!column) throw new Error(`Constrained target field ${nested.target}.${childKey} is not generated.`);
        childConditions.push(sql`${sql.id("related", column.name)} = ${childConstraint.eq}`);
      }
      conditions.push(sql`exists (
        select 1 from ${sql.id(child.schema, child.table)} as related
        where ${sql.join(childConditions, sql` and `)}
      )`);
    }
    const result = await sql<{ accepted: number }>`
      select 1 as accepted
      from ${sql.id(target.schema, target.table)} as candidate
      where ${sql.join(conditions, sql` and `)}
      limit 1
    `.execute(trx);
    if (!result.rows[0]) {
      const field = sourceColumn.sourceField ?? relationship.fieldKey ?? relationship.name;
      throw operationFailure({
        code: "VALIDATION",
        message: `The selected ${relationship.target} is not valid for ${table.source?.authoringEntityName ?? table.name}.${field}.`,
        retryable: false,
        violations: [{ field, code: "RELATIONSHIP_CONSTRAINT", message: "Select an allowed record." }],
      });
    }
  }
}
