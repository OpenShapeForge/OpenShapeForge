// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { DB } from "../../generated/db/types.js";
import { subtypeScopeWhere } from "./subtype-scope.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

type Values = Record<string, unknown>;
type Change = {
  relationship: string;
  create?: Values[];
  update?: Array<{
    id: string;
    expectedVersion: string;
    leaseToken?: string;
    values: Values;
  }>;
};
type Run = (
  table: GeneratedCrudTable,
  intent: "create" | "update",
  input: Values,
) => Promise<GeneratedEntityRow>;
function fail(message: string): never {
  throw operationFailure({ code: "VALIDATION", message, retryable: false });
}

/** Statically projected inverse relationships only. Each write re-enters canonical CRUD. */
export async function applyRelatedChanges(
  trx: Transaction<DB>,
  session: { tenantId?: string | null },
  owner: GeneratedCrudTable,
  parentId: string,
  changes: Change[],
  tables: readonly GeneratedCrudTable[],
  run: Run,
) {
  const seen = new Set<string>();
  const materialize = async (
    table: GeneratedCrudTable,
    input: Values,
    depth = 0,
  ): Promise<Values> => {
    const values = { ...input };
    for (const [key, value] of Object.entries(values)) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, "create")
      )
        continue;
      if (depth >= 2 || Object.keys(value).length !== 1)
        fail("Nested reference creation exceeds the offered contract.");
      const column = table.columns.find((c) => fieldNameForColumn(c) === key);
      const relation = table.source?.graphql?.relationships?.find(
        (r) => r.resolve === "belongsTo" && r.foreignKey === column?.name,
      );
      const target = tables.find(
        (t) => t.source?.graphql?.typeName === relation?.target,
      );
      if (!target || !relation)
        fail("This field does not support reference creation.");
      const draft = (value as { create: Values }).create;
      if (!draft || typeof draft !== "object" || Array.isArray(draft))
        fail("Reference values are required.");
      const constraints = relation.constraints ?? {};
      const bound: Values = {};
      for (const [field, rule] of Object.entries(constraints)) {
        if (!("eq" in rule))
          fail(
            "This reference needs its dedicated constrained-create Operation.",
          );
        if (Object.hasOwn(draft, field) && draft[field] !== rule.eq)
          fail("Reference values contradict the required relationship.");
        bound[field] = rule.eq;
      }
      const row = await run(target, "create", {
        values: await materialize(target, { ...draft, ...bound }, depth + 1),
      });
      values[key] = row[target.primaryKey];
    }
    return values;
  };
  for (const change of changes) {
    if (seen.has(change.relationship))
      fail("A relationship may occur only once per save.");
    seen.add(change.relationship);
    const relation = owner.source?.graphql?.relationships?.find(
      (r) => r.fieldKey === change.relationship,
    );
    if (
      !relation ||
      relation.kind !== "hasMany" ||
      relation.ownership !== "reference" ||
      relation.via ||
      !relation.foreignKey ||
      !relation.inverse
    )
      fail("Only declared direct reference collections may be changed.");
    if (
      relation.sortable ||
      relation.childAuthorization === "owner" ||
      (typeof relation.cardinality === "object" &&
        ((relation.cardinality.min ?? 0) > 0 ||
          typeof relation.cardinality.max === "number"))
    )
      fail("This collection requires its dedicated guarded Operation.");
    const target = tables.find(
      (t) => t.source?.graphql?.typeName === relation.target,
    );
    const parentColumn = target?.columns.find(
      (c) => c.name === relation.foreignKey,
    );
    if (!target || !parentColumn || !target.primaryKey)
      fail("Related storage is unavailable.");
    const field = fieldNameForColumn(parentColumn);
    for (const item of change.update ?? []) {
      if (Object.hasOwn(item.values, field))
        fail("The parent relationship cannot be changed here.");
      const result =
        await sql`select ${sql.id(parentColumn.name)} as parent from ${sql.id(target.schema, target.table)} where ${sql.id(target.primaryKey)}::text=${item.id} ${target.tenantScoped ? sql`and tenant_id=${session.tenantId}` : sql``}${subtypeScopeWhere(target)} for update`.execute(
          trx,
        );
      if (
        result.rows.length !== 1 ||
        (result.rows[0] as { parent: string }).parent !== parentId
      )
        fail("The selected record is not in this collection.");
      await run(target, "update", {
        id: item.id,
        expectedVersion: item.expectedVersion,
        ...(item.leaseToken ? { leaseToken: item.leaseToken } : {}),
        values: item.values,
      });
    }
    for (const item of change.create ?? []) {
      if (Object.hasOwn(item, field))
        fail("The parent relationship is supplied by the server.");
      await run(target, "create", {
        values: { ...(await materialize(target, item)), [field]: parentId },
      });
    }
  }
}
