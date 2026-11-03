// SPDX-License-Identifier: BUSL-1.1
/**
 * References without a foreign key (§4, "Link to another record"): a tenant
 * reference field stores only the target id, because its target differs per
 * field and is known at runtime only. What a foreign key would do is done
 * here: the deletion guard on the target (`onDelete: restrict | setNull`,
 * per definition) and a per-tenant check that finds and reports orphans.
 */
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { DB } from "../../../generated/db/types.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import type { DbSessionInput } from "../../../db/session.js";
import { getGeneratedCrudTables } from "../catalog.js";
import type { GeneratedCrudTable } from "../types.js";
import { extensionShape, isCollection, type ExtensionField } from "./model.js";
import { extensionRegistry } from "./registry.js";
import { loadExtensionFieldsFor } from "./store.js";
import { completeExtensionWrite, qualifiedTable } from "./write.js";
import { storedExtensionSource } from "./read.js";

function sourceTable(entity: string): GeneratedCrudTable {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  if (tables.length !== 1) throw operationFailure({ code: "INVALID_DEFINITION", message: `Extensible entity ${entity} has no unambiguous table.` });
  return tables[0]!;
}

/**
 * The deletion guard of a reference target. Runs under the target row's
 * exclusive lock, so a concurrent writer referencing it either committed its
 * index row (and is seen here) or waits on its `for share` and then finds
 * the target gone.
 */
export async function enforceExtensionReferencesOnDelete(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
): Promise<void> {
  const target = table.source?.authoringEntityName;
  if (!target || !session.tenantId) return;
  for (const source of extensionRegistry.referencedBy(target)) {
    const entry = extensionRegistry.entity(source.sourceEntity)!;
    const referencing = await sql<{ field_id: string; record_id: string }>`
      select distinct field_id, record_id from ${qualifiedTable(source.valuesTable)}
      where tenant_id = ${session.tenantId}::uuid and value_ref_id = ${id}::uuid
      order by field_id, record_id`.execute(trx);
    if (!referencing.rows.length) continue;
    const set = await loadExtensionFieldsFor(trx, session, source.sourceEntity, entry);
    const byField = new Map<string, string[]>();
    for (const row of referencing.rows) byField.set(row.field_id, [...byField.get(row.field_id) ?? [], row.record_id]);
    for (const [fieldId, records] of byField) {
      const field = set.byId.get(fieldId);
      // A deleted field's index rows are its backfill's to remove; they hold
      // nothing a reader can see and never restrict.
      if (!field || field.state === "deleted") continue;
      if ((field.definition.onDelete ?? "restrict") === "restrict") {
        throw operationFailure({
          code: "OPERATION_REFUSED",
          message: `This record is still referenced by ${records.length} ${source.sourceEntity} record(s) through "${field.key}".`,
          retryable: false,
        });
      }
      await unlinkReferences(trx, session, source.sourceEntity, set, field, records, id);
    }
  }
}

/** `setNull`: remove the id from each referencing record's source and index. */
async function unlinkReferences(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  set: Awaited<ReturnType<typeof loadExtensionFieldsFor>>,
  field: ExtensionField,
  records: readonly string[],
  targetId: string,
): Promise<void> {
  const table = sourceTable(entity);
  for (const recordId of records) {
    const locked = await sql<{ extension_values: unknown }>`
      select extension_values from ${sql.id(table.schema, table.table)}
      where tenant_id = ${session.tenantId}::uuid and id = ${recordId}::uuid for update`.execute(trx);
    if (!locked.rows[0]) continue;
    const before = storedExtensionSource(locked.rows[0]);
    const after: Record<string, unknown> = { ...before };
    const value = before[field.fieldId];
    if (isCollection(field.definition) && Array.isArray(value)) {
      const kept = value.filter((item) => item !== targetId);
      if (kept.length) after[field.fieldId] = kept; else delete after[field.fieldId];
    } else if (value === targetId) {
      delete after[field.fieldId];
    }
    await sql`update ${sql.id(table.schema, table.table)} set extension_values = ${jsonbLiteral(after)}
      where tenant_id = ${session.tenantId}::uuid and id = ${recordId}::uuid`.execute(trx);
    await completeExtensionWrite(trx, session, { table, set, before, after, changed: [field] }, recordId);
  }
}

export type ExtensionReferenceOrphan = {
  entity: string;
  fieldKey: string;
  recordId: string;
  targetEntity: string;
  targetId: string;
};

/**
 * The maintenance check: every reference value of this tenant whose target
 * row no longer exists (a delete that bypassed the guard, a restore from
 * backup). Reports; never repairs — that is the designer's decision.
 */
export async function findExtensionReferenceOrphans(
  trx: Transaction<DB>,
  session: DbSessionInput,
): Promise<ExtensionReferenceOrphan[]> {
  const orphans: ExtensionReferenceOrphan[] = [];
  for (const entity of extensionRegistry.entityNames()) {
    const entry = extensionRegistry.entity(entity)!;
    const set = await loadExtensionFieldsFor(trx, session, entity, entry);
    for (const field of set.fields) {
      if (field.state === "deleted") continue;
      const reference = extensionShape(entry, field.definition).reference;
      if (!reference) continue;
      const rows = await sql<{ record_id: string; value_ref_id: string }>`
        select v.record_id, v.value_ref_id from ${qualifiedTable(entry.valuesTable)} v
        where v.tenant_id = ${session.tenantId}::uuid and v.field_id = ${field.fieldId}::uuid
          and v.value_ref_id is not null
          and not exists (select 1 from ${qualifiedTable(reference.table)} t
            where t.tenant_id = v.tenant_id and t.id = v.value_ref_id)
        order by v.record_id, v.ordinal`.execute(trx);
      for (const row of rows.rows) {
        orphans.push({ entity, fieldKey: field.key, recordId: row.record_id, targetEntity: reference.entity, targetId: row.value_ref_id });
      }
    }
  }
  return orphans;
}
